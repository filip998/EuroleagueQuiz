"""Higher or Lower game service."""

import random
from datetime import date, datetime
from typing import Literal

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.game import Game
from app.models.higher_lower import HigherLowerGame, HigherLowerScore
from app.models.player import Player, PlayerSeasonTeam
from app.models.season import Season
from app.models.stats import GamePlayerStats, PlayerSeasonStats

# ---------------------------------------------------------------------------
# Category definitions per tier
# ---------------------------------------------------------------------------

TIER_CATEGORIES: dict[str, list[dict]] = {
    "easy": [
        {"key": "height_cm", "label": "Height (cm)"},
        {"key": "age", "label": "Age (years)"},
        {"key": "seasons_played", "label": "EuroLeague Seasons Played"},
        {"key": "teams_played_for", "label": "EuroLeague Teams Played For"},
    ],
    "medium": [
        {"key": "total_points", "label": "Total Points"},
        {"key": "total_assists", "label": "Total Assists"},
        {"key": "total_rebounds", "label": "Total Rebounds"},
        {"key": "total_games", "label": "Total Games Played"},
        {"key": "best_season_pir", "label": "Best Single-Season PIR"},
    ],
    "hard": [
        {"key": "total_three_pointers", "label": "Career 3-Pointers Made"},
        {"key": "career_high_points", "label": "Single-Game Career-High Points"},
        {"key": "total_steals", "label": "Total Steals"},
        {"key": "total_blocks", "label": "Total Blocks"},
        {"key": "total_turnovers", "label": "Total Turnovers"},
    ],
}


# ---------------------------------------------------------------------------
# Eligible players
# ---------------------------------------------------------------------------

def _eligible_player_ids(
    db: Session,
    season_start: int,
    season_end: int,
    min_games: int | None = None,
) -> list[int]:
    """Return player IDs with ≥ min_games career games and at least 1 season in range.

    If min_games is None, uses dynamic threshold: min(30, seasons_selected * 10).
    """
    if min_games is None:
        seasons_count = season_end - season_start + 1
        min_games = min(30, seasons_count * 10)
    season_ids = (
        db.query(Season.id)
        .filter(Season.year >= season_start, Season.year <= season_end)
        .subquery()
    )

    rows = (
        db.query(PlayerSeasonTeam.player_id)
        .join(PlayerSeasonStats, PlayerSeasonStats.player_season_team_id == PlayerSeasonTeam.id)
        .filter(PlayerSeasonTeam.season_id.in_(db.query(season_ids)))
        .group_by(PlayerSeasonTeam.player_id)
        .having(func.sum(PlayerSeasonStats.games_played) >= min_games)
        .all()
    )
    return [r[0] for r in rows]


# ---------------------------------------------------------------------------
# Stat computation
# ---------------------------------------------------------------------------

