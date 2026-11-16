"""Global email configuration + sending for the consolidated report (TYH-003).

Holds up to two sender accounts at once — a "gmail" slot (classic SMTP: Gmail, or any SMTP
server via the manual host/port) and an "outlook" slot (Microsoft 365 / Outlook via the
Microsoft Graph API, app-only client-credentials flow) — plus `active`, which picks the one
that actually sends. Saved as a JSON file in the mounted storage volume (not .env, which
Docker only reads at `up` time and never mounts writable), read at send time, so changes take
effect immediately with no restart.

Outlook needs an Azure AD app (tenant id / client id / client secret) with the Mail.Send
*application* permission + admin consent; the sender must be a real mailbox in that tenant.
Microsoft disables basic SMTP auth, so there's no password path for it.

Secrets (SMTP app password, Graph client secret) are encrypted at rest with the same Fernet
key used for stored media (STORAGE_ENCRYPTION_KEY) when it's set; otherwise stored as-is on
the local storage volume.
"""
import base64
import json
import logging
import os
import smtplib
import ssl
import urllib.error
import urllib.parse
import urllib.request
from email.message import EmailMessage

from app.core.config import settings

logger = logging.getLogger(__name__)

CONFIG_PATH = os.path.join(settings.storage_root, "smtp_config.json")

_SMTP_HOSTS = {
    "gmail.com": ("smtp.gmail.com", 587),
    "googlemail.com": ("smtp.gmail.com", 587),
}
_GRAPH_SCOPE = "https://graph.microsoft.com/.default"


class SmtpNotConfiguredError(Exception):
    """No usable email configuration exists for the requested account."""


class SmtpSendError(Exception):
    """The provider rejected the message or couldn't be reached."""


# --- secret encryption ----------------------------------------------------------------------
def _fernet():
    if not settings.storage_encryption_key:
        return None
    from cryptography.fernet import Fernet

    return Fernet(settings.storage_encryption_key.encode())


def _encrypt(value: str) -> dict:
    f = _fernet()
    if f:
        return {"enc": True, "value": f.encrypt(value.encode()).decode()}
    return {"enc": False, "value": value}


def _decrypt(blob: dict | None) -> str:
    if not blob:
        return ""
    if blob.get("enc"):
        f = _fernet()
        if not f:
            raise SmtpSendError(
                "A saved secret was encrypted, but STORAGE_ENCRYPTION_KEY is no longer set — "
                "re-save the settings in Email settings."
            )
        return f.decrypt(blob["value"].encode()).decode()
    return blob.get("value", "")


def _keep_or_encrypt(new_value: str | None, existing_blob: dict | None) -> dict | None:
    """A blank new secret keeps the previously saved one."""
    if new_value:
        return _encrypt(new_value)
    return existing_blob


# --- load / save ----------------------------------------------------------------------------
def _migrate(cfg: dict) -> dict:
    """Convert the earlier single-slot format ({provider, sender_email, password, ...}) into the
    two-slot format ({active, gmail, outlook}) so previously saved accounts aren't lost."""
    if not cfg or "gmail" in cfg or "outlook" in cfg or "active" in cfg:
        return cfg  # already two-slot (or empty)
    if not cfg.get("sender_email"):
        return cfg
    provider = (cfg.get("provider") or "").lower()
    if not provider:
        provider = "outlook" if (cfg.get("tenant_id") or cfg.get("client_id")) else "gmail"
    if provider == "outlook":
        return {
            "active": "outlook",
            "outlook": {
                "sender_email": cfg.get("sender_email"),
                "from_name": cfg.get("from_name"),
                "tenant_id": cfg.get("tenant_id"),
                "client_id": cfg.get("client_id"),
                "client_secret": cfg.get("client_secret"),
            },
        }
    return {
        "active": "gmail",
        "gmail": {
            "sender_email": cfg.get("sender_email"),
            "from_name": cfg.get("from_name"),
            "password": cfg.get("password"),
            "host": cfg.get("host"),
            "port": cfg.get("port"),
            "use_tls": cfg.get("use_tls", True),
        },
    }


def load_config() -> dict:
    if not os.path.exists(CONFIG_PATH):
        return {}
    try:
        with open(CONFIG_PATH, encoding="utf-8") as fh:
            return _migrate(json.load(fh))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("Could not read SMTP config at %s: %s", CONFIG_PATH, exc)
        return {}


def _write_config(config: dict) -> None:
    os.makedirs(settings.storage_root, exist_ok=True)
    tmp_path = CONFIG_PATH + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as fh:
        json.dump(config, fh)
    os.replace(tmp_path, CONFIG_PATH)
    try:
        os.chmod(CONFIG_PATH, 0o600)
    except OSError:
        pass


