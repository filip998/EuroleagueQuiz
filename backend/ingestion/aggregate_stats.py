import logging

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models import (
    Game,
    GamePlayerStats,
    PlayerSeasonStats,
    PlayerSeasonTeam,
    Season,
)
from ingestion.utils import parse_minutes

logger = logging.getLogger(__name__)


def aggregate_season_stats(session: Session, year: int) -> None:
    """Aggregate game_player_stats into player_season_stats for a season."""
    season_obj = session.query(Season).filter_by(year=year).first()
    if not season_obj:
        logger.warning(f"Season {year} not found in DB")
        return

    # Query aggregated stats grouped by (player_id, team_id)
    agg = (
        session.query(
            GamePlayerStats.player_id,
            GamePlayerStats.team_id,
            func.count(GamePlayerStats.id).label("games_played"),
            func.sum(GamePlayerStats.is_starter).label("games_started"),
            func.sum(GamePlayerStats.points).label("points"),
            func.sum(GamePlayerStats.two_points_made).label("two_points_made"),
            func.sum(GamePlayerStats.two_points_attempted).label("two_points_attempted"),
            func.sum(GamePlayerStats.three_points_made).label("three_points_made"),
            func.sum(GamePlayerStats.three_points_attempted).label("three_points_attempted"),
            func.sum(GamePlayerStats.free_throws_made).label("free_throws_made"),
            func.sum(GamePlayerStats.free_throws_attempted).label("free_throws_attempted"),
            func.sum(GamePlayerStats.offensive_rebounds).label("offensive_rebounds"),
            func.sum(GamePlayerStats.defensive_rebounds).label("defensive_rebounds"),
            func.sum(GamePlayerStats.total_rebounds).label("total_rebounds"),
            func.sum(GamePlayerStats.assists).label("assists"),
            func.sum(GamePlayerStats.steals).label("steals"),
            func.sum(GamePlayerStats.turnovers).label("turnovers"),
            func.sum(GamePlayerStats.blocks_favor).label("blocks_favor"),
            func.sum(GamePlayerStats.blocks_against).label("blocks_against"),
            func.sum(GamePlayerStats.fouls_committed).label("fouls_committed"),
            func.sum(GamePlayerStats.fouls_received).label("fouls_received"),
            func.sum(GamePlayerStats.pir).label("pir"),
            func.min(Game.round).label("first_round"),
            func.max(Game.round).label("last_round"),
        )
        .join(Game, GamePlayerStats.game_id == Game.id)
        .filter(Game.season_id == season_obj.id)
        .group_by(GamePlayerStats.player_id, GamePlayerStats.team_id)
        .all()
    )

    if not agg:
        logger.warning(f"No game stats found for season {year}")
        return

    # Collect minutes separately (need raw strings, can't SUM in SQL)
    minutes_rows = (
        session.query(
            GamePlayerStats.player_id,
            GamePlayerStats.team_id,
            GamePlayerStats.minutes,
        )
        .join(Game, GamePlayerStats.game_id == Game.id)
        .filter(Game.season_id == season_obj.id)
        .all()
    )
    minutes_map: dict[tuple[int, int], int] = {}
    for row in minutes_rows:
        key = (row.player_id, row.team_id)
        minutes_map[key] = minutes_map.get(key, 0) + parse_minutes(row.minutes or "")

    count = 0
    for row in agg:
        # Find or create PlayerSeasonTeam
        pst = (
            session.query(PlayerSeasonTeam)
            .filter_by(
                player_id=row.player_id,
                team_id=row.team_id,
                season_id=season_obj.id,
            )
            .first()
        )
        if not pst:
            pst = PlayerSeasonTeam(
                player_id=row.player_id,
                team_id=row.team_id,
                season_id=season_obj.id,
            )
            session.add(pst)
            session.flush()

        # Update round fields
        pst.first_game_round = row.first_round
        pst.last_game_round = row.last_round

        total_minutes = minutes_map.get((row.player_id, row.team_id), 0)

        stats_data = dict(
            player_season_team_id=pst.id,
            games_played=row.games_played or 0,
            games_started=int(row.games_started or 0),
            minutes_played=total_minutes,
            points=row.points or 0,
            two_points_made=row.two_points_made or 0,
            two_points_attempted=row.two_points_attempted or 0,
            three_points_made=row.three_points_made or 0,
            three_points_attempted=row.three_points_attempted or 0,
            free_throws_made=row.free_throws_made or 0,
            free_throws_attempted=row.free_throws_attempted or 0,
            offensive_rebounds=row.offensive_rebounds or 0,
            defensive_rebounds=row.defensive_rebounds or 0,
            total_rebounds=row.total_rebounds or 0,
            assists=row.assists or 0,
            steals=row.steals or 0,
            turnovers=row.turnovers or 0,
            blocks_favor=row.blocks_favor or 0,
            blocks_against=row.blocks_against or 0,
            fouls_committed=row.fouls_committed or 0,
            fouls_received=row.fouls_received or 0,
            pir=row.pir or 0,
        )

        # Upsert PlayerSeasonStats
        existing = (
            session.query(PlayerSeasonStats)
            .filter_by(player_season_team_id=pst.id)
            .first()
        )
        if existing:
            for k, v in stats_data.items():
                setattr(existing, k, v)
        else:
            session.add(PlayerSeasonStats(**stats_data))
        count += 1

    session.flush()
    logger.info(f"Aggregated stats for {count} player-team combos in season {year}")