def _compute_stat(
    db: Session,
    player_id: int,
    category: str,
    season_start: int,
    season_end: int,
) -> int:
    """Compute a stat value for a player filtered to the season range."""
    season_ids = (
        db.query(Season.id)
        .filter(Season.year >= season_start, Season.year <= season_end)
        .subquery()
    )

    pst_in_range = (
        db.query(PlayerSeasonTeam.id)
        .filter(
            PlayerSeasonTeam.player_id == player_id,
            PlayerSeasonTeam.season_id.in_(db.query(season_ids)),
        )
        .subquery()
    )

    if category == "height_cm":
        p = db.query(Player).filter(Player.id == player_id).first()
        return p.height_cm or 0

    if category == "age":
        p = db.query(Player).filter(Player.id == player_id).first()
        if p and p.birth_date:
            today = date.today()
            return today.year - p.birth_date.year - (
                (today.month, today.day) < (p.birth_date.month, p.birth_date.day)
            )
        return 0

    if category == "seasons_played":
        r = (
            db.query(func.count(func.distinct(PlayerSeasonTeam.season_id)))
            .filter(
                PlayerSeasonTeam.player_id == player_id,
                PlayerSeasonTeam.season_id.in_(db.query(season_ids)),
            )
            .scalar()
        )
        return r or 0

    if category == "teams_played_for":
        r = (
            db.query(func.count(func.distinct(PlayerSeasonTeam.team_id)))
            .filter(
                PlayerSeasonTeam.player_id == player_id,
                PlayerSeasonTeam.season_id.in_(db.query(season_ids)),
            )
            .scalar()
        )
        return r or 0

    # Season-aggregate stats
    agg_map = {
        "total_points": func.sum(PlayerSeasonStats.points),
        "total_assists": func.sum(PlayerSeasonStats.assists),
        "total_rebounds": func.sum(PlayerSeasonStats.total_rebounds),
        "total_games": func.sum(PlayerSeasonStats.games_played),
        "best_season_pir": func.max(PlayerSeasonStats.pir),
        "total_three_pointers": func.sum(PlayerSeasonStats.three_points_made),
        "total_steals": func.sum(PlayerSeasonStats.steals),
        "total_blocks": func.sum(PlayerSeasonStats.blocks_favor),
        "total_turnovers": func.sum(PlayerSeasonStats.turnovers),
    }
    if category in agg_map:
        r = (
            db.query(agg_map[category])
            .join(PlayerSeasonTeam, PlayerSeasonStats.player_season_team_id == PlayerSeasonTeam.id)
            .filter(PlayerSeasonTeam.player_id == player_id)
            .filter(PlayerSeasonTeam.season_id.in_(db.query(season_ids)))
            .scalar()
        )
        return r or 0

    # Game-level stats
    if category == "career_high_points":
        game_ids_in_range = (
            db.query(Game.id)
            .filter(Game.season_id.in_(db.query(season_ids)))
            .subquery()
        )
        r = (
            db.query(func.max(GamePlayerStats.points))
            .filter(
                GamePlayerStats.player_id == player_id,
                GamePlayerStats.game_id.in_(db.query(game_ids_in_range)),
            )
            .scalar()
        )
        return r or 0

    return 0


# ---------------------------------------------------------------------------
# Pair generation
# ---------------------------------------------------------------------------

def _generate_pair(
    db: Session,
    eligible_ids: list[int],
    tier: str,
    season_start: int,
    season_end: int,
    exclude_ids: set[int] | None = None,
) -> dict:
    """Pick two random players and a random category from the tier."""
    pool = [pid for pid in eligible_ids if not exclude_ids or pid not in exclude_ids]
    if len(pool) < 2:
        pool = eligible_ids  # fallback

    pair = random.sample(pool, 2)
    left_id, right_id = pair

    cat = random.choice(TIER_CATEGORIES[tier])
    category = cat["key"]
    category_label = cat["label"]

    left_val = _compute_stat(db, left_id, category, season_start, season_end)
    right_val = _compute_stat(db, right_id, category, season_start, season_end)

    left_player = db.query(Player).filter(Player.id == left_id).first()
    right_player = db.query(Player).filter(Player.id == right_id).first()

    return {
        "left": {
            "player_id": left_id,
            "name": f"{left_player.first_name} {left_player.last_name}".strip(),
            "nationality": left_player.nationality,
        },
        "right": {
            "player_id": right_id,
            "name": f"{right_player.first_name} {right_player.last_name}".strip(),
            "nationality": right_player.nationality,
        },
        "category": category,
        "category_label": category_label,
        "left_value": left_val,
        "right_value": right_val,
    }


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def create_game(
    db: Session,
    *,
    tier: str,
    season_range_start: int,
    season_range_end: int,
    nickname: str,
) -> dict:
    """Create a new Higher or Lower game and return the first pair."""
    eligible = _eligible_player_ids(db, season_range_start, season_range_end)
    if len(eligible) < 2:
        raise ValueError("Not enough eligible players for the selected season range")

    pair = _generate_pair(db, eligible, tier, season_range_start, season_range_end)

    game = HigherLowerGame(
        tier=tier,
        season_range_start=season_range_start,
        season_range_end=season_range_end,
        nickname=nickname.strip(),
        current_streak=0,
        status="active",
        left_player_id=pair["left"]["player_id"],
        right_player_id=pair["right"]["player_id"],
        category=pair["category"],
        left_value=pair["left_value"],
        right_value=pair["right_value"],
    )
    db.add(game)
    db.flush()

    return {
        "game_id": game.id,
        "pair": {
            "left": pair["left"],
            "right": pair["right"],
            "category": pair["category"],
            "category_label": pair["category_label"],
        },
    }


