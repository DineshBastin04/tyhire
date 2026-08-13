import enum
import uuid

from sqlalchemy import Column, String, Integer, JSON, DateTime, ForeignKey, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship

from app.db.session import Base


class BatchStatus(str, enum.Enum):
    pending = "pending"
    processing = "processing"
    completed = "completed"
    failed = "failed"


class BulkUploadBatch(Base):
    __tablename__ = "bulk_upload_batches"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    job_id = Column(UUID(as_uuid=True), ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False)
    batch_type = Column(String, nullable=False)  # "zip" | "csv"
    status = Column(String, nullable=False, default="pending")  # "pending" | "processing" | "completed" | "failed"

    total_count = Column(Integer, default=0)
    processed_count = Column(Integer, default=0)
    failed_count = Column(Integer, default=0)
    error_log = Column(JSON, default=list)  # list of {"row": int, "identifier": str, "error": str}

    uploaded_by_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    completed_at = Column(DateTime(timezone=True), nullable=True)

    job = relationship("Job")
    uploader = relationship("User")
