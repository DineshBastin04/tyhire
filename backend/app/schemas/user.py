import uuid
from typing import Optional

from pydantic import BaseModel


class LoginRequest(BaseModel):
    email: str
    password: str


class UserCreate(BaseModel):
    email: str
    password: str
    display_name: Optional[str] = None


class UserOut(BaseModel):
    id: uuid.UUID
    email: str
    display_name: Optional[str]
    is_active: bool
    is_admin: bool

    class Config:
        from_attributes = True
