import json
from datetime import date

from app.models.job import Job, JobLevel
from app.services import ai_cache
from app.services.experience import analyze_experience
from app.services.openai_client import MODEL, call_tool

CATEGORIES = ("skills", "experience", "education", "certifications", "communication")

# Bump whenever the system prompt, the rubric bands, or SCORE_TOOL change meaning. Cached
# scores are keyed on this, so raising it re-scores everything under the new rubric
# instead of serving numbers produced by the old one.
PROMPT_VERSION = 3


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
            "Records per-category fit sub-scores, skill relevancy categorization, and "
            "profession fit analysis for a candidate against a job — each independently "
            "explainable rather than one opaque overall number."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "skills_score": _subscore_schema("required/preferred technical & role skills match"),
                "experience_score": _subscore_schema("work history, tenure, role progression"),
                "education_score": _subscore_schema("degree relevance, grades, coursework"),
                "certifications_score": _subscore_schema("relevant certifications and credentials"),
                # Banded deliberately. This category asks about *written* quality, but the
                # model is handed the parsed profile, not the resume prose — so without
                # anchors it was scoring on an impression it can barely observe, and the
                # same candidate landed on 75 one run and 90 the next. The bands below
                # tie each value to something actually present in the profile, so the
                # score is reproducible instead of a coin flip between two plausible ones.
                "communication_score": _subscore_schema(
                    "clarity and substance of how the candidate documented their own work, "
                    "judged ONLY from the structured profile provided. Apply these bands "
                    "mechanically and pick the single best fit: "
                    "90-100 = summary and role entries both state concrete scope and "
                    "measurable impact; "
                    "75-89 = clear, well-structured entries describing responsibilities, "
                    "but impact is mostly unquantified; "
                    "60-74 = entries are present but terse or generic (titles and dates "
                    "with little description); "
                    "40-59 = sparse or inconsistent documentation, gaps in basic detail; "
                    "0-39 = profile is largely empty or unintelligible. "
                    "Do not infer spoken communication ability — it is not observable here."
                ),
                "skills_breakdown": {
                    "type": "object",
                    "description": "Granular classification of candidate skills against JD requirements.",
                    "properties": {
                        "relevant_skills": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Skills on candidate resume that directly match and fulfill JD requirements.",
                        },
                        "missing_critical_skills": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Critical/required skills mandated by JD that candidate lacks.",
                        },
                        "irrelevant_skills": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Skills listed on resume that are irrelevant or out-of-scope for this role.",
                        },
                    },
                    "required": ["relevant_skills", "missing_critical_skills", "irrelevant_skills"],
                },
                "profession_fit": {
                    "type": "object",
                    "description": "Assessment of candidate's profession alignment, seniority ladder, and industry domain experience.",
                    "properties": {
                        "seniority_match": {
                            "type": "string",
                            "description": "Evaluation of whether candidate seniority aligns with role (e.g. 'Strong Senior match with 5+ yrs relevant tenure').",
                        },
                        "domain_alignment": {
                            "type": "string",
                            "description": "Relevance of candidate industry/domain background (e.g. 'Direct FinTech / SaaS experience').",
                        },
                        "career_trajectory_score": {
                            "type": "number",
                            "description": "0-100 score on career trajectory, title consistency, and growth.",
                        },
                        "verdict": {
                            "type": "string",
                            "enum": ["aligned", "partial", "misaligned"],
                            "description": "Overall professional trajectory verdict.",
                        },
                        "insights": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "1-3 concise bullet points on profession & career fit.",
                        },
                    },
                    "required": [
                        "seniority_match",
                        "domain_alignment",
                        "career_trajectory_score",
                        "verdict",
                        "insights",
                    ],
                },
            },
            "required": [f"{c}_score" for c in CATEGORIES] + ["skills_breakdown", "profession_fit"],
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


def _with_defaults(value, defaults: dict) -> dict:
    """Fills in anything the model left out or returned as null.

    Written this way because `dict.get(key, default)` does NOT cover the case that actually
    happens: the model emits the key with an explicit null, and `.get` dutifully returns
    that null instead of the default. That is precisely how `list(entry.get("reasons", []))`
    became "'NoneType' object is not iterable" on real uploads. The per-key pass matters for
    the same reason — a present-but-null `relevant_skills` inside an otherwise fine object
    would still reach the UI and break rendering there instead.
    """
    merged = dict(defaults)
    if isinstance(value, dict):
        for key, fallback in defaults.items():
            got = value.get(key)
            merged[key] = fallback if got is None else got
        # Keep anything extra the model volunteered; only the known keys are defaulted.
        for key, got in value.items():
            if key not in merged and got is not None:
                merged[key] = got
    return merged


