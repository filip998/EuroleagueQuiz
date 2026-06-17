import logging
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session
from sqlalchemy.sql.expression import func

from app.database import get_db
from app.game_actions import (
    GameActionError,
    http_exception_for_game_action_error,
    raise_http_game_action_error,
    websocket_error_payload,
)
from app.models import Player, PlayerSeasonTeam, PlayerSeasonStats, Team, Season
from app.schemas.player import PlayerDetail, SeasonStatsEntry
from app.schemas.quiz_ttt import (
    TicTacToeCreateGameRequest,
    TicTacToeMoveRequest,
    TicTacToeDrawResponseRequest,
    TicTacToeJoinGameRequest,
    TicTacToeQuickMatchCancelRequest,
    TicTacToeQuickMatchRequest,
)
from app.schemas.realtime import state_message
from app.services.tictactoe import (
    autocomplete_players,
    get_game_or_404,
    serialize_game_state,
)
from app.services.game_action_orchestration import (
    GameActionName,
    HttpGameActionRejected,
)
from app.services.matchmaking import (
    MatchmakingCancelRequest,
    MatchmakingRequest,
    MatchmakingStatus,
    cancel_search,
    find_or_create_match,
)
from app.services.matchmaking_adapters import TicTacToeMatchmakingAdapter
from app.services.realtime import OnlineGameRealtimeModule
from app.services.realtime_adapters import TicTacToeRealtimeAdapter

router = APIRouter()
logger = logging.getLogger(__name__)
tictactoe_realtime = OnlineGameRealtimeModule(TicTacToeRealtimeAdapter())
tictactoe_matchmaking = TicTacToeMatchmakingAdapter()


async def _tictactoe_http_action(
    db: Session,
    action: GameActionName,
    *,
    payload=None,
    game_id: int | None = None,
    player: int | None = None,
):
    try:
        return await tictactoe_realtime.game_actions.http_action(
            db=db,
            action=action,
            payload=payload,
            game_id=game_id,
            player=player,
        )
    except HttpGameActionRejected as exc:
        return JSONResponse(status_code=exc.status_code, content=exc.envelope)


def _game_action_error_response(exc: GameActionError) -> JSONResponse:
    http_exc = http_exception_for_game_action_error(exc)
    return JSONResponse(
        status_code=http_exc.status_code,
        content=websocket_error_payload(exc),
    )


async def _apply_quick_match_pair_effects(
    result,
    game_state: dict,
) -> None:
    if result.status != MatchmakingStatus.MATCHED or result.starting_player is None:
        return

    try:
        tictactoe_realtime.start_timer_from_state(game_state)
    except Exception:
        logger.exception("Post-commit quick-match side effect failed: start timer")

    try:
        await tictactoe_realtime.broadcast_state(game_state["id"], game_state)
    except Exception:
        logger.exception("Post-commit quick-match side effect failed: broadcast state")


def _cancelled_quick_match_state(result) -> dict:
    game = result.game
    return {
        "id": game.id,
        "mode": "online_friend",
        "resolved_mode": "online_friend",
        "status": "cancelled",
        "join_code": None,
        "is_public": True,
        "preset": result.preset,
        "target_wins": game.target_wins,
        "turn_seconds": game.turn_seconds,
        "turn_deadline_utc": None,
        "player1_name": game.player1_name or "Player 1",
        "player2_name": game.player2_name or "Player 2",
        "player1_score": game.player1_score,
        "player2_score": game.player2_score,
        "current_player": game.current_player,
        "round_number": game.round_number,
        "winner_player": game.winner_player,
        "pending_draw": None,
        "round": None,
    }


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


@router.post("/tictactoe/games")
async def create_tictactoe_game(
    payload: TicTacToeCreateGameRequest,
    db: Session = Depends(get_db),
):
    return await _tictactoe_http_action(
        db,
        GameActionName.CREATE,
        payload=payload,
    )


