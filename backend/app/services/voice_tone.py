import base64
import json

from app.services.openai_client import client

TONE_MODEL = "gpt-audio"

TONE_TOOL = {
    "type": "function",
    "function": {
        "name": "record_voice_tone",
        "description": "Assesses vocal tone/affect from an audio recording of interview answers.",
        "parameters": {
            "type": "object",
            "properties": {
                "overall_tone": {
                    "type": "string",
                    "description": "One or two words for the dominant vocal tone, e.g. 'confident', 'hesitant', 'nervous', 'calm'.",
                },
                "confidence_level": {"type": "string", "enum": ["low", "medium", "high"]},
                "notes": {
                    "type": "string",
                    "description": "Brief, specific observations about pacing/hesitation/energy — not speculation about character.",
                },
            },
            "required": ["overall_tone", "confidence_level", "notes"],
        },
    },
}

SYSTEM_PROMPT = (
    "You assess vocal tone from an interview recording — pacing, hesitation, energy, and "
    "confidence as conveyed by HOW something is said, not what is said. This is a "
    "supplementary signal for human review, never an automated pass/fail judgment. Describe "
    "observable vocal qualities only — do not infer the speaker's honesty, personality, or "
    "fitness for the role from their tone alone."
)


def analyze_voice_tone(wav_path: str) -> dict:
    with open(wav_path, "rb") as f:
        audio_b64 = base64.b64encode(f.read()).decode("utf-8")

    response = client.chat.completions.create(
        model=TONE_MODEL,
        modalities=["text"],
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [{"type": "input_audio", "input_audio": {"data": audio_b64, "format": "wav"}}],
            },
        ],
        tools=[TONE_TOOL],
        tool_choice={"type": "function", "function": {"name": "record_voice_tone"}},
    )
    message = response.choices[0].message
    if not message.tool_calls:
        raise ValueError("gpt-audio did not return a tool call")
    return json.loads(message.tool_calls[0].function.arguments)
