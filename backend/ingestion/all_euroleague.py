from __future__ import annotations

import argparse
import hashlib
import json
import logging
import re
import sys
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol
from urllib.parse import quote

import httpx
import mwparserfromhell
from sqlalchemy import create_engine, func
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.models import (
    AwardDataRevision,
    Player,
    PlayerAwardSelection,
    PlayerSeasonTeam,
    Season,
    Team,
    TeamSeason,
)
from ingestion.utils import RateLimiter
from ingestion.wikipedia_careers import normalize_name

logger = logging.getLogger(__name__)

ACCEPTED = "accepted"
AMBIGUOUS = "ambiguous"
EXCLUDED = "excluded"
UNMATCHED = "unmatched"

AWARD_KEY = "all_euroleague"
SOURCE_NAME = "wikipedia"
SOURCE_TITLE = "All-EuroLeague Team"
SOURCE_API_URL = "https://en.wikipedia.org/w/api.php"
SOURCE_PAGE_URL = "https://en.wikipedia.org/wiki/All-EuroLeague_Team"

METRIC_FIRST = "first"
METRIC_SECOND = "second"
METRIC_FIRST_SECOND = "first_second"
DEFAULT_OVERRIDES_PATH = Path(__file__).with_name("all_euroleague_overrides.json")
EXPECTED_AWARDED_SEASON_YEARS = tuple(
    year for year in range(2000, 2026) if year != 2019
)


@dataclass(frozen=True)
class WikipediaAwardPage:
    page_id: int
    title: str
    url: str
    revision_id: str
    wikitext: str
    retrieved_at: datetime


@dataclass(frozen=True)
class SourceLink:
    label: str
    target: str | None
    url: str | None


@dataclass(frozen=True)
class ParsedAllEuroLeagueSelection:
    season_year: int
    season_label: str
    award_metric: str
    source_order: int
    source_row_key: str
    source_position: str | None
    source_player_label: str
    source_player_url: str | None
    source_team_label: str | None
    source_team_url: str | None


@dataclass(frozen=True)
class PlayerOverride:
    euroleague_code: str | None = None
    status: str | None = None
    note: str | None = None


@dataclass(frozen=True)
class IngestOptions:
    start_year: int = 2000
    end_year: int = 2025
    overrides_path: Path | None = DEFAULT_OVERRIDES_PATH
    report_path: Path | None = None


@dataclass(frozen=True)
class Resolution:
    status: str
    local_id: int | None
    match_method: str | None
    reviewed: bool = False
    review_note: str | None = None
    candidates: tuple[dict, ...] = ()
    error: str | None = None


@dataclass
class CoverageReport:
    metric: str
    min_answers: int
    passed: bool
    playable_seasons: list[int] = field(default_factory=list)
    missing_seasons: list[int] = field(default_factory=list)
    unresolved_rows: list[dict] = field(default_factory=list)
    duplicate_players: list[dict] = field(default_factory=list)
    seasons: dict[str, dict] = field(default_factory=dict)


@dataclass
class IngestionReport:
    source_revision_id: str
    source_url: str
    content_hash: str
    parsed_rows: int = 0
    in_range_rows: int = 0
    accepted: int = 0
    unmatched: int = 0
    ambiguous: int = 0
    excluded: int = 0
    team_unmatched: int = 0
    enabled_metric: str | None = None
    threshold_passed: bool = False
    expected_seasons: list[int] = field(default_factory=list)
    first_second: CoverageReport | None = None
    first: CoverageReport | None = None
    selections: list[dict] = field(default_factory=list)


class AllEuroLeagueAdapter(Protocol):
    def fetch_page(self) -> WikipediaAwardPage: ...


