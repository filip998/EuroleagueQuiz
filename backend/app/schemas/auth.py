from datetime import datetime

from pydantic import BaseModel


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
