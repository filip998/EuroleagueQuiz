from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class AuthUser(BaseModel):
    id: str
    username: str
    email: str
    display_name: str | None = None
    avatar_url: str | None = None
    role: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class LinkGuestRequest(BaseModel):
    guest_id: str | None = Field(
        default=None,
        description="Opaque client guest id from identity.js; normalized by the service.",
    )


class LinkGuestResponse(BaseModel):
    guest_id: str
    status: Literal["linked", "already_linked"]
