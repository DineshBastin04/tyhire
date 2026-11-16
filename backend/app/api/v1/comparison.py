import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.api.v1.auth import require_hr_auth
from app.core.config import settings
from app.db.session import get_db
from app.models.candidate import Candidate
from app.models.interview import InterviewSession
from app.models.job import Job
from app.models.l1_screening import L1PhoneScreening
from app.schemas.comparison import (
    AIComparison,
    CandidateCompareRequest,
    CandidateComparisonResponse,
    ComparisonCandidateAnalysis,
    ComparisonDifferentiator,
    ComparisonInterview,
    ComparisonL1,
    ComparisonScores,
    ComparisonTableRow,
    JobRef,
)
from app.services import candidate_comparison as cmp

logger = logging.getLogger(__name__)

# prefix="/jobs" mirrors jobs.py; the full path /jobs/{job_id}/candidates/compare is distinct
# from candidates.py's /jobs/{job_id}/candidates, so there's no route collision.
router = APIRouter(prefix="/jobs", tags=["comparison"], dependencies=[Depends(require_hr_auth)])


def _effective_fit(candidate: Candidate) -> float | None:
    if candidate.fit_score is None:
        return None
    return max(0.0, min(100.0, candidate.fit_score + (candidate.manual_score_adjustment or 0)))


def _completeness(candidate: Candidate, l1: L1PhoneScreening | None, interview: InterviewSession | None) -> list[str]:
    missing: list[str] = []
    if candidate.fit_score is None:
        missing.append("AI fit score")
    if not (candidate.parsed_profile or {}).get("skills") and not (candidate.skills_breakdown or {}).get(
        "relevant_skills"
    ):
        missing.append("Parsed skills")
    if not (candidate.parsed_profile or {}).get("experience"):
        missing.append("Work experience")
    if l1 is None:
        missing.append("L1 phone screening")
    if interview is None or (interview.status and interview.status.value != "completed"):
        missing.append("Completed interview")
    if candidate.processing_failed:
        missing.append("Resume processing failed")
    return missing


