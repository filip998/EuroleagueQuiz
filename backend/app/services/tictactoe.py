from dataclasses import dataclass
import math
import random
import string
from datetime import date, datetime, timedelta
from itertools import combinations
from typing import Callable, Optional

from sqlalchemy import distinct, func, or_
from sqlalchemy.orm import Session

from app.game_actions import (
    ConflictGameActionError,
    InvalidGameActionError,
    NotFoundGameActionError,
    UnsupportedGameActionError,
)
from app.models import (
    Player,
    PlayerSeasonStats,
    PlayerSeasonTeam,
    QuizTicTacToeAxis,
    QuizTicTacToeCell,
    QuizTicTacToeGame,
    QuizTicTacToeRound,
    Season,
    Team,
)

SUPPORTED_MODES = {"single_player", "local_two_player", "online_friend"}
LOCAL_PLAY_MODES = {"single_player", "local_two_player"}
TARGET_WINS_OPTIONS = {2, 3, 5}
TIMER_MODE_TO_SECONDS = {"15s": 15, "40s": 40, "unlimited": None}


TicTacToeError = InvalidGameActionError
TicTacToeNotFoundError = NotFoundGameActionError
TicTacToeConflictError = ConflictGameActionError
TicTacToeNotImplementedError = UnsupportedGameActionError

GUEST_ID_MAX_LENGTH = 64


def _clean_guest_id(guest_id: Optional[str]) -> Optional[str]:
    """Normalize an opaque, untrusted client guest id (None when blank)."""
    if not guest_id:
        return None
    cleaned = guest_id.strip()[:GUEST_ID_MAX_LENGTH]
    return cleaned or None


# ---------------------------------------------------------------------------
# Axis registry — extensible axis types for board generation
# ---------------------------------------------------------------------------

MIN_NATIONALITY_PLAYERS = 5
PLAYED_WITH_TOP_N = 100  # raw PIR query limit (filtered down after scoring)
PLAYED_WITH_CANDIDATE_LIMIT = 80
TEAM_CANDIDATE_LIMIT = 40
SEASON_LOOKBACK_YEARS = 10
SEASON_RECENCY_DECAY = 0.10  # 10% weight reduction per year from current
RECENCY_PENALTY_PER_YEAR = 0.05  # 5% score reduction per year since last active
RECENCY_FLOOR = 0.10
TEAM_DIVERSITY_BONUS = 0.10  # 10% score bonus per additional team played for
POSITION_AXIS_VALUES = ("Guard", "Forward", "Center")
ACHIEVEMENT_AXIS_TYPES = frozenset({"champion", "stat_milestone"})


@dataclass(frozen=True)
class AxisCapGroup:
    axis_types: frozenset[str]
    max_per_board: int


@dataclass(frozen=True)
class TicTacToeAxisDefinition:
    axis_type: str
    weight: float
    candidate_provider: Callable[[Session], list[dict]]
    player_set_builder: Callable[[Session, dict], set[int]]
    matcher: Callable[[Session, int, dict], bool]
    candidate_picker: Callable[[list[dict]], dict] | None = None
    max_per_board: int | None = None

    def pick_candidate(self, candidates: list[dict]) -> dict:
        if self.candidate_picker is not None:
            return self.candidate_picker(candidates)
        return random.choice(candidates)


AXIS_CAP_GROUPS = (
    AxisCapGroup(axis_types=ACHIEVEMENT_AXIS_TYPES, max_per_board=1),
)


def _get_team_candidates(db: Session) -> list[dict]:
    """Get candidate teams ranked by recency-weighted player count.

    Score = total_distinct_players × recency_factor, where
    recency_factor = max(RECENCY_FLOOR, 1.0 - years_since_last_season × 0.05).
    This ensures currently active teams (Monaco, Paris, Dubai…) rank above
    historically large but long-inactive teams (Olimpija, Cibona…).
    Display label uses Team.short_name (falling back to Team.name).
    """
    current_year = date.today().year

    # Raw aggregates per team
    rows = (
        db.query(
            Team.id,
            Team.name,
            Team.short_name,
            func.count(distinct(PlayerSeasonTeam.player_id)).label("player_count"),
            func.max(Season.year).label("last_season_year"),
        )
        .join(PlayerSeasonTeam, PlayerSeasonTeam.team_id == Team.id)
        .join(Season, Season.id == PlayerSeasonTeam.season_id)
        .group_by(Team.id)
        .having(func.count(distinct(PlayerSeasonTeam.player_id)) >= 3)
        .all()
    )

    # Score and rank
    scored = []
    for r in rows:
        years_since = current_year - r.last_season_year
        recency = max(RECENCY_FLOOR, 1.0 - years_since * RECENCY_PENALTY_PER_YEAR)
        score = r.player_count * recency
        display = r.short_name or r.name
        scored.append((r.id, display, score))

    scored.sort(key=lambda x: -x[2])
    return [
        {"axis_type": "team", "value": str(tid), "display_label": name}
        for tid, name, _ in scored[:TEAM_CANDIDATE_LIMIT]
    ]


