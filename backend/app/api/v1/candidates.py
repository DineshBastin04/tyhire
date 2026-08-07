import os
import uuid

from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.api.v1.auth import require_hr_auth
from app.db.session import get_db
from app.models.candidate import AuditLog, Candidate
from app.models.job import Job
from app.models.user import User
from app.schemas.candidate import (
    ArchiveRequest,
    CandidateOut,
    DeleteRequest,
    ManualAdjustmentRequest,
    OverrideRequest,
    ScreeningDetailsRequest,
)
from app.services import dedupe, knockout, scoring, storage, triage
from app.services.fit_report import build_fit_report_pdf
from app.services.resume_parser import parse_resume
from app.services.text_extract import extract_text

router = APIRouter(tags=["candidates"], dependencies=[Depends(require_hr_auth)])

MANUAL_ADJUSTMENT_LIMIT = 20


def _apply_bucket_from_score(candidate: Candidate, job: Job) -> None:
    """Bucket is derived from fit_score plus any HR manual adjustment (clamped to 0-100) —
    override_bucket, set separately via /override, always wins over this in the UI and is
    never touched here."""
    effective = (candidate.fit_score or 0) + (candidate.manual_score_adjustment or 0)
    effective = max(0.0, min(100.0, effective))
    candidate.bucket = triage.bucket_for_score(effective, job)


@router.post("/jobs/{job_id}/resumes", response_model=list[CandidateOut])
async def upload_resumes(
    job_id: uuid.UUID,
    files: list[UploadFile],
    source: str | None = Form(default=None),
    db: Session = Depends(get_db),
    current_hr_user: dict = Depends(require_hr_auth),
):
    job = db.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    uploader = db.query(User).filter(User.id == current_hr_user["user_id"]).first()

    results: list[Candidate] = []

    for file in files:
        content = await file.read()
        relative_path = storage.save_file(f"resumes/{job_id}", file.filename, content)

        candidate = Candidate(
            job_id=job_id,
            resume_file_path=relative_path,
            uploaded_by_user_id=uploader.id if uploader else None,
            source=source,
        )

        try:
            resume_text, ocr_used = extract_text(file.filename, content)
            candidate.ocr_fallback_used = ocr_used
            profile = parse_resume(resume_text)

            candidate.parsed_profile = profile
            candidate.full_name = profile.get("full_name")
            candidate.email = profile.get("email")
            candidate.phone = profile.get("phone")
            candidate.notice_period_days = profile.get("notice_period_days")
            candidate.expected_salary = profile.get("expected_salary")

            duplicate = dedupe.find_duplicate(
                db, job_id, candidate.email, candidate.phone, candidate.full_name
            )
            if duplicate:
                candidate.is_duplicate_of = duplicate.id
                db.add(candidate)
                results.append(candidate)
                continue

            failed, reasons = knockout.check_knockout(profile, job)
            candidate.knockout_failed = failed
            candidate.knockout_reasons = reasons

            if failed:
                candidate.bucket = "declined"
            else:
                score, score_reasons, breakdown = scoring.score_candidate(profile, job)
                candidate.fit_score = score
                candidate.score_reasons = score_reasons
                candidate.score_breakdown = breakdown
                _apply_bucket_from_score(candidate, job)

        except Exception as exc:  # noqa: BLE001 - surfaced to HR in the "Needs attention" panel, not dropped
            candidate.processing_failed = True
            candidate.processing_error = str(exc)

        db.add(candidate)
        results.append(candidate)

    db.commit()
    for candidate in results:
        db.refresh(candidate)
        candidate.uploaded_by_email = uploader.email if uploader else None
    return results


