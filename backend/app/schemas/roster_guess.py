from typing import Literal, Optional

from pydantic import BaseModel, Field


class RosterGuessCreateRequest(BaseModel):
    mode: Literal["single_player", "local_two_player", "online_friend"] = "single_player"
    target_wins: Literal[2, 3, 5] = 3
    timer_mode: Literal["15s", "40s", "unlimited"] = "40s"
    player1_name: Optional[str] = None
    player2_name: Optional[str] = None
    season_range_start: int = Field(ge=2000, le=2030)
    season_range_end: int = Field(ge=2000, le=2030)


class RosterGuessGuessRequest(BaseModel):
    player_id: int = Field(gt=0)


class RosterGuessEndResponseRequest(BaseModel):
    accept: bool


class RosterGuessJoinRequest(BaseModel):
    join_code: str = Field(min_length=6, max_length=6)
    player_name: Optional[str] = None