# Mapping of EuroLeague nationality names → ISO 3166-1 alpha-2 codes
NATIONALITY_TO_COUNTRY_CODE: dict[str, str] = {
    "Albania": "AL", "Algeria": "DZ", "Andorra": "AD", "Angola": "AO",
    "Argentina": "AR", "Australia": "AU", "Austria": "AT", "Bahamas": "BS",
    "Belarus": "BY", "Belgium": "BE", "Belize": "BZ",
    "Bosnia and Herzegovina": "BA", "Brazil": "BR", "Bulgaria": "BG",
    "Burkina Faso": "BF", "Cabo Verde": "CV", "Cameroon": "CM",
    "Canada": "CA", "Central African Republic": "CF", "Chad": "TD",
    "Chile": "CL", "China": "CN", "Colombia": "CO", "Congo": "CG",
    "Cote D'Ivoire": "CI", "Croatia": "HR", "Cuba": "CU", "Cyprus": "CY",
    "Czech Republic": "CZ", "Democratic Republic of the Congo": "CD",
    "Democratic Republic of the Congo (Zaire)": "CD", "Denmark": "DK",
    "Dominican Republic": "DO", "England": "GB", "Estonia": "EE",
    "Finland": "FI", "France": "FR", "Gabon": "GA", "Georgia": "GE",
    "Germany": "DE", "Ghana": "GH", "Greece": "GR", "Guinea": "GN",
    "Hungary": "HU", "Iceland": "IS", "Iran": "IR", "Ireland": "IE",
    "Israel": "IL", "Italy": "IT", "Ivory Coast": "CI", "Jamaica": "JM",
    "Latvia": "LV", "Lithuania": "LT", "Luxembourg": "LU", "Mali": "ML",
    "Mexico": "MX", "Montenegro": "ME", "Netherlands": "NL",
    "New Zealand": "NZ", "Niger": "NE", "Nigeria": "NG",
    "North Macedonia": "MK", "Panama": "PA", "Poland": "PL",
    "Portugal": "PT", "Puerto Rico": "PR", "Romania": "RO",
    "Russian Federation": "RU", "Senegal": "SN", "Serbia": "RS",
    "Seychelles": "SC", "Sierra Leone": "SL", "Slovakia": "SK",
    "Slovenia": "SI", "Spain": "ES", "Sweden": "SE", "Switzerland": "CH",
    "Trinidad and Tobago": "TT", "Tunisia": "TN", "Turkiye": "TR",
    "Ukraine": "UA", "United Kingdom": "GB",
    "United States of America": "US", "Uruguay": "UY", "Venezuela": "VE",
}


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
    candidates = []
    for r in rows:
        c = {
            "axis_type": "nationality",
            "value": r.nationality,
            "display_label": r.nationality,
            "_weight": math.sqrt(r.cnt),
        }
        code = NATIONALITY_TO_COUNTRY_CODE.get(r.nationality)
        if code:
            c["country_code"] = code
        candidates.append(c)
    return candidates


def _get_played_with_candidates(db: Session) -> list[dict]:
    """Get top players as 'played with' axis candidates.

    Ranked by score = career_PIR × recency × team_diversity, where
    recency decays 5% per year since last active season and
    team_diversity gives a 10% bonus per additional team played for.
    This favours active players who moved between clubs (= richer
    teammate pools) over retired one-club legends.
    """
    current_year = date.today().year

    rows = (
        db.query(
            Player.id,
            (Player.first_name + " " + Player.last_name).label("name"),
            Player.euroleague_image_url,
            func.sum(PlayerSeasonStats.pir).label("career_pir"),
            func.count(distinct(PlayerSeasonTeam.team_id)).label("team_count"),
            func.max(Season.year).label("last_season_year"),
        )
        .join(PlayerSeasonTeam, PlayerSeasonTeam.player_id == Player.id)
        .join(
            PlayerSeasonStats,
            PlayerSeasonStats.player_season_team_id == PlayerSeasonTeam.id,
        )
        .join(Season, Season.id == PlayerSeasonTeam.season_id)
        .group_by(Player.id)
        .order_by(func.sum(PlayerSeasonStats.pir).desc())
        .limit(PLAYED_WITH_TOP_N)
        .all()
    )

    scored = []
    for r in rows:
        if r.career_pir is None:
            continue
        years_since = current_year - r.last_season_year
        recency = max(RECENCY_FLOOR, 1.0 - years_since * RECENCY_PENALTY_PER_YEAR)
        diversity = 1.0 + (r.team_count - 1) * TEAM_DIVERSITY_BONUS
        score = r.career_pir * recency * diversity
        candidate = {
            "axis_type": "played_with",
            "value": str(r.id),
            "display_label": r.name,
            "_score": score,
        }
        if r.euroleague_image_url:
            candidate["image_url"] = r.euroleague_image_url
        scored.append(candidate)

    scored.sort(key=lambda c: -c["_score"])
    return scored[:PLAYED_WITH_CANDIDATE_LIMIT]


