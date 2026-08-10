"""One-shot backfill that encrypts pre-existing plaintext files at rest.

STORAGE_ENCRYPTION_KEY only affects files written *after* it's set (see services/storage.py),
so anything stored beforehand — resumes, ID photos, selfies, finished recordings — stays
plaintext on disk forever, and read_file serves it happily because only .enc paths are
decrypted. Enabling encryption therefore silently leaves old sensitive media in cleartext.

This module walks every DB-tracked file path, encrypts the ones still in plaintext in place,
and reconciles the stored path (which gains a .enc suffix) so the app keeps finding the file.
Run it once, after setting STORAGE_ENCRYPTION_KEY, via app.jobs.encrypt_storage_backfill.

Idempotent and crash-safe: re-running skips already-encrypted files and repairs any DB
pointer left dangling by a crash between encrypting a file and committing its new path.
"""
import logging
import os

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.candidate import Candidate
from app.models.interview import IdentityCheck, InterviewSession, SessionStatus
from app.services import storage
from app.services.storage import ENCRYPTED_SUFFIX

logger = logging.getLogger(__name__)


def _reconcile_path(relative_path: str) -> tuple[str | None, str]:
    """Encrypts one stored file in place if needed and returns (new_relative_path, status).

    status is one of:
      - "already_encrypted": path already ends in .enc — nothing to do.
      - "encrypted": plaintext file was present and has been encrypted in place.
      - "repaired_pointer": plaintext was already gone but the .enc file exists (a crash left
        the DB pointing at the old plaintext path); the caller should adopt the .enc path.
      - "missing": neither the plaintext nor the .enc file exists on disk; caller leaves the
        DB row untouched rather than guessing.
    new_relative_path is None only for "missing"."""
    if relative_path.endswith(ENCRYPTED_SUFFIX):
        return relative_path, "already_encrypted"
    if os.path.exists(storage.absolute_path(relative_path)):
        return storage.finalize_encrypt(relative_path), "encrypted"
    if os.path.exists(storage.absolute_path(relative_path + ENCRYPTED_SUFFIX)):
        return relative_path + ENCRYPTED_SUFFIX, "repaired_pointer"
    return None, "missing"


def backfill_encrypt_storage(db: Session) -> dict[str, int]:
    """Encrypts every DB-tracked plaintext file and updates its stored path. Commits after
    each file so an interrupted run resumes cleanly. Returns per-status counts.

    Raises RuntimeError if no key is configured — there'd be nothing to encrypt to, and
    silently doing nothing would be worse than a clear error."""
    if not settings.storage_encryption_key:
        raise RuntimeError(
            "STORAGE_ENCRYPTION_KEY is not set - set it first, then run this backfill."
        )

    stats = {"encrypted": 0, "repaired_pointer": 0, "already_encrypted": 0, "missing": 0}

    def handle(obj, attr: str) -> None:
        relative_path = getattr(obj, attr)
        if not relative_path:
            return
        try:
            new_path, status = _reconcile_path(relative_path)
        except Exception:  # noqa: BLE001 - one bad file must not abort the whole migration
            logger.exception(
                "backfill: failed to encrypt %s.%s = %s", type(obj).__name__, attr, relative_path
            )
            return

        if status in ("encrypted", "repaired_pointer"):
            setattr(obj, attr, new_path)
            db.add(obj)
            db.commit()  # persist the new pointer immediately — the plaintext file is already gone
            stats[status] += 1
        elif status == "already_encrypted":
            stats["already_encrypted"] += 1
        elif status == "missing":
            stats["missing"] += 1
            logger.warning(
                "backfill: file missing on disk for %s.%s = %s",
                type(obj).__name__, attr, relative_path,
            )

    # Resumes and identity photos are one-shot writes (never appended), so they're safe to
    # encrypt at any time.
    for candidate in db.query(Candidate).filter(Candidate.resume_file_path.isnot(None)).all():
        handle(candidate, "resume_file_path")

    for check in db.query(IdentityCheck).all():
        handle(check, "id_document_path")
        handle(check, "selfie_path")

    # Recordings only for COMPLETED sessions. A still-growing recording on an in-progress
    # session is plaintext by design (Fernet tokens can't be appended) and is finalized at
    # /complete — encrypting it mid-write here would corrupt it.
    for session in (
        db.query(InterviewSession)
        .filter(InterviewSession.status == SessionStatus.completed)
        .all()
    ):
        handle(session, "recording_file_path")
        handle(session, "interviewer_recording_file_path")

    logger.info("storage encryption backfill result: %s", stats)
    return stats