def _smtp_host_port(slot: dict) -> tuple[str | None, int]:
    host = (slot.get("host") or "").strip() or None
    port = slot.get("port")
    if not host:
        domain = (slot.get("sender_email", "").rsplit("@", 1)[-1] or "").lower()
        host, detected_port = _SMTP_HOSTS.get(domain, (None, None))
        if not port:
            port = detected_port
    return host, int(port) if port else 587


def _build_gmail_slot(fields: dict, existing: dict | None) -> dict:
    pwd_blob = _keep_or_encrypt(fields.get("password"), (existing or {}).get("password"))
    if not pwd_blob:
        raise ValueError("The Gmail / SMTP account needs an app password.")
    return {
        "sender_email": fields["sender_email"].strip(),
        "from_name": (fields.get("from_name") or "").strip() or None,
        "password": pwd_blob,
        "host": (fields.get("host") or "").strip() or None,
        "port": int(fields["port"]) if fields.get("port") else None,
        "use_tls": bool(fields.get("use_tls", True)),
    }


def _build_outlook_slot(fields: dict, existing: dict | None) -> dict:
    secret_blob = _keep_or_encrypt(fields.get("client_secret"), (existing or {}).get("client_secret"))
    tenant_id = (fields.get("tenant_id") or "").strip()
    client_id = (fields.get("client_id") or "").strip()
    if not tenant_id or not client_id or not secret_blob:
        raise ValueError("The Outlook account needs a tenant ID, client ID, and client secret.")
    return {
        "sender_email": fields["sender_email"].strip(),
        "from_name": (fields.get("from_name") or "").strip() or None,
        "tenant_id": tenant_id,
        "client_id": client_id,
        "client_secret": secret_blob,
    }


def save_all(*, active: str | None, gmail: dict | None, outlook: dict | None) -> None:
    """Rewrite the whole config from the submitted form state. A slot with a non-empty
    sender_email is (re)saved (blank secret keeps the stored one); a slot with no sender_email
    is cleared. `active` must name a configured slot — otherwise the first configured one is
    used, or None when nothing is configured."""
    existing = load_config()
    config: dict = {}

    if gmail and (gmail.get("sender_email") or "").strip():
        config["gmail"] = _build_gmail_slot(gmail, existing.get("gmail"))
    if outlook and (outlook.get("sender_email") or "").strip():
        config["outlook"] = _build_outlook_slot(outlook, existing.get("outlook"))

    if active not in ("gmail", "outlook") or active not in config:
        active = next((k for k in ("gmail", "outlook") if k in config), None)
    config["active"] = active
    _write_config(config)


def _slot_status(slot: dict | None, kind: str) -> dict:
    if not slot:
        base = {"configured": False, "sender_email": None, "from_name": None}
        if kind == "gmail":
            base.update({"host": None, "port": None, "use_tls": True, "has_password": False})
        else:
            base.update({"tenant_id": None, "client_id": None, "has_client_secret": False})
        return base
    if kind == "gmail":
        host, port = _smtp_host_port(slot)
        return {
            "configured": True,
            "sender_email": slot.get("sender_email"),
            "from_name": slot.get("from_name"),
            "host": host,
            "port": port,
            "use_tls": slot.get("use_tls", True),
            "has_password": bool(slot.get("password")),
        }
    return {
        "configured": True,
        "sender_email": slot.get("sender_email"),
        "from_name": slot.get("from_name"),
        "tenant_id": slot.get("tenant_id"),
        "client_id": slot.get("client_id"),
        "has_client_secret": bool(slot.get("client_secret")),
    }


def get_status() -> dict:
    """Full config view WITHOUT any secrets — safe for the UI. Secret presence is reported as
    has_password / has_client_secret flags."""
    cfg = load_config()
    return {
        "active": cfg.get("active"),
        "gmail": _slot_status(cfg.get("gmail"), "gmail"),
        "outlook": _slot_status(cfg.get("outlook"), "outlook"),
    }


# --- sending --------------------------------------------------------------------------------
def send_email(
    *,
    to_email: str,
    subject: str,
    body_text: str,
    attachments: list[tuple[str, bytes, str, str]] | None = None,
    account: str | None = None,
) -> None:
    """Send from a configured account (default: the active one). `attachments` items are
    (filename, content_bytes, maintype, subtype). Raises SmtpNotConfiguredError if the chosen
    account isn't set up, or SmtpSendError on a send failure."""
    cfg = load_config()
    kind = account or cfg.get("active")
    if kind not in ("gmail", "outlook"):
        raise SmtpNotConfiguredError("No sending account is configured. Set one up in Email settings.")
    slot = cfg.get(kind)
    if not slot:
        raise SmtpNotConfiguredError(f"The {kind} account isn't configured yet.")

    if kind == "outlook":
        _send_graph(slot, to_email, subject, body_text, attachments or [])
    else:
        _send_smtp(slot, to_email, subject, body_text, attachments or [])