def _get_season_candidates(db: Session) -> list[dict]:
    """Get recent seasons as axis candidates with recency-weighted selection.

    Returns the last SEASON_LOOKBACK_YEARS seasons, each weighted so the
    current season is most likely to appear and older seasons decay by
    SEASON_RECENCY_DECAY per year.
    """
    current_year = date.today().year
    min_year = current_year - SEASON_LOOKBACK_YEARS

    rows = (
        db.query(Season)
        .filter(Season.year >= min_year)
        .order_by(Season.year.desc())
        .all()
    )

    candidates = []
    for s in rows:
        years_ago = current_year - s.year
        weight = max(0.1, 1.0 - years_ago * SEASON_RECENCY_DECAY)
        label = f"{s.year}/{str(s.year + 1)[2:]}"
        candidates.append({
            "axis_type": "season",
            "value": str(s.id),
            "display_label": label,
            "_weight": weight,
        })
    return candidates


def _get_position_candidates(db: Session) -> list[dict]:
    """Get coarse player-position axis candidates with at least one matching player."""
    rows = (
        db.query(Player.position, func.count(Player.id).label("cnt"))
        .filter(Player.position.in_(POSITION_AXIS_VALUES))
        .group_by(Player.position)
        .having(func.count(Player.id) > 0)
        .all()
    )
    available_positions = {r.position for r in rows}
    return [
        {
            "axis_type": "position",
            "value": position,
            "display_label": position,
        }
        for position in POSITION_AXIS_VALUES
        if position in available_positions
    ]


def _pick_weighted(candidates: list[dict]) -> dict:
    """Pick a candidate using _weight field (or uniform if no weights)."""
    weights = [c.get("_weight", 1.0) for c in candidates]
    return random.choices(candidates, weights=weights, k=1)[0]


def _stints_overlap(
    start_a: date | None,
    end_a: date | None,
    start_b: date | None,
    end_b: date | None,
) -> bool:
    """Check if two date ranges overlap. None dates treated as unbounded (always overlaps)."""
    if start_a is None or end_a is None or start_b is None or end_b is None:
        return True
    return start_a <= end_b and start_b <= end_a


def _get_teammate_player_set(
    db: Session,
    star_id: int,
    *,
    season_id: int | None = None,
) -> set[int]:
    """Get teammates of a star, preserving registration date overlap semantics."""
    star_q = db.query(
        PlayerSeasonTeam.team_id,
        PlayerSeasonTeam.season_id,
        PlayerSeasonTeam.registration_start,
        PlayerSeasonTeam.registration_end,
    ).filter(PlayerSeasonTeam.player_id == star_id)
    if season_id is not None:
        star_q = star_q.filter(PlayerSeasonTeam.season_id == season_id)
    star_stints = star_q.all()
    if not star_stints:
        return set()

    conditions = [
        (PlayerSeasonTeam.team_id == s.team_id)
        & (PlayerSeasonTeam.season_id == s.season_id)
        for s in star_stints
    ]
    candidate_rows = (
        db.query(
            PlayerSeasonTeam.player_id,
            PlayerSeasonTeam.team_id,
            PlayerSeasonTeam.season_id,
            PlayerSeasonTeam.registration_start,
            PlayerSeasonTeam.registration_end,
        )
        .filter(or_(*conditions))
        .filter(PlayerSeasonTeam.player_id != star_id)
        .all()
    )

    result: set[int] = set()
    star_by_key = {}
    for stint in star_stints:
        star_by_key.setdefault((stint.team_id, stint.season_id), []).append(stint)
    for row in candidate_rows:
        key = (row.team_id, row.season_id)
        for stint in star_by_key.get(key, []):
            if _stints_overlap(
                row.registration_start,
                row.registration_end,
                stint.registration_start,
                stint.registration_end,
            ):
                result.add(row.player_id)
                break
    return result


