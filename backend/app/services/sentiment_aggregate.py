from app.models.interview import SentimentSample

TENSION_ORDER = {"low": 0, "medium": 1, "high": 2}


def aggregate_sentiment(samples: list[SentimentSample]) -> dict:
    """Aggregates periodic facial-affect readings into a distribution + trend across the
    whole session, instead of numerically averaging a categorical field and rounding back —
    that would misrepresent what "average tension: 1.4" is supposed to mean. Still framed as
    a supplementary signal, same caution as the single post-call reading it supplements."""
    readings: list[tuple[int, str]] = []
    for sample in samples:
        affect = sample.facial_affect or {}
        level = affect.get("tension_level")
        if level in TENSION_ORDER and affect.get("face_visible", True):
            readings.append((sample.session_offset_ms, level))

    if not readings:
        return {
            "sample_count": len(samples),
            "tension_distribution": {"low": 0, "medium": 0, "high": 0},
            "dominant_tension": "unknown",
            "summary": "No usable facial-affect readings were captured across the session.",
        }

    distribution = {"low": 0, "medium": 0, "high": 0}
    for _, level in readings:
        distribution[level] += 1
    dominant = max(distribution, key=lambda k: distribution[k])

    readings.sort(key=lambda r: r[0])
    third = max(1, len(readings) // 3)
    first_avg = sum(TENSION_ORDER[level] for _, level in readings[:third]) / third
    last_avg = sum(TENSION_ORDER[level] for _, level in readings[-third:]) / third

    if last_avg - first_avg >= 0.5:
        trend = "tension rose over the course of the interview"
    elif first_avg - last_avg >= 0.5:
        trend = "tension eased over the course of the interview"
    else:
        trend = "tension stayed roughly steady throughout"

    return {
        "sample_count": len(samples),
        "tension_distribution": distribution,
        "dominant_tension": dominant,
        "summary": f"Predominantly {dominant} tension across {len(readings)} readings — {trend}.",
    }
