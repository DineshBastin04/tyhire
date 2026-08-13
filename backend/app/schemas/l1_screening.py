import uuid
from datetime import datetime
from typing import Optional, Any
from pydantic import BaseModel


class L1PhoneScreeningOut(BaseModel):
    id: uuid.UUID
    candidate_id: uuid.UUID
    job_id: Optional[uuid.UUID]
    audio_file_path: Optional[str]
    audio_duration_seconds: Optional[float]
    is_stereo_split: bool
    transcript: Optional[str]
    transcript_segments: list[dict[str, Any]]
    technical_score: Optional[float]
    communication_score: Optional[float]
    overall_l1_score: Optional[float]
    verdict: str
    call_summary: Optional[str]
    extracted_details: dict[str, Any]
    strengths: list[str]
    red_flags: list[str]
    next_steps: list[str]
    voice_tone_notes: dict[str, Any]
    uploaded_by_user_id: Optional[uuid.UUID]
    uploaded_by_email: Optional[str] = None
    created_at: Optional[datetime]

    class Config:
        from_attributes = True
