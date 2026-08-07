import uuid

from rapidfuzz import fuzz
from sqlalchemy.orm import Session

from app.models.candidate import Candidate

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
        if email and candidate.email and email.strip().lower() == candidate.email.strip().lower():
            return candidate
        if phone and candidate.phone and _normalize_phone(phone) == _normalize_phone(candidate.phone):
            return candidate
        if full_name and candidate.full_name:
            if fuzz.ratio(full_name.strip().lower(), candidate.full_name.strip().lower()) >= NAME_MATCH_THRESHOLD:
                return candidate

    return None


def _normalize_phone(phone: str) -> str:
    return "".join(ch for ch in phone if ch.isdigit())[-10:]
