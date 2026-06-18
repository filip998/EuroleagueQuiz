import random
import string
import threading
import weakref
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.game_actions import (
    ConflictGameActionError,
    InvalidGameActionError,
    NotFoundGameActionError,
)
from app.models import Player, PlayerSeasonTeam, Season, Team, TeamSeason
from app.models.roster_guess import RosterGuessGame, RosterGuessRound, RosterGuessSlot
from app.services.race_rounds import normalize_utc, parse_utc_datetime, reveal_window_starts_at

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SUPPORTED_MODES = {"single_player", "local_two_player", "online_friend"}
LOCAL_PLAY_MODES = {"single_player", "local_two_player"}
TARGET_WINS_OPTIONS = {2, 3, 5}
TIMER_MODE_TO_SECONDS = {"15s": 15, "40s": 40, "unlimited": None}
RACE_TARGET_WINS_OPTIONS = {1, 2, 3}
RACE_ROUND_SECONDS = 120
RACE_REVEAL_SECONDS = 12

MIN_ROSTER_SIZE = 5
MAX_ROSTER_RETRIES = 10


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


RosterGuessError = InvalidGameActionError
RosterGuessNotFoundError = NotFoundGameActionError
RosterGuessConflictError = ConflictGameActionError

GUEST_ID_MAX_LENGTH = 64
_race_locks_guard = threading.Lock()
_race_locks: weakref.WeakValueDictionary[int, Any] = weakref.WeakValueDictionary()


def _clean_guest_id(guest_id: Optional[str]) -> Optional[str]:
    """Normalize an opaque, untrusted client guest id (None when blank)."""
    if not guest_id:
        return None
    cleaned = guest_id.strip()[:GUEST_ID_MAX_LENGTH]
    return cleaned or None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _other_player(p: int) -> int:
    return 2 if p == 1 else 1


def _ensure_game_playable(game: RosterGuessGame) -> None:
    if game.status != "active":
        raise RosterGuessConflictError("Game is not active")


def _race_lock(game_id: int) -> threading.Lock:
    with _race_locks_guard:
        lock = _race_locks.get(game_id)
        if lock is None:
            lock = threading.Lock()
            _race_locks[game_id] = lock
        return lock


def _utc_isoformat(value: datetime | None) -> str | None:
    if value is None:
        return None
    return normalize_utc(value).isoformat()


def _utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


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
    guest_id: Optional[str] = None,
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
        is_race=False,
        is_public=False,
        preset=None,
        target_wins=target_wins,
        turn_seconds=TIMER_MODE_TO_SECONDS[timer_mode],
        race_round_seconds=None,
        race_reveal_seconds=None,
        player1_name=player1_name,
        player2_name=player2_name,
        player1_guest_id=_clean_guest_id(guest_id),
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
    guest_id: Optional[str] = None,
    *,
    allow_public: bool = False,
) -> RosterGuessGame:
    game = (
        db.query(RosterGuessGame)
        .filter(RosterGuessGame.join_code == join_code.upper())
        .first()
    )
    if not game:
        raise RosterGuessNotFoundError("Invalid join code")
    if game.is_race:
        raise RosterGuessConflictError("Race games must be joined through Race endpoints")
    if game.is_public and not allow_public:
        raise RosterGuessConflictError("Public games must be joined through quick match")
    if game.status != "waiting_for_opponent":
        raise RosterGuessConflictError("Game is no longer accepting players")

    game.player2_name = player2_name or game.player2_name
    game.player2_guest_id = _clean_guest_id(guest_id) or game.player2_guest_id
    game.status = "active"
    now = datetime.utcnow()
    game.turn_started_at = now
    game.updated_at = now

    _create_next_round(db, game)
    db.flush()
    return game


