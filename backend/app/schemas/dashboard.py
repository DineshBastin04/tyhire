from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel


class JobCounts(BaseModel):
    active: int
    archived: int


class CandidateCounts(BaseModel):
    # Active (non-archived) candidates only — archived rows are kept for audit but are off the
    # live board, so they'd distort every "how big is my pipeline right now" number.
    total_active: int
    # Effective-bucket distribution (HR override wins over the AI bucket), excluding rows with
    # no bucket yet (e.g. processing failures), which are surfaced separately below.
    approved: int
    review: int
    declined: int
    # The actionable pile: AI said "review" and no HR has decided yet (no override).
    needs_review: int
    processing_failed: int
    duplicates: int


class InterviewCounts(BaseModel):
    # Not yet completed (scheduled / identity_pending / in_progress).
    pending: int
    completed: int
    # Completed sessions still flagged for a human: integrity score flagged OR an unresolved
    # identity mismatch. Mirrors GET /interviews/review/queue exactly.
    awaiting_review: int


class RecentCandidate(BaseModel):
    id: str
    full_name: Optional[str]
    job_id: str
    job_title: Optional[str]
    bucket: Optional[str]  # effective bucket (override wins)
    fit_score: Optional[float]
    created_at: Optional[datetime]


class RecentActivity(BaseModel):
    actor: str
    action: str
    detail: Any = None
    created_at: Optional[datetime]


class DashboardSummary(BaseModel):
    jobs: JobCounts
    candidates: CandidateCounts
    interviews: InterviewCounts
    recent_candidates: list[RecentCandidate]
    recent_activity: list[RecentActivity]
