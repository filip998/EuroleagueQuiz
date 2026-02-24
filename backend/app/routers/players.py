from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import or_

from app.database import get_db
from app.models import Player, PlayerSeasonTeam, PlayerSeasonStats, Season, Team
from app.schemas.player import PlayerBase, PlayerDetail, SeasonStatsEntry

router = APIRouter()


@router.get("/", response_model=List[PlayerBase])
def list_players(
    name: Optional[str] = Query(None, description="Search by name"),
    team_code: Optional[str] = Query(None, description="Filter by team code"),
    nationality: Optional[str] = Query(None, description="Filter by nationality"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
):
    q = db.query(Player)

    if name:
        pattern = f"%{name}%"
        q = q.filter(
            or_(
                Player.first_name.ilike(pattern),
                Player.last_name.ilike(pattern),
            )
        )

    if team_code:
        q = q.join(PlayerSeasonTeam).join(Team).filter(Team.euroleague_code == team_code)

    if nationality:
        q = q.filter(Player.nationality.ilike(f"%{nationality}%"))

    return q.order_by(Player.last_name, Player.first_name).offset(offset).limit(limit).all()


@router.get("/{player_id}", response_model=PlayerDetail)
def get_player(player_id: int, db: Session = Depends(get_db)):
    player = db.query(Player).filter(Player.id == player_id).first()
    if not player:
        raise HTTPException(status_code=404, detail="Player not found")

    return PlayerDetail(
        id=player.id,
        euroleague_code=player.euroleague_code,
        first_name=player.first_name,
        last_name=player.last_name,
        birth_date=player.birth_date,
        nationality=player.nationality,
        height_cm=player.height_cm,
        position=player.position,
        seasons=_get_season_stats(db, player.id),
    )


@router.get("/{player_id}/seasons", response_model=List[SeasonStatsEntry])
def get_player_seasons(player_id: int, db: Session = Depends(get_db)):
    player = db.query(Player).filter(Player.id == player_id).first()
    if not player:
        raise HTTPException(status_code=404, detail="Player not found")
    return _get_season_stats(db, player_id)


def _get_season_stats(db: Session, player_id: int) -> List[SeasonStatsEntry]:
    psts = (
        db.query(PlayerSeasonTeam)
        .join(Season)
        .join(Team)
        .filter(PlayerSeasonTeam.player_id == player_id)
        .order_by(Season.year.desc())
        .all()
    )

    entries = []
    for pst in psts:
        stats = pst.stats
        entries.append(
            SeasonStatsEntry(
                season_year=pst.season.year,
                season_name=pst.season.name,
                team_code=pst.team.euroleague_code,
                team_name=pst.team.name,
                jersey_number=pst.jersey_number,
                games_played=stats.games_played if stats else 0,
                games_started=stats.games_started if stats else 0,
                points=stats.points if stats else 0,
                total_rebounds=stats.total_rebounds if stats else 0,
                assists=stats.assists if stats else 0,
                steals=stats.steals if stats else 0,
                turnovers=stats.turnovers if stats else 0,
                blocks_favor=stats.blocks_favor if stats else 0,
                pir=stats.pir if stats else 0,
            )
        )
    return entries
