import enum
import uuid

from sqlalchemy import Column, String, Text, Enum, JSON, DateTime, Integer, Float, Boolean, func
from sqlalchemy.dialects.postgresql import UUID

from app.db.session import Base


class JobLevel(str, enum.Enum):
    fresher = "fresher"
    experienced = "experienced"


class WorkMode(str, enum.Enum):
    remote = "remote"
    hybrid = "hybrid"
    onsite = "onsite"


class Job(Base):
    __tablename__ = "jobs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    title = Column(String, nullable=False)
    jd_text = Column(Text, nullable=False)
    required_skills = Column(JSON, default=list)
    level = Column(Enum(JobLevel), nullable=False, default=JobLevel.experienced)
    work_mode = Column(Enum(WorkMode), nullable=False, default=WorkMode.onsite)

    # Knockout rules (any left null is skipped during filtering). Location is additionally
    # skipped outright for remote roles regardless of allowed_locations — see knockout.py.
    min_years_experience = Column(Integer, nullable=True)
    allowed_locations = Column(JSON, default=list)
    max_notice_period_days = Column(Integer, nullable=True)
    salary_band_min = Column(Integer, nullable=True)
    salary_band_max = Column(Integer, nullable=True)

    # Triage thresholds (0-100)
    approve_threshold = Column(Integer, default=75)
    decline_threshold = Column(Integer, default=40)

    # Per-category weights the deterministic overall fit_score is computed from
    # (services/scoring.py) — must sum to 1.0, validated at job create/update time.
    weight_skills = Column(Float, default=0.25)
    weight_experience = Column(Float, default=0.25)
    weight_education = Column(Float, default=0.25)
    weight_certifications = Column(Float, default=0.25)

    # Opt-in per-job: hard-blocks interview start until the desktop probe (background-app +
    # external-display monitor) has checked in. Off by default — many candidates use
    # locked-down corporate laptops with no rights to run it at all.
    require_desktop_probe = Column(Boolean, default=False)

    # Same archive-then-hard-delete pattern as Candidate — protects against accidental
    # permanent loss of a job's scoring history/config.
    archived = Column(Boolean, default=False)
    archived_reason = Column(Text, nullable=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now())
