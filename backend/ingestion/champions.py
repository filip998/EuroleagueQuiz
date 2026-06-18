import re
from dataclasses import dataclass
from datetime import date
from typing import Mapping

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models import Game, PlayerSeasonTeam, Season, Team

@dataclass(frozen=True)
class ChampionSeason:
    euroleague_code: str | None
    team_names: tuple[str, ...] = ()
    final_four_date_fallback: date | None = None
    note: str | None = None


@dataclass(frozen=True)
class ChampionSeasonReport:
    season_year: int
    champion_code: str | None
    champion_team_id: int | None
    final_four_date: date | None
    flagged_count: int
    set_true_count: int = 0
    set_false_count: int = 0
    skipped_reason: str | None = None


CHAMPION_SEASONS_BY_YEAR: dict[int, ChampionSeason] = {
    2000: ChampionSeason(
        "VIR",
        ("Virtus Bologna", "Kinder Bologna"),
        final_four_date_fallback=date(2001, 6, 30),
        note="No Final Four games are tagged in the source data for 2000-2001.",
    ),
    2001: ChampionSeason("PAN", ("Panathinaikos",)),
    2002: ChampionSeason("BAR", ("FC Barcelona", "Barcelona")),
    2003: ChampionSeason("TEL", ("Maccabi Tel Aviv",)),
    2004: ChampionSeason("TEL", ("Maccabi Tel Aviv",)),
    2005: ChampionSeason("CSK", ("CSKA Moscow",)),
    2006: ChampionSeason("PAN", ("Panathinaikos",)),
    2007: ChampionSeason("CSK", ("CSKA Moscow",)),
    2008: ChampionSeason("PAN", ("Panathinaikos",)),
    2009: ChampionSeason("BAR", ("FC Barcelona", "Barcelona")),
    2010: ChampionSeason("PAN", ("Panathinaikos",)),
    2011: ChampionSeason("OLY", ("Olympiacos",)),
    2012: ChampionSeason("OLY", ("Olympiacos",)),
    2013: ChampionSeason("TEL", ("Maccabi Tel Aviv",)),
    2014: ChampionSeason("MAD", ("Real Madrid",)),
    2015: ChampionSeason("CSK", ("CSKA Moscow",)),
    2016: ChampionSeason("ULK", ("Fenerbahce",)),
    2017: ChampionSeason("MAD", ("Real Madrid",)),
    2018: ChampionSeason("CSK", ("CSKA Moscow",)),
    2019: ChampionSeason(
        None,
        note="The 2019-2020 EuroLeague season was canceled with no champion.",
    ),
    2020: ChampionSeason("IST", ("Anadolu Efes", "Efes Pilsen")),
    2021: ChampionSeason("IST", ("Anadolu Efes", "Efes Pilsen")),
    2022: ChampionSeason("MAD", ("Real Madrid",)),
    2023: ChampionSeason("PAN", ("Panathinaikos",)),
    2024: ChampionSeason("ULK", ("Fenerbahce",)),
    2025: ChampionSeason(
        "OLY",
        ("Olympiacos",),
        note=(
            "The 2025-2026 champion is curated, but the tracked database is "
            "not flagged until Final Four games are ingested."
        ),
    ),
}

_EXPECTED_CHAMPION_YEARS = tuple(range(2000, 2026))
if tuple(sorted(CHAMPION_SEASONS_BY_YEAR)) != _EXPECTED_CHAMPION_YEARS:
    raise ValueError("Champion seasons must cover every season year from 2000 to 2025")

_GAME_DATE_RE = re.compile(r"^(?P<month>[A-Za-z]{3}) (?P<day>\d{1,2}), (?P<year>\d{4})$")
_MONTHS_BY_ABBREVIATION = {
    "Jan": 1,
    "Feb": 2,
    "Mar": 3,
    "Apr": 4,
    "May": 5,
    "Jun": 6,
    "Jul": 7,
    "Aug": 8,
    "Sep": 9,
    "Oct": 10,
    "Nov": 11,
    "Dec": 12,
}


def enrich_champion_flags(
    db: Session,
    *,
    start_year: int = 2000,
    end_year: int = 2025,
    champion_seasons: Mapping[int, ChampionSeason] = CHAMPION_SEASONS_BY_YEAR,
) -> list[ChampionSeasonReport]:
    """Populate title-squad champion flags for the requested season range."""

    reports: list[ChampionSeasonReport] = []
    for season_year in range(start_year, end_year + 1):
        season = db.query(Season).filter(Season.year == season_year).first()
        if season is None:
            reports.append(
                ChampionSeasonReport(
                    season_year=season_year,
                    champion_code=None,
                    champion_team_id=None,
                    final_four_date=None,
                    flagged_count=0,
                    skipped_reason="season_missing",
                )
            )
            continue

        champion = champion_seasons.get(season_year)
        if champion is None:
            reports.append(
                _sync_champion_targets(
                    db,
                    season=season,
                    champion_code=None,
                    champion_team_id=None,
                    final_four_date=None,
                    target_ids=set(),
                    skipped_reason="champion_mapping_missing",
                )
            )
            continue

        if champion.euroleague_code is None:
            if season.champion_team_id is not None:
                season.champion_team_id = None
            reports.append(
                _sync_champion_targets(
                    db,
                    season=season,
                    champion_code=None,
                    champion_team_id=None,
                    final_four_date=None,
                    target_ids=set(),
                    skipped_reason="no_champion",
                )
            )
            continue

        team = _resolve_champion_team(db, champion)
        if season.champion_team_id != team.id:
            season.champion_team_id = team.id

        final_four_date = _final_four_date_for_season(db, season, champion)
        if final_four_date is None:
            reports.append(
                _sync_champion_targets(
                    db,
                    season=season,
                    champion_code=champion.euroleague_code,
                    champion_team_id=team.id,
                    final_four_date=None,
                    target_ids=set(),
                    skipped_reason="final_four_date_missing",
                )
            )
            continue

        target_ids = _title_squad_player_season_team_ids(
            db,
            season=season,
            champion_team=team,
            final_four_date=final_four_date,
        )
        reports.append(
            _sync_champion_targets(
                db,
                season=season,
                champion_code=champion.euroleague_code,
                champion_team_id=team.id,
                final_four_date=final_four_date,
                target_ids=target_ids,
                skipped_reason=None,
            )
        )

    db.flush()
    return reports


