from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy.sql.expression import func

from app.database import get_db
from app.models import Player, PlayerSeasonTeam, PlayerSeasonStats, Team, Season
from app.schemas.player import PlayerDetail, SeasonStatsEntry

router = APIRouter()


@router.get("/random-player")
def random_player(db: Session = Depends(get_db)):
    """Return a random player with career stats for 'guess who' games."""
    player = db.query(Player).order_by(func.random()).first()
    if not player:
        raise HTTPException(status_code=404, detail="No players found")

    seasons = _build_season_entries(db, player.id)
    return PlayerDetail(
        id=player.id,
        euroleague_code=player.euroleague_code,
        first_name=player.first_name,
        last_name=player.last_name,
        birth_date=player.birth_date,
        nationality=player.nationality,
        height_cm=player.height_cm,
        position=player.position,
        seasons=seasons,
    )


@router.get("/roster/{team_code}/{season_year}")
def roster(team_code: str, season_year: int, db: Session = Depends(get_db)):
    """Return full roster for a team in a season."""
    team = db.query(Team).filter(Team.euroleague_code == team_code).first()
    if not team:
        raise HTTPException(status_code=404, detail="Team not found")

    season = db.query(Season).filter(Season.year == season_year).first()
    if not season:
        raise HTTPException(status_code=404, detail="Season not found")

    psts = (
        db.query(PlayerSeasonTeam)
        .filter(
            PlayerSeasonTeam.team_id == team.id,
            PlayerSeasonTeam.season_id == season.id,
        )
        .all()
    )

    roster_list = []
    for pst in psts:
        p = pst.player
        stats = pst.stats
        roster_list.append({
            "player_id": p.id,
            "first_name": p.first_name,
            "last_name": p.last_name,
            "position": p.position,
            "nationality": p.nationality,
            "jersey_number": pst.jersey_number,
            "games_played": stats.games_played if stats else 0,
            "points": stats.points if stats else 0,
            "total_rebounds": stats.total_rebounds if stats else 0,
            "assists": stats.assists if stats else 0,
            "pir": stats.pir if stats else 0,
        })

    return {
        "team_code": team.euroleague_code,
        "team_name": team.name,
        "season_year": season.year,
        "players": roster_list,
    }


@router.get("/player-clubs/{player_id}")
def player_clubs(player_id: int, db: Session = Depends(get_db)):
    """Return all clubs a player played for."""
    player = db.query(Player).filter(Player.id == player_id).first()
    if not player:
        raise HTTPException(status_code=404, detail="Player not found")

    psts = (
        db.query(PlayerSeasonTeam)
        .join(Team)
        .join(Season)
        .filter(PlayerSeasonTeam.player_id == player_id)
        .order_by(Season.year.desc())
        .all()
    )

    seen = set()
    clubs = []
    for pst in psts:
        key = pst.team.euroleague_code
        if key not in seen:
            seen.add(key)
            clubs.append({
                "team_code": pst.team.euroleague_code,
                "team_name": pst.team.name,
                "seasons": [],
            })
        # Add season to the matching club entry
        for club in clubs:
            if club["team_code"] == key:
                club["seasons"].append(pst.season.year)
                break

    return {
        "player_id": player.id,
        "first_name": player.first_name,
        "last_name": player.last_name,
        "clubs": clubs,
    }


STAT_COLUMN_MAP = {
    "points": PlayerSeasonStats.points,
    "rebounds": PlayerSeasonStats.total_rebounds,
    "assists": PlayerSeasonStats.assists,
    "steals": PlayerSeasonStats.steals,
    "blocks": PlayerSeasonStats.blocks_favor,
    "pir": PlayerSeasonStats.pir,
}


@router.get("/season-leaders/{season_year}/{stat}")
def season_leaders(season_year: int, stat: str, db: Session = Depends(get_db)):
    """Return top 10 players in a stat category for a season."""
    if stat not in STAT_COLUMN_MAP:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid stat. Choose from: {', '.join(STAT_COLUMN_MAP.keys())}",
        )

    season = db.query(Season).filter(Season.year == season_year).first()
    if not season:
        raise HTTPException(status_code=404, detail="Season not found")

    stat_col = STAT_COLUMN_MAP[stat]
    results = (
        db.query(PlayerSeasonStats, PlayerSeasonTeam, Player, Team)
        .join(PlayerSeasonTeam, PlayerSeasonStats.player_season_team_id == PlayerSeasonTeam.id)
        .join(Player, PlayerSeasonTeam.player_id == Player.id)
        .join(Team, PlayerSeasonTeam.team_id == Team.id)
        .filter(PlayerSeasonTeam.season_id == season.id)
        .order_by(stat_col.desc())
        .limit(10)
        .all()
    )

    leaders = []
    for pss, pst, player, team in results:
        leaders.append({
            "rank": len(leaders) + 1,
            "player_id": player.id,
            "first_name": player.first_name,
            "last_name": player.last_name,
            "team_code": team.euroleague_code,
            "team_name": team.name,
            "value": getattr(pss, stat_col.key),
        })

    return {
        "season_year": season_year,
        "stat": stat,
        "leaders": leaders,
    }


def _build_season_entries(db: Session, player_id: int) -> List[SeasonStatsEntry]:
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
