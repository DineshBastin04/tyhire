import subprocess


def extract_audio_wav(input_path: str) -> str:
    """Pulls a plain WAV audio track out of a recording (which may be video+audio, as the
    candidate's webm is). gpt-audio's input format is stricter than Whisper's — it doesn't
    reliably accept webm — so this guarantees a format it actually supports."""
    output_path = input_path.rsplit(".", 1)[0] + "_audio.wav"
    subprocess.run(
        ["ffmpeg", "-y", "-i", input_path, "-vn", "-ar", "16000", "-ac", "1", output_path],
        check=True,
        capture_output=True,
    )
    return output_path
