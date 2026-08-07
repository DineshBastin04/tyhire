import uuid
from typing import Optional

from pydantic import BaseModel, model_validator

from app.models.job import JobLevel, WorkMode


class JobCreate(BaseModel):
    title: str
    jd_text: str
    required_skills: list[str] = []
    level: JobLevel = JobLevel.experienced
    work_mode: WorkMode = WorkMode.onsite

    min_years_experience: Optional[int] = None
    allowed_locations: list[str] = []
    max_notice_period_days: Optional[int] = None
    salary_band_min: Optional[int] = None
    salary_band_max: Optional[int] = None

    approve_threshold: int = 75
    decline_threshold: int = 40

    weight_skills: float = 0.25
    weight_experience: float = 0.25
    weight_education: float = 0.25
    weight_certifications: float = 0.25

    require_desktop_probe: bool = False

    @model_validator(mode="after")
    def _weights_sum_to_one(self) -> "JobCreate":
        total = self.weight_skills + self.weight_experience + self.weight_education + self.weight_certifications
        if abs(total - 1.0) > 0.01:
            raise ValueError(f"Sub-score weights must sum to 1.0 (got {total})")
        return self


class JobOut(JobCreate):
    id: uuid.UUID
    archived: bool = False
    archived_reason: Optional[str] = None

    class Config:
        from_attributes = True


class JobUpdate(BaseModel):
    title: Optional[str] = None
    jd_text: Optional[str] = None
    required_skills: Optional[list[str]] = None
    level: Optional[JobLevel] = None
    work_mode: Optional[WorkMode] = None

    min_years_experience: Optional[int] = None
    allowed_locations: Optional[list[str]] = None
    max_notice_period_days: Optional[int] = None
    salary_band_min: Optional[int] = None
    salary_band_max: Optional[int] = None

    approve_threshold: Optional[int] = None
    decline_threshold: Optional[int] = None

    weight_skills: Optional[float] = None
    weight_experience: Optional[float] = None
    weight_education: Optional[float] = None
    weight_certifications: Optional[float] = None

    require_desktop_probe: Optional[bool] = None


class JobArchiveRequest(BaseModel):
    reason: str


class JobSuggestRequest(BaseModel):
    title: str
    draft_jd_text: Optional[str] = None


class JobSuggestResponse(BaseModel):
    jd_text: str
    required_skills: list[str]
