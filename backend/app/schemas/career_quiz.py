from typing import Literal

from pydantic import BaseModel, Field


class CareerSoloRoundRequest(BaseModel):
    recent_player_ids: list[int] = Field(default_factory=list)


class CareerSoloGuessRequest(BaseModel):
    round_token: str
    player_id: int = Field(gt=0)


class CareerSoloRevealRequest(BaseModel):
    round_token: str


class CareerQuizCreateRequest(BaseModel):
    target_wins: Literal[1, 3, 5, 7] = 3
    wrong_guess_visibility: Literal["private", "shared"] = "private"
    player1_name: str | None = None


class CareerQuizJoinRequest(BaseModel):
    join_code: str = Field(min_length=6, max_length=6)
    player_name: str | None = None


class CareerQuizGuessRequest(BaseModel):
    player_id: int = Field(gt=0)
    round_number: int = Field(gt=0)


class CareerQuizNoAnswerOfferRequest(BaseModel):
    round_number: int = Field(gt=0)


class CareerQuizNoAnswerResponseRequest(BaseModel):
    accept: bool
    round_number: int = Field(gt=0)
