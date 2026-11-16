from typing import Optional

from pydantic import BaseModel


# ---- inputs ----
class GmailSlotIn(BaseModel):
    sender_email: str = ""
    from_name: Optional[str] = None
    password: str = ""  # blank keeps the previously saved one
    host: Optional[str] = None
    port: Optional[int] = None
    use_tls: bool = True


class OutlookSlotIn(BaseModel):
    sender_email: str = ""
    from_name: Optional[str] = None
    tenant_id: Optional[str] = None
    client_id: Optional[str] = None
    client_secret: str = ""  # blank keeps the previously saved one


class SmtpConfigIn(BaseModel):
    active: Optional[str] = None  # "gmail" | "outlook"
    gmail: Optional[GmailSlotIn] = None
    outlook: Optional[OutlookSlotIn] = None


class SmtpTestRequest(BaseModel):
    account: Optional[str] = None  # which slot to test; default = active
    recipient_email: str = ""  # blank self-sends to that account's sender


# ---- status (no secrets) ----
class GmailSlotStatus(BaseModel):
    configured: bool
    sender_email: Optional[str] = None
    from_name: Optional[str] = None
    host: Optional[str] = None
    port: Optional[int] = None
    use_tls: bool = True
    has_password: bool = False


class OutlookSlotStatus(BaseModel):
    configured: bool
    sender_email: Optional[str] = None
    from_name: Optional[str] = None
    tenant_id: Optional[str] = None
    client_id: Optional[str] = None
    has_client_secret: bool = False


class SmtpConfigStatus(BaseModel):
    active: Optional[str] = None
    gmail: GmailSlotStatus
    outlook: OutlookSlotStatus
