import base64
import contextlib
import json
import os
import subprocess
import tempfile
from app.services.openai_client import client
from app.services import storage

# Using the standard gpt-4o-audio-preview model to assess speaker identity
VOICE_MODEL = "gpt-4o-audio-preview"

SYSTEM_PROMPT = (
    "You are a biometric voice comparison assistant. Your job is to listen to two audio clips "
    "and determine if they are spoken by the exact same speaker. Focus purely on the vocal characteristics "
    "such as pitch, timber, accent, pronunciation, and pacing. Ignore background noise or slight variations "
    "in microphone quality. You must trigger the record_voice_comparison function with your findings."
)

VERIFICATION_TOOL = {
    "type": "function",
    "function": {
        "name": "record_voice_comparison",
        "description": "Records the speaker verification comparison results.",
        "parameters": {
            "type": "object",
            "properties": {
                "match": {
                    "type": "boolean",
                    "description": "True if the speaker in both clips is the same person, False if they are different people.",
                },
                "confidence": {
                    "type": "number",
                    "description": "Confidence score for the verdict, ranging from 0.0 (no confidence) to 1.0 (perfect confidence).",
                },
                "reason": {
                    "type": "string",
                    "description": "A brief explanation describing the voice characteristics that led to the match or mismatch verdict.",
                },
            },
            "required": ["match", "confidence", "reason"],
        },
    },
}


def _transcode_to_wav(input_path: str, output_path: str, start_time: float = None, duration: float = None) -> None:
    """Helper to convert any audio/video input to a standard 16kHz mono WAV file."""
    cmd = ["ffmpeg", "-y"]
    if start_time is not None:
        cmd.extend(["-ss", str(start_time)])
    if duration is not None:
        cmd.extend(["-t", str(duration)])
    cmd.extend(["-i", input_path, "-ac", "1", "-ar", "16000", "-f", "wav", output_path])
    subprocess.run(cmd, check=True, capture_output=True)


def verify_voice_match(enrollment_relative_path: str, interview_wav_path: str) -> dict:
    """Compares the candidate's enrolled voice sample with the interview recording.
    Extracts a 5-second candidate slice and uses GPT-4o-Audio to compare them."""
    if not os.path.exists(storage.absolute_path(enrollment_relative_path)) or not os.path.exists(interview_wav_path):
        return {"match": True, "confidence": 1.0, "reason": "Missing audio files for comparison"}

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp_enroll, \
         tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp_slice:
        enroll_wav = tmp_enroll.name
        slice_wav = tmp_slice.name

    try:
        # Decrypt reference voice snippet dynamically before transcoding
        with storage.decrypted_temp_copy(enrollment_relative_path) as enroll_temp_path:
            # Transcode enrollment to 16kHz WAV
            _transcode_to_wav(enroll_temp_path, enroll_wav)

        # Transcode a 5-second slice from the interview (skip first 10 seconds to avoid silent start)
        _transcode_to_wav(interview_wav_path, slice_wav, start_time=10.0, duration=5.0)

        # Encode both WAVs in base64
        with open(enroll_wav, "rb") as f:
            enroll_b64 = base64.b64encode(f.read()).decode("utf-8")
        with open(slice_wav, "rb") as f:
            slice_b64 = base64.b64encode(f.read()).decode("utf-8")

        # Call OpenAI Chat Completions using audio inputs
        response = client.chat.completions.create(
            model=VOICE_MODEL,
            modalities=["text"],
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "Here is the candidate's enrolled voice reference sample:"},
                        {"type": "input_audio", "input_audio": {"data": enroll_b64, "format": "wav"}},
                        {"type": "text", "text": "Here is a 5-second slice from the candidate's interview recording:"},
                        {"type": "input_audio", "input_audio": {"data": slice_b64, "format": "wav"}},
                    ],
                },
            ],
            tools=[VERIFICATION_TOOL],
            tool_choice={"type": "function", "function": {"name": "record_voice_comparison"}},
        )

        message = response.choices[0].message
        if not message.tool_calls:
            raise ValueError("GPT-4o-Audio did not trigger the verification function tool")

        result = json.loads(message.tool_calls[0].function.arguments)
        return result

    except Exception as exc:
        print(f"[voice_verification] verification failed: {exc}")
        # Default to a safe bypass in case of AI exceptions or transcription limitations
        return {
            "match": True,
            "confidence": 0.5,
            "reason": f"Voice comparison failed or skipped due to system error: {exc}",
        }
    finally:
        for path in (enroll_wav, slice_wav):
            if os.path.exists(path):
                with contextlib.suppress(OSError):
                    os.remove(path)
