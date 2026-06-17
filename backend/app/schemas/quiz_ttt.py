from typing import Literal, Optional

from pydantic import BaseModel, Field


class TicTacToeCreateGameRequest(BaseModel):
    mode: Literal["single_player", "local_two_player", "online_friend"] = "single_player"
    target_wins: Literal[2, 3, 5] = 3
    timer_mode: Literal["15s", "40s", "unlimited"] = "40s"
    player1_name: Optional[str] = None
    player2_name: Optional[str] = None
    guest_id: Optional[str] = None


class TicTacToeMoveRequest(BaseModel):
    row_index: int = Field(ge=0, le=2)
    col_index: int = Field(ge=0, le=2)
    player_id: int = Field(gt=0)


class TicTacToeDrawResponseRequest(BaseModel):
    accept: bool


class TicTacToeJoinGameRequest(BaseModel):
    join_code: str = Field(min_length=6, max_length=6)
    player_name: Optional[str] = None
    guest_id: Optional[str] = None


class TicTacToeQuickMatchRequest(BaseModel):
    preset: str
    player_name: Optional[str] = None
    guest_id: Optional[str] = None


class TicTacToeQuickMatchCancelRequest(BaseModel):
    preset: str
    game_id: int
    guest_id: Optional[str] = None


class TicTacToeQuickMatchPoolCounts(BaseModel):
    searching: int = Field(ge=0)
    in_progress: int = Field(ge=0)


class TicTacToeQuickMatchPoolsResponse(BaseModel):
    pools: dict[str, TicTacToeQuickMatchPoolCounts]
    poll_interval_seconds: int = Field(gt=0)
