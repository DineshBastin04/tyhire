"""Thin boundary between the app and whatever runs the live interview call.

Everything else in the codebase (the interview endpoints, the frontend) only ever goes
through the two functions below — never at WebRTC/coturn details directly. Today the call
is plain browser-to-browser WebRTC with our own signaling relay (api/v1/signaling.py) and a
self-hosted coturn TURN fallback. If this ever needs to move to a hosted SFU (panel
interviews, call volume past a couple thousand interviews/month, or a client uptime
requirement we can't self-host our way out of), only this file and the frontend's
WebRTCRoom.tsx should need to change — not the interview pages or endpoints that use them.

Recording is deliberately not part of this boundary: it already happens independently,
client-side (see InterviewRecorder in the candidate/interviewer pages), regardless of
whatever the live call is layered on top of.
"""

import base64
import hashlib
import hmac
import time
import uuid

from app.core.config import settings
from app.models.interview import InterviewSession


def get_room_id(session: InterviewSession) -> str:
    return session.video_room_token


def get_ice_servers() -> list[dict]:
    """STUN (free, public, no credentials needed) plus our own coturn TURN server with a
    short-lived credential — coturn's standard REST API credential scheme, so no shared
    long-term password has to be handed to the browser."""
    username, credential = _turn_credential()
    return [
        {"urls": "stun:stun.l.google.com:19302"},
        {
            "urls": [
                f"turn:{settings.turn_domain}:3478",
                f"turn:{settings.turn_domain}:3478?transport=tcp",
            ],
            "username": username,
            "credential": credential,
        },
    ]


def _turn_credential(ttl_seconds: int = 4 * 60 * 60) -> tuple[str, str]:
    expiry = int(time.time()) + ttl_seconds
    username = f"{expiry}:{uuid.uuid4().hex[:8]}"
    credential = hmac.new(
        settings.turn_secret.encode(), username.encode(), hashlib.sha1
    ).digest()
    return username, base64.b64encode(credential).decode()
