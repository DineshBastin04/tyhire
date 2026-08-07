from app.services.openai_client import call_tool

SUGGEST_TOOL = {
    "type": "function",
    "function": {
        "name": "record_jd_suggestion",
        "description": "Records a suggested job description and required-skills list for a role.",
        "parameters": {
            "type": "object",
            "properties": {
                "jd_text": {
                    "type": "string",
                    "description": (
                        "A complete, realistic job description: role overview, key "
                        "responsibilities, and requirements. Plain text, no markdown headers."
                    ),
                },
                "required_skills": {
                    "type": "array",
                    "description": "5-12 concrete required/preferred skills, most important first.",
                    "items": {"type": "string"},
                },
            },
            "required": ["jd_text", "required_skills"],
        },
    },
}

FROM_TITLE_PROMPT = (
    "You draft realistic job descriptions for an ATS. Given only a job title, write a "
    "complete JD (role overview, key responsibilities, requirements) and a required-skills "
    "list a recruiter could post today. This is a starting draft the recruiter will edit — "
    "be concrete and realistic for the role, not generic filler."
)

IMPROVE_DRAFT_PROMPT = (
    "You improve an HR-written draft job description for an ATS. Expand and clarify it — "
    "fix vague responsibilities, add missing standard sections if absent, keep everything "
    "the draft already specifies (seniority, must-have tools, tone) rather than replacing it. "
    "Also extract/complete a required-skills list consistent with the (improved) JD. This is "
    "still a draft the recruiter will edit further, not a final posting."
)


def suggest_job_description(title: str, draft_jd_text: str | None) -> dict:
    if draft_jd_text and draft_jd_text.strip():
        system = IMPROVE_DRAFT_PROMPT
        user_content = f"Job title: {title}\n\nExisting draft JD:\n{draft_jd_text}"
    else:
        system = FROM_TITLE_PROMPT
        user_content = f"Job title: {title}"

    return call_tool(system=system, user_content=user_content, tool=SUGGEST_TOOL)
