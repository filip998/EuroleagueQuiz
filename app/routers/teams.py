from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Team, TeamSeason, Season
from app.schemas.team import TeamBase, TeamDetail, SeasonBrief

router = APIRouter()


@router.get("/", response_model=List[TeamBase])
def list_teams(db: Session = Depends(get_db)):
    return db.query(Team).order_by(Team.name).all()


@router.get("/{code}", response_model=TeamDetail)
def get_team(code: str, db: Session = Depends(get_db)):
    team = db.query(Team).filter(Team.euroleague_code == code).first()
    if not team:
        raise HTTPException(status_code=404, detail="Team not found")

    team_seasons = (
        db.query(TeamSeason)
        .join(Season)
        .filter(TeamSeason.team_id == team.id)
        .order_by(Season.year.desc())
        .all()
    )
    seasons = [
        SeasonBrief(year=ts.season.year, name=ts.season.name)
        for ts in team_seasons
    ]

    return TeamDetail(
        id=team.id,
        euroleague_code=team.euroleague_code,
        name=team.name,
        country=team.country,
        logo_url=team.logo_url,
        seasons=seasons,
    )
