from pydantic import BaseModel
from typing import Optional, List


class TeamBrief(BaseModel):
    id: int
    euroleague_code: str
    name: str
    model_config = {"from_attributes": True}


class SeasonBase(BaseModel):
    id: int
    year: int
    name: str
    champion_team_id: Optional[int] = None
    model_config = {"from_attributes": True}


class SeasonDetail(SeasonBase):
    champion_team: Optional[TeamBrief] = None
    teams: List[TeamBrief] = []
