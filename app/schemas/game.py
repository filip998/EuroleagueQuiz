from pydantic import BaseModel
from typing import Optional, List


class GameBase(BaseModel):
    id: int
    season_year: int
    euroleague_gamecode: int
    round: Optional[int] = None
    phase: Optional[str] = None
    game_date: Optional[str] = None
    home_team_code: str
    home_team_name: str
    away_team_code: str
    away_team_name: str
    home_score: Optional[int] = None
    away_score: Optional[int] = None
    model_config = {"from_attributes": True}


class BoxScoreEntry(BaseModel):
    player_id: int
    player_name: str
    team_code: str
    is_starter: bool = False
    minutes: Optional[str] = None
    points: int = 0
    total_rebounds: int = 0
    assists: int = 0
    steals: int = 0
    turnovers: int = 0
    model_config = {"from_attributes": True}


class GameDetail(GameBase):
    box_score: List[BoxScoreEntry] = []