@router.post("/candidates/{candidate_id}/screening-details", response_model=CandidateOut)
def set_screening_details(
    candidate_id: uuid.UUID,
    payload: ScreeningDetailsRequest,
    db: Session = Depends(get_db),
    current_hr_user: dict = Depends(require_hr_auth),
):
    """Notice period / expected salary a resume rarely states outright — HR fills these in
    after a screening call, and knockout is re-checked immediately against the job's rules."""
    candidate = db.get(Candidate, candidate_id)
    if not candidate:
        raise HTTPException(status_code=404, detail="Candidate not found")
    job = db.get(Job, candidate.job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    candidate.notice_period_days = payload.notice_period_days
    candidate.expected_salary = payload.expected_salary

    merged_profile = {
        **(candidate.parsed_profile or {}),
        "notice_period_days": payload.notice_period_days,
        "expected_salary": payload.expected_salary,
    }
    failed, reasons = knockout.check_knockout(merged_profile, job)
    candidate.knockout_failed = failed
    candidate.knockout_reasons = reasons

    if failed:
        candidate.bucket = "declined"
    elif candidate.fit_score is None and candidate.parsed_profile:
        # Never scored because knockout blocked it at upload time — score it now that the
        # thing that blocked it has cleared.
        score, score_reasons, breakdown = scoring.score_candidate(candidate.parsed_profile, job)
        candidate.fit_score = score
        candidate.score_reasons = score_reasons
        candidate.score_breakdown = breakdown
        _apply_bucket_from_score(candidate, job)
    elif candidate.fit_score is not None:
        _apply_bucket_from_score(candidate, job)

    db.add(AuditLog(
        candidate_id=candidate.id,
        actor=f"hr:{current_hr_user['email']}",
        action="set_screening_details",
        detail={
            "notice_period_days": payload.notice_period_days,
            "expected_salary": payload.expected_salary,
        },
    ))

    db.add(candidate)
    db.commit()
    db.refresh(candidate)
    return candidate


@router.post("/candidates/{candidate_id}/manual-adjustment", response_model=CandidateOut)
def set_manual_adjustment(
    candidate_id: uuid.UUID,
    payload: ManualAdjustmentRequest,
    db: Session = Depends(get_db),
    current_hr_user: dict = Depends(require_hr_auth),
):
    """A small HR-entered nudge on top of the AI sub-scores (e.g. a competing offer, a
    referral) — always shown separately from the AI breakdown, never folded into it."""
    if not -MANUAL_ADJUSTMENT_LIMIT <= payload.adjustment <= MANUAL_ADJUSTMENT_LIMIT:
        raise HTTPException(
            status_code=400,
            detail=f"Adjustment must be between -{MANUAL_ADJUSTMENT_LIMIT} and +{MANUAL_ADJUSTMENT_LIMIT}",
        )

    candidate = db.get(Candidate, candidate_id)
    if not candidate:
        raise HTTPException(status_code=404, detail="Candidate not found")
    if candidate.fit_score is None:
        raise HTTPException(status_code=400, detail="Candidate has no AI score to adjust yet")
    job = db.get(Job, candidate.job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    candidate.manual_score_adjustment = payload.adjustment
    candidate.manual_adjustment_reason = payload.reason
    _apply_bucket_from_score(candidate, job)

    db.add(AuditLog(
        candidate_id=candidate.id,
        actor=f"hr:{current_hr_user['email']}",
        action="manual_score_adjustment",
        detail={"adjustment": payload.adjustment, "reason": payload.reason},
    ))

    db.add(candidate)
    db.commit()
    db.refresh(candidate)
    return candidate


@router.get("/candidates/{candidate_id}", response_model=CandidateOut)
def get_candidate(candidate_id: uuid.UUID, db: Session = Depends(get_db)):
    """Backs the consolidated final-decision view — everything scoring-related in one
    place, distinct from the Kanban card's summary. HR-only, same as every other candidate
    endpoint; nothing here is ever exposed to the candidate themselves."""
    candidate = db.get(Candidate, candidate_id)
    if not candidate:
        raise HTTPException(status_code=404, detail="Candidate not found")
    candidate.uploaded_by_email = candidate.uploader.email if candidate.uploader else None
    return candidate


@router.get("/candidates/{candidate_id}/fit-report")
def download_fit_report(candidate_id: uuid.UUID, db: Session = Depends(get_db)):
    """A downloadable PDF summary of the AI fit assessment (overall score, sub-scores,
    eligibility, HR decision) — not the resume itself, which HR already has from the
    upload. This is the score/reasoning HR would otherwise have to reconstruct by clicking
    through the candidate page."""
    candidate = db.get(Candidate, candidate_id)
    if not candidate:
        raise HTTPException(status_code=404, detail="Candidate not found")
    job = db.get(Job, candidate.job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    pdf_bytes = build_fit_report_pdf(candidate, job)
    safe_name = (candidate.full_name or "candidate").replace(" ", "_")

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{safe_name}_fit_report.pdf"'},
    )


@router.get("/jobs/{job_id}/candidates", response_model=list[CandidateOut])
def list_candidates(job_id: uuid.UUID, db: Session = Depends(get_db)):
    candidates = (
        db.query(Candidate)
        .filter(Candidate.job_id == job_id)
        .order_by(Candidate.fit_score.desc().nullslast())
        .all()
    )
    for candidate in candidates:
        candidate.uploaded_by_email = candidate.uploader.email if candidate.uploader else None
    return candidates


@router.post("/candidates/{candidate_id}/override", response_model=CandidateOut)
def override_candidate(
    candidate_id: uuid.UUID,
    payload: OverrideRequest,
    db: Session = Depends(get_db),
    current_hr_user: dict = Depends(require_hr_auth),
):
    candidate = db.get(Candidate, candidate_id)
    if not candidate:
        raise HTTPException(status_code=404, detail="Candidate not found")

    candidate.override_bucket = payload.bucket
    candidate.override_reason = payload.reason
    db.add(candidate)

    db.add(AuditLog(
        candidate_id=candidate.id,
        actor=f"hr:{current_hr_user['email']}",
        action="override_bucket",
        detail={"bucket": payload.bucket.value, "reason": payload.reason},
    ))

    db.commit()
    db.refresh(candidate)
    return candidate


@router.post("/candidates/{candidate_id}/archive", response_model=CandidateOut)
def archive_candidate(
    candidate_id: uuid.UUID,
    payload: ArchiveRequest,
    db: Session = Depends(get_db),
    current_hr_user: dict = Depends(require_hr_auth),
):
    candidate = db.get(Candidate, candidate_id)
    if not candidate:
        raise HTTPException(status_code=404, detail="Candidate not found")

    candidate.archived = True
    candidate.archived_reason = payload.reason
    db.add(candidate)

    db.add(AuditLog(
        candidate_id=candidate.id,
        actor=f"hr:{current_hr_user['email']}",
        action="archive_candidate",
        detail={"reason": payload.reason},
    ))

    db.commit()
    db.refresh(candidate)
    return candidate


def _collect_duplicate_chain(db: Session, candidate_id: uuid.UUID) -> list[Candidate]:
    """Finds every candidate row marked as a duplicate of candidate_id, transitively.

    Duplicate rows never get scored independently (upload_resumes skips scoring for
    them), so deleting them alongside the primary loses no AI decision history —
    they're pure resume-file records pointing at the primary, and leaving them behind
    is exactly what caused deleted candidates to "come back" as duplicates on re-upload.
    """
    chain: list[Candidate] = []
    frontier = [candidate_id]
    while frontier:
        children = db.query(Candidate).filter(Candidate.is_duplicate_of.in_(frontier)).all()
        if not children:
            break
        chain.extend(children)
        frontier = [c.id for c in children]
    return chain


@router.delete("/candidates/{candidate_id}")
def delete_candidate(
    candidate_id: uuid.UUID,
    payload: DeleteRequest,
    db: Session = Depends(get_db),
    current_hr_user: dict = Depends(require_hr_auth),
):
    candidate = db.get(Candidate, candidate_id)
    if not candidate:
        raise HTTPException(status_code=404, detail="Candidate not found")
    if not candidate.archived:
        raise HTTPException(
            status_code=400,
            detail="Candidate must be archived before it can be permanently deleted.",
        )

    duplicates = _collect_duplicate_chain(db, candidate_id)

    # Logged before the rows are gone — candidate_id is left null since the row it
    # would reference is about to be deleted (the FK is ON DELETE SET NULL).
    db.add(AuditLog(
        candidate_id=None,
        actor=f"hr:{current_hr_user['email']}",
        action="hard_delete_candidate",
        detail={
            "reason": payload.reason,
            "candidate_name": candidate.full_name,
            "email": candidate.email,
            "duplicates_removed": len(duplicates),
        },
    ))

    resume_paths = [candidate.resume_file_path] + [d.resume_file_path for d in duplicates]
    for dup in duplicates:
        db.delete(dup)
    db.delete(candidate)
    db.commit()

    for path in resume_paths:
        try:
            os.remove(storage.absolute_path(path))
        except OSError:
            pass

    return {"deleted": True, "duplicates_removed": len(duplicates)}


@router.post("/candidates/{candidate_id}/unarchive", response_model=CandidateOut)
def unarchive_candidate(
    candidate_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_hr_user: dict = Depends(require_hr_auth),
):
    candidate = db.get(Candidate, candidate_id)
    if not candidate:
        raise HTTPException(status_code=404, detail="Candidate not found")

    candidate.archived = False
    db.add(candidate)

    db.add(AuditLog(
        candidate_id=candidate.id,
        actor=f"hr:{current_hr_user['email']}",
        action="unarchive_candidate",
        detail={},
    ))

    db.commit()
    db.refresh(candidate)
    return candidate
