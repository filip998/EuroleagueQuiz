from pydantic import BaseModel, Field


class PhotoSoloRoundRequest(BaseModel):
    recent_player_ids: list[int] = Field(default_factory=list)


class PhotoSoloGuessRequest(BaseModel):
    round_token: str
    player_id: int = Field(gt=0)


class PhotoSoloRevealRequest(BaseModel):
    round_token: str