def _send_smtp(slot, to_email, subject, body_text, attachments) -> None:
    host, port = _smtp_host_port(slot)
    if not host:
        raise SmtpNotConfiguredError(
            "Couldn't determine the SMTP server for this sender — set the host and port in "
            "Email settings."
        )
    sender = slot.get("sender_email")
    password = _decrypt(slot.get("password"))
    from_name = slot.get("from_name")

    msg = EmailMessage()
    msg["From"] = f"{from_name} <{sender}>" if from_name else sender
    msg["To"] = to_email
    msg["Subject"] = subject
    msg.set_content(body_text)
    for filename, content, maintype, subtype in attachments:
        msg.add_attachment(content, maintype=maintype, subtype=subtype, filename=filename)

    try:
        with smtplib.SMTP(host, port, timeout=30) as server:
            if slot.get("use_tls", True):
                server.starttls(context=ssl.create_default_context())
            server.login(sender, password)
            server.send_message(msg)
    except smtplib.SMTPAuthenticationError as exc:
        raise SmtpSendError(
            "SMTP authentication failed — check the sender email and app password. Gmail "
            "requires an app password (with 2-factor enabled), not your normal password."
        ) from exc
    except (smtplib.SMTPException, OSError) as exc:
        raise SmtpSendError(f"Couldn't send the email via {host}:{port} — {exc}") from exc

    logger.info("Email sent to %s via SMTP %s:%s", to_email, host, port)


def _graph_token(tenant_id: str, client_id: str, client_secret: str) -> str:
    data = urllib.parse.urlencode(
        {
            "client_id": client_id,
            "client_secret": client_secret,
            "scope": _GRAPH_SCOPE,
            "grant_type": "client_credentials",
        }
    ).encode()
    url = f"https://login.microsoftonline.com/{urllib.parse.quote(tenant_id)}/oauth2/v2.0/token"
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")
        try:
            detail = json.loads(detail).get("error_description", detail)
        except json.JSONDecodeError:
            pass
        raise SmtpSendError(f"Microsoft sign-in failed — {detail.splitlines()[0] if detail else exc}") from exc
    except (urllib.error.URLError, OSError) as exc:
        raise SmtpSendError(f"Couldn't reach Microsoft sign-in — {exc}") from exc

    token = payload.get("access_token")
    if not token:
        raise SmtpSendError("Microsoft sign-in returned no access token.")
    return token


def _send_graph(slot, to_email, subject, body_text, attachments) -> None:
    tenant_id = slot.get("tenant_id")
    client_id = slot.get("client_id")
    sender = slot.get("sender_email")
    if not (tenant_id and client_id and sender):
        raise SmtpNotConfiguredError("Outlook settings are incomplete — re-save them in Email settings.")
    client_secret = _decrypt(slot.get("client_secret"))
    if not client_secret:
        raise SmtpNotConfiguredError("The Outlook client secret is missing — re-save it in Email settings.")

    token = _graph_token(tenant_id, client_id, client_secret)

    graph_attachments = [
        {
            "@odata.type": "#microsoft.graph.fileAttachment",
            "name": filename,
            "contentType": f"{maintype}/{subtype}",
            "contentBytes": base64.b64encode(content).decode(),
        }
        for filename, content, maintype, subtype in attachments
    ]
    message = {
        "message": {
            "subject": subject,
            "body": {"contentType": "Text", "content": body_text},
            "toRecipients": [{"emailAddress": {"address": to_email}}],
            "attachments": graph_attachments,
        },
        "saveToSentItems": True,
    }
    url = f"https://graph.microsoft.com/v1.0/users/{urllib.parse.quote(sender)}/sendMail"
    req = urllib.request.Request(url, data=json.dumps(message).encode(), method="POST")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30):
            pass  # 202 Accepted, empty body
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")
        try:
            detail = json.loads(detail).get("error", {}).get("message", detail)
        except json.JSONDecodeError:
            pass
        hint = ""
        if exc.code in (401, 403):
            hint = " (check the Mail.Send application permission + admin consent, and that the sender is a mailbox in this tenant)"
        raise SmtpSendError(f"Microsoft Graph rejected the send — {detail.splitlines()[0] if detail else exc}{hint}") from exc
    except (urllib.error.URLError, OSError) as exc:
        raise SmtpSendError(f"Couldn't reach Microsoft Graph — {exc}") from exc

    logger.info("Email sent to %s via Microsoft Graph (sender %s)", to_email, sender)
