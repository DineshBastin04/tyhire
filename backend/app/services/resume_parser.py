from app.services.openai_client import call_tool

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
            "description": "0 for freshers with no professional work history.",
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
    "and total_years_experience should be 0; this is a normal, valid profile, not missing data."
)


def parse_resume(resume_text: str) -> dict:
    return call_tool(
        system=SYSTEM_PROMPT,
        user_content=f"Resume text:\n\n{resume_text}",
        tool=PARSE_TOOL,
    )
