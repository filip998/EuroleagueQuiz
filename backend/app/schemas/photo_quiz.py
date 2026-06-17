from typing import Literal

from pydantic import BaseModel, Field


class PhotoSoloRoundRequest(BaseModel):
    recent_player_ids: list[int] = Field(default_factory=list)


class PhotoSoloGuessRequest(BaseModel):
    round_token: str
    player_id: int = Field(gt=0)


class PhotoSoloRevealRequest(BaseModel):
    round_token: str


class PhotoQuizCreateRequest(BaseModel):
    target_wins: Literal[1, 3, 5, 7] = 3
    wrong_guess_visibility: Literal["private", "shared"] = "private"
    player1_name: str | None = None
    guest_id: str | None = None


class PhotoQuizJoinRequest(BaseModel):
    join_code: str = Field(min_length=6, max_length=6)
    player_name: str | None = None
    guest_id: str | None = None


class PhotoQuizQuickMatchRequest(BaseModel):
    preset: str
    player_name: str | None = None
    guest_id: str | None = None


class PhotoQuizQuickMatchCancelRequest(BaseModel):
    preset: str
    game_id: int
    guest_id: str | None = None


class PhotoQuizQuickMatchPoolCounts(BaseModel):
    searching: int = Field(ge=0)
    in_progress: int = Field(ge=0)


class PhotoQuizQuickMatchPoolsResponse(BaseModel):
    pools: dict[str, PhotoQuizQuickMatchPoolCounts]
    poll_interval_seconds: int = Field(gt=0)


class PhotoQuizGuessRequest(BaseModel):
    player_id: int = Field(gt=0)
    round_number: int = Field(gt=0)


class PhotoQuizNoAnswerOfferRequest(BaseModel):
    round_number: int = Field(gt=0)


class PhotoQuizNoAnswerResponseRequest(BaseModel):
    accept: bool
    round_number: int = Field(gt=0)
    no_answer_offer_version: int = Field(gt=0)
