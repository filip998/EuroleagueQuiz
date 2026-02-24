import logging

import pandas as pd
from euroleague_api.boxscore_data import BoxScoreData
from sqlalchemy.orm import Session

from app.models import Game, GamePlayerStats, Player, Season, Team
from ingestion.utils import RateLimiter

logger = logging.getLogger(__name__)

# Summary rows to skip
_SKIP_PLAYER_IDS = {"Team", "Total"}


def fetch_boxscores(session: Session, year: int, rate_limiter: RateLimiter) -> None:
    """Fetch box scores for all games in a season."""
    season_obj = session.query(Season).filter_by(year=year).first()
    if not season_obj:
        logger.warning(f"Season {year} not found in DB — run fetch_seasons first")
        return

    games = session.query(Game).filter_by(season_id=season_obj.id).all()
    if not games:
        logger.warning(f"No games found for season {year}")
        return

    # Build team code → id map
    team_map: dict[str, int] = {
        t.euroleague_code: t.id for t in session.query(Team).all()
    }
    # Build player euroleague_code → id map
    player_map: dict[str, int] = {
        p.euroleague_code: p.id for p in session.query(Player).all()
    }

    api = BoxScoreData("E")
    stats_count = 0

    for idx, game in enumerate(games):
        gamecode = game.euroleague_gamecode
        rate_limiter.wait()
        try:
            df = api.get_player_boxscore_stats_data(year, gamecode)
        except Exception as e:
            logger.warning(
                f"Failed to fetch box score for game {gamecode} season {year}: {e}"
            )
            continue

        if df is None or df.empty:
            continue

        game_stats = 0
        for _, row in df.iterrows():
            raw_pid = str(row.get("Player_ID", "")).strip()

            # Filter summary rows
            if raw_pid in _SKIP_PLAYER_IDS or not raw_pid:
                continue

            # Strip "P" prefix to get euroleague_code
            eur_code = raw_pid[1:] if raw_pid.startswith("P") else raw_pid

            # Resolve player
            player_id = player_map.get(eur_code)
            if not player_id:
                # Create a minimal Player record
                player = Player(euroleague_code=eur_code)
                # Try to parse name from the Player column
                player_name = str(row.get("Player", "")).strip()
                if player_name and player_name not in _SKIP_PLAYER_IDS:
                    parts = player_name.split(", ", 1)
                    if len(parts) == 2:
                        player.first_name = parts[1].strip()
                        player.last_name = parts[0].strip()
                    else:
                        player.last_name = player_name
                session.add(player)
                session.flush()
                player_id = player.id
                player_map[eur_code] = player_id

            # Resolve team
            team_code = str(row.get("Team", "")).strip()
            team_id = team_map.get(team_code)
            if not team_id:
                logger.debug(
                    f"Unknown team code '{team_code}' in box score "
                    f"game {gamecode} season {year}"
                )
                continue

            is_starter = bool(row.get("IsStarter", 0))
            minutes_str = str(row.get("Minutes", "")) if pd.notna(row.get("Minutes")) else None

            gps_data = dict(
                game_id=game.id,
                player_id=player_id,
                team_id=team_id,
                is_starter=is_starter,
                minutes=minutes_str,
                points=_safe_int(row.get("Points")),
                two_points_made=_safe_int(row.get("FieldGoalsMade2")),
                two_points_attempted=_safe_int(row.get("FieldGoalsAttempted2")),
                three_points_made=_safe_int(row.get("FieldGoalsMade3")),
                three_points_attempted=_safe_int(row.get("FieldGoalsAttempted3")),
                free_throws_made=_safe_int(row.get("FreeThrowsMade")),
                free_throws_attempted=_safe_int(row.get("FreeThrowsAttempted")),
                offensive_rebounds=_safe_int(row.get("OffensiveRebounds")),
                defensive_rebounds=_safe_int(row.get("DefensiveRebounds")),
                total_rebounds=_safe_int(row.get("TotalRebounds")),
                assists=_safe_int(row.get("Assistances")),
                steals=_safe_int(row.get("Steals")),
                turnovers=_safe_int(row.get("Turnovers")),
                blocks_favor=_safe_int(row.get("BlocksFavour")),
                blocks_against=_safe_int(row.get("BlocksAgainst")),
                fouls_committed=_safe_int(row.get("FoulsCommited")),
                fouls_received=_safe_int(row.get("FoulsReceived")),
                plus_minus=_safe_int(row.get("Plusminus")),
                pir=_safe_int(row.get("Valuation")),
            )

            # Upsert GamePlayerStats
            existing = (
                session.query(GamePlayerStats)
                .filter_by(
                    game_id=game.id,
                    player_id=player_id,
                    team_id=team_id,
                )
                .first()
            )
            if existing:
                for k, v in gps_data.items():
                    setattr(existing, k, v)
            else:
                session.add(GamePlayerStats(**gps_data))
            game_stats += 1

        stats_count += game_stats

        # Flush periodically to avoid huge transaction memory
        if (idx + 1) % 50 == 0:
            session.flush()
            logger.info(
                f"Season {year}: processed {idx + 1}/{len(games)} games"
            )

    session.flush()
    logger.info(
        f"Upserted {stats_count} game-player-stat records for season {year}"
    )


def _safe_int(val) -> int | None:
    if val is None or (isinstance(val, float) and pd.isna(val)):
        return None
    try:
        return int(val)
    except (ValueError, TypeError):
        return None
