import random
import string
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models import Player, PlayerSeasonTeam, Season, Team, TeamSeason
from app.models.roster_guess import RosterGuessGame, RosterGuessRound, RosterGuessSlot

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SUPPORTED_MODES = {"single_player", "local_two_player", "online_friend"}
LOCAL_PLAY_MODES = {"single_player", "local_two_player"}
TARGET_WINS_OPTIONS = {2, 3, 5}
TIMER_MODE_TO_SECONDS = {"15s": 15, "40s": 40, "unlimited": None}

MIN_ROSTER_SIZE = 5
MAX_ROSTER_RETRIES = 10


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class RosterGuessError(Exception):
    status_code = 400

    def __init__(self, detail: str):
        super().__init__(detail)
        self.detail = detail


class RosterGuessNotFoundError(RosterGuessError):
    status_code = 404


class RosterGuessConflictError(RosterGuessError):
    status_code = 409


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _other_player(p: int) -> int:
    return 2 if p == 1 else 1


def _ensure_game_playable(game: RosterGuessGame) -> None:
    if game.status != "active":
        raise RosterGuessConflictError("Game is not active")


def _generate_join_code(db: Session) -> str:
    for _ in range(100):
        code = "".join(random.choices(string.ascii_uppercase + string.digits, k=6))
        existing = (
            db.query(RosterGuessGame)
            .filter(RosterGuessGame.join_code == code)
            .first()
        )
        if not existing:
            return code
    raise RosterGuessError("Unable to generate a unique join code")


# ---------------------------------------------------------------------------
# Game lifecycle
# ---------------------------------------------------------------------------


