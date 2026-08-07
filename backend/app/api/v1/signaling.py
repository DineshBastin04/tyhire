"""WebSocket relay the candidate's and interviewer's browsers use to set up their direct
WebRTC connection — swaps a handful of small messages (SDP offer/answer, ICE candidates)
then gets out of the way once the call is live. Message contents are never inspected or
stored; this is a plain mailbox between exactly two sockets per room.

Browsers can't send custom headers on a WebSocket handshake, so the join/interviewer token
travels as a query param here instead of the X-Interview-Token/X-Interviewer-Token headers
used everywhere else in interviews.py — same token values, checked the same way.

In-memory room registry assumes a single backend process. If this backend is ever run as
multiple replicas, this would need a shared layer (e.g. Redis pub/sub) instead — not needed
at today's scale.
"""

import secrets
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, Query, WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models.interview import InterviewSession
from app.services import video_provider

router = APIRouter(prefix="/interviews", tags=["signaling"])

_rooms: dict[str, dict[str, WebSocket]] = {}


def _authorize(
    db: Session, session_id: uuid.UUID, token: str, role: str
) -> InterviewSession | None:
    session = db.get(InterviewSession, session_id)
    if not session:
        return None
    if role == "candidate":
        if not secrets.compare_digest(session.join_token, token):
            return None
    elif role == "interviewer":
        if not session.interviewer_join_token or not secrets.compare_digest(
            session.interviewer_join_token, token
        ):
            return None
    else:
        return None
    return session


async def _safe_send(ws: WebSocket, message: dict) -> None:
    try:
        await ws.send_json(message)
    except Exception:
        pass


@router.websocket("/{session_id}/ws/signal")
async def signal(
    websocket: WebSocket,
    session_id: uuid.UUID,
    token: str = Query(...),
    role: Literal["candidate", "interviewer"] = Query(...),
    db: Session = Depends(get_db),
):
    session = _authorize(db, session_id, token, role)
    if not session:
        await websocket.close(code=4403)
        return

    room_id = video_provider.get_room_id(session)
    other_role = "interviewer" if role == "candidate" else "candidate"

    await websocket.accept()
    room = _rooms.setdefault(room_id, {})
    room[role] = websocket

    peer = room.get(other_role)
    if peer is not None:
        await _safe_send(peer, {"type": "peer-joined"})
        await websocket.send_json({"type": "peer-joined"})

    try:
        while True:
            message = await websocket.receive_json()
            peer = room.get(other_role)
            if peer is not None:
                await _safe_send(peer, message)
    except WebSocketDisconnect:
        pass
    finally:
        if room.get(role) is websocket:
            del room[role]
        peer = room.get(other_role)
        if peer is not None:
            await _safe_send(peer, {"type": "peer-left"})
        if not room:
            _rooms.pop(room_id, None)