class HttpAllEuroLeagueAdapter:
    def __init__(
        self,
        *,
        user_agent: str = settings.wikipedia_user_agent,
        rate_limiter: RateLimiter | None = None,
        timeout: float = 30.0,
    ):
        self.user_agent = user_agent
        self.rate_limiter = rate_limiter or RateLimiter(settings.api_rate_limit_seconds)
        self.timeout = timeout

    def fetch_page(self) -> WikipediaAwardPage:
        self.rate_limiter.wait()
        with httpx.Client(timeout=self.timeout, headers=self._headers()) as client:
            response = client.get(
                SOURCE_API_URL,
                params={
                    "action": "query",
                    "prop": "revisions|info",
                    "titles": SOURCE_TITLE,
                    "rvprop": "ids|content",
                    "rvslots": "main",
                    "inprop": "url",
                    "formatversion": 2,
                    "format": "json",
                },
            )
            response.raise_for_status()
            pages = response.json().get("query", {}).get("pages", [])
        if not pages or pages[0].get("missing"):
            raise RuntimeError(f"Wikipedia page not found: {SOURCE_TITLE}")
        page = pages[0]
        revisions = page.get("revisions") or []
        if not revisions:
            raise RuntimeError(f"Wikipedia page has no revision content: {SOURCE_TITLE}")
        revision = revisions[0]
        wikitext = revision.get("slots", {}).get("main", {}).get("content", "")
        return WikipediaAwardPage(
            page_id=int(page["pageid"]),
            title=page["title"],
            url=page.get("fullurl") or SOURCE_PAGE_URL,
            revision_id=str(revision.get("revid") or ""),
            wikitext=wikitext,
            retrieved_at=datetime.now(timezone.utc).replace(tzinfo=None),
        )

    def _headers(self) -> dict[str, str]:
        return {"User-Agent": self.user_agent}


class PlayerResolver:
    def __init__(self, session: Session, overrides: dict[str, PlayerOverride]):
        self.overrides = overrides
        self.players = session.query(Player).order_by(Player.id).all()
        roster_counts = dict(
            session.query(PlayerSeasonTeam.player_id, func.count(PlayerSeasonTeam.id))
            .group_by(PlayerSeasonTeam.player_id)
            .all()
        )
        self.roster_counts = {int(player_id): int(count) for player_id, count in roster_counts.items()}
        self.by_code = {
            player.euroleague_code.upper(): player
            for player in self.players
            if player.euroleague_code
        }
        self.by_normalized_name: dict[str, list[Player]] = {}
        for player in self.players:
            self.by_normalized_name.setdefault(
                normalize_name(_player_name(player)),
                [],
            ).append(player)

    def resolve(self, label: str) -> Resolution:
        normalized = normalize_name(label)
        override = self.overrides.get(normalized)
        if override is not None:
            if override.status == EXCLUDED:
                return Resolution(
                    status=EXCLUDED,
                    local_id=None,
                    match_method="override_excluded",
                    reviewed=True,
                    review_note=override.note,
                )
            if override.euroleague_code:
                player = self.by_code.get(override.euroleague_code.upper())
                if player is not None:
                    return Resolution(
                        status=ACCEPTED,
                        local_id=player.id,
                        match_method="override",
                        reviewed=True,
                        review_note=override.note,
                        candidates=(self._candidate(player),),
                    )
            return Resolution(
                status=UNMATCHED,
                local_id=None,
                match_method="override",
                reviewed=True,
                review_note=override.note,
                error="Reviewed player override did not match a local player",
            )

        exact = self.by_normalized_name.get(normalized, [])
        if len(exact) == 1:
            player = exact[0]
            return Resolution(
                status=ACCEPTED,
                local_id=player.id,
                match_method="exact_name",
                candidates=(self._candidate(player),),
            )
        if len(exact) > 1:
            return Resolution(
                status=AMBIGUOUS,
                local_id=None,
                match_method="exact_name",
                candidates=tuple(self._candidate(player) for player in exact),
                error="Multiple local players share this source label",
            )

        candidates = tuple(self._candidate(player) for player in self._candidate_players(label))
        return Resolution(
            status=UNMATCHED,
            local_id=None,
            match_method=None,
            candidates=candidates,
            error="No local player matched this source label",
        )

    def _candidate_players(self, label: str) -> list[Player]:
        source_tokens = set(normalize_name(label).split())
        if not source_tokens:
            return []
        candidates = []
        for player in self.players:
            local_tokens = set(normalize_name(_player_name(player)).split())
            if source_tokens & local_tokens:
                candidates.append(player)
        return sorted(
            candidates,
            key=lambda player: (
                -len(source_tokens & set(normalize_name(_player_name(player)).split())),
                -self.roster_counts.get(player.id, 0),
                _player_name(player),
            ),
        )[:8]

    def _candidate(self, player: Player) -> dict:
        return {
            "player_id": player.id,
            "euroleague_code": player.euroleague_code,
            "name": _player_name(player),
            "roster_seasons": self.roster_counts.get(player.id, 0),
        }


