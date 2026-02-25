from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session
from sqlalchemy.sql.expression import func

from app.database import get_db, SessionLocal
from app.models import Player, PlayerSeasonTeam, PlayerSeasonStats, Team, Season
from app.schemas.player import PlayerDetail, SeasonStatsEntry
from app.schemas.quiz_ttt import (
    TicTacToeCreateGameRequest,
    TicTacToeMoveRequest,
    TicTacToeDrawResponseRequest,
    TicTacToeJoinGameRequest,
)
from app.services.tictactoe import (
    TicTacToeError,
    _other_player,
    autocomplete_players,
    create_game,
    get_game_or_404,
    join_game,
    offer_draw,
    respond_draw,
    serialize_completed_round,
    serialize_game_state,
    submit_move,
)
from app.services.timer_manager import start_turn_timer, cancel_timer

router = APIRouter()


import asyncio


def _try_broadcast(game_id: int, state: dict):
    """Best-effort broadcast game state to connected WebSocket clients."""
    try:
        loop = asyncio.get_running_loop()
        loop.create_task(ws_manager.broadcast(game_id, state))
    except RuntimeError:
        # No running loop in this thread — use run_coroutine_threadsafe
        try:
            import uvicorn
            loop = asyncio.get_event_loop()
            asyncio.run_coroutine_threadsafe(ws_manager.broadcast(game_id, state), loop)
        except Exception:
            pass


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
def create_tictactoe_game(
    payload: TicTacToeCreateGameRequest,
    db: Session = Depends(get_db),
):
    try:
        game = create_game(
            db,
            mode=payload.mode,
            target_wins=payload.target_wins,
            timer_mode=payload.timer_mode,
            player1_name=payload.player1_name,
            player2_name=payload.player2_name,
        )
        db.commit()
        db.refresh(game)
        return serialize_game_state(db, game)
    except TicTacToeError as exc:
        db.rollback()
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


@router.get("/tictactoe/games/{game_id}")
def get_tictactoe_game(game_id: int, db: Session = Depends(get_db)):
    try:
        game = get_game_or_404(db, game_id)
        return serialize_game_state(db, game)
    except TicTacToeError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


@router.post("/tictactoe/games/{game_id}/moves")
async def submit_tictactoe_move(
    game_id: int,
    payload: TicTacToeMoveRequest,
    db: Session = Depends(get_db),
):
    try:
        game = get_game_or_404(db, game_id)
        prev_round_number = game.round_number
        result = submit_move(
            db,
            game=game,
            row_index=payload.row_index,
            col_index=payload.col_index,
            player_id=payload.player_id,
        )
        db.commit()
        db.refresh(game)
        state = serialize_game_state(db, game)

        # Include completed round with sample answers on round-ending moves
        response = {"result": result, "game": state}
        if result in ("round_won", "round_drawn", "match_won"):
            completed = serialize_completed_round(db, game_id, prev_round_number)
            if completed:
                response["completed_round"] = completed

        await ws_manager.broadcast(game_id, {**state, "last_result": result,
            **({"completed_round": response.get("completed_round")} if "completed_round" in response else {})})
        return response
    except TicTacToeError as exc:
        db.rollback()
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


@router.post("/tictactoe/games/{game_id}/draw-offer")
async def offer_tictactoe_draw(game_id: int, db: Session = Depends(get_db)):
    try:
        game = get_game_or_404(db, game_id)
        offer_draw(db, game)
        db.commit()
        db.refresh(game)
        state = serialize_game_state(db, game)
        await ws_manager.broadcast(game_id, state)
        return {"result": "offered", "game": state}
    except TicTacToeError as exc:
        db.rollback()
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


@router.post("/tictactoe/games/{game_id}/draw-response")
async def respond_tictactoe_draw(
    game_id: int,
    payload: TicTacToeDrawResponseRequest,
    db: Session = Depends(get_db),
):
    try:
        game = get_game_or_404(db, game_id)
        prev_round_number = game.round_number
        result = respond_draw(db, game, accept=payload.accept)
        db.commit()
        db.refresh(game)
        state = serialize_game_state(db, game)

        response = {"result": result, "game": state}
        if result == "accepted":
            completed = serialize_completed_round(db, game_id, prev_round_number)
            if completed:
                response["completed_round"] = completed

        broadcast_data = {**state, "last_result": f"draw_{result}"}
        if "completed_round" in response:
            broadcast_data["completed_round"] = response["completed_round"]
        await ws_manager.broadcast(game_id, broadcast_data)
        return response
    except TicTacToeError as exc:
        db.rollback()
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


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
    except TicTacToeError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