def create_race_game(
    db: Session,
    *,
    target_wins: int,
    player1_name: Optional[str] = None,
    season_range_start: int,
    season_range_end: int,
    guest_id: Optional[str] = None,
    is_public: bool = False,
    preset: str | None = None,
    race_round_seconds: int = RACE_ROUND_SECONDS,
    race_reveal_seconds: int = RACE_REVEAL_SECONDS,
) -> RosterGuessGame:
    if target_wins not in RACE_TARGET_WINS_OPTIONS:
        raise RosterGuessError("race target_wins must be one of: 1, 2, 3")
    if season_range_start > season_range_end:
        raise RosterGuessError("season_range_start must be <= season_range_end")
    if race_round_seconds <= 0:
        raise RosterGuessError("race_round_seconds must be positive")
    if race_reveal_seconds < 0:
        raise RosterGuessError("race_reveal_seconds must be non-negative")

    game = RosterGuessGame(
        mode="online_friend",
        status="waiting_for_opponent",
        join_code=_generate_join_code(db),
        is_race=True,
        is_public=is_public,
        preset=preset,
        target_wins=target_wins,
        turn_seconds=None,
        race_round_seconds=race_round_seconds,
        race_reveal_seconds=race_reveal_seconds,
        player1_name=player1_name or "Player 1",
        player2_name=None,
        player1_guest_id=_clean_guest_id(guest_id),
        current_player=0,
        player1_score=0,
        player2_score=0,
        round_number=0,
        season_range_start=season_range_start,
        season_range_end=season_range_end,
        pending_end_from=None,
        pending_end_to=None,
        winner_player=None,
        turn_started_at=None,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    db.add(game)
    db.flush()
    return game


def join_race_game(
    db: Session,
    join_code: str,
    *,
    player_name: Optional[str] = None,
    guest_id: Optional[str] = None,
    allow_public: bool = False,
) -> RosterGuessGame:
    game = (
        db.query(RosterGuessGame)
        .filter(RosterGuessGame.join_code == join_code.upper())
        .first()
    )
    if not game:
        raise RosterGuessNotFoundError("Invalid join code")
    if not game.is_race:
        raise RosterGuessConflictError("Game is not a Race game")
    if game.is_public and not allow_public:
        raise RosterGuessConflictError("Public games must be joined through quick match")
    if game.status != "waiting_for_opponent":
        raise RosterGuessConflictError("Game is no longer accepting players")

    cleaned_guest_id = _clean_guest_id(guest_id)
    if cleaned_guest_id is not None and game.player1_guest_id == cleaned_guest_id:
        raise RosterGuessConflictError("Cannot join your own race")

    joined_at = datetime.utcnow()
    updated = (
        db.query(RosterGuessGame)
        .filter(RosterGuessGame.id == game.id)
        .filter(RosterGuessGame.is_race.is_(True))
        .filter(RosterGuessGame.status == "waiting_for_opponent")
        .update(
            {
                "player2_name": player_name or "Player 2",
                "player2_guest_id": cleaned_guest_id or game.player2_guest_id,
                "status": "active",
                "updated_at": joined_at,
            },
            synchronize_session=False,
        )
    )
    if updated != 1:
        raise RosterGuessConflictError("Game is no longer accepting players")

    game.player2_name = player_name or "Player 2"
    game.player2_guest_id = cleaned_guest_id or game.player2_guest_id
    game.status = "active"
    game.updated_at = joined_at
    _create_next_round(db, game)
    db.flush()
    return game


# ---------------------------------------------------------------------------
# Round creation
# ---------------------------------------------------------------------------


def _create_next_round(
    db: Session,
    game: RosterGuessGame,
    *,
    starts_at: datetime | None = None,
) -> RosterGuessRound:
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

    created_at = starts_at or datetime.utcnow()
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
        created_at=created_at,
        completed_at=None,
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
    game.current_player = 0 if game.is_race else 1
    game.pending_end_from = None
    game.pending_end_to = None
    now = datetime.utcnow()
    game.turn_started_at = None if game.is_race else now
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

    if game.mode == "online_friend":
        if acting_player is None:
            raise RosterGuessConflictError("Online game actions require realtime player identity")
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


def submit_race_claim(
    db: Session,
    *,
    game: RosterGuessGame,
    player_id: int,
    acting_player: int,
    round_number: int,
) -> str:
    if acting_player not in (1, 2):
        raise RosterGuessConflictError("Online game actions require realtime player identity")
    if not game.is_race:
        raise RosterGuessConflictError("Game is not a Race game")

    with _race_lock(game.id):
        _ensure_game_playable(game)
        _raise_if_race_round_stale(game, round_number)
        _raise_if_race_round_locked(game)
        round_obj = get_active_round(db, game.id)
        _assert_active_race_round(db, game, round_obj, round_number)

        now = datetime.utcnow()
        deadline = _race_round_deadline_at(game)
        if deadline is not None and normalize_utc(now) >= deadline:
            result = _finish_race_round(
                db,
                game,
                round_obj,
                expected_round=round_number,
                completed_at=now,
            )
            if result is not None:
                return result
            return "incorrect"

        updated = (
            db.query(RosterGuessSlot)
            .filter(RosterGuessSlot.round_id == round_obj.id)
            .filter(RosterGuessSlot.player_id == player_id)
            .filter(RosterGuessSlot.guessed_by_player.is_(None))
            .filter(
                RosterGuessSlot.round.has(
                    (RosterGuessRound.status == "active")
                    & (RosterGuessRound.game_id == game.id)
                    & (
                        RosterGuessRound.game.has(
                            (RosterGuessGame.status == "active")
                            & (RosterGuessGame.is_race.is_(True))
                            & (RosterGuessGame.round_number == round_number)
                        )
                    )
                )
            )
            .update(
                {
                    "guessed_by_player": acting_player,
                    "guessed_at": now,
                },
                synchronize_session=False,
            )
        )

        if updated != 1:
            _assert_active_race_round(db, game, round_obj, round_number)
            return "incorrect"

        _sync_race_claim_counts(db, round_obj)
        if _race_unguessed_count(db, round_obj) == 0:
            result = _finish_race_round(
                db,
                game,
                round_obj,
                expected_round=round_number,
                completed_at=now,
            )
            if result is not None:
                return result

        game.updated_at = now
        db.flush()
        return "correct"


def _raise_if_race_round_stale(game: RosterGuessGame, round_number: int) -> None:
    if round_number != game.round_number:
        raise RosterGuessConflictError("round_stale")


def _raise_if_race_round_locked(game: RosterGuessGame) -> None:
    if _race_reveal_window_starts_at(game) is not None:
        raise RosterGuessConflictError("round_locked")


def _assert_active_race_round(
    db: Session,
    game: RosterGuessGame,
    round_obj: RosterGuessRound,
    round_number: int,
) -> None:
    exists = (
        db.query(RosterGuessRound.id)
        .join(RosterGuessGame, RosterGuessGame.id == RosterGuessRound.game_id)
        .filter(RosterGuessRound.id == round_obj.id)
        .filter(RosterGuessRound.status == "active")
        .filter(RosterGuessGame.id == game.id)
        .filter(RosterGuessGame.is_race.is_(True))
        .filter(RosterGuessGame.status == "active")
        .filter(RosterGuessGame.round_number == round_number)
        .first()
    )
    if exists is None:
        raise RosterGuessConflictError("round_stale")


def _sync_race_claim_counts(db: Session, round_obj: RosterGuessRound) -> None:
    player1_count = _race_claim_count(db, round_obj, 1)
    player2_count = _race_claim_count(db, round_obj, 2)
    db.query(RosterGuessRound).filter(RosterGuessRound.id == round_obj.id).update(
        {
            "player1_correct": player1_count,
            "player2_correct": player2_count,
        },
        synchronize_session=False,
    )
    round_obj.player1_correct = player1_count
    round_obj.player2_correct = player2_count


def _race_claim_count(db: Session, round_obj: RosterGuessRound, player: int) -> int:
    return int(
        db.query(func.count(RosterGuessSlot.id))
        .filter(RosterGuessSlot.round_id == round_obj.id)
        .filter(RosterGuessSlot.guessed_by_player == player)
        .scalar()
        or 0
    )


def _race_unguessed_count(db: Session, round_obj: RosterGuessRound) -> int:
    return int(
        db.query(func.count(RosterGuessSlot.id))
        .filter(RosterGuessSlot.round_id == round_obj.id)
        .filter(RosterGuessSlot.guessed_by_player.is_(None))
        .scalar()
        or 0
    )


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


def _finish_race_round(
    db: Session,
    game: RosterGuessGame,
    round_obj: RosterGuessRound,
    *,
    expected_round: int,
    completed_at: datetime | None = None,
) -> str | None:
    if not game.is_race:
        raise RosterGuessConflictError("Game is not a Race game")
    if game.status != "active" or game.round_number != expected_round:
        return None

    completed_at = completed_at or datetime.utcnow()
    updated = (
        db.query(RosterGuessRound)
        .filter(RosterGuessRound.id == round_obj.id)
        .filter(RosterGuessRound.status == "active")
        .update(
            {
                "status": "completed",
                "completed_at": completed_at,
            },
            synchronize_session=False,
        )
    )
    if updated != 1:
        return None

    round_obj.status = "completed"
    round_obj.completed_at = completed_at
    _sync_race_claim_counts(db, round_obj)

    if round_obj.player1_correct > round_obj.player2_correct:
        round_obj.winner_player = 1
    elif round_obj.player2_correct > round_obj.player1_correct:
        round_obj.winner_player = 2
    else:
        round_obj.winner_player = None

    if round_obj.winner_player == 1:
        game.player1_score += 1
    elif round_obj.winner_player == 2:
        game.player2_score += 1

    game.pending_end_from = None
    game.pending_end_to = None
    game.updated_at = completed_at

    if max(game.player1_score, game.player2_score) >= game.target_wins:
        game.status = "finished"
        game.winner_player = 1 if game.player1_score >= game.target_wins else 2
        db.flush()
        return "match_won"

    next_round_starts_at = completed_at + timedelta(
        seconds=game.race_reveal_seconds or RACE_REVEAL_SECONDS
    )
    _create_next_round(db, game, starts_at=next_round_starts_at)
    db.flush()
    return "round_won" if round_obj.winner_player is not None else "round_complete"


def forfeit_online_game(
    db: Session,
    game: RosterGuessGame,
    *,
    forfeiting_player: int,
) -> bool:
    """Finish an online Roster Guess Race game because one player disconnected.

    The forfeiting player loses; the remaining player wins.  The current
    active race round is completed so both sides see the roster reveal.
    For non-race online games the function is a no-op.  Returns ``False``
    if another resolver already finished the game/round before this
    forfeit could claim it.
    """
    if game.mode != "online_friend":
        raise RosterGuessConflictError("Forfeit is only available in online games")
    if game.status != "active" or not game.is_race:
        return False
    if forfeiting_player not in (1, 2):
        raise RosterGuessError("forfeiting_player must be 1 or 2")

    winning_player = _other_player(forfeiting_player)
    now = datetime.utcnow()
    round_number = game.round_number

    try:
        round_obj = get_active_round(db, game.id)
    except RosterGuessConflictError:
        return False
    if round_obj.status != "active":
        return False

    updated_game = (
        db.query(RosterGuessGame)
        .filter(RosterGuessGame.id == game.id)
        .filter(RosterGuessGame.is_race.is_(True))
        .filter(RosterGuessGame.status == "active")
        .filter(RosterGuessGame.round_number == round_number)
        .update(
            {
                "status": "finished",
                "winner_player": winning_player,
                "pending_end_from": None,
                "pending_end_to": None,
                "updated_at": now,
            },
            synchronize_session=False,
        )
    )
    if updated_game != 1:
        return False

    updated_round = (
        db.query(RosterGuessRound)
        .filter(RosterGuessRound.id == round_obj.id)
        .filter(RosterGuessRound.status == "active")
        .update(
            {
                "status": "completed",
                "completed_at": now,
                "winner_player": None,
            },
            synchronize_session=False,
        )
    )
    if updated_round != 1:
        raise RosterGuessConflictError("round_stale")
    game.status = "finished"
    game.winner_player = winning_player
    game.pending_end_from = None
    game.pending_end_to = None
    game.updated_at = now
    round_obj.status = "completed"
    round_obj.completed_at = now
    round_obj.winner_player = None
    db.flush()
    return True


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
    if game.is_race:
        raise RosterGuessConflictError("End offers are not available in Race mode")
    if game.pending_end_from is not None:
        raise RosterGuessConflictError("An end offer is already pending")

    if game.mode == "online_friend":
        if acting_player is None:
            raise RosterGuessConflictError("Online game actions require realtime player identity")
        if acting_player != game.current_player:
            raise RosterGuessConflictError("It is not your turn")

    get_active_round(db, game.id)
    offered_by = game.current_player
    game.pending_end_from = offered_by
    game.pending_end_to = _other_player(offered_by)
    game.current_player = game.pending_end_to
    now = datetime.utcnow()
    game.turn_started_at = now
    game.updated_at = now
    db.flush()


def respond_end(
    db: Session,
    game: RosterGuessGame,
    *,
    accept: bool,
    acting_player: Optional[int] = None,
) -> str:
    _ensure_game_playable(game)
    if game.is_race:
        raise RosterGuessConflictError("End offers are not available in Race mode")
    if game.pending_end_from is None or game.pending_end_to is None:
        raise RosterGuessConflictError("No pending end offer")

    if game.mode == "online_friend":
        if acting_player is None:
            raise RosterGuessConflictError("Online game actions require realtime player identity")
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
    now = datetime.utcnow()
    game.turn_started_at = now
    game.updated_at = now
    db.flush()
    return "declined"


# ---------------------------------------------------------------------------
# Timer handling
# ---------------------------------------------------------------------------


def race_round_timer_delay_seconds(
    game: RosterGuessGame,
    *,
    now: datetime | None = None,
) -> float | None:
    deadline = _race_round_deadline_at(game)
    if deadline is None:
        return None
    now_utc = normalize_utc(now or _utc_now())
    return max((deadline - now_utc).total_seconds(), 0.001)


def race_round_timer_delay_seconds_from_state(
    game_state: dict[str, Any],
    *,
    now: datetime | None = None,
) -> float | None:
    if (
        game_state.get("mode") != "online_friend"
        or game_state.get("status") != "active"
        or not game_state.get("is_race")
    ):
        return None
    current_round = game_state.get("round")
    if not isinstance(current_round, dict) or current_round.get("status") != "active":
        return None
    deadline = parse_utc_datetime(game_state.get("race_round_deadline_utc"))
    if deadline is None:
        return None
    now_utc = normalize_utc(now or _utc_now())
    return max((deadline - now_utc).total_seconds(), 0.001)


def handle_race_round_time_expired(
    db: Session,
    game: RosterGuessGame,
    *,
    expected_round: int,
) -> bool:
    if not game.is_race:
        return False

    with _race_lock(game.id):
        if game.status != "active" or game.round_number != expected_round:
            return False
        if _race_reveal_window_starts_at(game) is not None:
            return False

        deadline = _race_round_deadline_at(game)
        if deadline is None or normalize_utc(_utc_now()) < deadline:
            return False

        try:
            round_obj = get_active_round(db, game.id)
        except RosterGuessConflictError:
            return False
        result = _finish_race_round(
            db,
            game,
            round_obj,
            expected_round=expected_round,
            completed_at=datetime.utcnow(),
        )
        return result is not None


def handle_race_game_unattended_time_expired(
    db: Session,
    game: RosterGuessGame,
    *,
    expected_round: int,
) -> bool:
    if not game.is_race:
        return False

    with _race_lock(game.id):
        if game.status != "active" or game.round_number != expected_round:
            return False
        if _race_reveal_window_starts_at(game) is not None:
            return False

        deadline = _race_round_deadline_at(game)
        if deadline is None or normalize_utc(_utc_now()) < deadline:
            return False

        try:
            round_obj = get_active_round(db, game.id)
        except RosterGuessConflictError:
            return False

        completed_at = datetime.utcnow()
        updated = (
            db.query(RosterGuessRound)
            .filter(RosterGuessRound.id == round_obj.id)
            .filter(RosterGuessRound.status == "active")
            .update(
                {
                    "status": "completed",
                    "completed_at": completed_at,
                    "winner_player": None,
                },
                synchronize_session=False,
            )
        )
        if updated != 1:
            return False

        round_obj.status = "completed"
        round_obj.completed_at = completed_at
        round_obj.winner_player = None
        _sync_race_claim_counts(db, round_obj)

        game.status = "finished"
        game.winner_player = None
        game.pending_end_from = None
        game.pending_end_to = None
        game.updated_at = completed_at
        db.flush()
        return True


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

    game.pending_end_from = None
    game.pending_end_to = None
    if game.mode != "single_player":
        game.current_player = _other_player(game.current_player)

    now = datetime.utcnow()
    game.turn_started_at = now
    game.updated_at = now
    db.flush()


def _race_round_deadline_at(game: RosterGuessGame) -> datetime | None:
    if not game.is_race or game.status != "active":
        return None
    try:
        round_obj = _current_game_round(game)
    except RosterGuessConflictError:
        return None
    if round_obj.status != "active":
        return None
    starts_at = _race_round_starts_at(game, round_obj)
    if starts_at is None:
        return None
    return starts_at + timedelta(seconds=game.race_round_seconds or RACE_ROUND_SECONDS)


def _race_round_starts_at(
    game: RosterGuessGame,
    round_obj: RosterGuessRound,
) -> datetime | None:
    previous_round = _previous_completed_race_round_for_current(game)
    if previous_round is not None and previous_round.completed_at is not None:
        return normalize_utc(previous_round.completed_at) + timedelta(
            seconds=game.race_reveal_seconds or RACE_REVEAL_SECONDS
        )
    return normalize_utc(round_obj.created_at)


def _race_reveal_window_starts_at(
    game: RosterGuessGame,
    *,
    now: datetime | None = None,
) -> datetime | None:
    if not game.is_race or game.status != "active":
        return None
    try:
        current_round = _current_game_round(game)
    except RosterGuessConflictError:
        return None
    if current_round.status != "active":
        return None
    previous_round = _previous_completed_race_round_for_current(game)
    if previous_round is None:
        return None
    return reveal_window_starts_at(
        previous_round.completed_at,
        reveal_seconds=game.race_reveal_seconds or RACE_REVEAL_SECONDS,
        now=now,
    )


def _previous_completed_race_round_for_current(
    game: RosterGuessGame,
) -> RosterGuessRound | None:
    previous_round_number = game.round_number - 1
    if previous_round_number < 1:
        return None
    for round_obj in game.rounds:
        if round_obj.round_number == previous_round_number and round_obj.status == "completed":
            return round_obj
    return None


def _current_game_round(game: RosterGuessGame) -> RosterGuessRound:
    for round_obj in game.rounds:
        if round_obj.round_number == game.round_number:
            return round_obj
    raise RosterGuessConflictError("Current round not found")


# ---------------------------------------------------------------------------
# Give up (single player)
# ---------------------------------------------------------------------------


def give_up(db: Session, game: RosterGuessGame) -> int:
    """Single-player gives up on the current round. Reveals the full roster
    and creates the next round (like tic-tac-toe). Returns the given-up
    round number so the caller can serialize it as ``completed_round``."""
    _ensure_game_playable(game)
    if game.is_race:
        raise RosterGuessConflictError("Give up is not available in Race mode")
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

    latest_completed_round = _latest_completed_round_payload(db, game)
    race_round_deadline = _utc_isoformat(_race_round_deadline_at(game))

    return {
        "id": game.id,
        "mode": game.mode,
        "status": game.status,
        "join_code": None if game.is_public else game.join_code,
        "is_race": game.is_race,
        "is_public": game.is_public,
        "preset": game.preset,
        "target_wins": game.target_wins,
        "turn_seconds": game.turn_seconds,
        "turn_deadline_utc": turn_deadline,
        "race_round_seconds": game.race_round_seconds,
        "race_reveal_seconds": game.race_reveal_seconds,
        "race_round_deadline_utc": race_round_deadline,
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
        "latest_completed_round": latest_completed_round,
    }


def _serialize_round(round_obj: RosterGuessRound) -> dict:
    slots = round_obj.slots
    guessed_count = sum(1 for s in slots if s.guessed_by_player is not None)
    round_over = round_obj.status in ("completed", "given_up")

    return {
        "round_number": round_obj.round_number,
        "team_code": round_obj.team_code,
        "team_name": round_obj.team_name,
        "season_year": round_obj.season_year,
        "player1_correct": round_obj.player1_correct,
        "player2_correct": round_obj.player2_correct,
        "winner_player": round_obj.winner_player,
        "completed_at": _utc_isoformat(round_obj.completed_at),
        "total_slots": len(slots),
        "guessed_count": guessed_count,
        "status": round_obj.status,
        "slots": [
            _serialize_slot(slot, round_over)
            for slot in slots
        ],
    }


def _latest_completed_round_payload(
    db: Session,
    game: RosterGuessGame,
) -> dict[str, Any] | None:
    if not game.is_race:
        return None
    round_obj = (
        db.query(RosterGuessRound)
        .filter(RosterGuessRound.game_id == game.id)
        .filter(RosterGuessRound.status == "completed")
        .order_by(RosterGuessRound.round_number.desc())
        .first()
    )
    if round_obj is None:
        return None
    payload = _serialize_round(round_obj)
    next_round_starts_at = _race_reveal_window_starts_at(game)
    if (
        next_round_starts_at is not None
        and round_obj.round_number == game.round_number - 1
    ):
        payload["next_round_starts_at"] = _utc_isoformat(next_round_starts_at)
    else:
        payload["next_round_starts_at"] = None
    return payload


# Reuse the TicTacToe nationality mapping for flag images
from app.services.tictactoe import NATIONALITY_TO_COUNTRY_CODE


def _serialize_slot(slot, round_over: bool) -> dict:
    show_answer = slot.guessed_by_player is not None or round_over
    data = {
        "id": slot.id,
        "jersey_number": slot.jersey_number,
        "position": slot.position,
        "nationality": slot.nationality,
        "height_cm": slot.height_cm,
        "guessed_by_player": slot.guessed_by_player,
        "guessed_at": _utc_isoformat(slot.guessed_at),
        "player_name": slot.player_name if show_answer else None,
    }
    # Include country code for flag display
    if slot.nationality:
        code = NATIONALITY_TO_COUNTRY_CODE.get(slot.nationality)
        if code:
            data["country_code"] = code
    # Include player image when answer is revealed
    if show_answer and slot.player and slot.player.euroleague_image_url:
        data["image_url"] = slot.player.euroleague_image_url
    return data


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
