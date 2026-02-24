from pydantic import BaseModel
from typing import Optional, List


class TeamBase(BaseModel):
    id: int
    euroleague_code: str
    name: str
    country: Optional[str] = None
    logo_url: Optional[str] = None
    model_config = {"from_attributes": True}


class SeasonBrief(BaseModel):
    year: int
    name: str
    model_config = {"from_attributes": True}


class PlayerInRoster(BaseModel):
    id: int
    euroleague_code: str
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    position: Optional[str] = None
    jersey_number: Optional[str] = None
    model_config = {"from_attributes": True}


class TeamDetail(TeamBase):
    seasons: List[SeasonBrief] = []