def _team_player_set(db: Session, axis: dict) -> set[int]:
    team_id = int(axis["value"])
    rows = (
        db.query(PlayerSeasonTeam.player_id)
        .filter(PlayerSeasonTeam.team_id == team_id)
        .distinct()
        .all()
    )
    return {r.player_id for r in rows}


def _nationality_player_set(db: Session, axis: dict) -> set[int]:
    rows = db.query(Player.id).filter(Player.nationality == axis["value"]).all()
    return {r.id for r in rows}


def _played_with_player_set(db: Session, axis: dict) -> set[int]:
    return _get_teammate_player_set(db, int(axis["value"]))


def _season_player_set(db: Session, axis: dict) -> set[int]:
    season_id = int(axis["value"])
    rows = (
        db.query(PlayerSeasonTeam.player_id)
        .filter(PlayerSeasonTeam.season_id == season_id)
        .distinct()
        .all()
    )
    return {r.player_id for r in rows}


def _position_player_set(db: Session, axis: dict) -> set[int]:
    rows = (
        db.query(Player.id)
        .filter(Player.position == axis["value"], Player.position != "")
        .all()
    )
    return {r.id for r in rows}


def _matches_team_axis(db: Session, player_id: int, axis: dict) -> bool:
    return (
        db.query(PlayerSeasonTeam)
        .filter(
            PlayerSeasonTeam.player_id == player_id,
            PlayerSeasonTeam.team_id == int(axis["value"]),
        )
        .first()
    ) is not None


def _matches_nationality_axis(db: Session, player_id: int, axis: dict) -> bool:
    player = db.query(Player).filter(Player.id == player_id).first()
    return player is not None and player.nationality == axis["value"]


def _matches_played_with_axis(db: Session, player_id: int, axis: dict) -> bool:
    return _player_is_teammate(db, player_id, int(axis["value"]))


def _matches_season_axis(db: Session, player_id: int, axis: dict) -> bool:
    return (
        db.query(PlayerSeasonTeam)
        .filter(
            PlayerSeasonTeam.player_id == player_id,
            PlayerSeasonTeam.season_id == int(axis["value"]),
        )
        .first()
    ) is not None


def _matches_position_axis(db: Session, player_id: int, axis: dict) -> bool:
    player = db.query(Player).filter(Player.id == player_id).first()
    return player is not None and player.position == axis["value"]


AXIS_REGISTRY: dict[str, TicTacToeAxisDefinition] = {
    "team": TicTacToeAxisDefinition(
        axis_type="team",
        weight=0.58,
        candidate_provider=_get_team_candidates,
        player_set_builder=_team_player_set,
        matcher=_matches_team_axis,
    ),
    "nationality": TicTacToeAxisDefinition(
        axis_type="nationality",
        weight=0.12,
        candidate_provider=_get_nationality_candidates,
        player_set_builder=_nationality_player_set,
        matcher=_matches_nationality_axis,
        candidate_picker=_pick_weighted,
    ),
    "played_with": TicTacToeAxisDefinition(
        axis_type="played_with",
        weight=0.20,
        candidate_provider=_get_played_with_candidates,
        player_set_builder=_played_with_player_set,
        matcher=_matches_played_with_axis,
    ),
    "season": TicTacToeAxisDefinition(
        axis_type="season",
        weight=0.10,
        candidate_provider=_get_season_candidates,
        player_set_builder=_season_player_set,
        matcher=_matches_season_axis,
        candidate_picker=_pick_weighted,
        max_per_board=1,
    ),
    "position": TicTacToeAxisDefinition(
        axis_type="position",
        weight=0.08,
        candidate_provider=_get_position_candidates,
        player_set_builder=_position_player_set,
        matcher=_matches_position_axis,
        max_per_board=1,
    ),
}

# Raw random.choices weights; they are normalized at selection time.
AXIS_WEIGHTS = {
    axis_type: definition.weight
    for axis_type, definition in AXIS_REGISTRY.items()
}


def _get_player_set_for_axis(db: Session, axis: dict) -> set[int]:
    """Get set of player IDs matching an axis constraint."""
    definition = AXIS_REGISTRY.get(axis["axis_type"])
    if definition is None:
        return set()
    return definition.player_set_builder(db, axis)


