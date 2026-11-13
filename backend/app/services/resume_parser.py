from datetime import date

from app.services import ai_cache
from app.services.openai_client import MODEL, call_tool

PARSE_PARAMETERS = {
    "type": "object",
    "properties": {
        "full_name": {"type": "string"},
        "email": {"type": "string"},
        "phone": {"type": "string"},
        "education": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "degree": {"type": "string"},
                    "institution": {"type": "string"},
                    "year": {"type": "string"},
                    "grade": {"type": "string"},
                    "status": {
                        "type": "string",
                        "enum": ["completed", "in_progress"],
                        "description": (
                            "Decided against the current date given in the user message. "
                            "'completed' when the end year is on or before that date — a "
                            "finished degree does not become in-progress just because it is "
                            "recent. 'in_progress' only when the end year is still in the "
                            "future, or the resume itself says pursuing/expected/ongoing."
                        ),
                    },
                },
            },
        },
        "work_history": {
            "type": "array",
            "description": "Empty for freshers with no work experience — that is expected.",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "company": {"type": "string"},
                    "start_date": {"type": "string"},
                    "end_date": {"type": "string"},
                    "description": {"type": "string"},
                },
            },
        },
        "projects_internships": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "description": {"type": "string"},
                    "technologies": {"type": "array", "items": {"type": "string"}},
                },
            },
        },
        "skills": {"type": "array", "items": {"type": "string"}},
        "certifications": {"type": "array", "items": {"type": "string"}},
        "total_years_experience": {
            "type": "number",
            "description": (
                "The total the resume itself states, if it states one. If it does not, "
                "measure it from the employment dates, counting any open-ended role up to "
                "the current date given in the user message. 0 for freshers with no "
                "professional work history."
            ),
        },
        "current_location": {"type": "string"},
        "notice_period_days": {
            "type": "number",
            "description": (
                "Only if the resume explicitly states a notice period in days. Omit "
                "entirely if not mentioned — do not guess or default to 0."
            ),
        },
        "expected_salary": {
            "type": "number",
            "description": (
                "Only if the resume explicitly states an expected/current salary figure. "
                "Omit entirely if not mentioned — do not guess or default to 0."
            ),
        },
    },
    "required": ["skills", "work_history", "total_years_experience"],
}

PARSE_TOOL = {
    "type": "function",
    "function": {
        "name": "record_resume_profile",
        "description": "Records a structured profile extracted from a resume.",
        "parameters": PARSE_PARAMETERS,
    },
}

SYSTEM_PROMPT = (
    "You extract structured candidate profiles from raw resume text for an ATS. "
    "Be literal — do not infer skills or experience the resume does not state. "
    "If the candidate is a fresher/student with no jobs, work_history should be an empty list "
    "and total_years_experience should be 0; this is a normal, valid profile, not missing data. "
    # A resume carries no date of its own, so "Present" means nothing without one, and a
    # model left to supply that date falls back on whatever year it believes it is — its
    # training cutoff, not today. The error is silent and only ever runs one way: every
    # open-ended role comes out truncated and every recently-finished course still running.
    # The date is given in the user message so none of it has to be guessed.
    "The user message states the current date. Treat that as today and use no other date. "
    "'Present', 'Current' and 'Ongoing' all run up to it. A date range whose end has "
    "already passed is finished, however recent it looks."
)


# Bump when SYSTEM_PROMPT or PARSE_TOOL changes meaning, so previously cached profiles
# are not served under a prompt that would now extract something different.
PROMPT_VERSION = 2


def parse_resume(resume_text: str, today: date | None = None) -> dict:
    """Memoized on the resume text: the same file re-uploaded must parse to the same
    profile, or the score computed from it drifts even when scoring itself is pinned."""
    today = today or date.today()
    as_of = today.isoformat()
    key = ai_cache.make_key(
        "resume_parse",
        {
            "text": resume_text,
            "model": MODEL,
            "prompt_version": PROMPT_VERSION,
            # Month, not day. Every span a profile carries is whole months, so the month is
            # the coarsest anchor that can still change an answer: the same resume twice in
            # one month parses identically, which is the determinism this cache exists for,
            # while next month it is re-read so an open-ended role is measured to the new
            # date instead of being served a span that has quietly aged.
            "as_of_month": as_of[:7],
        },
    )
    return call_tool(
        system=SYSTEM_PROMPT,
        user_content=f"Current date: {as_of}\n\nResume text:\n\n{resume_text}",
        tool=PARSE_TOOL,
        cache_key=key,
        cache_kind="resume_parse",
    )
