import asyncio
import contextlib
import logging
import os

import bcrypt
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.concurrency import run_in_threadpool
from starlette.middleware.sessions import SessionMiddleware

from app.api.v1 import api_router
from app.core.config import settings
from app.db.session import Base, SessionLocal, engine
from app import models  # noqa: F401 - ensures models are registered on Base before create_all
from app.models.user import User
from app.services.retention import purge_expired_identity_media

logger = logging.getLogger(__name__)

app = FastAPI(title="TyHire")

os.makedirs(settings.storage_root, exist_ok=True)
# No public static file mount — every file (ID photos, recordings) is served through an
# authenticated, decrypting proxy endpoint instead (see /interviews/{id}/media/*). The old
# public /media mount had zero access control: anyone who knew or guessed a storage path
# could download it with no login at all.

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Required by authlib's OAuth login flow (api/v1/oauth.py) to stash transient state/nonce
# across the redirect to Google/Microsoft and back — a completely separate cookie from our
# own stateless hr_session cookie (services/auth_session.py), not a replacement for it.
app.add_middleware(SessionMiddleware, secret_key=settings.session_secret)

app.include_router(api_router, prefix="/api/v1")


_retention_task: asyncio.Task | None = None


@app.on_event("startup")
def on_startup():
    Base.metadata.create_all(bind=engine)
    _bootstrap_initial_admin()


@app.on_event("startup")
async def _start_retention_sweeper():
    """Enforces the identity-media retention window automatically, so retention doesn't
    silently depend on someone remembering to POST /interviews/cleanup-expired-media. Runs
    in-process on the single uvicorn worker; disable via RETENTION_SWEEP_ENABLED and use the
    standalone job (app.jobs.run_retention_sweep) under external cron for multi-worker setups.
    Registered after on_startup, so create_all has already run before the first sweep."""
    if not settings.retention_sweep_enabled:
        return
    global _retention_task
    _retention_task = asyncio.create_task(_retention_sweep_loop())


async def _retention_sweep_loop():
    interval_seconds = max(1, settings.retention_sweep_interval_hours) * 3600
    while True:
        try:
            # Sync SQLAlchemy/psycopg2 work — off the event loop so it can't block requests.
            await run_in_threadpool(_run_retention_sweep_once)
        except Exception:  # noqa: BLE001 - a failed cycle must never kill the recurring loop
            logger.exception("retention sweep cycle failed")
        await asyncio.sleep(interval_seconds)


def _run_retention_sweep_once():
    db = SessionLocal()
    try:
        purge_expired_identity_media(db)
    finally:
        db.close()


@app.on_event("shutdown")
async def _stop_retention_sweeper():
    if _retention_task is not None:
        _retention_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await _retention_task


def _bootstrap_initial_admin():
    """Creates the very first HR user from env vars if no users exist yet — there's no
    signup flow, so without this a fresh database has no way to log in and create one."""
    if not settings.initial_admin_email or not settings.initial_admin_password:
        return

    db = SessionLocal()
    try:
        if db.query(User).first() is not None:
            return
        db.add(User(
            email=settings.initial_admin_email.strip().lower(),
            password_hash=bcrypt.hashpw(
                settings.initial_admin_password.encode(), bcrypt.gensalt()
            ).decode(),
            display_name="Admin",
            is_admin=True,
        ))
        db.commit()
    finally:
        db.close()


@app.get("/health")
def health():
    return {"status": "ok"}
