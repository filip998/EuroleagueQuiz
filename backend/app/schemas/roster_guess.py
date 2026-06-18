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
    guest_id: Optional[str] = None


class RosterGuessGuessRequest(BaseModel):
    player_id: int = Field(gt=0)
    round_number: Optional[int] = Field(default=None, gt=0)


class RosterGuessEndResponseRequest(BaseModel):
    accept: bool


class RosterGuessJoinRequest(BaseModel):
    join_code: str = Field(min_length=6, max_length=6)
    player_name: Optional[str] = None
    guest_id: Optional[str] = None


class RosterGuessRaceCreateRequest(BaseModel):
    target_wins: Literal[1, 3, 5] = 3
    player1_name: Optional[str] = None
    season_range_start: int = Field(ge=2000, le=2030)
    season_range_end: int = Field(ge=2000, le=2030)
    guest_id: Optional[str] = None


class RosterGuessQuickMatchRequest(BaseModel):
    preset: str
    player_name: Optional[str] = None
    guest_id: Optional[str] = None


class RosterGuessQuickMatchCancelRequest(BaseModel):
    preset: str
    game_id: int
    guest_id: Optional[str] = None


class RosterGuessQuickMatchPoolCounts(BaseModel):
    searching: int = Field(ge=0)
    in_progress: int = Field(ge=0)


class RosterGuessQuickMatchPoolsResponse(BaseModel):
    pools: dict[str, RosterGuessQuickMatchPoolCounts]
    poll_interval_seconds: int = Field(gt=0)