def _redact_for_scoring(profile: dict) -> dict:
    """Strips identity fields the scoring model never needs. Fit-scoring only ever reasons
    about skills/experience/education, so there's no reason it should see who the candidate
    is — this converts 'the model was told not to use the name' into 'the model structurally
    couldn't,' which matters if a score is ever challenged for bias."""
    return {k: v for k, v in profile.items() if k not in ("full_name", "email", "phone")}


def _experience_brief(exp: dict, today: date) -> str:
    """States the experience total as a fact, so the model never does the date arithmetic.

    It cannot do that arithmetic reliably, and the way it fails is the problem. A resume
    says "Nov 2023 - Present" and carries no date of its own, so "Present" only means
    something against a date the model has not been given. Left to fill that in, it uses
    whatever year it takes the present to be — its training cutoff — and reports a span
    short by however stale that is, with a confident "limited tenure" to match. Handing it
    the finished number removes the guess rather than asking for a better one.

    analyze_experience already does this properly: whole months, concurrent roles counted
    once, nothing counted past today. This only puts its answer into words.
    """
    computed = exp["computed_years"]
    claimed = exp["claimed_years"]

    if computed is None:
        if claimed is None:
            return (
                "Measured professional experience: the resume states no total and its "
                "employment dates could not be read. Judge experience from the roles "
                "themselves, and say so, rather than assuming zero."
            )
        return (
            f"Measured professional experience: the employment dates could not be read, so "
            f"use the resume's own stated total of {claimed} year(s)."
        )

    lines = [
        f"Measured professional experience: {computed} year(s) in total, computed from the "
        f"employment dates up to {today.isoformat()}. Use this figure as given; do not "
        f"recompute it from the dates."
    ]
    if exp["currently_employed"]:
        lines.append("The candidate is still in their most recent role.")
    if exp["approximate"]:
        lines.append("Some roles gave only a year, so the total is approximate.")
    if exp["unparsed_roles"]:
        lines.append(
            "Roles whose dates could not be read, and so are not in that total: "
            + ", ".join(exp["unparsed_roles"])
            + "."
        )
    if exp["gaps"]:
        lines.append(
            "Employment gaps: "
            + "; ".join(
                f"{g['start']} to {g['end']} ({g['months']} months"
                + (", still open)" if g["ongoing"] else ")")
                for g in exp["gaps"]
            )
            + "."
        )
    if claimed is not None and exp["discrepancy_years"]:
        lines.append(
            f"The resume itself claims {claimed} year(s); the measured figure above is the "
            f"one to score on."
        )
    return "\n".join(lines)


