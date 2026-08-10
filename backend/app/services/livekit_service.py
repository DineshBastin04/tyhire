import time
from authlib.jose import jwt
from app.core.config import settings


def generate_livekit_token(room_name: str, identity: str, name: str) -> str | None:
    """Generates a signed LiveKit access token for a specific room and identity.
    Returns None if LiveKit credentials are not fully configured in settings."""
    if not settings.livekit_url or not settings.livekit_api_key or not settings.livekit_api_secret:
        return None

    header = {"alg": "HS256", "typ": "JWT"}
    now = int(time.time())
    payload = {
        "iss": settings.livekit_api_key,
        "sub": identity,
        "name": name,
        "nbf": now - 5,
        "exp": now + 4 * 60 * 60,  # 4 hours expiration
        "video": {
            "roomJoin": True,
            "room": room_name,
            "canPublish": True,
            "canSubscribe": True,
            "canPublishData": True,
            "name": name,
        },
    }
    # authlib encodes the JWT payload using HS256 signed with the api secret
    token = jwt.encode(header, payload, settings.livekit_api_secret)
    return token.decode("utf-8") if isinstance(token, bytes) else token