def _player_matches_axis(db: Session, player_id: int, axis: dict) -> bool:
    """Check if a player matches an axis constraint."""
    definition = AXIS_REGISTRY.get(axis["axis_type"])
    if definition is None:
        return False
    return definition.matcher(db, player_id, axis)


def _player_is_teammate(
    db: Session, player_id: int, star_id: int, *, season_id: int | None = None,
) -> bool:
    """Check if player was a teammate of star (optionally restricted to a season)."""
    if player_id == star_id:
        return False
    return player_id in _get_teammate_player_set(
        db,
        star_id,
        season_id=season_id,
    )


def _player_matches_cell(
    db: Session, player_id: int, row_axis: dict, col_axis: dict,
) -> bool:
    """Check if a player is valid for a cell, handling cross-axis constraints.

    When one axis is a season, team/played_with checks are restricted to that
    season (e.g., 'Real Madrid × 2025/26' requires the player on Real Madrid
    specifically in 2025/26).
    """
    types = {row_axis["axis_type"], col_axis["axis_type"]}
    season_axis = row_axis if row_axis["axis_type"] == "season" else (
        col_axis if col_axis["axis_type"] == "season" else None
    )
    other_axis = col_axis if season_axis is row_axis else row_axis

    if season_axis and "season" != other_axis["axis_type"]:
        season_id = int(season_axis["value"])
        # Season constraint: player must have played in this season
        in_season = (
            db.query(PlayerSeasonTeam)
            .filter(
                PlayerSeasonTeam.player_id == player_id,
                PlayerSeasonTeam.season_id == season_id,
            )
            .first()
        ) is not None
        if not in_season:
            return False

        if other_axis["axis_type"] == "team":
            # Team × Season: player on that team in that season
            return (
                db.query(PlayerSeasonTeam)
                .filter(
                    PlayerSeasonTeam.player_id == player_id,
                    PlayerSeasonTeam.team_id == int(other_axis["value"]),
                    PlayerSeasonTeam.season_id == season_id,
                )
                .first()
            ) is not None
        if other_axis["axis_type"] == "played_with":
            # Played_with × Season: teammate in that season only
            return _player_is_teammate(
                db, player_id, int(other_axis["value"]), season_id=season_id
            )
        return _player_matches_axis(db, player_id, other_axis)

    # No season axis — use independent checks (correct for team×team, team×nat, etc.)
    return (
        _player_matches_axis(db, player_id, row_axis)
        and _player_matches_axis(db, player_id, col_axis)
    )


def create_game(
    db: Session,
    *,
    mode: str,
    target_wins: int,
    timer_mode: str,
    player1_name: Optional[str] = None,
    player2_name: Optional[str] = None,
    guest_id: Optional[str] = None,
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
        player1_guest_id=_clean_guest_id(guest_id),
        current_player=1,
        player1_score=0,
        player2_score=0,
        round_number=0,
        pending_draw_from=None,
        pending_draw_to=None,
        winner_player=None,
        turn_started_at=datetime.utcnow(),
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
    guest_id: Optional[str] = None,
    *,
    started_by_player: int = 1,
) -> QuizTicTacToeGame:
    if started_by_player not in (1, 2):
        raise TicTacToeError("started_by_player must be 1 or 2")
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
    game.player2_guest_id = _clean_guest_id(guest_id) or game.player2_guest_id
    game.status = "active"
    now = datetime.utcnow()
    game.turn_started_at = now
    game.updated_at = now

    create_next_round(db, game, started_by_player=started_by_player)
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

    if game.mode == "online_friend":
        if acting_player is None:
            raise TicTacToeConflictError("Online game actions require realtime player identity")
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
    is_correct = _player_matches_cell(db, player_id, row_axis, col_axis)

    is_solo = game.mode == "single_player"

    if not is_correct:
        now = datetime.utcnow()
        if not is_solo:
            game.current_player = _other_player(acting_player)
        game.turn_started_at = now
        game.updated_at = now
        db.flush()
        return "incorrect"

    cell.claimed_by_player = acting_player
    cell.claimed_player_id = player_id
    cell.claimed_at = datetime.utcnow()

    if is_solo:
        # Solo: no match scoring — just complete the board
        if _has_three_in_row(round_obj, acting_player) or _is_board_full(round_obj):
            round_obj.status = "completed" if _has_three_in_row(round_obj, acting_player) else "drawn"
            round_obj.winner_player = acting_player if round_obj.status == "completed" else None
            create_next_round(db, game, started_by_player=1)
            db.flush()
            return "board_complete"

        game.updated_at = datetime.utcnow()
        db.flush()
        return "correct"

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
    now = datetime.utcnow()
    game.turn_started_at = now
    game.updated_at = now
    db.flush()
    return "correct"


