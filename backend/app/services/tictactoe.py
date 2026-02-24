import random
from datetime import datetime, timedelta
from itertools import combinations
from typing import Optional

from sqlalchemy import distinct, func, or_
from sqlalchemy.orm import Session

from app.models import (
    Player,
    PlayerSeasonTeam,
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
    if mode == "online_friend":
        raise TicTacToeNotImplementedError(
            "online_friend mode is not implemented yet"
        )

    game = QuizTicTacToeGame(
        mode=mode,
        status="active",
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

    create_next_round(db, game, started_by_player=1)
    db.flush()
    return game


def get_game_or_404(db: Session, game_id: int) -> QuizTicTacToeGame:
    game = db.query(QuizTicTacToeGame).filter(QuizTicTacToeGame.id == game_id).first()
    if not game:
        raise TicTacToeNotFoundError("Game not found")
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
) -> str:
    _ensure_game_playable(game)
    if game.pending_draw_from is not None:
        raise TicTacToeConflictError("Resolve pending draw offer before making a move")

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
    row_team_id, col_team_id = _cell_team_ids(round_obj, row_index, col_index)
    is_correct = player_matches_teams(
        db,
        player_id=player_id,
        team_id_1=row_team_id,
        team_id_2=col_team_id,
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


def offer_draw(db: Session, game: QuizTicTacToeGame) -> None:
    _ensure_game_playable(game)
    if game.pending_draw_from is not None:
        raise TicTacToeConflictError("A draw offer is already pending")

    get_active_round(db, game.id)
    offered_by = game.current_player
    game.pending_draw_from = offered_by
    game.pending_draw_to = _other_player(offered_by)
    game.current_player = game.pending_draw_to
    game.updated_at = datetime.utcnow()
    db.flush()


def respond_draw(db: Session, game: QuizTicTacToeGame, *, accept: bool) -> str:
    _ensure_game_playable(game)
    if game.pending_draw_from is None or game.pending_draw_to is None:
        raise TicTacToeConflictError("No pending draw offer")

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
    row_team_ids, col_team_ids = _select_board_teams(db)
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
        row_team_id_1=row_team_ids[0],
        row_team_id_2=row_team_ids[1],
        row_team_id_3=row_team_ids[2],
        col_team_id_1=col_team_ids[0],
        col_team_id_2=col_team_ids[1],
        col_team_id_3=col_team_ids[2],
        started_by_player=started_by_player,
        winner_player=None,
        created_at=datetime.utcnow(),
    )
    db.add(round_obj)
    db.flush()

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
    row_teams = [round_obj.row_team_1, round_obj.row_team_2, round_obj.row_team_3]
    col_teams = [round_obj.col_team_1, round_obj.col_team_2, round_obj.col_team_3]
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

            cells.append(
                {
                    "row_index": row_index,
                    "col_index": col_index,
                    "row_team_code": row_teams[row_index].euroleague_code,
                    "row_team_name": row_teams[row_index].name,
                    "col_team_code": col_teams[col_index].euroleague_code,
                    "col_team_name": col_teams[col_index].name,
                    "claimed_by_player": cell.claimed_by_player,
                    "claimed_player_id": cell.claimed_player_id,
                    "claimed_player_name": claimed_player_name,
                }
            )

    return {
        "id": round_obj.id,
        "round_number": round_obj.round_number,
        "status": round_obj.status,
        "winner_player": round_obj.winner_player,
        "started_by_player": round_obj.started_by_player,
        "rows": [
            {"team_code": t.euroleague_code, "team_name": t.name}
            for t in row_teams
        ],
        "columns": [
            {"team_code": t.euroleague_code, "team_name": t.name}
            for t in col_teams
        ],
        "cells": cells,
    }


def _ensure_game_playable(game: QuizTicTacToeGame) -> None:
    if game.status != "active":
        raise TicTacToeConflictError("Game is not active")
    if game.mode not in LOCAL_PLAY_MODES:
        raise TicTacToeNotImplementedError(
            f"Mode '{game.mode}' is not implemented for gameplay"
        )


def _get_cell(
    round_obj: QuizTicTacToeRound, row_index: int, col_index: int
) -> QuizTicTacToeCell:
    for cell in round_obj.cells:
        if cell.row_index == row_index and cell.col_index == col_index:
            return cell
    raise TicTacToeNotFoundError("Cell not found")


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


def _select_board_teams(db: Session) -> tuple[list[int], list[int]]:
    candidate_rows = (
        db.query(
            Team.id,
            func.count(distinct(PlayerSeasonTeam.player_id)).label("player_count"),
        )
        .join(PlayerSeasonTeam, PlayerSeasonTeam.team_id == Team.id)
        .group_by(Team.id)
        .having(func.count(distinct(PlayerSeasonTeam.player_id)) >= 3)
        .order_by(func.count(distinct(PlayerSeasonTeam.player_id)).desc(), Team.id.asc())
        .limit(24)
        .all()
    )
    team_ids = [row.id for row in candidate_rows]

    if len(team_ids) < 6:
        raise TicTacToeConflictError(
            "Not enough teams with player history to generate a TicTacToe board"
        )

    pairs = (
        db.query(PlayerSeasonTeam.team_id, PlayerSeasonTeam.player_id)
        .filter(PlayerSeasonTeam.team_id.in_(team_ids))
        .distinct()
        .all()
    )
    player_sets: dict[int, set[int]] = {team_id: set() for team_id in team_ids}
    for team_id, player_id in pairs:
        player_sets[team_id].add(player_id)

    # Collect valid boards, then pick one at random
    valid_boards: list[tuple[tuple, tuple]] = []
    for row_team_ids in combinations(team_ids, 3):
        for col_team_ids in combinations(team_ids, 3):
            # Row and column sets must not share any team
            if set(row_team_ids) & set(col_team_ids):
                continue
            if _all_cells_have_answers(
                row_team_ids=row_team_ids,
                col_team_ids=col_team_ids,
                player_sets=player_sets,
            ):
                valid_boards.append((row_team_ids, col_team_ids))

    if not valid_boards:
        raise TicTacToeConflictError(
            "Unable to generate a valid 3x3 board with club intersections"
        )

    chosen = random.choice(valid_boards)
    rows = list(chosen[0])
    cols = list(chosen[1])
    random.shuffle(rows)
    random.shuffle(cols)
    return rows, cols


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
