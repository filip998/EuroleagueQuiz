from typing import Literal, Optional

from pydantic import BaseModel, Field


class HigherLowerCreateRequest(BaseModel):
    tier: Literal["easy", "medium", "hard"] = "easy"
    season_range_start: int = Field(ge=2007, le=2025)
    season_range_end: int = Field(ge=2007, le=2025)
    nickname: str = Field(min_length=1, max_length=30)


class HigherLowerAnswerRequest(BaseModel):
    choice: Literal["left", "right", "same"]


class PlayerCard(BaseModel):
    player_id: int
    name: str
    nationality: str | None = None


class PairInfo(BaseModel):
    left: PlayerCard
    right: PlayerCard
    category: str
    category_label: str


class HigherLowerCreateResponse(BaseModel):
    game_id: int
    pair: PairInfo


class HigherLowerAnswerResponse(BaseModel):
    correct: bool
    left_value: float
    right_value: float
    streak: int
    next_pair: PairInfo | None = None
    # Only present when game is over
    is_personal_best: bool | None = None
    leaderboard_position: int | None = None


class LeaderboardEntry(BaseModel):
    nickname: str
    streak: int
    played_at: str


class LeaderboardResponse(BaseModel):
    tier: str
    entries: list[LeaderboardEntry]
