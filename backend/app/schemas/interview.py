import uuid
from typing import Optional, Any

from pydantic import BaseModel

from app.models.interview import SessionStatus, SignalType


class SessionCreate(BaseModel):
    candidate_name: str
    job_id: Optional[uuid.UUID] = None
    candidate_id: Optional[uuid.UUID] = None


class SessionOut(BaseModel):
    id: uuid.UUID
    candidate_name: str
    job_id: Optional[uuid.UUID]
    join_token: str
    video_room_token: str
    status: SessionStatus
    integrity_score: Optional[float]
    integrity_needs_review: bool
    recording_file_path: Optional[str] = None
    transcript: Optional[str] = None
    transcript_status: Optional[str] = None
    interviewer_join_token: Optional[str] = None
    interviewer_recording_file_path: Optional[str] = None
    interviewer_transcript: Optional[str] = None
    interviewer_transcript_status: Optional[str] = None
    merged_transcript: Optional[str] = None
    qa_analysis: Optional[dict[str, Any]] = None
    voice_tone_analysis: Optional[dict[str, Any]] = None
    facial_affect_analysis: Optional[dict[str, Any]] = None
    sentiment_trend: Optional[dict[str, Any]] = None
    candidate_ip: Optional[str] = None
    interviewer_live_decision: Optional[str] = None
    interviewer_live_notes: Optional[str] = None
    # Populated only by the candidate/interviewer token-lookup endpoints (freshly minted
    # per fetch, never stored) — absent everywhere else, including every HR-facing
    # endpoint, since HR never joins the call itself. See services/video_provider.py.
    ice_servers: Optional[list[dict]] = None

    class Config:
        from_attributes = True


class IdentityCheckOut(BaseModel):
    id: uuid.UUID
    session_id: uuid.UUID
    liveness_prompt: Optional[str]
    liveness_passed: Optional[bool]
    match_confidence: Optional[float]
    match_verdict: Optional[str]
    needs_human_review: bool
    cleared_by_hr: bool
    cleared_reason: Optional[str]

    class Config:
        from_attributes = True


class IdentityCheckOverrideRequest(BaseModel):
    reason: str


class InterviewerDecisionRequest(BaseModel):
    decision: str  # "proceed" | "concern" | "reject"
    notes: Optional[str] = None


class StartSessionResponse(BaseModel):
    started: bool


class SentimentSampleOut(BaseModel):
    session_offset_ms: int
    facial_affect: Optional[dict[str, Any]] = None
    voice_tone: Optional[dict[str, Any]] = None

    class Config:
        from_attributes = True


class SignalEventIn(BaseModel):
    signal_type: SignalType
    session_offset_ms: int
    weight: float = 1.0
    meta: dict[str, Any] = {}


class SignalEventOut(BaseModel):
    signal_type: SignalType
    session_offset_ms: int
    meta: dict[str, Any]

    class Config:
        from_attributes = True


class IntegrityFlagOut(BaseModel):
    id: uuid.UUID
    session_offset_ms: int
    severity: float
    summary: str
    reviewed: bool
    reviewer_decision: Optional[str]
    reviewer_note: Optional[str]

    class Config:
        from_attributes = True


class ReviewDecision(BaseModel):
    decision: str  # "cleared" | "confirmed_issue"
    note: Optional[str] = None
