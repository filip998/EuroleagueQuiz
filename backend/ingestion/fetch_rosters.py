import logging
from datetime import date, datetime

from euroleague_api.utils import get_requests
from sqlalchemy.orm import Session

from app.models import Player, PlayerSeasonTeam, Season, TeamSeason
from ingestion.utils import RateLimiter, parse_player_name

logger = logging.getLogger(__name__)


def fetch_rosters(session: Session, year: int, rate_limiter: RateLimiter) -> None:
    """Fetch V2 club rosters to populate players and player_season_teams."""
    season_obj = session.query(Season).filter_by(year=year).first()
    if not season_obj:
        logger.warning(f"Season {year} not found in DB — run fetch_seasons first")
        return

    team_seasons = (
        session.query(TeamSeason).filter_by(season_id=season_obj.id).all()
    )
    if not team_seasons:
        logger.warning(f"No teams found for season {year}")
        return

    total_players = 0
    for ts in team_seasons:
        team = ts.team
        team_code = team.euroleague_code
        url = (
            f"https://api-live.euroleague.net/v2/competitions/E"
            f"/seasons/E{year}/clubs/{team_code}/people"
        )

        rate_limiter.wait()
        try:
            r = get_requests(url)
            data = r.json()
        except Exception as e:
            logger.warning(
                f"Failed to fetch roster for {team_code} season {year}: {e}"
            )
            continue

        if not data:
            continue

        players_in_team = 0
        for entry in data:
            if entry.get("type") != "J":
                continue

            person = entry.get("person", {})
            code = person.get("code")
            if not code:
                continue

            first_name, last_name = parse_player_name(person.get("name", ""))
            birth_date = _parse_date(person.get("birthDate"))
            height_cm = _safe_int(person.get("height"))
            nationality = (person.get("country") or {}).get("name")
            position = entry.get("positionName")
            jersey = str(entry.get("dorsal", "")) or None
            image_url = (entry.get("images") or {}).get("headshot")

            reg_start = _parse_date(entry.get("startDate"))
            reg_end = _parse_date(entry.get("endDate"))

            # Upsert Player
            player = (
                session.query(Player).filter_by(euroleague_code=code).first()
            )
            if not player:
                player = Player(
                    euroleague_code=code,
                    first_name=first_name,
                    last_name=last_name,
                    birth_date=birth_date,
                    nationality=nationality,
                    height_cm=height_cm,
                    position=position,
                    image_url=image_url,
                )
                session.add(player)
                session.flush()
            else:
                # Update fields if we have newer/better data
                if first_name:
                    player.first_name = first_name
                if last_name:
                    player.last_name = last_name
                if birth_date:
                    player.birth_date = birth_date
                if nationality:
                    player.nationality = nationality
                if height_cm:
                    player.height_cm = height_cm
                if position:
                    player.position = position
                if image_url:
                    player.image_url = image_url

            # Upsert PlayerSeasonTeam
            pst = (
                session.query(PlayerSeasonTeam)
                .filter_by(
                    player_id=player.id,
                    team_id=team.id,
                    season_id=season_obj.id,
                )
                .first()
            )
            if not pst:
                pst = PlayerSeasonTeam(
                    player_id=player.id,
                    team_id=team.id,
                    season_id=season_obj.id,
                    jersey_number=jersey,
                    registration_start=reg_start,
                    registration_end=reg_end,
                )
                session.add(pst)
                session.flush()
            else:
                if jersey:
                    pst.jersey_number = jersey
                if reg_start:
                    pst.registration_start = reg_start
                if reg_end:
                    pst.registration_end = reg_end

            players_in_team += 1

        total_players += players_in_team
        logger.debug(
            f"Fetched {players_in_team} players for {team_code} season {year}"
        )

    session.flush()
    logger.info(f"Upserted {total_players} player-season-team records for season {year}")


def _parse_date(val) -> date | None:
    if not val:
        return None
    try:
        return datetime.fromisoformat(val.replace("Z", "+00:00")).date()
    except (ValueError, AttributeError):
        return None


def _safe_int(val) -> int | None:
    if val is None:
        return None
    try:
        return int(val)
    except (ValueError, TypeError):
        return None
