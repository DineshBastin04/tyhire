import uuid
from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, Field


class CandidateCompareRequest(BaseModel):
    """Only the candidate IDs are accepted from the client — the job comes from the path, and
    every other fact (scores, buckets, skills, L1, interview) is read server-side from the
    persisted records, never trusted from the request body."""

    candidate_ids: list[uuid.UUID] = Field(
        min_length=2,
        description="At least two distinct candidate IDs, all belonging to the path job.",
    )


# --------------------------------------------------------------------------------------------
# Factual comparison table — built entirely server-side from persisted data. Nothing here is
# produced by the AI model; these are the existing scores/decisions the recruiter already owns.
# --------------------------------------------------------------------------------------------
class ComparisonScores(BaseModel):
    fit_score: Optional[float]
    technical_score: Optional[float]
    communication_score: Optional[float]
    manual_score_adjustment: Optional[int]
    manual_adjustment_reason: Optional[str]
    # fit_score + manual adjustment, clamped 0-100 — the same effective number the buckets and
    # the consolidated report use, surfaced so the table and the board can never disagree.
    effective_fit_score: Optional[float]


class ComparisonL1(BaseModel):
    overall_l1_score: Optional[float]
    technical_score: Optional[float]
    communication_score: Optional[float]
    verdict: Optional[str]
    strengths: list[str]
    red_flags: list[str]
    summary: Optional[str]


class ComparisonInterview(BaseModel):
    status: Optional[str]
    interviewer_decision: Optional[str]
    # Count of answers judged on-topic vs total, a competence signal — distinct from the
    # integrity/affect signals, which are review-context only and never fed to the AI as a
    # measure of job fit.
    qa_relevant_count: Optional[int]
    qa_total_count: Optional[int]
    # Review-context ONLY. Shown so a recruiter knows a session needs integrity review before
    # relying on it; it is never a competence or ranking input.
    integrity_needs_review: bool
    completed_at: Optional[datetime]


class ComparisonTableRow(BaseModel):
    candidate_id: uuid.UUID
    ref: str  # stable c1..cN label tying this row to the AI analysis entry
    full_name: Optional[str]
    bucket: Optional[str]
    override_bucket: Optional[str]
    scores: ComparisonScores
    relevant_skills: list[str]
    missing_critical_skills: list[str]
    years_experience: Optional[Any]
    education: list[str]
    certifications: list[str]
    knockout_failed: bool
    knockout_reasons: list[str]
    l1: Optional[ComparisonL1]
    interview: Optional[ComparisonInterview]
    # Human-readable list of the evidence sections that are missing for this candidate, so the
    # UI can show gaps honestly instead of implying absence means a negative.
    data_completeness: list[str]


# --------------------------------------------------------------------------------------------
# AI analysis — advisory only. Validated against this schema before it ever leaves the backend.
# --------------------------------------------------------------------------------------------
class ComparisonCandidateAnalysis(BaseModel):
    candidate_id: uuid.UUID
    ref: str
    strengths: list[str]
    gaps: list[str]
    evidence: list[str]
    insufficient_data: list[str]


class ComparisonDifferentiator(BaseModel):
    criterion: str
    detail: str


class AIComparison(BaseModel):
    overall_summary: str
    per_candidate: list[ComparisonCandidateAnalysis]
    differentiators: list[ComparisonDifferentiator]
    follow_up_questions: list[str]
    conclusion: str


class JobRef(BaseModel):
    id: uuid.UUID
    title: str


class CandidateComparisonResponse(BaseModel):
    job: JobRef
    generated_at: datetime
    candidate_count: int
    max_candidates: int
    table: list[ComparisonTableRow]
    analysis: AIComparison
    # False when the AI call failed/timed out or returned something that didn't validate — the
    # factual table is still returned so the comparison is useful, and the UI shows a retry.
    ai_available: bool
    ai_error: Optional[str] = None
