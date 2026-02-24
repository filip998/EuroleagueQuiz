from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Season, TeamSeason, Team
from app.schemas.season import SeasonBase, SeasonDetail, TeamBrief

router = APIRouter()


@router.get("/", response_model=List[SeasonBase])
def list_seasons(db: Session = Depends(get_db)):
    return db.query(Season).order_by(Season.year.desc()).all()


@router.get("/{year}", response_model=SeasonDetail)
def get_season(year: int, db: Session = Depends(get_db)):
    season = db.query(Season).filter(Season.year == year).first()
    if not season:
        raise HTTPException(status_code=404, detail="Season not found")

    team_seasons = (
        db.query(TeamSeason)
        .filter(TeamSeason.season_id == season.id)
        .all()
    )
    teams = [
        TeamBrief(
            id=ts.team.id,
            euroleague_code=ts.team.euroleague_code,
            name=ts.team_name_that_season or ts.team.name,
        )
        for ts in team_seasons
    ]

    return SeasonDetail(
        id=season.id,
        year=season.year,
        name=season.name,
        champion_team_id=season.champion_team_id,
        champion_team=(
            TeamBrief(
                id=season.champion_team.id,
                euroleague_code=season.champion_team.euroleague_code,
                name=season.champion_team.name,
            )
            if season.champion_team
            else None
        ),
        teams=teams,
    )
