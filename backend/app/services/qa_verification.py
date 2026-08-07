from app.services.openai_client import call_tool

QA_TOOL = {
    "type": "function",
    "function": {
        "name": "record_qa_analysis",
        "description": (
            "Extracts interviewer question / candidate answer exchanges from an interview "
            "transcript and verifies whether each answer actually addresses its question."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "no_questions_detected": {
                    "type": "boolean",
                    "description": (
                        "True if the transcript contains no discernible interviewer questions — "
                        "e.g. only the candidate's microphone was captured, not the interviewer's."
                    ),
                },
                "exchanges": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "question": {
                                "type": "string",
                                "description": "The question as actually spoken in the transcript.",
                            },
                            "answer": {
                                "type": "string",
                                "description": "The candidate's answer as actually spoken.",
                            },
                            "verdict": {
                                "type": "string",
                                "enum": ["relevant", "partially_relevant", "off_topic", "evasive"],
                            },
                            "explanation": {
                                "type": "string",
                                "description": "One sentence on why this verdict was given.",
                            },
                        },
                        "required": ["question", "answer", "verdict", "explanation"],
                    },
                },
            },
            "required": ["no_questions_detected", "exchanges"],
        },
    },
}

SYSTEM_PROMPT = (
    "You analyze an interview transcript to check whether the candidate's answers actually "
    "address the questions asked. The transcript may contain both the interviewer's questions "
    "and the candidate's answers, or it may contain ONLY the candidate's side if the "
    "interviewer's audio wasn't captured by the recording. In that case, set "
    "no_questions_detected=true and return an empty exchanges list — never fabricate a "
    "question that isn't actually present in the text. Only extract exchanges you can "
    "actually identify; do not guess at implied questions."
)


def analyze_qa(transcript: str) -> dict:
    return call_tool(
        system=SYSTEM_PROMPT,
        user_content=f"Interview transcript:\n\n{transcript}",
        tool=QA_TOOL,
    )
