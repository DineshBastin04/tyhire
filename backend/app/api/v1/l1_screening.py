import mimetypes
import os
import uuid

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.api.v1.auth import require_hr_auth
from app.db.session import get_db
from app.models.candidate import Candidate
from app.models.job import Job
from app.models.l1_screening import L1PhoneScreening
from app.models.user import User
from app.schemas.l1_screening import L1PhoneScreeningOut
from app.services import storage
from app.services.l1_phone_screener import process_l1_audio_screening

router = APIRouter(tags=["l1_screening"], dependencies=[Depends(require_hr_auth)])


@router.post("/candidates/{candidate_id}/l1-audio", response_model=L1PhoneScreeningOut)
async def upload_l1_audio(
    candidate_id: uuid.UUID,
    file: UploadFile,
    db: Session = Depends(get_db),
    current_hr_user: dict = Depends(require_hr_auth),
):
    candidate = db.get(Candidate, candidate_id)
    if not candidate:
        raise HTTPException(status_code=404, detail="Candidate not found")

    job = db.get(Job, candidate.job_id) if candidate.job_id else None
    uploader = db.query(User).filter(User.id == current_hr_user["user_id"]).first()

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Uploaded audio file is empty.")

    # Save audio encrypted-at-rest via storage.py
    try:
        relative_path = storage.save_file("l1_recordings", file.filename or "recording.mp3", content)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Failed to save audio recording: {exc}")

    abs_path = storage.absolute_path(relative_path)

    try:
        # Run Whisper transcription, tone analysis & structured evaluation
        analysis = process_l1_audio_screening(
            audio_path=abs_path,
            job=job,
            candidate_name=candidate.full_name or candidate.email or "Candidate",
        )
    except Exception as exc:
        # Cleanup uploaded file if processing failed catastrophically
        try:
            os.remove(abs_path)
        except OSError:
            pass
        raise HTTPException(status_code=500, detail=f"Failed to analyze L1 phone screening: {exc}")

    screening = L1PhoneScreening(
        candidate_id=candidate.id,
        job_id=candidate.job_id,
        audio_file_path=relative_path,
        audio_duration_seconds=analysis.get("audio_duration_seconds"),
        is_stereo_split=analysis.get("is_stereo_split", False),
        transcript=analysis.get("transcript"),
        transcript_segments=analysis.get("transcript_segments", []),
        technical_score=analysis.get("technical_score"),
        communication_score=analysis.get("communication_score"),
        overall_l1_score=analysis.get("overall_l1_score"),
        verdict=analysis.get("verdict", "recommend_l1"),
        call_summary=analysis.get("call_summary"),
        extracted_details=analysis.get("extracted_details", {}),
        strengths=analysis.get("strengths", []),
        red_flags=analysis.get("red_flags", []),
        next_steps=analysis.get("next_steps", []),
        voice_tone_notes=analysis.get("voice_tone_notes", {}),
        uploaded_by_user_id=uploader.id if uploader else None,
    )

    db.add(screening)
    db.commit()
    db.refresh(screening)
    screening.uploaded_by_email = uploader.email if uploader else None
    return screening


@router.get("/candidates/{candidate_id}/l1-screening", response_model=list[L1PhoneScreeningOut])
def get_candidate_l1_screenings(
    candidate_id: uuid.UUID,
    db: Session = Depends(get_db),
):
    candidate = db.get(Candidate, candidate_id)
    if not candidate:
        raise HTTPException(status_code=404, detail="Candidate not found")

    screenings = (
        db.query(L1PhoneScreening)
        .filter(L1PhoneScreening.candidate_id == candidate_id)
        .order_by(L1PhoneScreening.created_at.desc())
        .all()
    )
    for s in screenings:
        s.uploaded_by_email = s.uploader.email if s.uploader else None
    return screenings


@router.get("/l1-screening/{screening_id}/audio")
def stream_l1_audio(
    screening_id: uuid.UUID,
    db: Session = Depends(get_db),
):
    screening = db.get(L1PhoneScreening, screening_id)
    if not screening or not screening.audio_file_path:
        raise HTTPException(status_code=404, detail="Audio recording not found or has expired.")

    try:
        decrypted_bytes = storage.read_file(screening.audio_file_path)
    except (FileNotFoundError, OSError):
        raise HTTPException(status_code=404, detail="Audio file no longer exists on disk.")

    media_type, _ = mimetypes.guess_type(screening.audio_file_path)
    if not media_type:
        media_type = "audio/mpeg"

    return Response(
        content=decrypted_bytes,
        media_type=media_type,
        headers={"Accept-Ranges": "bytes"},
    )