def champion_counts_by_season(
    reports: list[ChampionSeasonReport],
) -> dict[int, int]:
    return {report.season_year: report.flagged_count for report in reports}


def format_champion_report(reports: list[ChampionSeasonReport]) -> str:
    return ", ".join(
        (
            f"{report.season_year}={report.flagged_count}"
            if report.skipped_reason is None
            else f"{report.season_year}={report.flagged_count}({report.skipped_reason})"
        )
        for report in reports
    )


def parse_euroleague_game_date(value: str) -> date:
    match = _GAME_DATE_RE.match(value.strip())
    if match is None:
        raise ValueError(f"Unsupported EuroLeague game date format: {value!r}")

    month = _MONTHS_BY_ABBREVIATION.get(match.group("month"))
    if month is None:
        raise ValueError(f"Unsupported EuroLeague game date month: {value!r}")

    return date(
        int(match.group("year")),
        month,
        int(match.group("day")),
    )


def _resolve_champion_team(db: Session, champion: ChampionSeason) -> Team:
    if champion.euroleague_code is not None:
        team = (
            db.query(Team)
            .filter(Team.euroleague_code == champion.euroleague_code)
            .one_or_none()
        )
        if team is not None:
            return team

    aliases = {
        _normalize_team_name(name)
        for name in (champion.euroleague_code, *champion.team_names)
        if name
    }
    if not aliases:
        raise ValueError("Champion team must define a EuroLeague code or team name")

    teams = db.query(Team).all()
    matches = [
        team
        for team in teams
        if aliases
        & {
            _normalize_team_name(value)
            for value in (team.name, team.short_name, team.euroleague_code)
            if value
        }
    ]
    if len(matches) == 1:
        return matches[0]
    if not matches:
        raise ValueError(
            "Champion team could not be resolved: "
            f"code={champion.euroleague_code!r} names={champion.team_names!r}"
        )
    raise ValueError(
        "Champion team resolved ambiguously: "
        f"code={champion.euroleague_code!r} names={champion.team_names!r}"
    )


def _final_four_date_for_season(
    db: Session,
    season: Season,
    champion: ChampionSeason,
) -> date | None:
    rows = (
        db.query(Game.game_date)
        .filter(Game.season_id == season.id)
        .filter(Game.phase == "FF")
        .all()
    )
    parsed_dates = [
        parse_euroleague_game_date(row.game_date)
        for row in rows
        if row.game_date
    ]
    if parsed_dates:
        return max(parsed_dates)
    return champion.final_four_date_fallback


def _title_squad_player_season_team_ids(
    db: Session,
    *,
    season: Season,
    champion_team: Team,
    final_four_date: date,
) -> set[int]:
    rows = (
        db.query(PlayerSeasonTeam.id)
        .filter(PlayerSeasonTeam.season_id == season.id)
        .filter(PlayerSeasonTeam.team_id == champion_team.id)
        .filter(
            or_(
                PlayerSeasonTeam.registration_end.is_(None),
                PlayerSeasonTeam.registration_end >= final_four_date,
            )
        )
        .all()
    )
    return {row.id for row in rows}


def _sync_champion_targets(
    db: Session,
    *,
    season: Season,
    champion_code: str | None,
    champion_team_id: int | None,
    final_four_date: date | None,
    target_ids: set[int],
    skipped_reason: str | None,
) -> ChampionSeasonReport:
    existing_true_ids = {
        row.id
        for row in (
            db.query(PlayerSeasonTeam.id)
            .filter(PlayerSeasonTeam.season_id == season.id)
            .filter(PlayerSeasonTeam.is_champion.is_(True))
            .all()
        )
    }
    existing_null_ids = {
        row.id
        for row in (
            db.query(PlayerSeasonTeam.id)
            .filter(PlayerSeasonTeam.season_id == season.id)
            .filter(PlayerSeasonTeam.is_champion.is_(None))
            .all()
        )
    }

    set_true_ids = target_ids - existing_true_ids
    set_false_ids = (existing_true_ids - target_ids) | (existing_null_ids - target_ids)

    if set_true_ids:
        (
            db.query(PlayerSeasonTeam)
            .filter(PlayerSeasonTeam.id.in_(sorted(set_true_ids)))
            .update({PlayerSeasonTeam.is_champion: True}, synchronize_session=False)
        )
    if set_false_ids:
        (
            db.query(PlayerSeasonTeam)
            .filter(PlayerSeasonTeam.id.in_(sorted(set_false_ids)))
            .update({PlayerSeasonTeam.is_champion: False}, synchronize_session=False)
        )

    return ChampionSeasonReport(
        season_year=season.year,
        champion_code=champion_code,
        champion_team_id=champion_team_id,
        final_four_date=final_four_date,
        flagged_count=len(target_ids),
        set_true_count=len(set_true_ids),
        set_false_count=len(set_false_ids),
        skipped_reason=skipped_reason,
    )


def _normalize_team_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.casefold())