@router.post("/tictactoe/quick-match")
async def quick_match_tictactoe_game(
    payload: TicTacToeQuickMatchRequest,
    db: Session = Depends(get_db),
):
    try:
        result = await find_or_create_match(
            db,
            tictactoe_matchmaking,
            MatchmakingRequest(
                preset=payload.preset,
                player_name=payload.player_name,
                guest_id=payload.guest_id,
            ),
        )
        game_state = serialize_game_state(db, result.game)
        await _apply_quick_match_pair_effects(result, game_state)
        return state_message(game_state)
    except GameActionError as exc:
        return _game_action_error_response(exc)


@router.post("/tictactoe/quick-match/cancel")
async def cancel_quick_match_tictactoe_game(
    payload: TicTacToeQuickMatchCancelRequest,
    db: Session = Depends(get_db),
):
    try:
        result = await cancel_search(
            db,
            tictactoe_matchmaking,
            MatchmakingCancelRequest(
                preset=payload.preset,
                game_id=payload.game_id,
                guest_id=payload.guest_id,
            ),
        )
        return state_message(_cancelled_quick_match_state(result))
    except GameActionError as exc:
        return _game_action_error_response(exc)


@router.get("/tictactoe/games/{game_id}")
def get_tictactoe_game(game_id: int, db: Session = Depends(get_db)):
    try:
        game = get_game_or_404(db, game_id)
        return serialize_game_state(db, game)
    except GameActionError as exc:
        raise_http_game_action_error(exc)


@router.post("/tictactoe/games/{game_id}/moves")
async def submit_tictactoe_move(
    game_id: int,
    payload: TicTacToeMoveRequest,
    player: int | None = Query(None),
    db: Session = Depends(get_db),
):
    return await _tictactoe_http_action(
        db,
        GameActionName.MOVE,
        payload=payload,
        game_id=game_id,
        player=player,
    )


@router.post("/tictactoe/games/{game_id}/draw-offer")
async def offer_tictactoe_draw(
    game_id: int,
    player: int | None = Query(None),
    db: Session = Depends(get_db),
):
    return await _tictactoe_http_action(
        db,
        GameActionName.OFFER_DRAW,
        game_id=game_id,
        player=player,
    )


@router.post("/tictactoe/games/{game_id}/draw-response")
async def respond_tictactoe_draw(
    game_id: int,
    payload: TicTacToeDrawResponseRequest,
    player: int | None = Query(None),
    db: Session = Depends(get_db),
):
    return await _tictactoe_http_action(
        db,
        GameActionName.RESPOND_DRAW,
        payload=payload,
        game_id=game_id,
        player=player,
    )


@router.post("/tictactoe/games/{game_id}/give-up")
async def give_up_tictactoe_game(
    game_id: int,
    player: int | None = Query(None),
    db: Session = Depends(get_db),
):
    return await _tictactoe_http_action(
        db,
        GameActionName.GIVE_UP,
        game_id=game_id,
        player=player,
    )


@router.get("/tictactoe/players/autocomplete")
def tictactoe_player_autocomplete(
    q: str = Query("", description="Search by first/last name"),
    limit: int = Query(15, ge=1, le=50),
    team_code_1: Optional[str] = Query(None, description="First club code filter"),
    team_code_2: Optional[str] = Query(None, description="Second club code filter"),
    db: Session = Depends(get_db),
):
    try:
        players = autocomplete_players(
            db,
            q=q,
            limit=limit,
            team_code_1=team_code_1,
            team_code_2=team_code_2,
        )
        return {"query": q, "count": len(players), "players": players}
    except GameActionError as exc:
        raise_http_game_action_error(exc)


# ---------------------------------------------------------------------------
# Online multiplayer: join endpoint
# ---------------------------------------------------------------------------

@router.post("/tictactoe/games/join")
async def join_tictactoe_game(
    payload: TicTacToeJoinGameRequest,
    db: Session = Depends(get_db),
):
    return await _tictactoe_http_action(
        db,
        GameActionName.JOIN,
        payload=payload,
    )


@router.websocket("/tictactoe/ws/{game_id}")
async def tictactoe_websocket(websocket: WebSocket, game_id: int, player: int = 1):
    await tictactoe_realtime.connect(websocket, game_id, player)


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