def give_up_round(db: Session, game: QuizTicTacToeGame) -> int:
    """Give up the current round in a solo game. Returns the round number that was given up."""
    if game.mode != "single_player":
        raise TicTacToeError("Give up is only available in single player mode")
    _ensure_game_playable(game)

    round_obj = get_active_round(db, game.id)
    given_up_round_number = round_obj.round_number
    round_obj.status = "drawn"
    round_obj.winner_player = None

    create_next_round(db, game, started_by_player=1)
    db.flush()
    return given_up_round_number


def forfeit_online_game(
    db: Session,
    game: QuizTicTacToeGame,
    *,
    forfeiting_player: int,
) -> None:
    if game.mode != "online_friend":
        raise TicTacToeConflictError("Forfeit is only available in online games")
    _ensure_game_playable(game)
    if forfeiting_player not in (1, 2):
        raise TicTacToeConflictError("Online game actions require player identity")

    winning_player = _other_player(forfeiting_player)
    round_obj = get_active_round(db, game.id)
    round_obj.status = "completed"
    round_obj.winner_player = winning_player

    game.status = "finished"
    game.winner_player = winning_player
    game.pending_draw_from = None
    game.pending_draw_to = None
    game.updated_at = datetime.utcnow()
    db.flush()


def offer_draw(db: Session, game: QuizTicTacToeGame, *, acting_player: Optional[int] = None) -> None:
    _ensure_game_playable(game)
    if game.pending_draw_from is not None:
        raise TicTacToeConflictError("A draw offer is already pending")

    if game.mode == "online_friend":
        if acting_player is None:
            raise TicTacToeConflictError("Online game actions require realtime player identity")
        if acting_player != game.current_player:
            raise TicTacToeConflictError("It is not your turn")

    get_active_round(db, game.id)
    offered_by = game.current_player
    game.pending_draw_from = offered_by
    game.pending_draw_to = _other_player(offered_by)
    game.current_player = game.pending_draw_to
    now = datetime.utcnow()
    game.turn_started_at = now
    game.updated_at = now
    db.flush()


def respond_draw(db: Session, game: QuizTicTacToeGame, *, accept: bool, acting_player: Optional[int] = None) -> str:
    _ensure_game_playable(game)
    if game.pending_draw_from is None or game.pending_draw_to is None:
        raise TicTacToeConflictError("No pending draw offer")

    if game.mode == "online_friend":
        if acting_player is None:
            raise TicTacToeConflictError("Online game actions require realtime player identity")
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
    now = datetime.utcnow()
    game.turn_started_at = now
    game.updated_at = now
    db.flush()
    return "declined"


def handle_time_expired(
    db: Session,
    game: QuizTicTacToeGame,
    *,
    expected_player: Optional[int] = None,
    expected_round: Optional[int] = None,
) -> None:
    _ensure_game_playable(game)
    if expected_player is not None and game.current_player != expected_player:
        return
    if expected_round is not None and game.round_number != expected_round:
        return

    game.pending_draw_from = None
    game.pending_draw_to = None
    if game.mode != "single_player":
        game.current_player = _other_player(game.current_player)

    now = datetime.utcnow()
    game.turn_started_at = now
    game.updated_at = now
    db.flush()


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
    now = datetime.utcnow()
    game.turn_started_at = now
    game.updated_at = now
    db.flush()
    return round_obj


