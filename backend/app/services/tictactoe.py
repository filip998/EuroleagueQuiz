import math
import random
import string
from datetime import datetime, timedelta
from itertools import combinations
from typing import Optional

from sqlalchemy import distinct, func, or_
from sqlalchemy.orm import Session

from app.models import (
    Player,
    PlayerSeasonTeam,
    QuizTicTacToeAxis,
    QuizTicTacToeCell,
    QuizTicTacToeGame,
    QuizTicTacToeRound,
    Team,
)

SUPPORTED_MODES = {"single_player", "local_two_player", "online_friend"}
LOCAL_PLAY_MODES = {"single_player", "local_two_player"}
TARGET_WINS_OPTIONS = {2, 3, 5}
TIMER_MODE_TO_SECONDS = {"15s": 15, "40s": 40, "unlimited": None}


class TicTacToeError(Exception):
    status_code = 400

    def __init__(self, detail: str):
        super().__init__(detail)
        self.detail = detail


class TicTacToeNotFoundError(TicTacToeError):
    status_code = 404


class TicTacToeConflictError(TicTacToeError):
    status_code = 409


class TicTacToeNotImplementedError(TicTacToeError):
    status_code = 501


# ---------------------------------------------------------------------------
# Axis registry — extensible axis types for board generation
# ---------------------------------------------------------------------------

# Weights for axis type selection (must sum to 1.0)
AXIS_WEIGHTS = {"team": 0.8, "nationality": 0.2}
MIN_NATIONALITY_PLAYERS = 5


def _get_team_candidates(db: Session) -> list[dict]:
    """Get candidate teams with enough player history."""
    rows = (
        db.query(
            Team.id,
            Team.name,
            func.count(distinct(PlayerSeasonTeam.player_id)).label("player_count"),
        )
        .join(PlayerSeasonTeam, PlayerSeasonTeam.team_id == Team.id)
        .group_by(Team.id)
        .having(func.count(distinct(PlayerSeasonTeam.player_id)) >= 3)
        .order_by(func.count(distinct(PlayerSeasonTeam.player_id)).desc())
        .limit(24)
        .all()
    )
    return [
        {"axis_type": "team", "value": str(r.id), "display_label": r.name}
        for r in rows
    ]


def _get_nationality_candidates(db: Session) -> list[dict]:
    """Get candidate nationalities using sqrt weighting."""
    rows = (
        db.query(
            Player.nationality,
            func.count(Player.id).label("cnt"),
        )
        .filter(Player.nationality.isnot(None), Player.nationality != "")
        .group_by(Player.nationality)
        .having(func.count(Player.id) >= MIN_NATIONALITY_PLAYERS)
        .all()
    )
    return [
        {
            "axis_type": "nationality",
            "value": r.nationality,
            "display_label": r.nationality,
            "_weight": math.sqrt(r.cnt),
        }
        for r in rows
    ]


def _pick_weighted(candidates: list[dict]) -> dict:
    """Pick a candidate using _weight field (or uniform if no weights)."""
    weights = [c.get("_weight", 1.0) for c in candidates]
    return random.choices(candidates, weights=weights, k=1)[0]


def _get_player_set_for_axis(db: Session, axis: dict) -> set[int]:
    """Get set of player IDs matching an axis constraint."""
    if axis["axis_type"] == "team":
        team_id = int(axis["value"])
        rows = (
            db.query(PlayerSeasonTeam.player_id)
            .filter(PlayerSeasonTeam.team_id == team_id)
            .distinct()
            .all()
        )
        return {r.player_id for r in rows}
    elif axis["axis_type"] == "nationality":
        rows = (
            db.query(Player.id)
            .filter(Player.nationality == axis["value"])
            .all()
        )
        return {r.id for r in rows}
    return set()


