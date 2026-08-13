import enum
import uuid

from sqlalchemy import Column, String, Text, JSON, DateTime, Float, ForeignKey, Boolean, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship

from app.db.session import Base


class L1Verdict(str, enum.Enum):
    recommend_l1 = "recommend_l1"
    recommend_l2 = "recommend_l1"  # backwards-compatible alias
    hold = "hold"
    decline = "decline"
    senior_review = "senior_review"


class L1PhoneScreening(Base):
    __tablename__ = "l1_phone_screenings"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    candidate_id = Column(
        UUID(as_uuid=True), ForeignKey("candidates.id", ondelete="CASCADE"), nullable=False
    )
    job_id = Column(UUID(as_uuid=True), ForeignKey("jobs.id"), nullable=True)

    # Path to encrypted audio file in storage/l1_recordings
    audio_file_path = Column(String, nullable=True)
    audio_duration_seconds = Column(Float, nullable=True)
    is_stereo_split = Column(Boolean, default=False)

    # Full transcription and timestamped segment list
    transcript = Column(Text, nullable=True)
    transcript_segments = Column(JSON, default=list)

    # Split competency scores (0-100)
    technical_score = Column(Float, nullable=True)
    communication_score = Column(Float, nullable=True)
    overall_l1_score = Column(Float, nullable=True)

    # AI evaluation output
    verdict = Column(String, nullable=False, default="recommend_l1")
    call_summary = Column(Text, nullable=True)
    extracted_details = Column(JSON, default=dict)  # notice_period, salary, location, etc.
    strengths = Column(JSON, default=list)
    red_flags = Column(JSON, default=list)
    next_steps = Column(JSON, default=list)  # Actionable next step recommendations

    # Acoustic vocal tone & confidence from gpt-audio
    voice_tone_notes = Column(JSON, default=dict)

    uploaded_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    candidate = relationship("Candidate")
    job = relationship("Job")
    uploader = relationship("User")
