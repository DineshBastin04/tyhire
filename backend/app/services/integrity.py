"""Fuses raw signal events into human-reviewable flags and a single integrity score.

Deliberately rule-based, not ML, for the POC: an isolated glance-off-screen should never read as a
standalone alarm, but several signals clustered in the same window should. See roadmap section 02.
"""
from app.models.interview import SignalEvent, SignalType

CLUSTER_WINDOW_MS = 5000

# Matches SignalEventIn's bound (schemas/interview.py) on the one field of a SignalEvent
# that's ever client-supplied. Clamped again here, independently, rather than trusting
# that every row reaching this function passed through that schema — the highest weight
# the backend itself assigns is 5 (location_mismatch, api/v1/interviews.py), so this still
# leaves headroom for that without letting a single row dominate a cluster's severity, or
# (via a negative value) swing the overall score above compute_integrity_score's 0-100
# range below.
MIN_SIGNAL_WEIGHT = 0.0
MAX_SIGNAL_WEIGHT = 10.0

# A lone occurrence of these is common/benign; they only matter when they cluster with something else.
# devtools_open is a heuristic (window-size diff) with real false-positive potential — same
# treatment as the other soft signals rather than trusting it standalone.
LOW_SIGNAL_ALONE = {
    SignalType.gaze_off_screen,
    SignalType.excessive_motion,
    SignalType.window_blur,
    SignalType.devtools_open,
}

# window_blur fires as a near-certain side effect of tab_switch — the OS window loses
# focus at essentially the same instant the tab becomes hidden — whenever the candidate
# alt-tabs away entirely, even though the frontend also tries to suppress the redundant
# one at the source (see interview/[token]/page.tsx). Without this, one alt-tab landing
# in the same cluster as both counted as 2 "distinct signal types": base_severity doubled
# (both signals' weights summed) AND the type-diversity multiplier below applied on top
# of that, tripling severity for what is really one event. window_blur on its own (no
# tab_switch in the cluster) is untouched — a genuine standalone focus loss, e.g.
# clicking a second monitor's window without the tab ever going hidden, is still real
# signal, just not alarm-worthy alone (see LOW_SIGNAL_ALONE above).
REDUNDANT_WHEN_PAIRED_WITH = {
    SignalType.window_blur: SignalType.tab_switch,
}


def fuse_signals(events: list[SignalEvent]) -> list[dict]:
    """Groups events into clusters within CLUSTER_WINDOW_MS and scores each cluster."""
    if not events:
        return []

    sorted_events = sorted(events, key=lambda e: e.session_offset_ms)
    clusters: list[list[SignalEvent]] = []
    current: list[SignalEvent] = [sorted_events[0]]

    for event in sorted_events[1:]:
        if event.session_offset_ms - current[-1].session_offset_ms <= CLUSTER_WINDOW_MS:
            current.append(event)
        else:
            clusters.append(current)
            current = [event]
    clusters.append(current)

    flags = []
    for cluster in clusters:
        raw_types = {e.signal_type for e in cluster}
        scored_events = [
            e for e in cluster
            if REDUNDANT_WHEN_PAIRED_WITH.get(e.signal_type) not in raw_types
        ]
        distinct_types = {e.signal_type for e in scored_events}
        if not distinct_types:
            continue

        base_severity = sum(
            max(MIN_SIGNAL_WEIGHT, min(MAX_SIGNAL_WEIGHT, e.weight)) for e in scored_events
        )

        # A single low-signal-alone type in isolation is not flag-worthy.
        if distinct_types.issubset(LOW_SIGNAL_ALONE) and len(distinct_types) == 1:
            continue

        # Multiple distinct signal types together compound severity — this is the fusion.
        severity = base_severity * (1 + 0.5 * (len(distinct_types) - 1))

        flags.append({
            "session_offset_ms": cluster[0].session_offset_ms,
            "severity": round(severity, 2),
            "summary": _summarize(distinct_types, cluster),
            # Every raw event in the cluster, including any redundant one dropped from
            # scoring above — the audit trail should still show it happened.
            "contributing_signal_ids": [str(e.id) for e in cluster],
        })

    return flags


def _summarize(distinct_types: set[SignalType], cluster: list[SignalEvent]) -> str:
    labels = {
        SignalType.tab_switch: "Tab switch",
        SignalType.window_blur: "Window lost focus",
        SignalType.copy_paste: "Copy/paste",
        SignalType.second_face: "Second face detected",
        SignalType.second_voice: "Second voice detected",
        SignalType.gaze_off_screen: "Gaze off-screen",
        SignalType.excessive_motion: "Excessive motion",
        SignalType.virtual_camera: "Virtual camera signature",
        SignalType.response_timing_anomaly: "Response timing anomaly",
        SignalType.unauthorized_app_detected: "Unauthorized app running (desktop probe)",
        SignalType.external_display_detected: "External display connected",
        SignalType.fullscreen_exit: "Exited fullscreen",
        SignalType.devtools_open: "Browser DevTools possibly open",
        SignalType.screen_share_partial: "Shared a single tab/window, not the full screen",
        SignalType.screen_share_stopped: "Stopped screen sharing mid-interview",
        SignalType.location_mismatch: "IP-resolved location doesn't match stated location",
        SignalType.ai_extension_detected: "AI answer-helper browser extension detected",
    }
    duration_s = round((cluster[-1].session_offset_ms - cluster[0].session_offset_ms) / 1000, 1)
    parts = " + ".join(labels[t] for t in distinct_types)
    return f"{parts} over {duration_s}s" if duration_s > 0 else parts


def compute_integrity_score(flags: list[dict]) -> tuple[float, bool]:
    """Returns (score 0-100 where 100 is clean, needs_human_review)."""
    total_severity = sum(f["severity"] for f in flags)
    # Every legitimate severity is >= 0 (weights are clamped to >= 0 above), so
    # total_severity can't actually go negative through normal use — this upper clamp is
    # a second, independent line of defense against that anyway, since 100 is documented
    # everywhere downstream (SessionOut.integrity_score, the review UI's score bands) as
    # this score's ceiling, not just its floor.
    score = max(0.0, min(100.0, 100.0 - total_severity))
    needs_review = score < 85 or any(f["severity"] >= 5 for f in flags)
    return round(score, 1), needs_review
