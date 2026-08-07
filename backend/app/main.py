import os

import bcrypt
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.sessions import SessionMiddleware

from app.api.v1 import api_router
from app.core.config import settings
from app.db.session import Base, SessionLocal, engine
from app import models  # noqa: F401 - ensures models are registered on Base before create_all
from app.models.user import User

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


@app.on_event("startup")
def on_startup():
    Base.metadata.create_all(bind=engine)
    _bootstrap_initial_admin()


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
