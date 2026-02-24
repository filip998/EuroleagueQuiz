import logging

import pandas as pd
from euroleague_api.EuroLeagueData import EuroLeagueData
from sqlalchemy.orm import Session

from app.models import Game, Season, Team, TeamSeason
from ingestion.utils import RateLimiter

logger = logging.getLogger(__name__)


def fetch_season_data(session: Session, year: int, rate_limiter: RateLimiter) -> None:
    """Fetch game metadata for a season and populate seasons, teams, team_seasons, games."""
    logger.info(f"Fetching season data for {year}")
    api = EuroLeagueData("E")

    rate_limiter.wait()
    try:
        df = api.get_gamecodes_season(year)
    except Exception as e:
        logger.error(f"Failed to fetch game codes for season {year}: {e}")
        return

    if df is None or df.empty:
        logger.warning(f"No game data returned for season {year}")
        return

    # Upsert Season
    season_obj = session.query(Season).filter_by(year=year).first()
    if not season_obj:
        season_obj = Season(year=year, name=f"{year}-{year + 1}")
        session.add(season_obj)
        session.flush()
    logger.info(f"Season {year} → id={season_obj.id}")

    # Collect unique team codes and names from home + away columns
    home_teams = df[["homecode", "hometeam"]].rename(
        columns={"homecode": "code", "hometeam": "name"}
    )
    away_teams = df[["awaycode", "awayteam"]].rename(
        columns={"awaycode": "code", "awayteam": "name"}
    )
    all_teams = pd.concat([home_teams, away_teams]).drop_duplicates(subset="code")

    # Upsert teams and team_seasons, build code→id map
    team_map: dict[str, int] = {}
    for _, row in all_teams.iterrows():
        code = str(row["code"]).strip()
        name = str(row["name"]).strip()
        if not code:
            continue

        team = session.query(Team).filter_by(euroleague_code=code).first()
        if not team:
            team = Team(euroleague_code=code, name=name)
            session.add(team)
            session.flush()
        elif not team.name or team.name != name:
            team.name = name

        team_map[code] = team.id

        # Upsert TeamSeason
        ts = (
            session.query(TeamSeason)
            .filter_by(team_id=team.id, season_id=season_obj.id)
            .first()
        )
        if not ts:
            ts = TeamSeason(
                team_id=team.id,
                season_id=season_obj.id,
                team_name_that_season=name,
            )
            session.add(ts)
        else:
            ts.team_name_that_season = name

    session.flush()
    logger.info(f"Upserted {len(team_map)} teams for season {year}")

    # Upsert games (only played games)
    games_count = 0
    for _, row in df.iterrows():
        if not row.get("played", True):
            continue

        home_code = str(row["homecode"]).strip()
        away_code = str(row["awaycode"]).strip()
        if home_code not in team_map or away_code not in team_map:
            continue

        gamecode = int(row["gameCode"])
        game = (
            session.query(Game)
            .filter_by(season_id=season_obj.id, euroleague_gamecode=gamecode)
            .first()
        )

        game_data = dict(
            season_id=season_obj.id,
            euroleague_gamecode=gamecode,
            round=_safe_int(row.get("Round")),
            phase=str(row.get("Phase", "")) or None,
            game_date=str(row.get("date", "")) or None,
            game_time=str(row.get("time", "")) or None,
            home_team_id=team_map[home_code],
            away_team_id=team_map[away_code],
            home_score=_safe_int(row.get("homescore")),
            away_score=_safe_int(row.get("awayscore")),
        )

        if game:
            for k, v in game_data.items():
                setattr(game, k, v)
        else:
            game = Game(**game_data)
            session.add(game)
        games_count += 1

    session.flush()
    logger.info(f"Upserted {games_count} games for season {year}")


def _safe_int(val) -> int | None:
    if val is None or (isinstance(val, float) and pd.isna(val)):
        return None
    try:
        return int(val)
    except (ValueError, TypeError):
        return None
