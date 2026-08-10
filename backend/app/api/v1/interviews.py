import contextlib
import logging
import os
import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    Form,
    Header,
    HTTPException,
    Request,
    UploadFile,
)
from fastapi.responses import StreamingResponse
from starlette.background import BackgroundTask
from sqlalchemy.orm import Session

from app.api.v1.auth import require_admin, require_hr_auth
from app.core.config import settings
from app.db.session import SessionLocal, get_db
from app.models.candidate import AuditLog, Candidate
from app.models.job import Job
from app.models.user import User
from app.models.interview import (
    IdentityCheck,
    IntegrityFlag,
    InterviewSession,
    SentimentSample,
    SessionStatus,
    SignalEvent,
    SignalType,
)
from app.schemas.interview import (
    CandidateJoinSessionOut,
    IdentityCheckOut,
    IdentityCheckOverrideRequest,
    IntegrityFlagOut,
    InterviewerDecisionRequest,
    InterviewerJoinSessionOut,
    ReviewDecision,
    SentimentSampleOut,
    SessionCreate,
    SessionOut,
    SignalEventIn,
    SignalEventOut,
    StartSessionResponse,
)
from app.services import geolocation, integrity, sentiment_aggregate, storage, video_provider
from app.services.audio_extract import extract_audio_wav
from app.services.facial_analysis import analyze_facial_affect
from app.services.identity_check import check_identity_match
from app.services.qa_verification import analyze_qa
from app.services.transcript_merge import merge_transcripts
from app.services.transcription import transcribe_with_segments
from app.services.video_extract import extract_frames
from app.services.voice_tone import analyze_voice_tone

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/interviews", tags=["interviews"])