def create_game(
    db: Session,
    *,
    mode: str,
    target_wins: int,
    timer_mode: str,
    player1_name: Optional[str] = None,
    player2_name: Optional[str] = None,
    season_range_start: int,
    season_range_end: int,
) -> RosterGuessGame:
    if mode not in SUPPORTED_MODES:
        raise RosterGuessError(
            f"Invalid mode '{mode}'. Choose from: {', '.join(sorted(SUPPORTED_MODES))}"
        )
    if target_wins not in TARGET_WINS_OPTIONS:
        raise RosterGuessError("target_wins must be one of: 2, 3, 5")
    if timer_mode not in TIMER_MODE_TO_SECONDS:
        raise RosterGuessError("timer_mode must be one of: 15s, 40s, unlimited")
    if season_range_start > season_range_end:
        raise RosterGuessError("season_range_start must be <= season_range_end")

    is_online = mode == "online_friend"
    join_code = _generate_join_code(db) if is_online else None

    game = RosterGuessGame(
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
        season_range_start=season_range_start,
        season_range_end=season_range_end,
        pending_end_from=None,
        pending_end_to=None,
        winner_player=None,
        turn_started_at=datetime.utcnow(),
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    db.add(game)
    db.flush()

    if not is_online:
        _create_next_round(db, game)
    db.flush()
    return game


def get_game_or_404(db: Session, game_id: int) -> RosterGuessGame:
    game = db.query(RosterGuessGame).filter(RosterGuessGame.id == game_id).first()
    if not game:
        raise RosterGuessNotFoundError("Game not found")
    return game


def join_game(
    db: Session,
    join_code: str,
    player2_name: Optional[str] = None,
) -> RosterGuessGame:
    game = (
        db.query(RosterGuessGame)
        .filter(RosterGuessGame.join_code == join_code.upper())
        .first()
    )
    if not game:
        raise RosterGuessNotFoundError("Invalid join code")
    if game.status != "waiting_for_opponent":
        raise RosterGuessConflictError("Game is no longer accepting players")

    game.player2_name = player2_name or game.player2_name
    game.status = "active"
    now = datetime.utcnow()
    game.turn_started_at = now
    game.updated_at = now

    _create_next_round(db, game)
    db.flush()
    return game


# ---------------------------------------------------------------------------
# Round creation
# ---------------------------------------------------------------------------


def _create_next_round(db: Session, game: RosterGuessGame) -> RosterGuessRound:
    """Pick a random team+season, build the roster, and create the round."""

    # Gather all eligible (team_id, season_id) pairs in the configured range
    eligible_pairs = (
        db.query(PlayerSeasonTeam.team_id, PlayerSeasonTeam.season_id)
        .join(Season, Season.id == PlayerSeasonTeam.season_id)
        .filter(
            Season.year >= game.season_range_start,
            Season.year <= game.season_range_end,
        )
        .group_by(PlayerSeasonTeam.team_id, PlayerSeasonTeam.season_id)
        .having(func.count(PlayerSeasonTeam.id) >= MIN_ROSTER_SIZE)
        .all()
    )

    if not eligible_pairs:
        raise RosterGuessError(
            "No team+season combination with enough players in the selected range"
        )

    random.shuffle(eligible_pairs)

    roster_rows = None
    chosen_team_id = None
    chosen_season_id = None

    for team_id, season_id in eligible_pairs[:MAX_ROSTER_RETRIES]:
        rows = (
            db.query(
                PlayerSeasonTeam.id.label("pst_id"),
                PlayerSeasonTeam.player_id,
                PlayerSeasonTeam.jersey_number,
                Player.first_name,
                Player.last_name,
                Player.position,
                Player.nationality,
                Player.height_cm,
            )
            .join(Player, Player.id == PlayerSeasonTeam.player_id)
            .filter(
                PlayerSeasonTeam.team_id == team_id,
                PlayerSeasonTeam.season_id == season_id,
            )
            .all()
        )
        if len(rows) >= MIN_ROSTER_SIZE:
            roster_rows = rows
            chosen_team_id = team_id
            chosen_season_id = season_id
            break

    if roster_rows is None:
        raise RosterGuessError("Could not find a valid roster after retries")

    # Look up display info
    team = db.query(Team).filter(Team.id == chosen_team_id).first()
    season = db.query(Season).filter(Season.id == chosen_season_id).first()

    team_code = team.euroleague_code if team else "UNK"
    season_year = season.year if season else 0

    # Prefer TeamSeason.team_name_that_season, fall back to Team.name
    team_season = (
        db.query(TeamSeason)
        .filter(
            TeamSeason.team_id == chosen_team_id,
            TeamSeason.season_id == chosen_season_id,
        )
        .first()
    )
    team_name = (
        (team_season.team_name_that_season if team_season and team_season.team_name_that_season else None)
        or (team.name if team else "Unknown")
    )

    # Determine next round number
    next_round_number = (
        db.query(func.max(RosterGuessRound.round_number))
        .filter(RosterGuessRound.game_id == game.id)
        .scalar()
        or 0
    ) + 1

    round_obj = RosterGuessRound(
        game_id=game.id,
        round_number=next_round_number,
        status="active",
        team_id=chosen_team_id,
        season_id=chosen_season_id,
        team_code=team_code,
        team_name=team_name,
        season_year=season_year,
        player1_correct=0,
        player2_correct=0,
        winner_player=None,
        created_at=datetime.utcnow(),
    )
    db.add(round_obj)
    db.flush()

    # Create slots (one per player)
    for row in roster_rows:
        full_name = f"{row.first_name or ''} {row.last_name or ''}".strip()
        db.add(
            RosterGuessSlot(
                round_id=round_obj.id,
                player_season_team_id=row.pst_id,
                player_id=row.player_id,
                jersey_number=row.jersey_number,
                position=row.position,
                nationality=row.nationality,
                height_cm=row.height_cm,
                player_name=full_name or "Unknown",
                guessed_by_player=None,
                guessed_at=None,
            )
        )

    # Update game state
    game.round_number = next_round_number
    game.current_player = 1
    game.pending_end_from = None
    game.pending_end_to = None
    now = datetime.utcnow()
    game.turn_started_at = now
    game.updated_at = now
    db.flush()
    return round_obj


# ---------------------------------------------------------------------------
# Active round query
# ---------------------------------------------------------------------------


def get_active_round(db: Session, game_id: int) -> RosterGuessRound:
    round_obj = (
        db.query(RosterGuessRound)
        .filter(
            RosterGuessRound.game_id == game_id,
            RosterGuessRound.status == "active",
        )
        .order_by(RosterGuessRound.round_number.desc())
        .first()
    )
    if not round_obj:
        raise RosterGuessConflictError("No active round found for game")
    return round_obj


# ---------------------------------------------------------------------------
# Guess submission
# ---------------------------------------------------------------------------


def submit_guess(
    db: Session,
    *,
    game: RosterGuessGame,
    player_id: int,
    acting_player: Optional[int] = None,
) -> str:
    _ensure_game_playable(game)

    if game.pending_end_from is not None:
        raise RosterGuessConflictError("Resolve pending end offer before guessing")

    # Online turn enforcement
    if game.mode == "online_friend" and acting_player is not None:
        if acting_player != game.current_player:
            raise RosterGuessConflictError("It is not your turn")

    round_obj = get_active_round(db, game.id)

    # Find an unguessed slot matching this player_id
    slot = (
        db.query(RosterGuessSlot)
        .filter(
            RosterGuessSlot.round_id == round_obj.id,
            RosterGuessSlot.player_id == player_id,
            RosterGuessSlot.guessed_by_player.is_(None),
        )
        .first()
    )

    current = game.current_player
    is_correct = slot is not None

    if is_correct:
        slot.guessed_by_player = current
        slot.guessed_at = datetime.utcnow()
        if current == 1:
            round_obj.player1_correct += 1
        else:
            round_obj.player2_correct += 1

    # Switch turn (in two-player modes)
    if game.mode != "single_player":
        game.current_player = _other_player(current)

    now = datetime.utcnow()
    game.turn_started_at = now
    game.updated_at = now

    # Check if all slots are guessed → round complete
    unguessed_count = (
        db.query(func.count(RosterGuessSlot.id))
        .filter(
            RosterGuessSlot.round_id == round_obj.id,
            RosterGuessSlot.guessed_by_player.is_(None),
        )
        .scalar()
    )

    if unguessed_count == 0:
        return _finish_round(db, game, round_obj)

    db.flush()
    return "correct" if is_correct else "incorrect"


def _finish_round(
    db: Session,
    game: RosterGuessGame,
    round_obj: RosterGuessRound,
) -> str:
    """Complete the round, update scores, and check for match end."""
    round_obj.status = "completed"

    if game.mode == "single_player":
        # Solo: no match scoring — just complete the roster and prepare next
        round_obj.winner_player = None
        _create_next_round(db, game)
        db.flush()
        return "board_complete"

    if round_obj.player1_correct > round_obj.player2_correct:
        round_obj.winner_player = 1
    elif round_obj.player2_correct > round_obj.player1_correct:
        round_obj.winner_player = 2
    else:
        round_obj.winner_player = None  # drawn round

    if round_obj.winner_player is not None:
        if round_obj.winner_player == 1:
            game.player1_score += 1
        else:
            game.player2_score += 1

    if max(game.player1_score, game.player2_score) >= game.target_wins:
        game.status = "finished"
        game.winner_player = (
            1 if game.player1_score >= game.target_wins else 2
        )
        game.pending_end_from = None
        game.pending_end_to = None
        game.updated_at = datetime.utcnow()
        db.flush()
        return "match_won"

    _create_next_round(db, game)
    db.flush()
    return "round_won" if round_obj.winner_player is not None else "round_complete"


# ---------------------------------------------------------------------------
# End-of-round offer
# ---------------------------------------------------------------------------


def offer_end(
    db: Session,
    game: RosterGuessGame,
    *,
    acting_player: Optional[int] = None,
) -> None:
    _ensure_game_playable(game)
    if game.pending_end_from is not None:
        raise RosterGuessConflictError("An end offer is already pending")

    if game.mode == "online_friend" and acting_player is not None:
        if acting_player != game.current_player:
            raise RosterGuessConflictError("It is not your turn")

    get_active_round(db, game.id)
    offered_by = game.current_player
    game.pending_end_from = offered_by
    game.pending_end_to = _other_player(offered_by)
    game.current_player = game.pending_end_to
    game.updated_at = datetime.utcnow()
    db.flush()


def respond_end(
    db: Session,
    game: RosterGuessGame,
    *,
    accept: bool,
    acting_player: Optional[int] = None,
) -> str:
    _ensure_game_playable(game)
    if game.pending_end_from is None or game.pending_end_to is None:
        raise RosterGuessConflictError("No pending end offer")

    if game.mode == "online_friend" and acting_player is not None:
        if acting_player != game.pending_end_to:
            raise RosterGuessConflictError(
                "Only the recipient can respond to the end offer"
            )

    round_obj = get_active_round(db, game.id)
    responder = game.current_player
    if responder != game.pending_end_to:
        raise RosterGuessConflictError("Current player cannot respond to end offer")

    if accept:
        return _finish_round(db, game, round_obj)

    game.pending_end_from = None
    game.pending_end_to = None
    game.updated_at = datetime.utcnow()
    db.flush()
    return "declined"


# ---------------------------------------------------------------------------
# Timer handling
# ---------------------------------------------------------------------------


def handle_time_expired(
    db: Session,
    game: RosterGuessGame,
    *,
    expected_player: Optional[int] = None,
    expected_round: Optional[int] = None,
) -> None:
    _ensure_game_playable(game)

    # Race guard: only act if the game is still on the expected turn/round
    if expected_player is not None and game.current_player != expected_player:
        return
    if expected_round is not None and game.round_number != expected_round:
        return

    if game.mode != "single_player":
        game.current_player = _other_player(game.current_player)

    now = datetime.utcnow()
    game.turn_started_at = now
    game.updated_at = now
    db.flush()


# ---------------------------------------------------------------------------
# Give up (single player)
# ---------------------------------------------------------------------------


def give_up(db: Session, game: RosterGuessGame) -> int:
    """Single-player gives up on the current round. Reveals the full roster
    and creates the next round (like tic-tac-toe). Returns the given-up
    round number so the caller can serialize it as ``completed_round``."""
    _ensure_game_playable(game)
    if game.mode != "single_player":
        raise RosterGuessConflictError("Give up is only available in single player mode")

    round_obj = get_active_round(db, game.id)
    given_up_round_number = round_obj.round_number
    round_obj.status = "given_up"
    round_obj.winner_player = None
    _create_next_round(db, game)
    db.flush()
    return given_up_round_number


# ---------------------------------------------------------------------------
# Serialization
# ---------------------------------------------------------------------------


def serialize_game_state(db: Session, game: RosterGuessGame) -> dict:
    round_obj = None
    if game.status == "active":
        round_obj = (
            db.query(RosterGuessRound)
            .filter(
                RosterGuessRound.game_id == game.id,
                RosterGuessRound.status == "active",
            )
            .order_by(RosterGuessRound.round_number.desc())
            .first()
        )
    if round_obj is None and game.round_number > 0:
        round_obj = (
            db.query(RosterGuessRound)
            .filter(RosterGuessRound.game_id == game.id)
            .order_by(RosterGuessRound.round_number.desc())
            .first()
        )

    round_payload = None
    if round_obj:
        round_payload = _serialize_round(round_obj)

    turn_deadline = None
    if game.turn_seconds is not None and game.turn_started_at is not None:
        turn_deadline = (
            game.turn_started_at + timedelta(seconds=game.turn_seconds)
        ).isoformat() + "Z"

    return {
        "id": game.id,
        "mode": game.mode,
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
        "season_range_start": game.season_range_start,
        "season_range_end": game.season_range_end,
        "pending_end": {
            "offered_by": game.pending_end_from,
            "respond_to": game.pending_end_to,
        }
        if game.pending_end_from is not None
        else None,
        "round": round_payload,
    }


def _serialize_round(round_obj: RosterGuessRound) -> dict:
    slots = round_obj.slots
    guessed_count = sum(1 for s in slots if s.guessed_by_player is not None)
    round_over = round_obj.status in ("completed", "given_up")

    return {
        "team_code": round_obj.team_code,
        "team_name": round_obj.team_name,
        "season_year": round_obj.season_year,
        "player1_correct": round_obj.player1_correct,
        "player2_correct": round_obj.player2_correct,
        "total_slots": len(slots),
        "guessed_count": guessed_count,
        "status": round_obj.status,
        "slots": [
            {
                "id": slot.id,
                "jersey_number": slot.jersey_number,
                "position": slot.position,
                "nationality": slot.nationality,
                "height_cm": slot.height_cm,
                "guessed_by_player": slot.guessed_by_player,
                "player_name": slot.player_name if (slot.guessed_by_player is not None or round_over) else None,
            }
            for slot in slots
        ],
    }


def serialize_completed_round(
    db: Session, game_id: int, round_number: int
) -> dict | None:
    """Return serialized data for a completed/given-up round (used after give-up)."""
    round_obj = (
        db.query(RosterGuessRound)
        .filter(
            RosterGuessRound.game_id == game_id,
            RosterGuessRound.round_number == round_number,
        )
        .first()
    )
    if not round_obj:
        return None
    return _serialize_round(round_obj)


# ---------------------------------------------------------------------------
# Autocomplete (simple wrapper — no team filtering needed for roster guess)
# ---------------------------------------------------------------------------


def autocomplete_players(
    db: Session,
    *,
    q: str,
    limit: int,
) -> list[dict]:
    from sqlalchemy import or_

    query = db.query(Player)
    if q:
        words = q.split()
        for word in words:
            pattern = f"%{word}%"
            query = query.filter(
                or_(
                    Player.first_name.ilike(pattern),
                    Player.last_name.ilike(pattern),
                )
            )

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