def _player_matches_axis(db: Session, player_id: int, axis: dict) -> bool:
    """Check if a player matches an axis constraint."""
    if axis["axis_type"] == "team":
        team_id = int(axis["value"])
        return (
            db.query(PlayerSeasonTeam)
            .filter(
                PlayerSeasonTeam.player_id == player_id,
                PlayerSeasonTeam.team_id == team_id,
            )
            .first()
        ) is not None
    elif axis["axis_type"] == "nationality":
        player = db.query(Player).filter(Player.id == player_id).first()
        return player is not None and player.nationality == axis["value"]
    return False


def create_game(
    db: Session,
    *,
    mode: str,
    target_wins: int,
    timer_mode: str,
    player1_name: Optional[str] = None,
    player2_name: Optional[str] = None,
) -> QuizTicTacToeGame:
    if mode not in SUPPORTED_MODES:
        raise TicTacToeError(
            f"Invalid mode '{mode}'. Choose from: {', '.join(sorted(SUPPORTED_MODES))}"
        )
    if target_wins not in TARGET_WINS_OPTIONS:
        raise TicTacToeError("target_wins must be one of: 2, 3, 5")
    if timer_mode not in TIMER_MODE_TO_SECONDS:
        raise TicTacToeError("timer_mode must be one of: 15s, 40s, unlimited")

    is_online = mode == "online_friend"
    join_code = _generate_join_code(db) if is_online else None

    game = QuizTicTacToeGame(
        mode=mode,
        status="waiting_for_opponent" if is_online else "active",
        join_code=join_code,
        target_wins=target_wins,
        turn_seconds=TIMER_MODE_TO_SECONDS[timer_mode],
        player1_name=player1_name,
        player2_name=player2_name,
        current_player=1,
        player1_score=0,
        player2_score=0,
        round_number=0,
        pending_draw_from=None,
        pending_draw_to=None,
        winner_player=None,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    db.add(game)
    db.flush()

    if not is_online:
        create_next_round(db, game, started_by_player=1)
    db.flush()
    return game


def get_game_or_404(db: Session, game_id: int) -> QuizTicTacToeGame:
    game = db.query(QuizTicTacToeGame).filter(QuizTicTacToeGame.id == game_id).first()
    if not game:
        raise TicTacToeNotFoundError("Game not found")
    return game


def join_game(
    db: Session,
    join_code: str,
    player2_name: Optional[str] = None,
) -> QuizTicTacToeGame:
    game = (
        db.query(QuizTicTacToeGame)
        .filter(QuizTicTacToeGame.join_code == join_code.upper())
        .first()
    )
    if not game:
        raise TicTacToeNotFoundError("Invalid join code")
    if game.status != "waiting_for_opponent":
        raise TicTacToeConflictError("Game is no longer accepting players")

    game.player2_name = player2_name or game.player2_name
    game.status = "active"
    game.updated_at = datetime.utcnow()

    create_next_round(db, game, started_by_player=1)
    db.flush()
    return game


def get_active_round(db: Session, game_id: int) -> QuizTicTacToeRound:
    round_obj = (
        db.query(QuizTicTacToeRound)
        .filter(
            QuizTicTacToeRound.game_id == game_id,
            QuizTicTacToeRound.status == "active",
        )
        .order_by(QuizTicTacToeRound.round_number.desc())
        .first()
    )
    if not round_obj:
        raise TicTacToeConflictError("No active round found for game")
    return round_obj


def submit_move(
    db: Session,
    *,
    game: QuizTicTacToeGame,
    row_index: int,
    col_index: int,
    player_id: int,
    acting_player: Optional[int] = None,
) -> str:
    _ensure_game_playable(game)
    if game.pending_draw_from is not None:
        raise TicTacToeConflictError("Resolve pending draw offer before making a move")

    # Online turn enforcement
    if game.mode == "online_friend" and acting_player is not None:
        if acting_player != game.current_player:
            raise TicTacToeConflictError("It is not your turn")

    if row_index not in (0, 1, 2) or col_index not in (0, 1, 2):
        raise TicTacToeError("row_index and col_index must be between 0 and 2")

    round_obj = get_active_round(db, game.id)
    cell = _get_cell(round_obj, row_index, col_index)
    if cell.claimed_by_player is not None:
        raise TicTacToeConflictError("Cell is already claimed")

    player = db.query(Player).filter(Player.id == player_id).first()
    if not player:
        raise TicTacToeNotFoundError("Player not found")

    acting_player = game.current_player
    row_axis, col_axis = _cell_axes(round_obj, row_index, col_index)
    is_correct = (
        _player_matches_axis(db, player_id, row_axis)
        and _player_matches_axis(db, player_id, col_axis)
    )

    if not is_correct:
        game.current_player = _other_player(acting_player)
        game.updated_at = datetime.utcnow()
        db.flush()
        return "incorrect"

    cell.claimed_by_player = acting_player
    cell.claimed_player_id = player_id
    cell.claimed_at = datetime.utcnow()

    if _has_three_in_row(round_obj, acting_player):
        round_obj.status = "completed"
        round_obj.winner_player = acting_player
        if acting_player == 1:
            game.player1_score += 1
        else:
            game.player2_score += 1

        if max(game.player1_score, game.player2_score) >= game.target_wins:
            game.status = "finished"
            game.winner_player = acting_player
            game.pending_draw_from = None
            game.pending_draw_to = None
            game.updated_at = datetime.utcnow()
            db.flush()
            return "match_won"

        next_starter = _other_player(round_obj.started_by_player)
        create_next_round(db, game, started_by_player=next_starter)
        db.flush()
        return "round_won"

    if _is_board_full(round_obj):
        round_obj.status = "drawn"
        round_obj.winner_player = None
        next_starter = _other_player(round_obj.started_by_player)
        create_next_round(db, game, started_by_player=next_starter)
        db.flush()
        return "round_drawn"

    game.current_player = _other_player(acting_player)
    game.updated_at = datetime.utcnow()
    db.flush()
    return "correct"


def offer_draw(db: Session, game: QuizTicTacToeGame, *, acting_player: Optional[int] = None) -> None:
    _ensure_game_playable(game)
    if game.pending_draw_from is not None:
        raise TicTacToeConflictError("A draw offer is already pending")

    if game.mode == "online_friend" and acting_player is not None:
        if acting_player != game.current_player:
            raise TicTacToeConflictError("It is not your turn")

    get_active_round(db, game.id)
    offered_by = game.current_player
    game.pending_draw_from = offered_by
    game.pending_draw_to = _other_player(offered_by)
    game.current_player = game.pending_draw_to
    game.updated_at = datetime.utcnow()
    db.flush()


def respond_draw(db: Session, game: QuizTicTacToeGame, *, accept: bool, acting_player: Optional[int] = None) -> str:
    _ensure_game_playable(game)
    if game.pending_draw_from is None or game.pending_draw_to is None:
        raise TicTacToeConflictError("No pending draw offer")

    if game.mode == "online_friend" and acting_player is not None:
        if acting_player != game.pending_draw_to:
            raise TicTacToeConflictError("Only the recipient can respond to the draw offer")

    round_obj = get_active_round(db, game.id)
    responder = game.current_player
    if responder != game.pending_draw_to:
        raise TicTacToeConflictError("Current player cannot respond to draw offer")

    if accept:
        round_obj.status = "drawn"
        round_obj.winner_player = None
        next_starter = _other_player(round_obj.started_by_player)
        create_next_round(db, game, started_by_player=next_starter)
        db.flush()
        return "accepted"

    game.pending_draw_from = None
    game.pending_draw_to = None
    game.updated_at = datetime.utcnow()
    db.flush()
    return "declined"


def create_next_round(
    db: Session,
    game: QuizTicTacToeGame,
    *,
    started_by_player: int,
) -> QuizTicTacToeRound:
    board_axes = _select_board_axes(db)
    row_axes = board_axes[:3]
    col_axes = board_axes[3:]

    # Extract team IDs for backward-compat columns (None for non-team axes)
    def _team_id_or_none(axis):
        return int(axis["value"]) if axis["axis_type"] == "team" else None

    next_round_number = (
        db.query(func.max(QuizTicTacToeRound.round_number))
        .filter(QuizTicTacToeRound.game_id == game.id)
        .scalar()
        or 0
    ) + 1

    round_obj = QuizTicTacToeRound(
        game_id=game.id,
        round_number=next_round_number,
        status="active",
        row_team_id_1=_team_id_or_none(row_axes[0]),
        row_team_id_2=_team_id_or_none(row_axes[1]),
        row_team_id_3=_team_id_or_none(row_axes[2]),
        col_team_id_1=_team_id_or_none(col_axes[0]),
        col_team_id_2=_team_id_or_none(col_axes[1]),
        col_team_id_3=_team_id_or_none(col_axes[2]),
        started_by_player=started_by_player,
        winner_player=None,
        created_at=datetime.utcnow(),
    )
    db.add(round_obj)
    db.flush()

    # Populate axes table
    for i, axis in enumerate(row_axes):
        db.add(QuizTicTacToeAxis(
            round_id=round_obj.id,
            position=f"row_{i}",
            axis_type=axis["axis_type"],
            value=axis["value"],
            display_label=axis["display_label"],
        ))
    for i, axis in enumerate(col_axes):
        db.add(QuizTicTacToeAxis(
            round_id=round_obj.id,
            position=f"col_{i}",
            axis_type=axis["axis_type"],
            value=axis["value"],
            display_label=axis["display_label"],
        ))

    for row_index in range(3):
        for col_index in range(3):
            db.add(
                QuizTicTacToeCell(
                    round_id=round_obj.id,
                    row_index=row_index,
                    col_index=col_index,
                )
            )

    game.round_number = next_round_number
    game.current_player = started_by_player
    game.pending_draw_from = None
    game.pending_draw_to = None
    game.updated_at = datetime.utcnow()
    db.flush()
    return round_obj


def serialize_game_state(
    db: Session,
    game: QuizTicTacToeGame,
) -> dict:
    round_obj = None
    if game.status == "active":
        round_obj = get_active_round(db, game.id)
    elif game.round_number > 0:
        round_obj = (
            db.query(QuizTicTacToeRound)
            .filter(QuizTicTacToeRound.game_id == game.id)
            .order_by(QuizTicTacToeRound.round_number.desc())
            .first()
        )

    round_payload = None
    if round_obj:
        round_payload = _serialize_round(round_obj)

    turn_deadline = None
    if game.turn_seconds is not None:
        turn_deadline = (game.updated_at + timedelta(seconds=game.turn_seconds)).isoformat()

    return {
        "id": game.id,
        "mode": game.mode,
        "resolved_mode": "local_two_player" if game.mode in LOCAL_PLAY_MODES else game.mode,
        "status": game.status,
        "join_code": game.join_code,
        "target_wins": game.target_wins,
        "turn_seconds": game.turn_seconds,
        "turn_deadline_utc": turn_deadline,
        "player1_name": game.player1_name or "Player 1",
        "player2_name": game.player2_name or "Player 2",
        "player1_score": game.player1_score,
        "player2_score": game.player2_score,
        "current_player": game.current_player,
        "round_number": game.round_number,
        "winner_player": game.winner_player,
        "pending_draw": {
            "offered_by": game.pending_draw_from,
            "respond_to": game.pending_draw_to,
        }
        if game.pending_draw_from is not None
        else None,
        "round": round_payload,
    }


def autocomplete_players(
    db: Session,
    *,
    q: str,
    limit: int,
    team_code_1: Optional[str] = None,
    team_code_2: Optional[str] = None,
) -> list[dict]:
    query = db.query(Player)

    if q:
        pattern = f"%{q}%"
        query = query.filter(
            or_(
                Player.first_name.ilike(pattern),
                Player.last_name.ilike(pattern),
            )
        )

    team_ids: list[int] = []
    for team_code in (team_code_1, team_code_2):
        if not team_code:
            continue
        team = db.query(Team).filter(Team.euroleague_code == team_code).first()
        if not team:
            raise TicTacToeNotFoundError(f"Team not found: {team_code}")
        if team.id not in team_ids:
            team_ids.append(team.id)

    if len(team_ids) == 1:
        query = query.join(PlayerSeasonTeam).filter(PlayerSeasonTeam.team_id == team_ids[0])
    elif len(team_ids) == 2:
        player_ids_query = (
            db.query(PlayerSeasonTeam.player_id)
            .filter(PlayerSeasonTeam.team_id.in_(team_ids))
            .group_by(PlayerSeasonTeam.player_id)
            .having(func.count(distinct(PlayerSeasonTeam.team_id)) == 2)
        )
        query = query.filter(Player.id.in_(player_ids_query))

    players = (
        query.order_by(Player.last_name.asc(), Player.first_name.asc())
        .limit(limit)
        .all()
    )
    return [
        {
            "player_id": p.id,
            "first_name": p.first_name,
            "last_name": p.last_name,
            "full_name": f"{p.first_name or ''} {p.last_name or ''}".strip(),
        }
        for p in players
    ]


def player_matches_teams(
    db: Session,
    *,
    player_id: int,
    team_id_1: int,
    team_id_2: int,
) -> bool:
    required_team_ids = [team_id_1]
    if team_id_2 != team_id_1:
        required_team_ids.append(team_id_2)

    matched_team_count = (
        db.query(func.count(distinct(PlayerSeasonTeam.team_id)))
        .filter(
            PlayerSeasonTeam.player_id == player_id,
            PlayerSeasonTeam.team_id.in_(required_team_ids),
        )
        .scalar()
        or 0
    )
    return matched_team_count == len(required_team_ids)


def _serialize_round(round_obj: QuizTicTacToeRound) -> dict:
    axes_by_pos = {a.position: a for a in round_obj.axes}
    use_axes_table = bool(axes_by_pos)

    # Build row/col axis info
    def _axis_info(pos_prefix, index, legacy_team):
        pos = f"{pos_prefix}_{index}"
        if use_axes_table and pos in axes_by_pos:
            a = axes_by_pos[pos]
            info = {
                "axis_type": a.axis_type,
                "value": a.value,
                "display_label": a.display_label,
            }
            if a.axis_type == "team" and legacy_team:
                info["team_code"] = legacy_team.euroleague_code
                info["team_name"] = legacy_team.name
            return info
        # Fallback: legacy team-only columns
        if legacy_team:
            return {
                "axis_type": "team",
                "value": str(legacy_team.id),
                "display_label": legacy_team.name,
                "team_code": legacy_team.euroleague_code,
                "team_name": legacy_team.name,
            }
        return {"axis_type": "unknown", "value": "", "display_label": "?"}

    row_teams = [round_obj.row_team_1, round_obj.row_team_2, round_obj.row_team_3]
    col_teams = [round_obj.col_team_1, round_obj.col_team_2, round_obj.col_team_3]

    rows = [_axis_info("row", i, row_teams[i]) for i in range(3)]
    columns = [_axis_info("col", i, col_teams[i]) for i in range(3)]

    cells_by_pos = {(c.row_index, c.col_index): c for c in round_obj.cells}
    cells = []
    for row_index in range(3):
        for col_index in range(3):
            cell = cells_by_pos[(row_index, col_index)]
            claimed_player_name = None
            if cell.claimed_player:
                claimed_player_name = (
                    f"{cell.claimed_player.first_name or ''} {cell.claimed_player.last_name or ''}"
                ).strip()

            cell_data = {
                "row_index": row_index,
                "col_index": col_index,
                "row_axis": rows[row_index],
                "col_axis": columns[col_index],
                "claimed_by_player": cell.claimed_by_player,
                "claimed_player_id": cell.claimed_player_id,
                "claimed_player_name": claimed_player_name,
            }
            # Backward compat: include team_code/team_name if both axes are teams
            if rows[row_index].get("team_code"):
                cell_data["row_team_code"] = rows[row_index]["team_code"]
                cell_data["row_team_name"] = rows[row_index]["team_name"]
            if columns[col_index].get("team_code"):
                cell_data["col_team_code"] = columns[col_index]["team_code"]
                cell_data["col_team_name"] = columns[col_index]["team_name"]
            cells.append(cell_data)

    return {
        "id": round_obj.id,
        "round_number": round_obj.round_number,
        "status": round_obj.status,
        "winner_player": round_obj.winner_player,
        "started_by_player": round_obj.started_by_player,
        "rows": rows,
        "columns": columns,
        "cells": cells,
    }


def _ensure_game_playable(game: QuizTicTacToeGame) -> None:
    if game.status != "active":
        raise TicTacToeConflictError("Game is not active")


def _get_cell(
    round_obj: QuizTicTacToeRound, row_index: int, col_index: int
) -> QuizTicTacToeCell:
    for cell in round_obj.cells:
        if cell.row_index == row_index and cell.col_index == col_index:
            return cell
    raise TicTacToeNotFoundError("Cell not found")


def _cell_axes(round_obj: QuizTicTacToeRound, row_index: int, col_index: int) -> tuple[dict, dict]:
    """Get the row and column axis dicts for a cell position."""
    axes_by_pos = {a.position: a for a in round_obj.axes}
    use_axes_table = bool(axes_by_pos)

    if use_axes_table:
        row_a = axes_by_pos[f"row_{row_index}"]
        col_a = axes_by_pos[f"col_{col_index}"]
        return (
            {"axis_type": row_a.axis_type, "value": row_a.value},
            {"axis_type": col_a.axis_type, "value": col_a.value},
        )

    # Legacy fallback
    row_team_ids = [
        round_obj.row_team_id_1,
        round_obj.row_team_id_2,
        round_obj.row_team_id_3,
    ]
    col_team_ids = [
        round_obj.col_team_id_1,
        round_obj.col_team_id_2,
        round_obj.col_team_id_3,
    ]
    return (
        {"axis_type": "team", "value": str(row_team_ids[row_index])},
        {"axis_type": "team", "value": str(col_team_ids[col_index])},
    )


def _cell_team_ids(round_obj: QuizTicTacToeRound, row_index: int, col_index: int) -> tuple[int, int]:
    row_team_ids = [
        round_obj.row_team_id_1,
        round_obj.row_team_id_2,
        round_obj.row_team_id_3,
    ]
    col_team_ids = [
        round_obj.col_team_id_1,
        round_obj.col_team_id_2,
        round_obj.col_team_id_3,
    ]
    return row_team_ids[row_index], col_team_ids[col_index]


def _is_board_full(round_obj: QuizTicTacToeRound) -> bool:
    return all(cell.claimed_by_player is not None for cell in round_obj.cells)


def _has_three_in_row(round_obj: QuizTicTacToeRound, player_no: int) -> bool:
    board = [[0, 0, 0] for _ in range(3)]
    for cell in round_obj.cells:
        board[cell.row_index][cell.col_index] = cell.claimed_by_player or 0

    for i in range(3):
        if all(board[i][j] == player_no for j in range(3)):
            return True
        if all(board[j][i] == player_no for j in range(3)):
            return True
    if all(board[i][i] == player_no for i in range(3)):
        return True
    if all(board[i][2 - i] == player_no for i in range(3)):
        return True
    return False


def _other_player(player_no: int) -> int:
    return 2 if player_no == 1 else 1


def _select_board_axes(db: Session) -> list[dict]:
    """Select 6 axes (3 rows + 3 cols) using weighted axis type selection.

    Returns list of 6 axis dicts: [row0, row1, row2, col0, col1, col2].
    Each dict has: axis_type, value, display_label.
    """
    team_candidates = _get_team_candidates(db)
    nationality_candidates = _get_nationality_candidates(db)

    if len(team_candidates) < 6:
        raise TicTacToeConflictError(
            "Not enough teams with player history to generate a TicTacToe board"
        )

    # Precompute player sets for validation
    team_ids = [int(c["value"]) for c in team_candidates]
    pairs = (
        db.query(PlayerSeasonTeam.team_id, PlayerSeasonTeam.player_id)
        .filter(PlayerSeasonTeam.team_id.in_(team_ids))
        .distinct()
        .all()
    )
    team_player_sets: dict[str, set[int]] = {}
    for team_id, player_id in pairs:
        team_player_sets.setdefault(str(team_id), set()).add(player_id)

    # Precompute nationality player sets
    nat_player_sets: dict[str, set[int]] = {}
    if nationality_candidates:
        nat_names = [c["value"] for c in nationality_candidates]
        nat_rows = (
            db.query(Player.id, Player.nationality)
            .filter(Player.nationality.in_(nat_names))
            .all()
        )
        for pid, nat in nat_rows:
            nat_player_sets.setdefault(nat, set()).add(pid)

    def _player_set_for(axis: dict) -> set[int]:
        if axis["axis_type"] == "team":
            return team_player_sets.get(axis["value"], set())
        elif axis["axis_type"] == "nationality":
            return nat_player_sets.get(axis["value"], set())
        return set()

    axis_types = list(AXIS_WEIGHTS.keys())
    axis_probs = [AXIS_WEIGHTS[t] for t in axis_types]

    max_attempts = 500
    for _ in range(max_attempts):
        axes = []
        used_values = set()  # prevent duplicate axes
        for _ in range(6):
            chosen_type = random.choices(axis_types, weights=axis_probs, k=1)[0]
            if chosen_type == "team":
                available = [c for c in team_candidates if c["value"] not in used_values]
                if not available:
                    break
                axis = random.choice(available)
            elif chosen_type == "nationality" and nationality_candidates:
                available = [c for c in nationality_candidates if c["value"] not in used_values]
                if not available:
                    # Fallback to team
                    available = [c for c in team_candidates if c["value"] not in used_values]
                    if not available:
                        break
                    axis = random.choice(available)
                else:
                    axis = _pick_weighted(available)
            else:
                available = [c for c in team_candidates if c["value"] not in used_values]
                if not available:
                    break
                axis = random.choice(available)

            used_values.add(axis["value"])
            axes.append(axis)

        if len(axes) != 6:
            continue

        # Validate: every cell intersection must have at least one valid player
        row_axes = axes[:3]
        col_axes = axes[3:]
        valid = True
        for ra in row_axes:
            for ca in col_axes:
                if not (_player_set_for(ra) & _player_set_for(ca)):
                    valid = False
                    break
            if not valid:
                break

        if valid:
            return axes

    raise TicTacToeConflictError(
        "Unable to generate a valid 3x3 board with axis intersections"
    )


def _all_cells_have_answers(
    *,
    row_team_ids,
    col_team_ids,
    player_sets: dict[int, set[int]],
) -> bool:
    for row_team_id in row_team_ids:
        for col_team_id in col_team_ids:
            if not (player_sets.get(row_team_id, set()) & player_sets.get(col_team_id, set())):
                return False
    return True


def _generate_join_code(db: Session) -> str:
    for _ in range(100):
        code = "".join(random.choices(string.ascii_uppercase + string.digits, k=6))
        existing = (
            db.query(QuizTicTacToeGame)
            .filter(QuizTicTacToeGame.join_code == code)
            .first()
        )
        if not existing:
            return code
    raise TicTacToeError("Unable to generate a unique join code")
