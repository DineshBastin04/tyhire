"""Fuses raw signal events into human-reviewable flags and a single integrity score.

Deliberately rule-based, not ML, for the POC: an isolated glance-off-screen should never read as a
standalone alarm, but several signals clustered in the same window should. See roadmap section 02.
"""
from app.models.interview import SignalEvent, SignalType

CLUSTER_WINDOW_MS = 5000

# A lone occurrence of these is common/benign; they only matter when they cluster with something else.
# devtools_open is a heuristic (window-size diff) with real false-positive potential — same
# treatment as the other soft signals rather than trusting it standalone.
LOW_SIGNAL_ALONE = {
    SignalType.gaze_off_screen,
    SignalType.excessive_motion,
    SignalType.window_blur,
    SignalType.devtools_open,
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
        distinct_types = {e.signal_type for e in cluster}
        base_severity = sum(e.weight for e in cluster)

        # A single low-signal-alone type in isolation is not flag-worthy.
        if distinct_types.issubset(LOW_SIGNAL_ALONE) and len(distinct_types) == 1:
            continue

        # Multiple distinct signal types together compound severity — this is the fusion.
        severity = base_severity * (1 + 0.5 * (len(distinct_types) - 1))

        flags.append({
            "session_offset_ms": cluster[0].session_offset_ms,
            "severity": round(severity, 2),
            "summary": _summarize(distinct_types, cluster),
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
    }
    duration_s = round((cluster[-1].session_offset_ms - cluster[0].session_offset_ms) / 1000, 1)
    parts = " + ".join(labels[t] for t in distinct_types)
    return f"{parts} over {duration_s}s" if duration_s > 0 else parts


def compute_integrity_score(flags: list[dict]) -> tuple[float, bool]:
    """Returns (score 0-100 where 100 is clean, needs_human_review)."""
    total_severity = sum(f["severity"] for f in flags)
    score = max(0.0, 100.0 - total_severity)
    needs_review = score < 85 or any(f["severity"] >= 5 for f in flags)
    return round(score, 1), needs_review
