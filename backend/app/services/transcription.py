import math
import os
import subprocess

from app.services.openai_client import client

# Whisper's supported input formats include webm directly, so the recorded
# interview file can be sent as-is — no audio extraction/re-encoding needed.
TRANSCRIBE_MODEL = "whisper-1"

# Whisper hard-rejects anything over 26,214,400 bytes (25 MiB) with a 413. Stay comfortably
# under that — a WAV header and rounding add a little overhead to every chunk we cut.
MAX_UPLOAD_BYTES = 24 * 1024 * 1024


def transcribe_recording(absolute_path: str) -> str:
    text, _ = transcribe_with_segments(absolute_path)
    return text


def transcribe_with_segments(absolute_path: str) -> tuple[str, list[dict]]:
    """Returns (full_text, segments) where each segment has start/end seconds relative to
    the start of this specific audio file — needed to align two separately-recorded tracks
    (candidate mic, interviewer mic) onto one shared timeline.

    Files over Whisper's 25MB limit are split into time-based chunks first (long interviews
    routinely exceed it), transcribed separately, and the segment timestamps re-offset onto
    the original file's timeline before being combined.
    """
    size = os.path.getsize(absolute_path)
    if size <= MAX_UPLOAD_BYTES:
        return _transcribe_chunk(absolute_path, offset_seconds=0.0)

    chunks = _split_into_chunks(absolute_path, size)
    try:
        text_parts: list[str] = []
        all_segments: list[dict] = []
        offset = 0.0
        for chunk_path, chunk_duration in chunks:
            text, segments = _transcribe_chunk(chunk_path, offset_seconds=offset)
            text_parts.append(text)
            all_segments.extend(segments)
            offset += chunk_duration
        return " ".join(p for p in text_parts if p), all_segments
    finally:
        for chunk_path, _ in chunks:
            try:
                os.remove(chunk_path)
            except OSError:
                pass


def _transcribe_chunk(path: str, offset_seconds: float) -> tuple[str, list[dict]]:
    with open(path, "rb") as f:
        result = client.audio.transcriptions.create(
            model=TRANSCRIBE_MODEL, file=f, response_format="verbose_json"
        )
    segments = [
        {"start": seg.start + offset_seconds, "end": seg.end + offset_seconds, "text": seg.text.strip()}
        for seg in (result.segments or [])
    ]
    return result.text, segments


def _split_into_chunks(absolute_path: str, total_bytes: int) -> list[tuple[str, float]]:
    """Splits into N equal-duration chunks sized to land under MAX_UPLOAD_BYTES, using the
    file's own total duration/size ratio — works regardless of the exact sample rate the
    audio was extracted at."""
    duration = _probe_duration_seconds(absolute_path)
    num_chunks = max(1, math.ceil(total_bytes / MAX_UPLOAD_BYTES))
    chunk_duration = duration / num_chunks

    base, ext = absolute_path.rsplit(".", 1)
    chunks: list[tuple[str, float]] = []
    for i in range(num_chunks):
        start = i * chunk_duration
        # Last chunk runs to the true end rather than the computed duration, so trailing
        # audio never gets silently dropped to rounding.
        length = chunk_duration if i < num_chunks - 1 else max(chunk_duration, duration - start)
        chunk_path = f"{base}_chunk{i}.{ext}"
        subprocess.run(
            ["ffmpeg", "-y", "-ss", str(start), "-t", str(length), "-i", absolute_path, "-c", "copy", chunk_path],
            check=True,
            capture_output=True,
        )
        chunks.append((chunk_path, length))
    return chunks


def _probe_duration_seconds(path: str) -> float:
    result = subprocess.run(
        [
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", path,
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return float(result.stdout.strip())