# ---------------------------------------------------------------------------
# Online multiplayer: join endpoint
# ---------------------------------------------------------------------------

@router.post("/tictactoe/games/join")
async def join_tictactoe_game(
    payload: TicTacToeJoinGameRequest,
    db: Session = Depends(get_db),
):
    try:
        game = join_game(db, payload.join_code.upper(), payload.player_name)
        db.commit()
        db.refresh(game)
        state = serialize_game_state(db, game)
        await ws_manager.broadcast(game.id, state)
        # Start server-side turn timer for the online game
        start_turn_timer(game.id, game.turn_seconds, game.current_player, game.round_number)
        return {"game_id": game.id, "game": state}
    except TicTacToeError as exc:
        db.rollback()
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


# ---------------------------------------------------------------------------
# WebSocket connection manager
# ---------------------------------------------------------------------------

class ConnectionManager:
    def __init__(self):
        # {game_id: {player_number: WebSocket}}
        self.connections: dict[int, dict[int, WebSocket]] = {}

    async def connect(self, game_id: int, player: int, ws: WebSocket):
        await ws.accept()
        self.connections.setdefault(game_id, {})[player] = ws

    def disconnect(self, game_id: int, player: int):
        if game_id in self.connections:
            self.connections[game_id].pop(player, None)
            if not self.connections[game_id]:
                del self.connections[game_id]

    async def broadcast(self, game_id: int, state: dict):
        conns = self.connections.get(game_id, {})
        for ws in list(conns.values()):
            try:
                await ws.send_json(state)
            except Exception:
                pass


ws_manager = ConnectionManager()


@router.websocket("/tictactoe/ws/{game_id}")
async def tictactoe_websocket(websocket: WebSocket, game_id: int, player: int = 1):
    db = SessionLocal()
    try:
        game = get_game_or_404(db, game_id)
        await ws_manager.connect(game_id, player, websocket)
        # Send current state on connect
        state = serialize_game_state(db, game)
        await websocket.send_json(state)

        while True:
            data = await websocket.receive_json()
            action = data.get("action")
            try:
                # Refresh game from DB to pick up changes from REST endpoints
                db.expire(game)
                db.refresh(game)

                if action == "move":
                    player_id = data["player_id"]
                    row_idx = data["row_index"]
                    col_idx = data["col_index"]
                    prev_round_number = game.round_number
                    result = submit_move(
                        db, game=game, row_index=row_idx, col_index=col_idx,
                        player_id=player_id, acting_player=player,
                    )
                    db.commit()
                    db.refresh(game)
                    state = serialize_game_state(db, game)
                    state["last_result"] = result
                    if result in ("round_won", "round_drawn", "match_won"):
                        completed = serialize_completed_round(db, game_id, prev_round_number)
                        if completed:
                            state["completed_round"] = completed
                        if result == "match_won":
                            cancel_timer(game_id)
                        else:
                            # New round started — timer for next turn
                            start_turn_timer(game_id, game.turn_seconds, game.current_player, game.round_number)
                    else:
                        # Turn switched (correct or incorrect) — timer for next turn
                        start_turn_timer(game_id, game.turn_seconds, game.current_player, game.round_number)
                    await ws_manager.broadcast(game_id, state)
                    continue
                elif action == "offer_draw":
                    offer_draw(db, game, acting_player=player)
                    db.commit()
                    db.refresh(game)
                elif action == "respond_draw":
                    respond_draw(
                        db, game, accept=data.get("accept", False),
                        acting_player=player,
                    )
                    db.commit()
                    db.refresh(game)
                    if game.status == "finished":
                        cancel_timer(game_id)
                    elif game.status == "active":
                        # Draw declined or new round after draw — restart timer
                        start_turn_timer(game_id, game.turn_seconds, game.current_player, game.round_number)
                elif action == "time_expired":
                    # Client-sent time_expired is ignored for online games;
                    # the server timer handles expiry authoritatively.
                    continue
                else:
                    await websocket.send_json({"error": f"Unknown action: {action}"})
                    continue

                state = serialize_game_state(db, game)
                await ws_manager.broadcast(game_id, state)

            except TicTacToeError as exc:
                await websocket.send_json({"error": exc.detail})

    except WebSocketDisconnect:
        ws_manager.disconnect(game_id, player)
    except Exception:
        ws_manager.disconnect(game_id, player)
    finally:
        db.close()


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