@router.post("/{job_id}/candidates/compare", response_model=CandidateComparisonResponse)
def compare_candidates(
    job_id: uuid.UUID,
    payload: CandidateCompareRequest,
    db: Session = Depends(get_db),
):
    """Compare several candidates of one job with an advisory AI analysis plus a factual table
    of their existing scores/decisions. Strictly read-only — no candidate, interview, score, or
    bucket is ever modified, and nothing is written to the database."""
    job = db.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    # De-duplicate while preserving the recruiter's selection order.
    unique_ids: list[uuid.UUID] = list(dict.fromkeys(payload.candidate_ids))
    if len(unique_ids) < 2:
        raise HTTPException(status_code=400, detail="Select at least two distinct candidates to compare.")
    if len(unique_ids) > settings.comparison_max_candidates:
        raise HTTPException(
            status_code=400,
            detail=(
                f"You can compare at most {settings.comparison_max_candidates} candidates at once "
                f"(you selected {len(unique_ids)}). Deselect some and try again."
            ),
        )

    # One bounded query, scoped to this job — the real authorization boundary here is job
    # membership. (TyHire has no per-recruiter/org ownership model; see PROJECT_NOTES.)
    rows = (
        db.query(Candidate)
        .filter(Candidate.job_id == job_id, Candidate.id.in_(unique_ids))
        .all()
    )
    by_id = {c.id: c for c in rows}
    missing = [cid for cid in unique_ids if cid not in by_id]
    if missing:
        # Don't disclose whether these IDs exist under some other job — just that they're not
        # valid for this one.
        raise HTTPException(
            status_code=400,
            detail="One or more selected candidates do not belong to this job.",
        )

    candidates = [by_id[cid] for cid in unique_ids]  # request order

    # Bulk-fetch L1 screenings and interviews for all candidates at once — no per-candidate
    # round trips.
    l1_rows = (
        db.query(L1PhoneScreening).filter(L1PhoneScreening.candidate_id.in_(unique_ids)).all()
    )
    interview_rows = (
        db.query(InterviewSession).filter(InterviewSession.candidate_id.in_(unique_ids)).all()
    )
    l1_by_cand: dict[uuid.UUID, list[L1PhoneScreening]] = {}
    for s in l1_rows:
        l1_by_cand.setdefault(s.candidate_id, []).append(s)
    iv_by_cand: dict[uuid.UUID, list[InterviewSession]] = {}
    for s in interview_rows:
        if s.candidate_id is not None:
            iv_by_cand.setdefault(s.candidate_id, []).append(s)

    ordered: list[tuple[str, Candidate]] = []
    table: list[ComparisonTableRow] = []
    evidence: list[dict] = []
    picked_l1: dict[uuid.UUID, L1PhoneScreening | None] = {}
    picked_iv: dict[uuid.UUID, InterviewSession | None] = {}

    for idx, candidate in enumerate(candidates, start=1):
        ref = f"c{idx}"
        ordered.append((ref, candidate))
        l1 = cmp.pick_latest_l1(l1_by_cand.get(candidate.id, []))
        interview = cmp.pick_latest_interview(iv_by_cand.get(candidate.id, []))
        picked_l1[candidate.id] = l1
        picked_iv[candidate.id] = interview
        evidence.append(cmp.build_evidence(candidate, ref, l1, interview))

        skills_breakdown = candidate.skills_breakdown or {}
        profile = candidate.parsed_profile or {}
        table.append(
            ComparisonTableRow(
                candidate_id=candidate.id,
                ref=ref,
                full_name=candidate.full_name,
                bucket=candidate.bucket.value if candidate.bucket else None,
                override_bucket=candidate.override_bucket.value if candidate.override_bucket else None,
                scores=ComparisonScores(
                    fit_score=candidate.fit_score,
                    technical_score=candidate.technical_score,
                    communication_score=candidate.communication_score,
                    manual_score_adjustment=candidate.manual_score_adjustment,
                    manual_adjustment_reason=candidate.manual_adjustment_reason,
                    effective_fit_score=_effective_fit(candidate),
                ),
                relevant_skills=cmp._str_list(skills_breakdown.get("relevant_skills"), cap=25, maxlen=60),
                missing_critical_skills=cmp._str_list(
                    skills_breakdown.get("missing_critical_skills"), cap=25, maxlen=60
                ),
                years_experience=cmp._years_experience(profile),
                education=cmp._education(profile),
                certifications=cmp._certifications(profile),
                knockout_failed=bool(candidate.knockout_failed),
                knockout_reasons=cmp._str_list(candidate.knockout_reasons, cap=6),
                l1=(
                    ComparisonL1(
                        overall_l1_score=l1.overall_l1_score,
                        technical_score=l1.technical_score,
                        communication_score=l1.communication_score,
                        verdict=l1.verdict,
                        strengths=cmp._str_list(l1.strengths, cap=6),
                        red_flags=cmp._str_list(l1.red_flags, cap=6),
                        summary=cmp._clip(l1.call_summary, 600),
                    )
                    if l1 is not None
                    else None
                ),
                interview=(
                    _interview_row(interview)
                    if interview is not None
                    else None
                ),
                data_completeness=_completeness(candidate, l1, interview),
            )
        )

    # --- AI analysis: advisory, and allowed to fail without sinking the whole response -------
    ai_available = True
    ai_error: str | None = None
    analysis_per_candidate: list[ComparisonCandidateAnalysis] = []
    differentiators: list[ComparisonDifferentiator] = []
    follow_ups: list[str] = []
    overall_summary = ""
    conclusion = ""

    try:
        parsed = cmp.run_ai_comparison(job, ordered, evidence)
        overall_summary = parsed.overall_summary
        conclusion = parsed.conclusion
        follow_ups = parsed.follow_up_questions
        differentiators = [
            ComparisonDifferentiator(criterion=d.criterion, detail=d.detail) for d in parsed.differentiators
        ]
        ref_to_cand = {ref: c for ref, c in ordered}
        analysis_per_candidate = [
            ComparisonCandidateAnalysis(
                candidate_id=ref_to_cand[pc.ref].id,
                ref=pc.ref,
                strengths=pc.strengths,
                gaps=pc.gaps,
                evidence=pc.evidence,
                insufficient_data=pc.insufficient_data,
            )
            for pc in parsed.per_candidate
        ]
    except Exception:  # noqa: BLE001 - AI is advisory; any failure degrades to the factual table
        logger.warning("AI candidate comparison failed for job %s", job_id, exc_info=True)
        ai_available = False
        ai_error = "The AI comparison couldn't be generated right now. The data table below is still accurate — try again in a moment."
        # Still account for every candidate so the UI can render analysis slots.
        analysis_per_candidate = [
            ComparisonCandidateAnalysis(
                candidate_id=c.id, ref=ref, strengths=[], gaps=[], evidence=[], insufficient_data=[]
            )
            for ref, c in ordered
        ]

    return CandidateComparisonResponse(
        job=JobRef(id=job.id, title=job.title),
        generated_at=datetime.now(timezone.utc),
        candidate_count=len(candidates),
        max_candidates=settings.comparison_max_candidates,
        table=table,
        analysis=AIComparison(
            overall_summary=overall_summary,
            per_candidate=analysis_per_candidate,
            differentiators=differentiators,
            follow_up_questions=follow_ups,
            conclusion=conclusion,
        ),
        ai_available=ai_available,
        ai_error=ai_error,
    )


def _interview_row(interview: InterviewSession) -> ComparisonInterview:
    relevant, total = cmp._qa_counts(interview)
    return ComparisonInterview(
        status=interview.status.value if interview.status else None,
        interviewer_decision=interview.interviewer_live_decision,
        qa_relevant_count=relevant,
        qa_total_count=total,
        integrity_needs_review=bool(interview.integrity_needs_review),
        completed_at=interview.completed_at,
    )
