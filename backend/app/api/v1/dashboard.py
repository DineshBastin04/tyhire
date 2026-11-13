from fastapi import APIRouter, Depends
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.api.v1.auth import require_hr_auth
from app.db.session import get_db
from app.models.candidate import AuditLog, Bucket, Candidate
from app.models.interview import IdentityCheck, InterviewSession, SessionStatus
from app.models.job import Job
from app.schemas.dashboard import (
    CandidateCounts,
    DashboardSummary,
    InterviewCounts,
    JobCounts,
    RecentActivity,
    RecentCandidate,
)

router = APIRouter(prefix="/dashboard", tags=["dashboard"], dependencies=[Depends(require_hr_auth)])


@router.get("/summary", response_model=DashboardSummary)
def dashboard_summary(db: Session = Depends(get_db)):
    """A single org-wide aggregation for the recruiter home dashboard. Deliberately one endpoint
    doing a handful of grouped COUNT queries rather than the frontend fanning out to /jobs and
    then an N+1 of /jobs/{id}/candidates (there is no cross-job candidate list endpoint). All
    numbers are computed only from data the app reliably has — there is no hire/offer lifecycle,
    so nothing here claims "hires" or "time-to-hire"; see PROJECT_NOTES for that gap."""

    # --- Jobs: active vs archived -------------------------------------------------------------
    active_jobs = db.query(func.count(Job.id)).filter(Job.archived.is_(False)).scalar() or 0
    archived_jobs = db.query(func.count(Job.id)).filter(Job.archived.is_(True)).scalar() or 0

    # --- Candidates (active board only) --------------------------------------------------------
    # Effective bucket = HR override if present, else the AI bucket. A plain filter on COALESCE
    # keeps this dialect-portable (Postgres in prod, SQLite fallback in code).
    effective_bucket = func.coalesce(Candidate.override_bucket, Candidate.bucket)
    active_candidate = Candidate.archived.is_(False)

    def candidate_count(*extra):
        q = db.query(func.count(Candidate.id)).filter(active_candidate)
        for clause in extra:
            q = q.filter(clause)
        return q.scalar() or 0

    candidate_counts = CandidateCounts(
        total_active=candidate_count(),
        approved=candidate_count(effective_bucket == Bucket.approved),
        review=candidate_count(effective_bucket == Bucket.review),
        declined=candidate_count(effective_bucket == Bucket.declined),
        needs_review=candidate_count(
            Candidate.bucket == Bucket.review, Candidate.override_bucket.is_(None)
        ),
        processing_failed=candidate_count(Candidate.processing_failed.is_(True)),
        duplicates=candidate_count(Candidate.is_duplicate_of.isnot(None)),
    )

    # --- Interviews ----------------------------------------------------------------------------
    pending_interviews = (
        db.query(func.count(InterviewSession.id))
        .filter(
            InterviewSession.status.in_(
                [
                    SessionStatus.scheduled,
                    SessionStatus.identity_pending,
                    SessionStatus.in_progress,
                ]
            )
        )
        .scalar()
        or 0
    )
    completed_interviews = (
        db.query(func.count(InterviewSession.id))
        .filter(InterviewSession.status == SessionStatus.completed)
        .scalar()
        or 0
    )

    # Same predicate as GET /interviews/review/queue, so the dashboard count can never disagree
    # with the list the recruiter opens from it.
    unresolved_identity_mismatch = db.query(IdentityCheck.session_id).filter(
        IdentityCheck.needs_human_review.is_(True),
        IdentityCheck.cleared_by_hr.is_(False),
    )
    awaiting_review = (
        db.query(func.count(InterviewSession.id))
        .filter(
            or_(
                InterviewSession.integrity_needs_review.is_(True),
                InterviewSession.id.in_(unresolved_identity_mismatch),
            )
        )
        .scalar()
        or 0
    )

    interview_counts = InterviewCounts(
        pending=pending_interviews,
        completed=completed_interviews,
        awaiting_review=awaiting_review,
    )

    # --- Recent candidates (newest applications on the active board) ---------------------------
    recent_rows = (
        db.query(Candidate, Job.title)
        .outerjoin(Job, Candidate.job_id == Job.id)
        .filter(active_candidate)
        .order_by(Candidate.created_at.desc())
        .limit(6)
        .all()
    )
    recent_candidates = [
        RecentCandidate(
            id=str(cand.id),
            full_name=cand.full_name,
            job_id=str(cand.job_id),
            job_title=job_title,
            bucket=(cand.override_bucket or cand.bucket).value
            if (cand.override_bucket or cand.bucket)
            else None,
            fit_score=cand.fit_score,
            created_at=cand.created_at,
        )
        for cand, job_title in recent_rows
    ]

    # --- Recent activity (audit trail) ---------------------------------------------------------
    activity_rows = (
        db.query(AuditLog).order_by(AuditLog.created_at.desc()).limit(8).all()
    )
    recent_activity = [
        RecentActivity(
            actor=row.actor,
            action=row.action,
            detail=row.detail,
            created_at=row.created_at,
        )
        for row in activity_rows
    ]

    return DashboardSummary(
        jobs=JobCounts(active=active_jobs, archived=archived_jobs),
        candidates=candidate_counts,
        interviews=interview_counts,
        recent_candidates=recent_candidates,
        recent_activity=recent_activity,
    )
