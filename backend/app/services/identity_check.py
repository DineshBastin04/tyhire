import base64

from app.services.openai_client import call_tool

MATCH_TOOL = {
    "type": "function",
    "function": {
        "name": "record_identity_match",
        "description": "Records whether a live selfie photo matches a government ID photo.",
        "parameters": {
            "type": "object",
            "properties": {
                "confidence": {
                    "type": "number",
                    "description": "0-1 confidence that the two photos show the same person.",
                },
                "verdict": {
                    "type": "string",
                    "enum": ["match", "no_match", "uncertain"],
                },
                "notes": {"type": "string"},
            },
            "required": ["confidence", "verdict"],
        },
    },
}

SYSTEM_PROMPT = (
    "You compare a government ID photo against a live selfie capture to support (never replace) "
    "human identity review for interview screening. This is a heuristic aid, not a biometric system of "
    "record. If lighting, angle, or image quality makes comparison unreliable, return verdict='uncertain' "
    "rather than guessing — uncertain matches are always routed to a human reviewer."
)


def _image_block(content: bytes, media_type: str) -> dict:
    b64 = base64.b64encode(content).decode("utf-8")
    return {
        "type": "image_url",
        "image_url": {"url": f"data:{media_type};base64,{b64}"},
    }


def check_identity_match(id_photo: bytes, id_media_type: str, selfie: bytes, selfie_media_type: str) -> dict:
    user_content = [
        {"type": "text", "text": "First image: government ID photo. Second image: live selfie capture."},
        _image_block(id_photo, id_media_type),
        _image_block(selfie, selfie_media_type),
    ]
    result = call_tool(system=SYSTEM_PROMPT, user_content=user_content, tool=MATCH_TOOL)
    result["needs_human_review"] = result.get("verdict") != "match" or result.get("confidence", 0) < 0.8
    return result
