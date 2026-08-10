import uuid

from rapidfuzz import fuzz
from sqlalchemy.orm import Session

from app.models.candidate import Bucket, Candidate

NAME_MATCH_THRESHOLD = 90


def find_duplicate(db: Session, job_id: uuid.UUID, email: str | None, phone: str | None, full_name: str | None) -> Candidate | None:
    # Only match against primary records, not rows that are themselves already marked as
    # duplicates — otherwise a new upload can end up pointing at a duplicate-of-a-duplicate,
    # and if that original primary is later hard-deleted, these orphaned duplicate rows keep
    # matching future uploads even though the record they actually represent is long gone.
    existing = (
        db.query(Candidate)
        .filter(Candidate.job_id == job_id, Candidate.is_duplicate_of.is_(None))
        .all()
    )

    for candidate in existing:
        # A declined candidate re-applying (fixed resume, reconsideration, etc.) must get
        # scored fresh, not silently swallowed as a "duplicate" of their own declined
        # record — duplicates are never scored (see upload_resumes), so matching here would
        # permanently block them from ever being reconsidered for this job.
        if (candidate.override_bucket or candidate.bucket) == Bucket.declined:
            continue
        if email and candidate.email and email.strip().lower() == candidate.email.strip().lower():
            return candidate
        norm_phone = _normalize_phone(phone)
        norm_cand_phone = _normalize_phone(candidate.phone)
        if phone and candidate.phone and norm_phone and norm_phone == norm_cand_phone:
            return candidate
        if full_name and candidate.full_name:
            if fuzz.ratio(full_name.strip().lower(), candidate.full_name.strip().lower()) >= NAME_MATCH_THRESHOLD:
                return candidate

    return None


def _normalize_phone(phone: str) -> str:
    return "".join(ch for ch in phone if ch.isdigit())[-10:]
