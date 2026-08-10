"""Standalone entrypoint for the storage encryption backfill.

Run once after enabling STORAGE_ENCRYPTION_KEY to encrypt files that were written while
encryption was off (they'd otherwise stay plaintext at rest forever):

    python -m app.jobs.encrypt_storage_backfill

Idempotent — safe to re-run. Exits non-zero on failure so a runbook/CI step can detect it.
"""
import logging
import sys

from app.db.session import SessionLocal
from app.services.storage_backfill import backfill_encrypt_storage


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    db = SessionLocal()
    try:
        stats = backfill_encrypt_storage(db)
        logging.getLogger(__name__).info("storage encryption backfill complete: %s", stats)
        return 0
    except Exception:
        logging.getLogger(__name__).exception("storage encryption backfill failed")
        return 1
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
