"""Data-retention enforcement for stored biometric media.

The identity check keeps a candidate's government-ID photo and selfie only long enough to be
reviewed; past settings.identity_media_retention_days the raw image files are deleted while
the verdict/confidence are kept for audit. This module holds that policy so it can be invoked
from three places identically: the manual HR endpoint, the in-process daily sweep
(app.main), and the standalone job runner (app.jobs.run_retention_sweep) for external cron.
"""
import logging
import os
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.interview import IdentityCheck
from app.services import storage

logger = logging.getLogger(__name__)


def purge_expired_identity_media(db: Session) -> int:
    """Deletes raw ID/selfie image files past the retention window, keeping each row's
    verdict/confidence (only the image paths are nulled). Returns the number of identity
    checks whose media was cleared.

    Idempotent: it only targets rows that still have an id_document_path, so a second run
    over the same window finds nothing new — which is what makes it safe to schedule (and to
    run redundantly) without any locking."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=settings.identity_media_retention_days)
    expired = (
        db.query(IdentityCheck)
        .filter(IdentityCheck.created_at < cutoff, IdentityCheck.id_document_path.isnot(None))
        .all()
    )

    cleared = 0
    for check in expired:
        for path in (check.id_document_path, check.selfie_path):
            if not path:
                continue
            try:
                os.remove(storage.absolute_path(path))
            except OSError:
                # File already gone (manual cleanup, prior run, or hard session delete) — the
                # DB row is still nulled below so it won't be revisited. Not worth failing on.
                pass
        check.id_document_path = None
        check.selfie_path = None
        db.add(check)
        cleared += 1

    db.commit()
    if cleared:
        logger.info("retention: cleared media for %d identity check(s)", cleared)
    return cleared


def purge_expired_l1_recordings(db: Session) -> int:
    """Deletes raw audio recording files for L1 phone screenings past the retention window,
    keeping transcripts, scores, and evaluation takeaways. Returns the number of recordings cleared."""
    from app.models.l1_screening import L1PhoneScreening

    cutoff = datetime.now(timezone.utc) - timedelta(days=settings.identity_media_retention_days)
    expired = (
        db.query(L1PhoneScreening)
        .filter(L1PhoneScreening.created_at < cutoff, L1PhoneScreening.audio_file_path.isnot(None))
        .all()
    )

    cleared = 0
    for screening in expired:
        path = screening.audio_file_path
        if path:
            try:
                os.remove(storage.absolute_path(path))
            except OSError:
                pass
        screening.audio_file_path = None
        db.add(screening)
        cleared += 1

    db.commit()
    if cleared:
        logger.info("retention: cleared audio for %d L1 screening(s)", cleared)
    return cleared

