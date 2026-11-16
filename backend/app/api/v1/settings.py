import re

from fastapi import APIRouter, Depends, HTTPException

from app.api.v1.auth import require_hr_auth
from app.schemas.settings import SmtpConfigIn, SmtpConfigStatus, SmtpTestRequest
from app.services import smtp_settings

# Any logged-in HR user may view/edit email settings and send a test (per product decision).
router = APIRouter(prefix="/settings", tags=["settings"], dependencies=[Depends(require_hr_auth)])

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


@router.get("/smtp", response_model=SmtpConfigStatus)
def get_smtp_settings():
    """Both account slots WITHOUT secrets, plus which one is active."""
    return smtp_settings.get_status()


@router.put("/smtp", response_model=SmtpConfigStatus)
def put_smtp_settings(payload: SmtpConfigIn):
    existing = smtp_settings.get_status()
    gmail = payload.gmail.model_dump() if payload.gmail else None
    outlook = payload.outlook.model_dump() if payload.outlook else None

    # Validate the Gmail / SMTP slot when it's being configured.
    if gmail and (gmail.get("sender_email") or "").strip():
        if not _EMAIL_RE.match(gmail["sender_email"].strip()):
            raise HTTPException(status_code=422, detail="Enter a valid Gmail / SMTP sender email.")
        port = gmail.get("port")
        if port is not None and not (1 <= port <= 65535):
            raise HTTPException(status_code=422, detail="SMTP port must be between 1 and 65535.")
        if (gmail.get("host") or "").strip() and not port:
            raise HTTPException(status_code=422, detail="Enter the SMTP port for the manual host.")
        if not existing["gmail"]["has_password"] and not (gmail.get("password") or "").strip():
            raise HTTPException(status_code=422, detail="Enter the Gmail / SMTP app password.")

    # Validate the Outlook slot when it's being configured.
    if outlook and (outlook.get("sender_email") or "").strip():
        if not _EMAIL_RE.match(outlook["sender_email"].strip()):
            raise HTTPException(status_code=422, detail="Enter a valid Outlook sender email.")
        if not (outlook.get("tenant_id") or "").strip() or not (outlook.get("client_id") or "").strip():
            raise HTTPException(status_code=422, detail="Outlook needs a tenant ID and a client ID.")
        if not existing["outlook"]["has_client_secret"] and not (outlook.get("client_secret") or "").strip():
            raise HTTPException(status_code=422, detail="Enter the Outlook client secret.")

    try:
        smtp_settings.save_all(active=payload.active, gmail=gmail, outlook=outlook)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return smtp_settings.get_status()


@router.post("/smtp/test")
def test_smtp_settings(payload: SmtpTestRequest):
    """Test one account's connection by connecting, authenticating, and sending a short test
    email. Defaults to the active account; a blank recipient self-sends to that account."""
    status = smtp_settings.get_status()
    account = payload.account or status["active"]
    if account not in ("gmail", "outlook") or not status[account]["configured"]:
        raise HTTPException(status_code=409, detail="That account isn't configured yet. Save it first.")

    recipient = payload.recipient_email.strip() or (status[account]["sender_email"] or "")
    if not _EMAIL_RE.match(recipient):
        raise HTTPException(status_code=422, detail="Enter a valid recipient email address.")

    try:
        smtp_settings.send_email(
            to_email=recipient,
            subject="TyHire SMTP connection test",
            body_text=(
                "This is a test. Connection successful.\n\n"
                "Your TyHire email settings are working correctly.\n\n"
                "— TyHire"
            ),
            account=account,
        )
    except smtp_settings.SmtpNotConfiguredError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except smtp_settings.SmtpSendError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return {"status": "sent", "recipient": recipient, "account": account}