class TeamResolver:
    def __init__(self, session: Session, aliases: dict[str, str]):
        self.teams = session.query(Team).order_by(Team.id).all()
        self.by_code = {
            team.euroleague_code.upper(): team
            for team in self.teams
            if team.euroleague_code
        }
        self.aliases = {
            normalize_name(alias): code.upper()
            for alias, code in aliases.items()
            if code.upper() in self.by_code
        }
        self.by_normalized: dict[str, list[Team]] = {}
        for team in self.teams:
            for value in (team.euroleague_code, team.name, team.short_name):
                self._add_name(value, team)
        for team_season in session.query(TeamSeason).all():
            self._add_name(team_season.team_name_that_season, team_season.team)

    def resolve(self, label: str | None, target: str | None) -> Resolution:
        for value in (label, target):
            if not value:
                continue
            normalized = normalize_name(value)
            if normalized in self.aliases:
                team = self.by_code[self.aliases[normalized]]
                return Resolution(
                    status=ACCEPTED,
                    local_id=team.id,
                    match_method="team_alias",
                    reviewed=True,
                    candidates=(self._candidate(team),),
                )
            exact = _dedupe_teams(self.by_normalized.get(normalized, []))
            if len(exact) == 1:
                team = exact[0]
                return Resolution(
                    status=ACCEPTED,
                    local_id=team.id,
                    match_method="team_exact",
                    candidates=(self._candidate(team),),
                )
            if len(exact) > 1:
                return Resolution(
                    status=AMBIGUOUS,
                    local_id=None,
                    match_method="team_exact",
                    candidates=tuple(self._candidate(team) for team in exact),
                    error="Multiple local teams match this source label",
                )
        return Resolution(
            status=UNMATCHED,
            local_id=None,
            match_method=None,
            error="No local team matched this source label",
        )

    def _add_name(self, value: str | None, team: Team | None) -> None:
        if not value or team is None:
            return
        self.by_normalized.setdefault(normalize_name(value), []).append(team)

    def _candidate(self, team: Team) -> dict:
        return {
            "team_id": team.id,
            "euroleague_code": team.euroleague_code,
            "name": team.name,
            "short_name": team.short_name,
        }


