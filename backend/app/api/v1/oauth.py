from authlib.integrations.starlette_client import OAuth
from fastapi import APIRouter, Depends, Request
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.session import get_db
from app.models.user import User
from app.services.auth_session import COOKIE_NAME, SESSION_TTL_SECONDS, create_session_cookie

router = APIRouter(prefix="/auth", tags=["auth"])

# An additional way for EXISTING HR users to log in — never a way to create new ones.
# Whoever authenticates only gets a session if their verified email already matches an
# active row in `users` (created the normal way, by an admin on the HR Users page).
# Anyone can have a Google/Microsoft account, so OAuth alone must never be enough to
# self-register as HR.
oauth = OAuth()

# A provider is only registered — and only then usable — once BOTH its id and secret are
# set. The /login routes below must gate on these same two flags (not just client_id) or a
# half-configured provider (id set, secret still blank) passes the gate but was never
# actually registered, and accessing oauth.<provider> then raises AttributeError.
GOOGLE_CONFIGURED = bool(settings.google_client_id and settings.google_client_secret)
MICROSOFT_CONFIGURED = bool(settings.microsoft_client_id and settings.microsoft_client_secret)

if GOOGLE_CONFIGURED:
    oauth.register(
        name="google",
        client_id=settings.google_client_id,
        client_secret=settings.google_client_secret,
        server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
        client_kwargs={"scope": "openid email profile"},
    )

if MICROSOFT_CONFIGURED:
    oauth.register(
        name="microsoft",
        client_id=settings.microsoft_client_id,
        client_secret=settings.microsoft_client_secret,
        server_metadata_url="https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration",
        client_kwargs={"scope": "openid email profile"},
    )


def _redirect_uri(provider: str) -> str:
    return f"{settings.oauth_redirect_base_url}/auth/{provider}/callback"


def _unconfigured(provider: str) -> RedirectResponse:
    return RedirectResponse(
        f"{settings.frontend_base_url}/login?error=oauth_not_configured&provider={provider}"
    )


@router.get("/google/login")
async def google_login(request: Request):
    if not GOOGLE_CONFIGURED:
        return _unconfigured("google")
    return await oauth.google.authorize_redirect(request, _redirect_uri("google"))


@router.get("/microsoft/login")
async def microsoft_login(request: Request):
    if not MICROSOFT_CONFIGURED:
        return _unconfigured("microsoft")
    return await oauth.microsoft.authorize_redirect(request, _redirect_uri("microsoft"))


async def _handle_callback(request: Request, provider: str, db: Session) -> RedirectResponse:
    client = oauth.create_client(provider)
    if client is None:
        # Provider never registered (not configured, or someone hits the callback URL
        # directly without going through /login first) — create_client returns None here
        # rather than raising, so this must be checked explicitly before use.
        return _unconfigured(provider)
    token = await client.authorize_access_token(request)
    userinfo = token.get("userinfo") or {}
    email = (userinfo.get("email") or "").strip().lower()

    if not email:
        return RedirectResponse(f"{settings.frontend_base_url}/login?error=no_email")

    user = db.query(User).filter(User.email == email).first()
    if not user or not user.is_active:
        return RedirectResponse(f"{settings.frontend_base_url}/login?error=not_registered")

    response = RedirectResponse(f"{settings.frontend_base_url}/jobs")
    response.set_cookie(
        key=COOKIE_NAME,
        value=create_session_cookie(user.id, user.email),
        max_age=SESSION_TTL_SECONDS,
        httponly=True,
        samesite="lax",
        secure=False,
    )
    return response


@router.get("/google/callback")
async def google_callback(request: Request, db: Session = Depends(get_db)):
    return await _handle_callback(request, "google", db)


@router.get("/microsoft/callback")
async def microsoft_callback(request: Request, db: Session = Depends(get_db)):
    return await _handle_callback(request, "microsoft", db)