def require_session_token(
    session_id: uuid.UUID,
    x_interview_token: str = Header(...),
    db: Session = Depends(get_db),
) -> InterviewSession:
    """Candidate-facing endpoints are authorized by the join token, not just session_id —
    session_id is a UUID visible in every response and browser network tab, so it's not a
    secret. Without this check, anyone who saw any session's id could tamper with it."""
    session = db.get(InterviewSession, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if not secrets.compare_digest(session.join_token, x_interview_token):
        raise HTTPException(status_code=403, detail="Invalid interview token")
    # Blocks replaying a finished interview on the same link — this guard sits on every
    # candidate-facing *mutating* endpoint (identity-check, signals, recording-chunk,
    # start, sentiment-sample, complete) since they all depend on this function. The
    # read-only GET /interviews/join/{token} doesn't use this dependency, so revisiting a
    # finished link can still render a friendly "already completed" message instead of a
    # raw 409 — the frontend checks session.status itself for that. /complete is unaffected
    # here: status is still in_progress/identity_pending at the moment it's called, only
    # flipping to completed once that handler finishes.
    if session.status == SessionStatus.completed:
        raise HTTPException(status_code=409, detail="This interview has already been completed.")
    return session


def require_interviewer_token(
    session_id: uuid.UUID,
    x_interviewer_token: str = Header(...),
    db: Session = Depends(get_db),
) -> InterviewSession:
    session = db.get(InterviewSession, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if not session.interviewer_join_token or not secrets.compare_digest(
        session.interviewer_join_token, x_interviewer_token
    ):
        raise HTTPException(status_code=403, detail="Invalid interviewer token")
    return session


# --- HR-facing (require login) ---------------------------------------------------------


@router.post("", response_model=SessionOut, dependencies=[Depends(require_hr_auth)])
def create_session(payload: SessionCreate, db: Session = Depends(get_db)):
    session = InterviewSession(
        candidate_name=payload.candidate_name,
        job_id=payload.job_id,
        candidate_id=payload.candidate_id,
        join_token=secrets.token_urlsafe(16),
        interviewer_join_token=secrets.token_urlsafe(16),
        video_room_token=secrets.token_urlsafe(16),
    )
    db.add(session)
    db.commit()
    db.refresh(session)
    return session


@router.get("/{session_id}", response_model=SessionOut, dependencies=[Depends(require_hr_auth)])
def get_session(session_id: uuid.UUID, db: Session = Depends(get_db)):
    session = db.get(InterviewSession, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


@router.get(
    "/by-candidate/{candidate_id}",
    response_model=list[SessionOut],
    dependencies=[Depends(require_hr_auth)],
)
def list_sessions_for_candidate(candidate_id: uuid.UUID, db: Session = Depends(get_db)):
    """Backs the consolidated candidate final-decision view — a candidate usually has one
    session, but nothing stops re-interviewing, so this returns all of them, newest first."""
    return (
        db.query(InterviewSession)
        .filter(InterviewSession.candidate_id == candidate_id)
        .order_by(InterviewSession.created_at.desc())
        .all()
    )


RANGE_HEADER_RE = re.compile(r"^bytes=(\d*)-(\d*)$")
RECORDING_CHUNK_SIZE = 1024 * 1024  # 1MB


def _iter_file_range(path: str, start: int, end: int):
    """Yields the [start, end] byte range (inclusive) from path in fixed-size chunks —
    never holds more than one chunk in memory, unlike reading the whole file up front."""
    with open(path, "rb") as f:
        f.seek(start)
        remaining = end - start + 1
        while remaining > 0:
            data = f.read(min(RECORDING_CHUNK_SIZE, remaining))
            if not data:
                break
            remaining -= len(data)
            yield data


def _serve_recording(relative_path: str, media_type: str, request: Request) -> StreamingResponse:
    """Streams a (possibly encrypted-at-rest) recording through an authenticated route
    instead of the public static /media mount, with Range support so a <video>/<audio>
    element can seek and start playing before the whole file (up to several hundred MB)
    has downloaded, rather than requiring it in full first.

    decrypted_temp_copy's context manager can't be used with a plain `with` here — the
    StreamingResponse generator below runs *after* this function returns, once Starlette
    is actually sending the body, so the temp file it creates for an encrypted recording
    must outlive this function. Driving it manually and handing its __exit__ to the
    response's background task defers cleanup until the whole response has been sent."""
    ctx = storage.decrypted_temp_copy(relative_path)
    real_path = ctx.__enter__()
    cleanup = BackgroundTask(ctx.__exit__, None, None, None)

    try:
        file_size = os.path.getsize(real_path)
        range_header = request.headers.get("range")

        if range_header:
            match = RANGE_HEADER_RE.match(range_header.strip())
            if not match:
                raise HTTPException(status_code=416, detail="Invalid Range header")
            start = int(match.group(1)) if match.group(1) else 0
            end = int(match.group(2)) if match.group(2) else file_size - 1
            end = min(end, file_size - 1)
            if start > end or start >= file_size:
                raise HTTPException(
                    status_code=416,
                    detail="Range not satisfiable",
                    headers={"Content-Range": f"bytes */{file_size}"},
                )
            return StreamingResponse(
                _iter_file_range(real_path, start, end),
                status_code=206,
                media_type=media_type,
                headers={
                    "Accept-Ranges": "bytes",
                    "Content-Range": f"bytes {start}-{end}/{file_size}",
                    "Content-Length": str(end - start + 1),
                },
                background=cleanup,
            )

        return StreamingResponse(
            _iter_file_range(real_path, 0, file_size - 1),
            media_type=media_type,
            headers={"Accept-Ranges": "bytes", "Content-Length": str(file_size)},
            background=cleanup,
        )
    except Exception:
        cleanup.func(*cleanup.args)
        raise


@router.get(
    "/{session_id}/media/recording",
    dependencies=[Depends(require_hr_auth)],
)
def get_candidate_recording(session_id: uuid.UUID, request: Request, db: Session = Depends(get_db)):
    session = db.get(InterviewSession, session_id)
    if not session or not session.recording_file_path:
        raise HTTPException(status_code=404, detail="No recording available")
    return _serve_recording(session.recording_file_path, "video/webm", request)


@router.get(
    "/{session_id}/media/interviewer-recording",
    dependencies=[Depends(require_hr_auth)],
)
def get_interviewer_recording(session_id: uuid.UUID, request: Request, db: Session = Depends(get_db)):
    session = db.get(InterviewSession, session_id)
    if not session or not session.interviewer_recording_file_path:
        raise HTTPException(status_code=404, detail="No interviewer recording available")
    return _serve_recording(session.interviewer_recording_file_path, "audio/webm", request)


@router.post("/cleanup-expired-media", dependencies=[Depends(require_hr_auth)])
def cleanup_expired_media(db: Session = Depends(get_db)):
    """Deletes raw ID/selfie image files past the retention window, keeping the verdict/
    confidence for audit purposes — not the images themselves. No scheduler exists in this
    POC, so this is HR-triggered rather than automatic; wire it to a cron job for real use."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=settings.identity_media_retention_days)
    expired = (
        db.query(IdentityCheck)
        .filter(IdentityCheck.created_at < cutoff, IdentityCheck.id_document_path.isnot(None))
        .all()
    )

    deleted = 0
    for check in expired:
        for path in (check.id_document_path, check.selfie_path):
            if not path:
                continue
            try:
                os.remove(storage.absolute_path(path))
            except OSError:
                pass
        check.id_document_path = None
        check.selfie_path = None
        db.add(check)
        deleted += 1

    db.commit()
    return {"identity_checks_cleaned": deleted}


@router.get(
    "/review/queue", response_model=list[SessionOut], dependencies=[Depends(require_hr_auth)]
)
def review_queue(db: Session = Depends(get_db)):
    return (
        db.query(InterviewSession)
        .filter(InterviewSession.integrity_needs_review == True)  # noqa: E712
        .order_by(InterviewSession.completed_at.desc())
        .all()
    )


@router.delete("/{session_id}")
def delete_session(
    session_id: uuid.UUID,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """Permanently removes an interview session once it's been reviewed and is no longer
    needed — admin-only, since this deletes the recording, transcripts, and every fused
    integrity flag with no way back. None of the child tables here cascade at the DB level
    (signals/flags/identity-checks/sentiment-samples all reference session_id with no
    ON DELETE), so they're removed explicitly first; the audit trail is kept, just
    detached, same as everywhere else a hard delete happens in this app."""
    session = db.get(InterviewSession, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    db.query(SignalEvent).filter(SignalEvent.session_id == session_id).delete()
    db.query(IntegrityFlag).filter(IntegrityFlag.session_id == session_id).delete()
    db.query(SentimentSample).filter(SentimentSample.session_id == session_id).delete()
    db.query(IdentityCheck).filter(IdentityCheck.session_id == session_id).delete()
    db.query(AuditLog).filter(AuditLog.interview_session_id == session_id).update(
        {"interview_session_id": None}
    )

    db.add(AuditLog(
        actor=f"hr:{admin.email}",
        action="hard_delete_interview_session",
        detail={"session_id": str(session_id), "candidate_name": session.candidate_name},
    ))

    db.delete(session)
    db.commit()

    # Recording, identity photos, and sentiment clips all live under this one prefix —
    # removed after the commit succeeds, mirroring the candidate/job delete file-cleanup
    # pattern elsewhere in this app.
    storage.remove_directory(f"interviews/{session_id}")

    return {"deleted": True}


@router.get(
    "/{session_id}/flags",
    response_model=list[IntegrityFlagOut],
    dependencies=[Depends(require_hr_auth)],
)
def get_flags(session_id: uuid.UUID, db: Session = Depends(get_db)):
    return (
        db.query(IntegrityFlag)
        .filter(IntegrityFlag.session_id == session_id)
        .order_by(IntegrityFlag.session_offset_ms)
        .all()
    )


@router.post(
    "/flags/{flag_id}/decision",
    response_model=IntegrityFlagOut,
    dependencies=[Depends(require_hr_auth)],
)
def decide_flag(
    flag_id: uuid.UUID,
    payload: ReviewDecision,
    db: Session = Depends(get_db),
    current_hr_user: dict = Depends(require_hr_auth),
):
    flag = db.get(IntegrityFlag, flag_id)
    if not flag:
        raise HTTPException(status_code=404, detail="Flag not found")

    flag.reviewed = True
    flag.reviewer_decision = payload.decision
    flag.reviewer_note = payload.note
    db.add(flag)

    db.add(AuditLog(
        interview_session_id=flag.session_id,
        actor=f"hr:{current_hr_user['email']}",
        action="review_flag",
        detail={"decision": payload.decision, "note": payload.note},
    ))

    db.commit()
    db.refresh(flag)
    return flag


# --- Candidate-facing (authorized by join token, no login) -----------------------------


@router.get("/join/{join_token}", response_model=CandidateJoinSessionOut)
def get_session_by_token(join_token: str, db: Session = Depends(get_db)):
    session = db.query(InterviewSession).filter(InterviewSession.join_token == join_token).first()
    if not session:
        raise HTTPException(status_code=404, detail="Invalid or expired interview link")
    session.ice_servers = video_provider.get_ice_servers()
    return session


@router.post("/{session_id}/identity-check", response_model=IdentityCheckOut)
async def submit_identity_check(
    request: Request,
    id_document: UploadFile,
    selfie: UploadFile,
    liveness_prompt: str = Form(...),
    liveness_passed: bool = Form(...),
    session: InterviewSession = Depends(require_session_token),
    db: Session = Depends(get_db),
):
    id_bytes = await id_document.read()
    selfie_bytes = await selfie.read()

    id_path = storage.save_file(f"interviews/{session.id}", id_document.filename, id_bytes)
    selfie_path = storage.save_file(f"interviews/{session.id}", selfie.filename, selfie_bytes)

    match = check_identity_match(
        id_bytes, id_document.content_type or "image/jpeg",
        selfie_bytes, selfie.content_type or "image/jpeg",
    )

    check = IdentityCheck(
        session_id=session.id,
        id_document_path=id_path,
        selfie_path=selfie_path,
        liveness_prompt=liveness_prompt,
        liveness_passed=liveness_passed,
        match_confidence=match["confidence"],
        match_verdict=match["verdict"],
        needs_human_review=match["needs_human_review"] or not liveness_passed,
    )
    db.add(check)

    session.status = SessionStatus.identity_pending if check.needs_human_review else SessionStatus.in_progress
    session.started_at = datetime.now(timezone.utc)

    # Captured once, here, rather than per-request — location shouldn't change mid-call, and
    # this is the first candidate-facing endpoint of the session.
    session.candidate_ip = request.client.host if request.client else None
    _maybe_flag_location_mismatch(db, session)

    db.add(session)

    db.add(AuditLog(
        interview_session_id=session.id,
        actor="system",
        action="identity_check",
        detail={"verdict": match["verdict"], "confidence": match["confidence"]},
    ))

    db.commit()
    db.refresh(check)
    return check


def _maybe_flag_location_mismatch(db: Session, session: InterviewSession) -> None:
    if not session.candidate_id or not session.candidate_ip:
        return
    candidate = db.get(Candidate, session.candidate_id)
    stated_location = (candidate.parsed_profile or {}).get("current_location") if candidate else None
    if not stated_location:
        return

    resolved_region = geolocation.resolve_region(session.candidate_ip)
    if geolocation.is_location_mismatch(resolved_region, stated_location):
        db.add(SignalEvent(
            session_id=session.id,
            signal_type=SignalType.location_mismatch,
            session_offset_ms=0,
            weight=5,
            meta={"resolved_region": resolved_region, "stated_location": stated_location},
        ))


@router.post("/{session_id}/start", response_model=StartSessionResponse)
def start_session(
    session: InterviewSession = Depends(require_session_token), db: Session = Depends(get_db)
):
    """The real gate behind the candidate's "Join interview" button — client-side-only
    checks can be bypassed by hitting the API directly, so both the probe and identity
    checks are enforced here, not just in the UI."""
    job = db.get(Job, session.job_id) if session.job_id else None

    if job and job.require_desktop_probe and not _probe_connected(session):
        raise HTTPException(
            status_code=409,
            detail="Desktop monitor not detected. Install and run the probe, then try again.",
        )

    latest_check = (
        db.query(IdentityCheck)
        .filter(IdentityCheck.session_id == session.id)
        .order_by(IdentityCheck.created_at.desc())
        .first()
    )
    if not latest_check:
        raise HTTPException(
            status_code=409,
            detail="Identity verification has not been completed for this interview.",
        )
    # needs_human_review already covers no_match, uncertain, AND failed liveness (see
    # submit_identity_check) — gating on the literal "no_match" string here let uncertain
    # verdicts and failed-liveness submissions start unblocked. cleared_by_hr is the one
    # designed override for all three, so it stays the sole way past this.
    if latest_check.needs_human_review and not latest_check.cleared_by_hr:
        raise HTTPException(
            status_code=409,
            detail="Identity verification did not match. Contact HR to proceed.",
        )

    return StartSessionResponse(started=True)


@router.get(
    "/{session_id}/identity-check",
    response_model=IdentityCheckOut,
    dependencies=[Depends(require_hr_auth)],
)
def get_identity_check(session_id: uuid.UUID, db: Session = Depends(get_db)):
    check = (
        db.query(IdentityCheck)
        .filter(IdentityCheck.session_id == session_id)
        .order_by(IdentityCheck.created_at.desc())
        .first()
    )
    if not check:
        raise HTTPException(status_code=404, detail="No identity check found for this session")
    return check


@router.post(
    "/{session_id}/identity-check/override",
    response_model=IdentityCheckOut,
    dependencies=[Depends(require_hr_auth)],
)
def override_identity_check(
    session_id: uuid.UUID,
    payload: IdentityCheckOverrideRequest,
    db: Session = Depends(get_db),
    current_hr_user: dict = Depends(require_hr_auth),
):
    """Clears a no_match verdict as a false positive (bad lighting/angle), unblocking
    POST /start — never auto-clears; only human review of the actual images does."""
    check = (
        db.query(IdentityCheck)
        .filter(IdentityCheck.session_id == session_id)
        .order_by(IdentityCheck.created_at.desc())
        .first()
    )
    if not check:
        raise HTTPException(status_code=404, detail="No identity check found for this session")

    check.cleared_by_hr = True
    check.cleared_reason = payload.reason
    db.add(check)

    db.add(AuditLog(
        interview_session_id=session_id,
        actor=f"hr:{current_hr_user['email']}",
        action="override_identity_check",
        detail={"reason": payload.reason},
    ))

    db.commit()
    db.refresh(check)
    return check


@router.post("/{session_id}/signals")
def ingest_signals(
    events: list[SignalEventIn],
    session: InterviewSession = Depends(require_session_token),
    db: Session = Depends(get_db),
):
    for event in events:
        db.add(SignalEvent(session_id=session.id, **event.model_dump()))
    db.commit()
    return {"ingested": len(events)}


PROBE_TIMEOUT_SECONDS = 15


@router.post("/{session_id}/probe-heartbeat")
def probe_heartbeat(
    session: InterviewSession = Depends(require_session_token), db: Session = Depends(get_db)
):
    session.probe_last_seen_at = datetime.now(timezone.utc)
    db.add(session)
    db.commit()
    return {"ok": True}


def _probe_connected(session: InterviewSession) -> bool:
    return (
        session.probe_last_seen_at is not None
        and (datetime.now(timezone.utc) - session.probe_last_seen_at).total_seconds()
        < PROBE_TIMEOUT_SECONDS
    )


@router.get("/{session_id}/probe-status")
def probe_status(session: InterviewSession = Depends(require_session_token)):
    return {"connected": _probe_connected(session), "last_seen_at": session.probe_last_seen_at}


@router.post("/{session_id}/recording-chunk")
async def upload_recording_chunk(
    chunk: UploadFile,
    session: InterviewSession = Depends(require_session_token),
    db: Session = Depends(get_db),
):
    if session.started_recording_at is None:
        session.started_recording_at = datetime.now(timezone.utc)
    content = await chunk.read()
    relative_path, is_new_segment = storage.append_recording_chunk(
        f"interviews/{session.id}", session.recording_file_path, content
    )
    if is_new_segment and session.recording_file_path:
        session.recording_segment_paths = [
            *(session.recording_segment_paths or []),
            session.recording_file_path,
        ]
    session.recording_file_path = relative_path
    db.add(session)
    db.commit()
    return {"bytes_received": len(content)}


# --- Interviewer-facing (authorized by a separate interviewer token, no login) ---------


@router.get("/interviewer-join/{interviewer_token}", response_model=InterviewerJoinSessionOut)
def get_session_by_interviewer_token(interviewer_token: str, db: Session = Depends(get_db)):
    session = (
        db.query(InterviewSession)
        .filter(InterviewSession.interviewer_join_token == interviewer_token)
        .first()
    )
    if not session:
        raise HTTPException(status_code=404, detail="Invalid or expired interviewer link")
    session.ice_servers = video_provider.get_ice_servers()
    return session


@router.post("/{session_id}/interviewer-recording-chunk")
async def upload_interviewer_recording_chunk(
    chunk: UploadFile,
    session: InterviewSession = Depends(require_interviewer_token),
    db: Session = Depends(get_db),
):
    if session.interviewer_started_recording_at is None:
        session.interviewer_started_recording_at = datetime.now(timezone.utc)
    content = await chunk.read()
    relative_path, is_new_segment = storage.append_recording_chunk(
        f"interviews/{session.id}", session.interviewer_recording_file_path, content
    )
    if is_new_segment and session.interviewer_recording_file_path:
        session.interviewer_recording_segment_paths = [
            *(session.interviewer_recording_segment_paths or []),
            session.interviewer_recording_file_path,
        ]
    session.interviewer_recording_file_path = relative_path
    db.add(session)
    db.commit()
    return {"bytes_received": len(content)}


@router.get("/{session_id}/live-signals", response_model=list[SignalEventOut])
def live_signals(
    session: InterviewSession = Depends(require_interviewer_token), db: Session = Depends(get_db)
):
    """Lets the interviewer's page show integrity signals as they happen, not just after the
    fact — polled during the live session. Raw events, not fused flags: fusion only runs once
    at /complete, and the interviewer benefits more from seeing everything as it comes in."""
    return (
        db.query(SignalEvent)
        .filter(SignalEvent.session_id == session.id)
        .order_by(SignalEvent.session_offset_ms)
        .all()
    )


@router.post("/{session_id}/interviewer-decision", response_model=SessionOut)
def submit_interviewer_decision(
    payload: InterviewerDecisionRequest,
    session: InterviewSession = Depends(require_interviewer_token),
    db: Session = Depends(get_db),
):
    """Logs the interviewer's own read of the candidate live, during the call — distinct
    from post-hoc flag review, which only ever reconstructs a session after it's over."""
    session.interviewer_live_decision = payload.decision
    session.interviewer_live_notes = payload.notes
    db.add(session)
    db.commit()
    db.refresh(session)
    return session


@router.post("/{session_id}/sentiment-sample")
async def upload_sentiment_sample(
    background_tasks: BackgroundTasks,
    clip: UploadFile,
    session_offset_ms: int = Form(...),
    session: InterviewSession = Depends(require_session_token),
    db: Session = Depends(get_db),
):
    """A short, independent, fully-closed clip — deliberately NOT a slice of the
    continuously-appended main recording, which isn't safe to read with ffmpeg mid-write
    (unfinalized WebM container). Powers the interviewer's live-sentiment panel and the
    post-call aggregate trend (see sentiment_aggregate.py)."""
    content = await clip.read()
    relative_path = storage.save_file(f"interviews/{session.id}/sentiment", "sample.webm", content)

    sample = SentimentSample(session_id=session.id, session_offset_ms=session_offset_ms)
    db.add(sample)
    db.commit()
    db.refresh(sample)

    background_tasks.add_task(_process_sentiment_sample, sample.id, relative_path)
    return {"accepted": True}


def _process_sentiment_sample(sample_id: uuid.UUID, relative_path: str):
    db = SessionLocal()
    try:
        sample = db.get(SentimentSample, sample_id)
        if not sample:
            return

        try:
            with storage.decrypted_temp_copy(relative_path) as path:
                frame_paths = extract_frames(path, count=1)
                sample.facial_affect = analyze_facial_affect(frame_paths)
        except Exception as exc:  # noqa: BLE001 - best-effort, same pattern as post-call analysis
            logger.warning("Facial affect analysis failed for sample %s: %s", sample_id, exc)
            sample.facial_affect = {"error": str(exc)}

        try:
            with storage.decrypted_temp_copy(relative_path) as path:
                wav_path = extract_audio_wav(path)
                sample.voice_tone = analyze_voice_tone(wav_path)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Voice tone analysis failed for sample %s: %s", sample_id, exc)
            sample.voice_tone = {"error": str(exc)}

        db.add(sample)
        db.commit()
    except Exception:  # noqa: BLE001 - backstop: without this, e.g. db.get() itself
        # throwing left this task dying silently with nothing in server logs at all.
        # There's no status field on SentimentSample to fix up here (unlike
        # InterviewSession.transcript_status below) — a missed sample just stays missing,
        # which the live-sentiment/review UI already tolerates.
        logger.exception("Sentiment sample processing failed for sample %s", sample_id)
    finally:
        db.close()


@router.get("/{session_id}/live-sentiment", response_model=list[SentimentSampleOut])
def live_sentiment(
    session: InterviewSession = Depends(require_interviewer_token), db: Session = Depends(get_db)
):
    return (
        db.query(SentimentSample)
        .filter(SentimentSample.session_id == session.id)
        .order_by(SentimentSample.session_offset_ms.desc())
        .limit(5)
        .all()
    )


# --- Post-interview processing (background) ---------------------------------------------


def _process_recordings_and_save(session_id: uuid.UUID):
    """Runs after the HTTP response is sent — needs its own DB session since the
    request-scoped one is already closed by then. Transcribes both sides (if the
    interviewer recorded), merges them onto one timeline, then runs Q&A verification and
    voice-tone analysis. Best-effort at each step — failing one shouldn't block the rest.

    Transcription runs against the extracted audio-only WAV, not the raw video+audio
    recording — Whisper hard-rejects anything over 25MB (413), and a video+audio webm
    hits that ceiling on any interview of real length; audio alone buys a lot more
    headroom (transcription.py chunks further if even that still exceeds the limit). The
    same extracted WAV is reused for voice-tone analysis below rather than re-extracted."""
    db = SessionLocal()
    candidate_wav_path: str | None = None
    interviewer_wav_path: str | None = None
    session: InterviewSession | None = None
    try:
        session = db.get(InterviewSession, session_id)
        if not session:
            return

        # Both moved here from POST /complete's request handler — confirmed ~5s of blocking
        # time for two 300MB recordings when done synchronously there, which bought nothing
        # (HR never opens the review page within seconds of the call ending) while making
        # the candidate's browser sit on the "Finish interview" click for it.
        #
        # If the candidate's browser reconnected mid-call, append_recording_chunk (see
        # storage.py) will have rolled the file at that point into *_segment_paths rather
        # than corrupting it, leaving several valid-on-their-own segments instead of one
        # complete recording. Stitch them back into a single file now, before encrypting —
        # best-effort: on failure, fall back to just the last segment (still a real,
        # playable file, just missing the earlier part of the call) rather than aborting
        # the rest of this task, and leave a record of it for HR/support.
        for path_attr, segments_attr in (
            ("recording_file_path", "recording_segment_paths"),
            ("interviewer_recording_file_path", "interviewer_recording_segment_paths"),
        ):
            segments = getattr(session, segments_attr) or []
            current_path = getattr(session, path_attr)
            if not (segments and current_path):
                continue
            try:
                merged_path = storage.concat_segments(
                    [*segments, current_path], f"interviews/{session.id}"
                )
                setattr(session, path_attr, merged_path)
                setattr(session, segments_attr, [])
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "Recording segment merge failed for session %s (%s): %s",
                    session.id, path_attr, exc,
                )
                db.add(AuditLog(
                    interview_session_id=session.id,
                    actor="system",
                    action="recording_segments_merge_failed",
                    detail={"path_attr": path_attr, "segments": segments, "error": str(exc)},
                ))

        # Encrypted here, once, now that the file is finished growing — append_file_chunk
        # can't encrypt incrementally (see storage.py). decrypted_temp_copy below decrypts
        # to a temp copy on demand for ffmpeg/whisper.
        session.recording_file_path = storage.finalize_encrypt(session.recording_file_path)
        session.interviewer_recording_file_path = storage.finalize_encrypt(
            session.interviewer_recording_file_path
        )
        db.add(session)
        db.commit()

        candidate_segments: list[dict] = []
        try:
            with storage.decrypted_temp_copy(session.recording_file_path) as path:
                candidate_wav_path = extract_audio_wav(path)
            text, segments = transcribe_with_segments(candidate_wav_path)
            session.transcript = text
            session.transcript_status = "done"
            candidate_segments = segments
        except Exception as exc:  # noqa: BLE001 - surfaced on the review page, not silently dropped
            logger.warning("Candidate transcription failed for session %s: %s", session.id, exc)
            session.transcript = f"Transcription failed: {exc}"
            session.transcript_status = "failed"

        interviewer_segments: list[dict] = []
        if session.interviewer_recording_file_path:
            try:
                with storage.decrypted_temp_copy(session.interviewer_recording_file_path) as path:
                    interviewer_wav_path = extract_audio_wav(path)
                text, segments = transcribe_with_segments(interviewer_wav_path)
                session.interviewer_transcript = text
                session.interviewer_transcript_status = "done"
                interviewer_segments = segments
            except Exception as exc:  # noqa: BLE001
                logger.warning("Interviewer transcription failed for session %s: %s", session.id, exc)
                session.interviewer_transcript = f"Transcription failed: {exc}"
                session.interviewer_transcript_status = "failed"

        if session.transcript_status == "done":
            try:
                session.merged_transcript = merge_transcripts(
                    candidate_segments,
                    session.started_recording_at,
                    interviewer_segments,
                    session.interviewer_started_recording_at,
                )
                session.qa_analysis = analyze_qa(session.merged_transcript or session.transcript)
            except Exception as exc:  # noqa: BLE001 - best-effort, not core status
                logger.warning("Q&A analysis failed for session %s: %s", session.id, exc)
                session.qa_analysis = {"error": str(exc)}

            try:
                if not candidate_wav_path:
                    raise RuntimeError("No extracted audio available (transcription step failed earlier)")
                session.voice_tone_analysis = analyze_voice_tone(candidate_wav_path)
            except Exception as exc:  # noqa: BLE001 - best-effort, not core status
                logger.warning("Voice tone analysis failed for session %s: %s", session.id, exc)
                session.voice_tone_analysis = {"error": str(exc)}

            try:
                with storage.decrypted_temp_copy(session.recording_file_path) as path:
                    frame_paths = extract_frames(path)
                    session.facial_affect_analysis = analyze_facial_affect(frame_paths)
            except Exception as exc:  # noqa: BLE001 - best-effort, not core status
                logger.warning("Facial affect analysis failed for session %s: %s", session.id, exc)
                session.facial_affect_analysis = {"error": str(exc)}

        db.add(session)
        db.commit()
    except Exception as exc:  # noqa: BLE001 - last-resort backstop: without this, anything
        # not already caught above (finalize_encrypt itself throwing, db.commit() failing,
        # db.get() throwing before `session` is even assigned, ...) left transcript_status
        # stuck at "pending" forever with nothing in server logs to explain why — the
        # review page polls every 4s while it's "pending" with no timeout, so HR would
        # just see it hang indefinitely. This turns that into a visible, terminal
        # "failed" instead, logged here (see core/logging.py) rather than only ever
        # existing as whatever happened to be in a developer's terminal at the time.
        logger.exception("Post-interview processing failed for session %s", session_id)
        if session is not None and session.transcript_status == "pending":
            try:
                session.transcript = f"Processing failed: {exc}"
                session.transcript_status = "failed"
                db.add(session)
                db.commit()
            except Exception:  # noqa: BLE001 - the DB itself may be what's actually down
                logger.exception(
                    "Also failed to record the processing failure for session %s", session_id
                )
    finally:
        for wav_path in (candidate_wav_path, interviewer_wav_path):
            if wav_path:
                with contextlib.suppress(OSError):
                    os.remove(wav_path)
        db.close()


@router.post("/{session_id}/complete", response_model=SessionOut)
def complete_session(
    background_tasks: BackgroundTasks,
    session: InterviewSession = Depends(require_session_token),
    db: Session = Depends(get_db),
):
    events = db.query(SignalEvent).filter(SignalEvent.session_id == session.id).all()
    flags = integrity.fuse_signals(events)

    for flag in flags:
        db.add(IntegrityFlag(session_id=session.id, **flag))

    score, needs_review = integrity.compute_integrity_score(flags)
    session.integrity_score = score
    session.integrity_needs_review = needs_review
    session.status = SessionStatus.completed
    session.completed_at = datetime.now(timezone.utc)

    samples = db.query(SentimentSample).filter(SentimentSample.session_id == session.id).all()
    if samples:
        session.sentiment_trend = sentiment_aggregate.aggregate_sentiment(samples)

    if session.recording_file_path:
        session.transcript_status = "pending"
        # Segment merging and at-rest encryption both happen inside the background task
        # now, not here — encrypting two 300MB recordings synchronously in this handler
        # measured at ~5s of dead time the candidate's browser sat waiting on for the
        # "Finish interview" click to resolve, for a step nothing reads before the
        # background task itself needs it (see _process_recordings_and_save above).
        background_tasks.add_task(_process_recordings_and_save, session.id)

    db.add(session)
    db.commit()
    db.refresh(session)
    return session
