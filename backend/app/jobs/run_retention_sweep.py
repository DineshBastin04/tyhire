"""Standalone entrypoint for the identity-media retention sweep.

Run one sweep and exit — intended for external schedulers (cron, systemd timer, Kubernetes
CronJob) when the in-process sweep is disabled (RETENTION_SWEEP_ENABLED=false), e.g. because
the backend runs multiple workers/replicas and only one process should sweep.

    python -m app.jobs.run_retention_sweep

Exits non-zero on failure so a scheduler can detect and alert on it.
"""
import logging
import sys

from app.db.session import SessionLocal
from app.services.retention import purge_expired_identity_media


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    db = SessionLocal()
    try:
        cleared = purge_expired_identity_media(db)
        logging.getLogger(__name__).info("retention sweep complete: %d identity check(s) cleared", cleared)
        return 0
    except Exception:
        logging.getLogger(__name__).exception("retention sweep failed")
        return 1
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
