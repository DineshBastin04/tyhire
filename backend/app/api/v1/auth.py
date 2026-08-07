import uuid

import bcrypt
from fastapi import APIRouter, Cookie, Depends, HTTPException, Response
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models.candidate import Candidate
from app.models.user import User
from app.schemas.user import LoginRequest, UserCreate, UserOut
from app.services.auth_session import (
    COOKIE_NAME,
    SESSION_TTL_SECONDS,
    create_session_cookie,
    verify_session_cookie,
)

router = APIRouter(prefix="/auth", tags=["auth"])


def require_hr_auth(hr_session: str | None = Cookie(default=None)) -> dict:
    identity = verify_session_cookie(hr_session)
    if not identity:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return identity


def require_admin(
    identity: dict = Depends(require_hr_auth), db: Session = Depends(get_db)
) -> User:
    """Looked up fresh from the DB rather than trusting the (stateless, signed-once-at-
    login) session cookie — admin status can change after a cookie is issued, and this way
    a demoted or deleted user's existing cookie can't keep exercising admin-only actions."""
    user = db.get(User, identity["user_id"])
    if not user or not user.is_active or not user.is_admin:
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


@router.post("/login")
def login(payload: LoginRequest, response: Response, db: Session = Depends(get_db)):
    email = payload.email.strip().lower()
    user = db.query(User).filter(User.email == email).first()

    # Compare against a real hash if the user exists, or a dummy one if not — keeps the
    # bcrypt work roughly constant either way rather than short-circuiting on "no such user",
    # which would let a caller distinguish valid from invalid emails by response timing.
    hash_to_check = user.password_hash if user else bcrypt.gensalt().decode()
    password_ok = bcrypt.checkpw(payload.password.encode(), hash_to_check.encode())

    if not user or not user.is_active or not password_ok:
        raise HTTPException(status_code=401, detail="Incorrect email or password")

    response.set_cookie(
        key=COOKIE_NAME,
        value=create_session_cookie(user.id, user.email),
        max_age=SESSION_TTL_SECONDS,
        httponly=True,
        samesite="lax",
        # Not marked Secure: this needs to work over plain-HTTP localhost during dev, not
        # just behind an HTTPS tunnel. Turn this on if deploying somewhere HTTPS-only.
        secure=False,
    )
    return {"ok": True}


@router.post("/logout")
def logout(response: Response):
    response.delete_cookie(COOKIE_NAME)
    return {"ok": True}


@router.get("/me")
def me(identity: dict = Depends(require_hr_auth), db: Session = Depends(get_db)):
    user = db.get(User, identity["user_id"])
    return {
        "authenticated": True,
        "email": identity["email"],
        "is_admin": bool(user and user.is_admin),
    }


@router.post("/users", response_model=UserOut)
def create_user(
    payload: UserCreate,
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    email = payload.email.strip().lower()
    if db.query(User).filter(User.email == email).first():
        raise HTTPException(status_code=409, detail="A user with that email already exists")

    user = User(
        email=email,
        password_hash=bcrypt.hashpw(payload.password.encode(), bcrypt.gensalt()).decode(),
        display_name=payload.display_name,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@router.get("/users", response_model=list[UserOut])
def list_users(db: Session = Depends(get_db), _identity: dict = Depends(require_hr_auth)):
    return db.query(User).order_by(User.created_at).all()


@router.delete("/users/{user_id}")
def delete_user(
    user_id: uuid.UUID,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    if user_id == admin.id:
        raise HTTPException(status_code=400, detail="You can't delete your own account.")

    target = db.get(User, user_id)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")

    if target.is_admin:
        remaining_admins = (
            db.query(User).filter(User.is_admin.is_(True), User.id != user_id).count()
        )
        if remaining_admins == 0:
            raise HTTPException(
                status_code=400, detail="Can't delete the last remaining admin account."
            )

    # Uploader attribution is audit metadata, not candidate data — nulling it out (rather
    # than blocking the delete) keeps every candidate record intact even once the account
    # that uploaded it is gone, same reasoning as AuditLog.candidate_id's ON DELETE SET NULL.
    db.query(Candidate).filter(Candidate.uploaded_by_user_id == user_id).update(
        {"uploaded_by_user_id": None}
    )

    db.delete(target)
    db.commit()
    return {"deleted": True}