def submit_answer(
    db: Session,
    game_id: int,
    *,
    choice: Literal["left", "right", "same"],
) -> dict:
    """Validate the player's answer and return the result."""
    game = db.query(HigherLowerGame).filter(HigherLowerGame.id == game_id).first()
    if not game:
        raise ValueError("Game not found")
    if game.status != "active":
        raise ValueError("Game is already finished")

    left_val = game.left_value
    right_val = game.right_value

    # Determine correct answer
    if left_val > right_val:
        correct_choice = "left"
    elif right_val > left_val:
        correct_choice = "right"
    else:
        correct_choice = "same"

    is_correct = choice == correct_choice

    if is_correct:
        game.current_streak += 1

        # Generate next pair
        eligible = _eligible_player_ids(db, game.season_range_start, game.season_range_end)
        next_pair = _generate_pair(
            db, eligible, game.tier,
            game.season_range_start, game.season_range_end,
            exclude_ids={game.left_player_id, game.right_player_id},
        )

        game.left_player_id = next_pair["left"]["player_id"]
        game.right_player_id = next_pair["right"]["player_id"]
        game.category = next_pair["category"]
        game.left_value = next_pair["left_value"]
        game.right_value = next_pair["right_value"]
        db.flush()

        return {
            "correct": True,
            "left_value": left_val,
            "right_value": right_val,
            "streak": game.current_streak,
            "next_pair": {
                "left": next_pair["left"],
                "right": next_pair["right"],
                "category": next_pair["category"],
                "category_label": next_pair["category_label"],
            },
        }
    else:
        # Game over
        game.status = "finished"
        final_streak = game.current_streak
        db.flush()

        # Save high score
        score = HigherLowerScore(
            nickname=game.nickname,
            tier=game.tier,
            streak=final_streak,
        )
        db.add(score)
        db.flush()

        # Check personal best
        personal_best = (
            db.query(func.max(HigherLowerScore.streak))
            .filter(
                HigherLowerScore.nickname == game.nickname,
                HigherLowerScore.tier == game.tier,
            )
            .scalar()
        ) or 0
        is_personal_best = final_streak >= personal_best and final_streak > 0

        # Check leaderboard position
        higher_count = (
            db.query(func.count())
            .select_from(HigherLowerScore)
            .filter(
                HigherLowerScore.tier == game.tier,
                HigherLowerScore.streak > final_streak,
            )
            .scalar()
        ) or 0
        leaderboard_pos = higher_count + 1

        return {
            "correct": False,
            "left_value": left_val,
            "right_value": right_val,
            "streak": final_streak,
            "next_pair": None,
            "is_personal_best": is_personal_best,
            "leaderboard_position": leaderboard_pos,
        }


def get_leaderboard(db: Session, tier: str) -> list[dict]:
    """Return top 10 scores for a tier."""
    rows = (
        db.query(HigherLowerScore)
        .filter(HigherLowerScore.tier == tier)
        .order_by(HigherLowerScore.streak.desc())
        .limit(10)
        .all()
    )
    return [
        {
            "nickname": r.nickname,
            "streak": r.streak,
            "played_at": r.played_at.isoformat() if r.played_at else "",
        }
        for r in rows
    ]
