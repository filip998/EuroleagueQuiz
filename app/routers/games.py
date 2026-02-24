from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Game, GamePlayerStats, Season, Team
from app.schemas.game import GameBase, GameDetail, BoxScoreEntry

router = APIRouter()


@router.get("/", response_model=List[GameBase])
def list_games(
    season_year: Optional[int] = Query(None, description="Filter by season year"),
    team_code: Optional[str] = Query(None, description="Filter by team code"),
    round: Optional[int] = Query(None, description="Filter by round"),
    phase: Optional[str] = Query(None, description="Filter by phase"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
):
    q = db.query(Game).join(Season).join(Team, Game.home_team_id == Team.id)

    if season_year:
        q = q.filter(Season.year == season_year)

    if team_code:
        home = db.query(Team).filter(Team.euroleague_code == team_code).first()
        if home:
            from sqlalchemy import or_
            q = q.filter(
                or_(Game.home_team_id == home.id, Game.away_team_id == home.id)
            )

    if round is not None:
        q = q.filter(Game.round == round)

    if phase:
        q = q.filter(Game.phase.ilike(f"%{phase}%"))

    games = q.order_by(Season.year.desc(), Game.round.desc()).offset(offset).limit(limit).all()

    return [_game_to_base(g) for g in games]


@router.get("/{game_id}", response_model=GameDetail)
def get_game(game_id: int, db: Session = Depends(get_db)):
    game = db.query(Game).filter(Game.id == game_id).first()
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")

    stats = (
        db.query(GamePlayerStats)
        .filter(GamePlayerStats.game_id == game_id)
        .all()
    )

    box_score = [
        BoxScoreEntry(
            player_id=s.player_id,
            player_name=f"{s.player.first_name or ''} {s.player.last_name or ''}".strip(),
            team_code=s.team.euroleague_code,
            is_starter=s.is_starter,
            minutes=s.minutes,
            points=s.points,
            total_rebounds=s.total_rebounds,
            assists=s.assists,
            steals=s.steals,
            turnovers=s.turnovers,
        )
        for s in stats
    ]

    base = _game_to_base(game)
    return GameDetail(**base.model_dump(), box_score=box_score)


def _game_to_base(game: Game) -> GameBase:
    return GameBase(
        id=game.id,
        season_year=game.season.year,
        euroleague_gamecode=game.euroleague_gamecode,
        round=game.round,
        phase=game.phase,
        game_date=game.game_date,
        home_team_code=game.home_team.euroleague_code,
        home_team_name=game.home_team.name,
        away_team_code=game.away_team.euroleague_code,
        away_team_name=game.away_team.name,
        home_score=game.home_score,
        away_score=game.away_score,
    )
