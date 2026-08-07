import json

from app.models.job import Job, JobLevel
from app.services.openai_client import call_tool

CATEGORIES = ("skills", "experience", "education", "certifications")


def _subscore_schema(criterion: str) -> dict:
    return {
        "type": "object",
        "description": f"0-100 fit score for {criterion}.",
        "properties": {
            "score": {"type": "number"},
            "reasons": {
                "type": "array",
                "description": (
                    "Short, specific reasons citing the JD's actual criteria, e.g. "
                    "'JD required 3+ yrs cloud, candidate has 0 ✗' or "
                    "'Built a Kafka-based project in final year ✓'."
                ),
                "items": {"type": "string"},
            },
        },
        "required": ["score", "reasons"],
    }


SCORE_TOOL = {
    "type": "function",
    "function": {
        "name": "record_fit_subscores",
        "description": (
            "Records per-category fit sub-scores for a candidate against a job — each "
            "independently explainable, rather than one opaque overall number."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "skills_score": _subscore_schema("required/preferred skills match"),
                "experience_score": _subscore_schema("work history, tenure, role progression"),
                "education_score": _subscore_schema("degree relevance, grades, coursework"),
                "certifications_score": _subscore_schema("relevant certifications and credentials"),
            },
            "required": [f"{c}_score" for c in CATEGORIES],
        },
    },
}

FRESHER_GUIDANCE = (
    "This job is marked FRESHER/entry-level. The candidate has no required prior work history. "
    "Weigh education (degree relevance, grades), academic projects, internships, certifications, "
    "and demonstrated skills from coursework/projects over work tenure. Do not penalize for having "
    "zero years of professional experience if the JD does not require it."
)

EXPERIENCED_GUIDANCE = (
    "This job is marked EXPERIENCED. Weigh work history, tenure, role progression, and demonstrated "
    "on-the-job use of required skills over academic background alone."
)


def _redact_for_scoring(profile: dict) -> dict:
    """Strips identity fields the scoring model never needs. Fit-scoring only ever reasons
    about skills/experience/education, so there's no reason it should see who the candidate
    is — this converts "the model was told not to use the name" into "the model structurally
    couldn't," which matters if a score is ever challenged for bias."""
    return {k: v for k, v in profile.items() if k not in ("full_name", "email", "phone")}


def score_candidate(profile: dict, job: Job) -> tuple[float, list[str], dict]:
    """Returns (overall fit_score, flattened reasons, per-category breakdown).

    The model only produces the four category sub-scores; the overall score is computed
    here deterministically from those sub-scores using the job's configured weights, rather
    than trusting a second LLM-generated overall number — that's what keeps it auditable:
    "why is the overall 72" is traceable to four visible numbers, not another black box.
    """
    guidance = FRESHER_GUIDANCE if job.level == JobLevel.fresher else EXPERIENCED_GUIDANCE
    system = (
        "You are an explainable resume-screening scorer for an ATS. Score each category "
        "strictly against the JD's stated criteria, not generic 'good candidate' impressions. "
        "Every reason must be traceable to either the JD or the candidate profile provided. "
        + guidance
    )
    user_content = (
        f"Job Description:\n{job.jd_text}\n\n"
        f"Required skills: {', '.join(job.required_skills or [])}\n\n"
        f"Candidate profile (JSON):\n{json.dumps(_redact_for_scoring(profile), indent=2)}"
    )
    result = call_tool(system=system, user_content=user_content, tool=SCORE_TOOL)

    breakdown: dict = {}
    all_reasons: list[str] = []
    weighted_total = 0.0

    for category in CATEGORIES:
        entry = result[f"{category}_score"]
        score = float(entry["score"])
        reasons = list(entry["reasons"])
        breakdown[category] = {"score": score, "reasons": reasons}
        all_reasons.extend(f"[{category}] {r}" for r in reasons)
        weight = getattr(job, f"weight_{category}", None) or 0.25
        weighted_total += score * weight

    return round(weighted_total, 1), all_reasons, breakdown
