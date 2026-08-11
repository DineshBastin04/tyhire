import base64

from app.services.openai_client import call_tool

FACIAL_TOOL = {
    "type": "function",
    "function": {
        "name": "record_facial_affect",
        "description": "Describes observable facial/body-language affect across a few frames from an interview recording.",
        "parameters": {
            "type": "object",
            "properties": {
                "face_visible": {
                    "type": "boolean",
                    "description": "False if the frames don't actually show a person's face clearly enough to assess — in that case leave overall_affect/tension_level as 'unknown'/'low' and explain in notes, don't guess.",
                },
                "overall_affect": {
                    "type": "string",
                    "description": "One or two words, e.g. 'relaxed', 'tense', 'engaged', 'fidgety', or 'unknown' if face_visible is false.",
                },
                "tension_level": {"type": "string", "enum": ["low", "medium", "high"]},
                "notes": {
                    "type": "string",
                    "description": "Brief, specific observations — posture, expression, eye contact with the camera — not speculation about honesty or competence.",
                },
            },
            "required": ["face_visible", "overall_affect", "tension_level", "notes"],
        },
    },
}

SYSTEM_PROMPT = (
    "You describe observable facial expression and body language across a few still frames "
    "from an interview recording — posture, visible tension, eye contact with the camera, "
    "expressiveness. This is a supplementary signal for human review, never an automated "
    "pass/fail judgment, and never a basis to infer honesty, competence, or personality. "
    "Be aware that anxiety, cultural differences in expressiveness, neurodivergence, and "
    "camera unfamiliarity can all look like 'tension' without meaning anything about the "
    "candidate — describe what's visible, do not diagnose the person."
)


def analyze_facial_affect(frame_paths: list[str]) -> dict:
    if not frame_paths:
        return {
            "face_visible": False,
            "overall_affect": "unknown",
            "tension_level": "low",
            "notes": "No frames could be extracted from recording for facial affect analysis.",
        }
    content = [
        {"type": "text", "text": f"{len(frame_paths)} frames from one candidate's interview recording, in order:"}
    ]
    for path in frame_paths:
        with open(path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode("utf-8")
        content.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}})

    return call_tool(system=SYSTEM_PROMPT, user_content=content, tool=FACIAL_TOOL)
