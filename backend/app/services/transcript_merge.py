from datetime import datetime


def merge_transcripts(
    candidate_segments: list[dict],
    candidate_started_at: datetime,
    interviewer_segments: list[dict],
    interviewer_started_at: datetime | None,
) -> str:
    """Interleaves two independently-recorded, timestamped transcripts into one chronological,
    speaker-labeled conversation. Each recording only knows offsets relative to its own start,
    so each recording's own wall-clock start time anchors its segments onto a shared timeline —
    this is what makes real Q&A cross-verification possible instead of guessing speakers from
    one mixed transcript."""
    entries: list[tuple[float, str, str]] = [
        (candidate_started_at.timestamp() + seg["start"], "Candidate", seg["text"])
        for seg in candidate_segments
    ]

    if interviewer_started_at:
        entries += [
            (interviewer_started_at.timestamp() + seg["start"], "Interviewer", seg["text"])
            for seg in interviewer_segments
        ]

    entries.sort(key=lambda e: e[0])
    return "\n".join(f"[{speaker}] {text}" for _, speaker, text in entries if text)
