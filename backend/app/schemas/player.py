from pydantic import BaseModel
from typing import Optional, List
from datetime import date


class PlayerBase(BaseModel):
    id: int
    euroleague_code: str
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    birth_date: Optional[date] = None
    nationality: Optional[str] = None
    height_cm: Optional[int] = None
    position: Optional[str] = None
    model_config = {"from_attributes": True}


class SeasonStatsEntry(BaseModel):
    season_year: int
    season_name: str
    team_code: str
    team_name: str
    jersey_number: Optional[str] = None
    games_played: int = 0
    games_started: int = 0
    points: int = 0
    total_rebounds: int = 0
    assists: int = 0
    steals: int = 0
    turnovers: int = 0
    blocks_favor: int = 0
    pir: int = 0
    model_config = {"from_attributes": True}


class PlayerDetail(PlayerBase):
    seasons: List[SeasonStatsEntry] = []
