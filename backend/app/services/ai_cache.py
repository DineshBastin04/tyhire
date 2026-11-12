"""Content-addressed memo store for AI tool calls that must be reproducible.

Opens its own short-lived session rather than taking one from the caller: the services
that use this (scoring, resume parsing) are otherwise pure functions of their arguments,
and threading a Session through them only so they can memoize would put the DB in their
signatures for every caller, including the ones in background tasks that don't have one.
A miss or a write failure here is never fatal — the caller just does the real work.
"""
import hashlib
import json
import logging

from app.db.session import SessionLocal
from app.models.ai_cache import AiResultCache

logger = logging.getLogger(__name__)


def make_key(kind: str, payload: dict) -> str:
    """Hashes the full set of inputs that determine an answer.

    `sort_keys` matters more than it looks: dict ordering follows however the profile was
    built, so without it the same resume parsed twice could serialize differently and miss
    its own cache entry — exactly the bug this is here to prevent.
    """
    canonical = json.dumps({"kind": kind, **payload}, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def get(key: str) -> dict | None:
    try:
        with SessionLocal() as db:
            row = db.get(AiResultCache, key)
            return row.result if row else None
    except Exception:  # noqa: BLE001 - a cache lookup must never break scoring
        logger.exception("AI cache lookup failed for key %s", key)
        return None


def put(key: str, kind: str, result: dict) -> None:
    try:
        with SessionLocal() as db:
            # Another worker may have stored the same key between our get() and here —
            # same inputs, so same answer. Nothing to reconcile; keep whichever landed.
            if db.get(AiResultCache, key) is None:
                db.add(AiResultCache(cache_key=key, kind=kind, result=result))
                db.commit()
    except Exception:  # noqa: BLE001
        logger.exception("AI cache write failed for key %s", key)
