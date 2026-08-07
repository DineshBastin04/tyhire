import re
import subprocess


def extract_frames(video_path: str, count: int = 3) -> list[str]:
    """Pulls `count` evenly-spaced JPEG frames out of a video for still-image analysis.
    Duration is probed first so the frames are actually spread across the recording rather
    than all landing in, say, the first second."""
    duration = _probe_duration_seconds(video_path)
    frame_paths = []

    for i in range(count):
        # Skip the very start/end — spread frames across the middle of the recording.
        fraction = (i + 1) / (count + 1)
        timestamp = duration * fraction
        output_path = f"{video_path.rsplit('.', 1)[0]}_frame{i}.jpg"
        subprocess.run(
            ["ffmpeg", "-y", "-ss", str(timestamp), "-i", video_path, "-frames:v", "1", output_path],
            check=True,
            capture_output=True,
        )
        frame_paths.append(output_path)

    return frame_paths


def _probe_duration_seconds(video_path: str) -> float:
    """Webm files built from concatenated browser MediaRecorder chunks (see
    storage.append_file_chunk) often never get a finalized container-level duration —
    ffprobe reports the literal string "N/A" for these rather than a number, which used to
    crash this whole post-call analysis step outright. Falls back through progressively
    more expensive but more reliable ways of getting a real duration instead of giving up."""
    duration = _ffprobe_duration(video_path, "format=duration")
    if duration is None:
        duration = _ffprobe_duration(video_path, "stream=duration", select_video_stream=True)
    if duration is None:
        duration = _decode_duration_seconds(video_path)
    return duration or 0.0


def _ffprobe_duration(video_path: str, entries: str, select_video_stream: bool = False) -> float | None:
    cmd = ["ffprobe", "-v", "error", "-show_entries", entries, "-of", "default=noprint_wrappers=1:nokey=1"]
    if select_video_stream:
        cmd += ["-select_streams", "v:0"]
    cmd.append(video_path)

    result = subprocess.run(cmd, check=True, capture_output=True, text=True)
    first_line = result.stdout.strip().splitlines()[0] if result.stdout.strip() else ""
    try:
        return float(first_line)
    except ValueError:
        return None  # e.g. ffprobe printed "N/A" — no duration available this way


_FFMPEG_TIME_RE = re.compile(r"time=(\d+):(\d+):(\d+\.\d+)")


def _decode_duration_seconds(video_path: str) -> float:
    """Last resort: decode the whole file to nowhere and read the final timestamp ffmpeg
    reports as it processes — slower, but works even when the container has no usable
    duration metadata at all."""
    result = subprocess.run(
        ["ffmpeg", "-i", video_path, "-f", "null", "-"],
        capture_output=True,
        text=True,
    )
    matches = _FFMPEG_TIME_RE.findall(result.stderr)
    if not matches:
        return 0.0
    hours, minutes, seconds = matches[-1]
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)