def score_candidate(
    profile: dict, job: Job, today: date | None = None
) -> tuple[float, float, float, list[str], dict, dict, dict]:
    """Returns (fit_score, technical_score, communication_score, all_reasons, breakdown, skills_breakdown, profession_fit).

    The model produces the five category sub-scores along with skill relevancy and profession fit in
    a single unified tool call. The overall fit_score and technical_score are computed deterministically
    from those sub-scores normalized by the active weights on the Job, preserving full auditability.
    """
    today = today or date.today()
    redacted = _redact_for_scoring(profile)
    experience_brief = _experience_brief(analyze_experience(profile, today=today), today)
    guidance = FRESHER_GUIDANCE if job.level == JobLevel.fresher else EXPERIENCED_GUIDANCE
    system = (
        "You are an explainable resume-screening scorer for an ATS. Score each category "
        "strictly against the JD's stated criteria, not generic 'good candidate' impressions. "
        "Classify skills into relevant, missing critical, and irrelevant/extraneous skills. "
        "Evaluate profession alignment, seniority ladder, and industry domain fit. "
        "Every reason must be traceable to either the JD or the candidate profile provided. "
        "Apply the rubric mechanically: the same profile and JD must always produce the "
        "same sub-scores, so where a category's description defines score bands, choose the "
        "band the evidence satisfies rather than an overall impression. "
        # Resumes are undated and the profile below is full of open-ended ranges. With no
        # date stated the model supplies its own, which is the year it was trained, and
        # then reads a finished degree as still running and a three-year role as a short one.
        "The user message states the current date; treat it as today and use no other "
        "date. 'Present' and any open-ended range run up to it, and a date range whose end "
        "has already passed is finished, however recent it looks. The professional "
        "experience total has already been measured from the employment dates and is given "
        "to you — score on that figure rather than working it out again. "
        + guidance
    )
    user_content = (
        f"Current date: {today.isoformat()}\n\n"
        f"Job Description:\n{job.jd_text}\n\n"
        f"Required skills: {', '.join(job.required_skills or [])}\n"
        f"Core skills: {', '.join(getattr(job, 'core_skills', []) or [])}\n"
        f"Secondary skills: {', '.join(getattr(job, 'secondary_skills', []) or [])}\n\n"
        f"{experience_brief}\n\n"
        f"Candidate profile (JSON):\n{json.dumps(redacted, indent=2)}"
    )
    # Memoized so that re-uploading the same resume to the same job returns the same
    # sub-scores instead of re-rolling them. The key covers everything the answer depends
    # on — the redacted profile, every JD field in the prompt, the level guidance, the
    # model, and the rubric version — so editing the job or the rubric misses the cache
    # and re-scores, while an identical re-upload cannot drift.
    #
    # Note the weights are deliberately NOT in the key: they are applied in Python below,
    # not by the model, so changing them recomputes the overall fit from the same cached
    # sub-scores rather than paying for an identical call.
    cache_key = ai_cache.make_key(
        "fit_score",
        {
            "profile": redacted,
            "jd_text": job.jd_text,
            "required_skills": list(job.required_skills or []),
            "core_skills": list(getattr(job, "core_skills", []) or []),
            "secondary_skills": list(getattr(job, "secondary_skills", []) or []),
            "level": str(job.level),
            "model": MODEL,
            "prompt_version": PROMPT_VERSION,
            # The two date-dependent inputs. Without them a score worked out today would be
            # served again next year, still asserting the tenure the candidate had when it
            # was first cached. Month granularity keeps an identical re-upload identical
            # within a month — the point of this cache — while letting the figure move when
            # it genuinely has.
            "as_of_month": today.isoformat()[:7],
            "measured_experience": experience_brief,
        },
    )
    result = call_tool(
        system=system,
        user_content=user_content,
        tool=SCORE_TOOL,
        cache_key=cache_key,
        cache_kind="fit_score",
    )

    breakdown: dict = {}
    all_reasons: list[str] = []
    weighted_total = 0.0
    active_weight_sum = 0.0

    tech_categories = ("skills", "experience", "certifications")
    tech_weighted_total = 0.0
    tech_weight_sum = 0.0

    for category in CATEGORIES:
        entry = result.get(f"{category}_score") or {"score": 50, "reasons": []}
        score = float(entry["score"])
        reasons = list(entry.get("reasons") or [])
        breakdown[category] = {"score": score, "reasons": reasons}
        all_reasons.extend(f"[{category}] {r}" for r in reasons)
        weight = getattr(job, f"weight_{category}", None)
        if weight is None:
            weight = 0.0 if category == "communication" else 0.25
        weight = float(weight)
        weighted_total += score * weight
        active_weight_sum += weight

        if category in tech_categories:
            tech_weighted_total += score * weight
            tech_weight_sum += weight

    overall_fit = round(weighted_total / active_weight_sum, 1) if active_weight_sum > 0 else 0.0
    tech_score = (
        round(tech_weighted_total / tech_weight_sum, 1)
        if tech_weight_sum > 0
        else float(breakdown.get("skills", {}).get("score", 0))
    )
    comm_score = float(breakdown.get("communication", {}).get("score", 0))

    skills_breakdown = _with_defaults(
        result.get("skills_breakdown"),
        {
            "relevant_skills": [],
            "missing_critical_skills": [],
            "irrelevant_skills": [],
        },
    )
    profession_fit = _with_defaults(
        result.get("profession_fit"),
        {
            "seniority_match": "Standard match",
            "domain_alignment": "Relevant domain",
            "career_trajectory_score": 75.0,
            "verdict": "aligned",
            "insights": [],
        },
    )

    return (
        overall_fit,
        tech_score,
        comm_score,
        all_reasons,
        breakdown,
        skills_breakdown,
        profession_fit,
    )