def ingest_all_euroleague(
    session: Session,
    adapter: AllEuroLeagueAdapter,
    options: IngestOptions | None = None,
) -> IngestionReport:
    options = options or IngestOptions()
    page = adapter.fetch_page()
    parsed = parse_all_euroleague_selections(page.wikitext)
    content_hash = hashlib.sha256(page.wikitext.encode("utf-8")).hexdigest()
    player_overrides, team_aliases = load_overrides(options.overrides_path)
    player_resolver = PlayerResolver(session, player_overrides)
    team_resolver = TeamResolver(session, team_aliases)
    seasons = {
        season.year: season
        for season in session.query(Season)
        .filter(Season.year >= options.start_year)
        .filter(Season.year <= options.end_year)
        .all()
    }
    expected_seasons = expected_awarded_season_years(options.start_year, options.end_year)

    revision = AwardDataRevision(
        award_key=AWARD_KEY,
        source_name=SOURCE_NAME,
        source_url=page.url,
        source_revision_id=page.revision_id,
        source_retrieved_at=page.retrieved_at,
        content_hash=content_hash,
        status="pending",
        enabled_metric=None,
        eligible_row_count=0,
        accepted_row_count=0,
        eligible_round_count=0,
        threshold_round_count=len(expected_seasons),
        threshold_passed=False,
        report_path=None,
        report_hash=None,
        is_active=False,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    session.add(revision)
    session.flush()

    report = IngestionReport(
        source_revision_id=page.revision_id,
        source_url=page.url,
        content_hash=content_hash,
        parsed_rows=len(parsed),
        expected_seasons=expected_seasons,
    )

    selection_rows: list[PlayerAwardSelection] = []
    for parsed_row in parsed:
        if parsed_row.season_year < options.start_year or parsed_row.season_year > options.end_year:
            continue
        report.in_range_rows += 1
        season = seasons.get(parsed_row.season_year)
        player_resolution = player_resolver.resolve(parsed_row.source_player_label)
        team_resolution = team_resolver.resolve(
            parsed_row.source_team_label,
            _title_from_url(parsed_row.source_team_url),
        )
        status = player_resolution.status
        error = player_resolution.error
        match_method = player_resolution.match_method
        if season is None:
            status = EXCLUDED
            error = "Local season is missing"
            match_method = "season_missing"

        if team_resolution.status != ACCEPTED:
            report.team_unmatched += 1

        selection = PlayerAwardSelection(
            revision_id=revision.id,
            award_key=AWARD_KEY,
            award_metric=parsed_row.award_metric,
            season_id=season.id if season is not None else None,
            season_year=parsed_row.season_year,
            source_row_key=parsed_row.source_row_key,
            source_order=parsed_row.source_order,
            source_position=parsed_row.source_position,
            source_player_label=parsed_row.source_player_label,
            source_player_url=parsed_row.source_player_url,
            local_player_id=player_resolution.local_id if status == ACCEPTED else None,
            source_team_label=parsed_row.source_team_label,
            source_team_url=parsed_row.source_team_url,
            local_team_id=team_resolution.local_id if team_resolution.status == ACCEPTED else None,
            status=status,
            match_method=match_method,
            reviewed=player_resolution.reviewed,
            review_note=player_resolution.review_note,
            candidate_count=len(player_resolution.candidates),
            candidates_json=json.dumps(player_resolution.candidates, default=str),
            error=error,
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
        )
        session.add(selection)
        selection_rows.append(selection)
        _count_status(report, status)
        report.selections.append(_selection_report(selection, team_resolution))

    session.flush()
    first_second = _coverage_for_metric(
        selection_rows,
        metric=METRIC_FIRST_SECOND,
        expected_seasons=expected_seasons,
    )
    first = _coverage_for_metric(
        selection_rows,
        metric=METRIC_FIRST,
        expected_seasons=expected_seasons,
    )
    report.first_second = first_second
    report.first = first

    if first_second.passed:
        enabled_metric = METRIC_FIRST_SECOND
        chosen_coverage = first_second
    elif first.passed:
        enabled_metric = METRIC_FIRST
        chosen_coverage = first
    else:
        enabled_metric = None
        chosen_coverage = first_second

    threshold_passed = enabled_metric is not None
    report.enabled_metric = enabled_metric
    report.threshold_passed = threshold_passed
    revision.status = "active" if threshold_passed else "failed_threshold"
    revision.enabled_metric = enabled_metric
    revision.threshold_passed = threshold_passed
    revision.eligible_row_count = sum(
        1 for row in selection_rows if _row_in_metric(row, enabled_metric)
    )
    revision.accepted_row_count = sum(
        1
        for row in selection_rows
        if _row_in_metric(row, enabled_metric) and row.status == ACCEPTED
    )
    revision.eligible_round_count = len(chosen_coverage.playable_seasons)
    revision.threshold_round_count = len(expected_seasons)

    report_path, report_hash = write_report(report, options.report_path)
    revision.report_path = report_path
    revision.report_hash = report_hash

    if threshold_passed:
        session.query(AwardDataRevision).filter(
            AwardDataRevision.award_key == AWARD_KEY,
            AwardDataRevision.id != revision.id,
        ).update({AwardDataRevision.is_active: False}, synchronize_session=False)
        revision.is_active = True

    session.flush()
    return report


def parse_all_euroleague_selections(wikitext: str) -> list[ParsedAllEuroLeagueSelection]:
    selections: list[ParsedAllEuroLeagueSelection] = []
    source_order = 0
    for table_index, table in enumerate(_award_tables(wikitext)):
        current_season: tuple[int, str] | None = None
        rows = mwparserfromhell.parse(table).filter_tags(
            matches=lambda node: node.tag == "tr"
        )
        for row_index, row in enumerate(rows):
            cells = list(
                row.contents.filter_tags(
                    matches=lambda node: node.tag in ("td", "th"),
                    recursive=False,
                )
            )
            if not cells or _is_header_row(cells):
                continue
            season = _season_from_cell(cells[0])
            if season is not None:
                current_season = season
                cells = cells[2:]
            if current_season is None or len(cells) < 5:
                continue

            season_year, season_label = current_season
            position = _clean_text(str(cells[0])) or None
            tier_cells = (
                (METRIC_FIRST, _source_links(cells[1]), _source_links(cells[2])),
                (METRIC_SECOND, _source_links(cells[3]), _source_links(cells[4])),
            )
            for metric, player_links, team_links in tier_cells:
                for split_index, player_link in enumerate(player_links):
                    team_link = _paired_link(team_links, split_index)
                    source_order += 1
                    selections.append(
                        ParsedAllEuroLeagueSelection(
                            season_year=season_year,
                            season_label=season_label,
                            award_metric=metric,
                            source_order=source_order,
                            source_row_key=(
                                f"{season_year}:{metric}:table{table_index}:"
                                f"row{row_index}:split{split_index}"
                            ),
                            source_position=position,
                            source_player_label=player_link.label,
                            source_player_url=player_link.url,
                            source_team_label=team_link.label if team_link else None,
                            source_team_url=team_link.url if team_link else None,
                        )
                    )
    return selections


def load_overrides(path: Path | None) -> tuple[dict[str, PlayerOverride], dict[str, str]]:
    if path is None or not path.exists():
        return {}, {}
    data = json.loads(path.read_text())
    player_overrides = {
        normalize_name(entry["source_label"]): PlayerOverride(
            euroleague_code=entry.get("euroleague_code"),
            status=entry.get("status"),
            note=entry.get("note"),
        )
        for entry in data.get("players", [])
    }
    return player_overrides, dict(data.get("team_aliases", {}))


def expected_awarded_season_years(start_year: int, end_year: int) -> list[int]:
    return [
        year
        for year in EXPECTED_AWARDED_SEASON_YEARS
        if start_year <= year <= end_year
    ]


def write_report(
    report: IngestionReport,
    path: Path | None,
) -> tuple[str | None, str | None]:
    if path is None:
        return None, None
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(asdict(report), indent=2, default=str)
    path.write_text(payload)
    return str(path), hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _coverage_for_metric(
    rows: list[PlayerAwardSelection],
    *,
    metric: str,
    expected_seasons: list[int],
) -> CoverageReport:
    min_answers = 10 if metric == METRIC_FIRST_SECOND else 5
    eligible_metrics = (METRIC_FIRST, METRIC_SECOND) if metric == METRIC_FIRST_SECOND else (METRIC_FIRST,)
    coverage = CoverageReport(metric=metric, min_answers=min_answers, passed=False)
    expected_set = set(expected_seasons)
    rows_by_season = {
        year: [
            row
            for row in rows
            if row.season_year == year
            and row.season_id is not None
            and row.award_metric in eligible_metrics
        ]
        for year in expected_seasons
    }
    coverage.missing_seasons = [
        year for year, season_rows in rows_by_season.items() if not season_rows
    ]
    for year, season_rows in rows_by_season.items():
        accepted_rows = [row for row in season_rows if row.status == ACCEPTED]
        player_unresolved = [
            row
            for row in season_rows
            if row.status not in {ACCEPTED, EXCLUDED}
        ]
        team_unresolved = [
            row
            for row in accepted_rows
            if row.source_team_label and row.local_team_id is None
        ]
        unresolved = player_unresolved + team_unresolved
        duplicates = _duplicate_players(accepted_rows)
        if unresolved:
            coverage.unresolved_rows.extend(
                _selection_report(row, None) for row in unresolved
            )
        if duplicates:
            coverage.duplicate_players.extend(
                {
                    "season_year": year,
                    "local_player_id": player_id,
                    "source_labels": [row.source_player_label for row in duplicate_rows],
                }
                for player_id, duplicate_rows in duplicates.items()
            )
        accepted_count = len(accepted_rows)
        season_passed = (
            year in expected_set
            and accepted_count >= min_answers
            and not unresolved
            and not duplicates
        )
        if season_passed:
            coverage.playable_seasons.append(year)
        coverage.seasons[str(year)] = {
            "accepted": accepted_count,
            "total_rows": len(season_rows),
            "unresolved": len(player_unresolved),
            "team_unresolved": len(team_unresolved),
            "duplicates": len(duplicates),
            "passed": season_passed,
        }
    coverage.passed = (
        bool(expected_seasons)
        and not coverage.missing_seasons
        and not coverage.unresolved_rows
        and not coverage.duplicate_players
        and len(coverage.playable_seasons) == len(expected_seasons)
    )
    return coverage


def _duplicate_players(
    rows: list[PlayerAwardSelection],
) -> dict[int, list[PlayerAwardSelection]]:
    by_player: dict[int, list[PlayerAwardSelection]] = {}
    for row in rows:
        if row.local_player_id is None:
            continue
        by_player.setdefault(row.local_player_id, []).append(row)
    return {player_id: grouped for player_id, grouped in by_player.items() if len(grouped) > 1}


def _row_in_metric(row: PlayerAwardSelection, metric: str | None) -> bool:
    if metric == METRIC_FIRST_SECOND:
        return row.award_metric in {METRIC_FIRST, METRIC_SECOND}
    if metric == METRIC_FIRST:
        return row.award_metric == METRIC_FIRST
    return False


def _award_tables(wikitext: str) -> list[str]:
    return [
        str(table)
        for table in mwparserfromhell.parse(wikitext).filter_tags(
            matches=lambda node: node.tag == "table"
        )
        if "All-EuroLeague First Team" in str(table)
        and "All-EuroLeague Second Team" in str(table)
    ]


def _is_header_row(cells) -> bool:
    return str(cells[0]).lstrip().startswith("!")


def _season_from_cell(cell) -> tuple[int, str] | None:
    text = _clean_text(str(cell))
    match = re.search(r"((?:19|20)\d{2})\s*[–-]\s*\d{2}", text)
    if match is None:
        return None
    return int(match.group(1)), text


def _source_links(cell) -> list[SourceLink]:
    code = mwparserfromhell.parse(_remove_refs(str(cell)))
    links = []
    for link in code.filter_wikilinks(recursive=True):
        target = str(link.title).strip()
        label = _clean_text(str(link.text if link.text is not None else link.title))
        if not label:
            continue
        links.append(SourceLink(label=label, target=target, url=_wikipedia_url(target)))
    if links:
        return links
    label = _clean_text(str(cell))
    return [SourceLink(label=label, target=None, url=None)] if label else []


def _paired_link(links: list[SourceLink], index: int) -> SourceLink | None:
    if not links:
        return None
    if index < len(links):
        return links[index]
    return links[0]


def _clean_text(value: str) -> str:
    text = _remove_refs(value)
    text = mwparserfromhell.parse(text).strip_code(normalize=True, collapse=True)
    text = text.replace("\xa0", " ")
    text = re.sub(r"\s+", " ", text).strip()
    return re.sub(r"\s*\(\d+\)\s*$", "", text).strip()


def _remove_refs(value: str) -> str:
    value = re.sub(r"<ref\b[^/>]*/>", "", value, flags=re.IGNORECASE)
    return re.sub(
        r"<ref\b[^>]*>.*?</ref>",
        "",
        value,
        flags=re.IGNORECASE | re.DOTALL,
    )


def _wikipedia_url(title: str) -> str:
    return f"https://en.wikipedia.org/wiki/{quote(title.replace(' ', '_'))}"


def _title_from_url(url: str | None) -> str | None:
    if not url:
        return None
    prefix = "https://en.wikipedia.org/wiki/"
    if not url.startswith(prefix):
        return None
    return url.removeprefix(prefix).replace("_", " ")


def _selection_report(
    row: PlayerAwardSelection,
    team_resolution: Resolution | None,
) -> dict:
    payload = {
        "season_year": row.season_year,
        "award_metric": row.award_metric,
        "source_order": row.source_order,
        "source_player_label": row.source_player_label,
        "local_player_id": row.local_player_id,
        "source_team_label": row.source_team_label,
        "local_team_id": row.local_team_id,
        "status": row.status,
        "match_method": row.match_method,
        "reviewed": row.reviewed,
        "error": row.error,
    }
    if team_resolution is not None and team_resolution.status != ACCEPTED:
        payload["team_status"] = team_resolution.status
        payload["team_error"] = team_resolution.error
    return payload


def _count_status(report: IngestionReport, status: str) -> None:
    if status == ACCEPTED:
        report.accepted += 1
    elif status == AMBIGUOUS:
        report.ambiguous += 1
    elif status == EXCLUDED:
        report.excluded += 1
    else:
        report.unmatched += 1


def _dedupe_teams(teams: list[Team]) -> list[Team]:
    by_id = {team.id: team for team in teams}
    return list(by_id.values())


def _player_name(player: Player) -> str:
    return " ".join(part for part in [player.first_name, player.last_name] if part).strip()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Ingest All-EuroLeague Team selections")
    parser.add_argument("--start-season", type=int, default=2000)
    parser.add_argument("--end-season", type=int, default=2025)
    parser.add_argument("--overrides", type=Path, default=DEFAULT_OVERRIDES_PATH)
    parser.add_argument("--report", type=Path, default=None)
    parser.add_argument(
        "--log-level",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        default="INFO",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stdout,
    )
    connect_args = {}
    if "sqlite" in settings.database_url:
        connect_args["check_same_thread"] = False
    engine = create_engine(settings.database_url, connect_args=connect_args, echo=False)
    SessionFactory = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    session = SessionFactory()
    try:
        report = ingest_all_euroleague(
            session,
            HttpAllEuroLeagueAdapter(),
            IngestOptions(
                start_year=args.start_season,
                end_year=args.end_season,
                overrides_path=args.overrides,
                report_path=args.report,
            ),
        )
        session.commit()
        logger.info(
            "All-EuroLeague ingestion complete: revision=%s rows=%s accepted=%s "
            "unmatched=%s ambiguous=%s enabled_metric=%s active=%s",
            report.source_revision_id,
            report.in_range_rows,
            report.accepted,
            report.unmatched,
            report.ambiguous,
            report.enabled_metric,
            report.threshold_passed,
        )
    except Exception:
        session.rollback()
        logger.exception("Error ingesting All-EuroLeague Team selections")
        raise
    finally:
        session.close()
        engine.dispose()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
