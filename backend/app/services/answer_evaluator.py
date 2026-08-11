import logging
from typing import Any
from app.services.openai_client import call_tool

logger = logging.getLogger(__name__)

ANSWER_EVAL_TOOL = {
    "type": "function",
    "function": {
        "name": "evaluate_interview_answer",
        "description": "Evaluates candidate answer accuracy, depth, concept coverage, and identifies if the response appears scripted/read from a teleprompter.",
        "parameters": {
            "type": "object",
            "properties": {
                "accuracy_score": {
                    "type": "number",
                    "description": "Overall technical accuracy and correctness score from 0 to 100.",
                },
                "verdict": {
                    "type": "string",
                    "enum": ["strong", "partially_correct", "superficial", "inaccurate", "scripted_delivery"],
                    "description": "Quick categorical verdict for HR decision making.",
                },
                "concepts_covered": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Expected concepts accurately addressed by candidate.",
                },
                "concepts_missing": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Important concepts or trade-offs that the candidate failed to mention.",
                },
                "depth_rating": {
                    "type": "string",
                    "enum": ["deep", "adequate", "surface"],
                    "description": "Level of technical depth exhibited.",
                },
                "fluff_detected": {
                    "type": "boolean",
                    "description": "True if the candidate used generic buzzwords without substantive technical depth.",
                },
                "teleprompter_speech_flag": {
                    "type": "boolean",
                    "description": "True if the response structure strongly resembles reading from an AI prompt/teleprompter (e.g. rigid bulleted list phrasing, unnatural robotic structure).",
                },
                "hr_summary": {
                    "type": "string",
                    "description": "1-2 sentence executive takeaway for the HR interviewer.",
                },
                "suggested_followup": {
                    "type": "string",
                    "description": "An immediate drill-down follow-up question for HR to ask next.",
                },
            },
            "required": [
                "accuracy_score",
                "verdict",
                "concepts_covered",
                "concepts_missing",
                "depth_rating",
                "fluff_detected",
                "teleprompter_speech_flag",
                "hr_summary",
                "suggested_followup",
            ],
        },
    },
}

SYSTEM_PROMPT = """You are an expert technical evaluator assisting an interviewer in real time.
Analyze the candidate's spoken response against the question and the expected concepts.
Evaluate:
1. Technical Accuracy (0-100%): Are the principles, terminology, and mechanisms correct?
2. Concept Coverage: Which expected key concepts were covered vs missing?
3. Delivery Authenticity: Does the answer sound like an authentic explanation, or does it sound like reading from a ChatGPT prompt/teleprompter?
4. Provide a punchy 1-2 sentence HR summary and a sharp follow-up question.
"""


def evaluate_live_answer(
    question_text: str,
    expected_concepts: list[str],
    candidate_transcript: str,
    job_context: str = "Software Engineering",
) -> dict[str, Any]:
    if not candidate_transcript or len(candidate_transcript.strip()) < 10:
        return {
            "accuracy_score": 0.0,
            "verdict": "inaccurate",
            "concepts_covered": [],
            "concepts_missing": expected_concepts,
            "depth_rating": "surface",
            "fluff_detected": False,
            "teleprompter_speech_flag": False,
            "hr_summary": "Candidate has not provided a substantive answer yet.",
            "suggested_followup": "Could you provide a detailed technical walkthrough of this?",
        }

    user_content = f"""Role Context: {job_context}
Question Asked: {question_text}
Expected Key Concepts: {', '.join(expected_concepts) if expected_concepts else 'Domain standard concepts'}

Candidate's Spoken Answer Transcript:
"{candidate_transcript}"

Evaluate the accuracy, key concepts covered vs missing, authenticity, and suggest the next follow-up question."""

    try:
        result = call_tool(
            system=SYSTEM_PROMPT,
            user_content=user_content,
            tool=ANSWER_EVAL_TOOL,
        )
        return result
    except Exception as exc:
        logger.warning("AI answer evaluation failed: %s. Returning heuristic fallback.", exc)
        # Graceful fallback heuristic
        word_count = len(candidate_transcript.split())
        matched = [c for c in expected_concepts if c.lower() in candidate_transcript.lower()]
        missing = [c for c in expected_concepts if c not in matched]
        score = min(90.0, max(20.0, (len(matched) / max(1, len(expected_concepts))) * 80.0 + (10 if word_count > 30 else 0)))
        return {
            "accuracy_score": round(score, 1),
            "verdict": "partially_correct" if score >= 50 else "superficial",
            "concepts_covered": matched,
            "concepts_missing": missing,
            "depth_rating": "adequate" if word_count > 40 else "surface",
            "fluff_detected": False,
            "teleprompter_speech_flag": False,
            "hr_summary": f"Candidate addressed {len(matched)} of {len(expected_concepts)} key concepts.",
            "suggested_followup": f"Can you elaborate on how you implement {missing[0] if missing else 'the edge cases'}?",
        }
