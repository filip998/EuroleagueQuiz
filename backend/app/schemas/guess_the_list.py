from typing import Literal, Optional

from pydantic import BaseModel, Field


class GuessTheListCreateRequest(BaseModel):
    mode: Literal["single_player", "local_two_player", "online_friend"] = "single_player"
    target_wins: Literal[2, 3, 5] = 3
    timer_mode: Literal["15s", "40s", "unlimited"] = "40s"
    player1_name: Optional[str] = None
    player2_name: Optional[str] = None
    season_range_start: int = Field(ge=2000, le=2030)
    season_range_end: int = Field(ge=2000, le=2030)
    guest_id: Optional[str] = None


class GuessTheListGuessRequest(BaseModel):
    player_id: int = Field(gt=0)
    round_number: Optional[int] = Field(default=None, gt=0)


class GuessTheListEndResponseRequest(BaseModel):
    accept: bool


class GuessTheListJoinRequest(BaseModel):
    join_code: str = Field(min_length=6, max_length=6)
    player_name: Optional[str] = None
    guest_id: Optional[str] = None


class GuessTheListRaceCreateRequest(BaseModel):
    target_wins: Literal[1, 2, 3] = 2
    player1_name: Optional[str] = None
    season_range_start: int = Field(ge=2000, le=2030)
    season_range_end: int = Field(ge=2000, le=2030)
    guest_id: Optional[str] = None


class GuessTheListRaceJoinRequest(BaseModel):
    join_code: str = Field(min_length=6, max_length=6)
    player_name: Optional[str] = None
    guest_id: Optional[str] = None


class GuessTheListQuickMatchRequest(BaseModel):
    preset: str
    player_name: Optional[str] = None
    guest_id: Optional[str] = None


class GuessTheListQuickMatchCancelRequest(BaseModel):
    preset: str
    game_id: int
    guest_id: Optional[str] = None


class GuessTheListQuickMatchPoolCounts(BaseModel):
    searching: int = Field(ge=0)
    in_progress: int = Field(ge=0)


class GuessTheListQuickMatchPoolsResponse(BaseModel):
    pools: dict[str, GuessTheListQuickMatchPoolCounts]
    poll_interval_seconds: int = Field(gt=0)
