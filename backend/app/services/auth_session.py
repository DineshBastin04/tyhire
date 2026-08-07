import hashlib
import hmac
import time
import uuid

from app.core.config import settings

COOKIE_NAME = "hr_session"
SESSION_TTL_SECONDS = 7 * 24 * 3600

# Stateless signed cookie rather than a server-side session table: a DB-backed store would
# get wiped every time the dev server hot-reloads (uvicorn --reload restarts the process on
# every file save), logging HR out constantly. Signing with a secret means no server state
# is needed to verify it — the payload carries the identity itself (user_id + email) rather
# than a session id that would need a DB lookup to resolve.
#
# Field order matters for parsing: user_id (uuid, no dots) and expires_at (digits, no dots)
# come first so they can be split off unambiguously from the left; email is last since it's
# the only field that can itself contain dots.


def _signature(value: str) -> str:
    return hmac.new(settings.session_secret.encode(), value.encode(), hashlib.sha256).hexdigest()


def create_session_cookie(user_id: uuid.UUID, email: str) -> str:
    expires_at = str(int(time.time()) + SESSION_TTL_SECONDS)
    payload = f"{user_id}.{expires_at}.{email}"
    return f"{payload}.{_signature(payload)}"


def verify_session_cookie(cookie_value: str | None) -> dict | None:
    if not cookie_value or "." not in cookie_value:
        return None

    payload, _, signature = cookie_value.rpartition(".")
    if not payload or not hmac.compare_digest(signature, _signature(payload)):
        return None

    try:
        user_id_str, expires_at_str, email = payload.split(".", 2)
        if time.time() >= int(expires_at_str):
            return None
        return {"user_id": uuid.UUID(user_id_str), "email": email}
    except ValueError:
        return None