def serialize_game_state(
    db: Session,
    game: QuizTicTacToeGame,
) -> dict:
    round_obj = None
    if game.status == "active":
        round_obj = (
            db.query(QuizTicTacToeRound)
            .filter(
                QuizTicTacToeRound.game_id == game.id,
                QuizTicTacToeRound.status == "active",
            )
            .order_by(QuizTicTacToeRound.round_number.desc())
            .first()
        )
    if round_obj is None and game.round_number > 0:
        round_obj = (
            db.query(QuizTicTacToeRound)
            .filter(QuizTicTacToeRound.game_id == game.id)
            .order_by(QuizTicTacToeRound.round_number.desc())
            .first()
        )

    round_payload = None
    if round_obj:
        round_payload = _serialize_round(round_obj, db=db)

    turn_deadline = None
    if game.turn_seconds is not None and game.turn_started_at is not None:
        turn_deadline = (game.turn_started_at + timedelta(seconds=game.turn_seconds)).isoformat() + "Z"

    return {
        "id": game.id,
        "mode": game.mode,
        "resolved_mode": game.mode if game.mode == "single_player" else ("local_two_player" if game.mode in LOCAL_PLAY_MODES else game.mode),
        "status": game.status,
        "join_code": game.join_code,
        "is_public": bool(game.is_public),
        "preset": game.preset,
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


def serialize_completed_round(db: Session, game_id: int, round_number: int) -> dict | None:
    """Serialize a completed/drawn round with sample answers for unclaimed cells."""
    round_obj = (
        db.query(QuizTicTacToeRound)
        .filter(
            QuizTicTacToeRound.game_id == game_id,
            QuizTicTacToeRound.round_number == round_number,
            QuizTicTacToeRound.status.in_(["completed", "drawn"]),
        )
        .first()
    )
    if not round_obj:
        return None
    return _serialize_round(round_obj, db=db)


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
        words = q.split()
        for word in words:
            pattern = f"%{word}%"
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


def _serialize_round(round_obj: QuizTicTacToeRound, db: Session | None = None) -> dict:
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
            if a.axis_type == "team":
                if legacy_team:
                    info["team_code"] = legacy_team.euroleague_code
                    info["team_name"] = legacy_team.short_name or legacy_team.name
                else:
                    # Look up team by ID from axis value
                    t = db.query(Team).filter(Team.id == int(a.value)).first()
                    if t:
                        info["team_code"] = t.euroleague_code
                        info["team_name"] = t.short_name or t.name
            elif a.axis_type == "played_with":
                p = (
                    db.query(Player.euroleague_image_url)
                    .filter(Player.id == int(a.value))
                    .first()
                )
                if p and p.euroleague_image_url:
                    info["image_url"] = p.euroleague_image_url
            elif a.axis_type == "nationality":
                code = NATIONALITY_TO_COUNTRY_CODE.get(a.value)
                if code:
                    info["country_code"] = code
            return info
        # Fallback: legacy team-only columns
        if legacy_team:
            return {
                "axis_type": "team",
                "value": str(legacy_team.id),
                "display_label": legacy_team.short_name or legacy_team.name,
                "team_code": legacy_team.euroleague_code,
                "team_name": legacy_team.short_name or legacy_team.name,
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

            claimed_player_image_url = (
                cell.claimed_player.euroleague_image_url if cell.claimed_player else None
            )
            cell_data = {
                "row_index": row_index,
                "col_index": col_index,
                "row_axis": rows[row_index],
                "col_axis": columns[col_index],
                "claimed_by_player": cell.claimed_by_player,
                "claimed_player_id": cell.claimed_player_id,
                "claimed_player_name": claimed_player_name,
                "claimed_player_image_url": claimed_player_image_url,
            }
            # Add sample answers when round is over
            if round_obj.status in ("completed", "drawn") and db is not None:
                if cell.claimed_by_player is None:
                    cell_data["sample_answers"] = _get_sample_answers(
                        db, round_obj, row_index, col_index
                    )
                else:
                    cell_data["sample_answers"] = _get_sample_answers(
                        db, round_obj, row_index, col_index,
                        count=2, exclude_player_id=cell.claimed_player_id,
                    )
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


def _get_player_set_for_cell(
    db: Session, row_axis: dict, col_axis: dict,
) -> set[int]:
    return _get_player_set_for_cell_with_cache(
        db,
        row_axis,
        col_axis,
        lambda axis: _get_player_set_for_axis(db, axis),
    )


def _get_player_set_for_cell_with_cache(
    db: Session,
    row_axis: dict,
    col_axis: dict,
    player_set_for: Callable[[dict], set[int]],
) -> set[int]:
    """Get player IDs valid for a cell, handling cross-axis constraints."""
    season_axis = row_axis if row_axis["axis_type"] == "season" else (
        col_axis if col_axis["axis_type"] == "season" else None
    )
    other_axis = col_axis if season_axis is row_axis else row_axis

    if season_axis and other_axis["axis_type"] != "season":
        season_id = int(season_axis["value"])

        if other_axis["axis_type"] == "team":
            # Team × Season: players on that team in that season
            rows = (
                db.query(PlayerSeasonTeam.player_id)
                .filter(
                    PlayerSeasonTeam.team_id == int(other_axis["value"]),
                    PlayerSeasonTeam.season_id == season_id,
                )
                .distinct()
                .all()
            )
            return {r.player_id for r in rows}
        if other_axis["axis_type"] == "played_with":
            # Played_with × Season: teammates of star in that season only
            return _get_teammate_player_set(
                db,
                int(other_axis["value"]),
                season_id=season_id,
            )

        season_players = player_set_for(season_axis)
        return season_players & player_set_for(other_axis)

    # No season cross-constraint — use standard intersection
    return player_set_for(row_axis) & player_set_for(col_axis)


def _get_sample_answers(
    db: Session, round_obj: QuizTicTacToeRound, row_index: int, col_index: int,
    count: int = 3, exclude_player_id: int | None = None,
) -> list[str]:
    """Get up to `count` random valid player names for a cell."""
    row_axis, col_axis = _cell_axes(round_obj, row_index, col_index)
    valid_ids = list(_get_player_set_for_cell(db, row_axis, col_axis))
    if exclude_player_id:
        valid_ids = [pid for pid in valid_ids if pid != exclude_player_id]
    if not valid_ids:
        return []
    sample_ids = random.sample(valid_ids, min(count, len(valid_ids)))
    players = db.query(Player).filter(Player.id.in_(sample_ids)).all()
    return [f"{p.first_name} {p.last_name}" for p in players]


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


def _axis_key(axis: dict) -> tuple[str, str]:
    return axis["axis_type"], axis["value"]


def _axis_type_exceeds_board_caps(
    axis_type: str,
    selected_axes: list[dict],
    *,
    cap_groups: tuple[AxisCapGroup, ...] = AXIS_CAP_GROUPS,
) -> bool:
    definition = AXIS_REGISTRY.get(axis_type)
    if definition and definition.max_per_board is not None:
        existing_count = sum(
            1 for axis in selected_axes if axis["axis_type"] == axis_type
        )
        if existing_count + 1 > definition.max_per_board:
            return True

    for cap_group in cap_groups:
        if axis_type not in cap_group.axis_types:
            continue
        existing_group_count = sum(
            1
            for axis in selected_axes
            if axis["axis_type"] in cap_group.axis_types
        )
        if existing_group_count + 1 > cap_group.max_per_board:
            return True
    return False


def _select_board_axes(db: Session) -> list[dict]:
    """Select 6 axes (3 rows + 3 cols) using weighted axis type selection.

    Returns list of 6 axis dicts: [row0, row1, row2, col0, col1, col2].
    Each dict has: axis_type, value, display_label.
    """
    candidates_by_type = {
        axis_type: definition.candidate_provider(db)
        for axis_type, definition in AXIS_REGISTRY.items()
    }
    team_candidates = candidates_by_type.get("team", [])

    if len(team_candidates) < 6:
        raise TicTacToeConflictError(
            "Not enough teams with player history to generate a TicTacToe board"
        )

    player_set_cache: dict[tuple[str, str], set[int]] = {}
    cell_set_cache: dict[tuple[tuple[str, str], tuple[str, str]], set[int]] = {}

    def _player_set_for(axis: dict) -> set[int]:
        key = _axis_key(axis)
        if key not in player_set_cache:
            player_set_cache[key] = _get_player_set_for_axis(db, axis)
        return player_set_cache[key]

    def _cell_player_set(ra: dict, ca: dict) -> set[int]:
        key = (_axis_key(ra), _axis_key(ca))
        if key not in cell_set_cache:
            cell_set_cache[key] = _get_player_set_for_cell_with_cache(
                db,
                ra,
                ca,
                _player_set_for,
            )
        return cell_set_cache[key]

    axis_types = list(AXIS_REGISTRY.keys())
    axis_probs = [AXIS_REGISTRY[t].weight for t in axis_types]

    max_attempts = 500
    for _ in range(max_attempts):
        axes = []
        used_values: set[tuple[str, str]] = set()
        for _ in range(6):
            chosen_type = random.choices(axis_types, weights=axis_probs, k=1)[0]
            if _axis_type_exceeds_board_caps(chosen_type, axes):
                chosen_type = "team"
            pool = candidates_by_type.get(chosen_type, [])
            available = [
                c for c in pool
                if _axis_key(c) not in used_values
                and not _axis_type_exceeds_board_caps(c["axis_type"], axes)
            ]

            if not available:
                # Fallback to team
                available = [
                    c for c in team_candidates
                    if _axis_key(c) not in used_values
                ]
                if not available:
                    break
                axis = AXIS_REGISTRY["team"].pick_candidate(available)
            else:
                axis = AXIS_REGISTRY[chosen_type].pick_candidate(available)

            used_values.add(_axis_key(axis))
            axes.append(axis)

        if len(axes) != 6:
            continue

        # Validate: every cell intersection must have at least one valid player
        row_axes = axes[:3]
        col_axes = axes[3:]
        valid = True
        for ra in row_axes:
            for ca in col_axes:
                if not _cell_player_set(ra, ca):
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
