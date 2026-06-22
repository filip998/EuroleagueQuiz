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
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.models import AwardDataRevision, PlayerAwardSelection, Season
from ingestion.all_euroleague import (
    ACCEPTED,
    AMBIGUOUS,
    DEFAULT_OVERRIDES_PATH,
    EXCLUDED,
    UNMATCHED,
    PlayerResolver,
    Resolution,
    SourceLink,
    TeamResolver,
    WikipediaAwardPage,
    load_overrides,
)
from ingestion.utils import RateLimiter
from ingestion.wikipedia_careers import normalize_name

logger = logging.getLogger(__name__)

SOURCE_NAME = "wikipedia"
SOURCE_API_URL = "https://en.wikipedia.org/w/api.php"

REGULAR_SEASON_MVP = "regular_season_mvp"
FINAL_FOUR_MVP = "final_four_mvp"
AWARD_METRICS = (REGULAR_SEASON_MVP, FINAL_FOUR_MVP)

AWARD_OPTION_TO_METRICS = {
    "all": AWARD_METRICS,
    "regular-season-mvp": (REGULAR_SEASON_MVP,),
    "final-four-mvp": (FINAL_FOUR_MVP,),
}


@dataclass(frozen=True)
class AwardSourceConfig:
    metric: str
    source_title: str
    source_url: str
    table_marker: str
    first_season_year: int
    last_season_year: int
    not_awarded_years: frozenset[int]
    window_size: int
    min_unique_winners: int


AWARD_SOURCE_CONFIGS = {
    REGULAR_SEASON_MVP: AwardSourceConfig(
        metric=REGULAR_SEASON_MVP,
        source_title="EuroLeague MVP",
        source_url="https://en.wikipedia.org/wiki/EuroLeague_MVP",
        table_marker="Player",
        first_season_year=2004,
        last_season_year=2025,
        not_awarded_years=frozenset({2019}),
        window_size=7,
        min_unique_winners=5,
    ),
    FINAL_FOUR_MVP: AwardSourceConfig(
        metric=FINAL_FOUR_MVP,
        source_title="EuroLeague Final Four MVP",
        source_url="https://en.wikipedia.org/wiki/EuroLeague_Final_Four_MVP",
        table_marker="Final Four MVP",
        first_season_year=2000,
        last_season_year=2025,
        not_awarded_years=frozenset({2019}),
        window_size=10,
        min_unique_winners=6,
    ),
}


@dataclass(frozen=True)
class ParsedAwardWinner:
    award_metric: str
    season_year: int
    season_label: str
    source_order: int
    source_row_key: str
    source_player_label: str
    source_player_url: str | None
    source_team_label: str | None
    source_team_url: str | None
    exclude_reason: str | None = None
    review_note: str | None = None


@dataclass(frozen=True)
class PlayerAwardsIngestOptions:
    start_year: int = 2000
    end_year: int = 2025
    metrics: tuple[str, ...] = AWARD_METRICS
    overrides_path: Path | None = DEFAULT_OVERRIDES_PATH
    report_path: Path | None = None


@dataclass
class AwardCoverageReport:
    metric: str
    expected_seasons: list[int]
    window_size: int
    min_unique_winners: int
    passed: bool = False
    accepted_seasons: list[int] = field(default_factory=list)
    excluded_seasons: list[int] = field(default_factory=list)
    missing_seasons: list[int] = field(default_factory=list)
    unresolved_rows: list[dict] = field(default_factory=list)
    duplicate_seasons: list[dict] = field(default_factory=list)
    eligible_windows: list[dict] = field(default_factory=list)
    seasons: dict[str, dict] = field(default_factory=dict)


@dataclass
class AwardIngestionReport:
    metric: str
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
    threshold_passed: bool = False
    expected_seasons: list[int] = field(default_factory=list)
    coverage: AwardCoverageReport | None = None
    selections: list[dict] = field(default_factory=list)


@dataclass
class PlayerAwardsIngestionReport:
    awards: dict[str, AwardIngestionReport] = field(default_factory=dict)
    report_path: str | None = None
    report_hash: str | None = None


class PlayerAwardsAdapter(Protocol):
    def fetch_pages(
        self,
        metrics: tuple[str, ...],
    ) -> dict[str, WikipediaAwardPage]: ...


class HttpPlayerAwardsAdapter:
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

    def fetch_pages(
        self,
        metrics: tuple[str, ...],
    ) -> dict[str, WikipediaAwardPage]:
        return {metric: self._fetch_page(AWARD_SOURCE_CONFIGS[metric]) for metric in metrics}

    def _fetch_page(self, config: AwardSourceConfig) -> WikipediaAwardPage:
        self.rate_limiter.wait()
        with httpx.Client(timeout=self.timeout, headers=self._headers()) as client:
            response = client.get(
                SOURCE_API_URL,
                params={
                    "action": "query",
                    "prop": "revisions|info",
                    "titles": config.source_title,
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
            raise RuntimeError(f"Wikipedia page not found: {config.source_title}")
        page = pages[0]
        revisions = page.get("revisions") or []
        if not revisions:
            raise RuntimeError(
                f"Wikipedia page has no revision content: {config.source_title}"
            )
        revision = revisions[0]
        wikitext = revision.get("slots", {}).get("main", {}).get("content", "")
        return WikipediaAwardPage(
            page_id=int(page["pageid"]),
            title=page["title"],
            url=page.get("fullurl") or config.source_url,
            revision_id=str(revision.get("revid") or ""),
            wikitext=wikitext,
            retrieved_at=datetime.now(timezone.utc).replace(tzinfo=None),
        )

    def _headers(self) -> dict[str, str]:
        return {"User-Agent": self.user_agent}


def ingest_player_awards(
    session: Session,
    adapter: PlayerAwardsAdapter,
    options: PlayerAwardsIngestOptions | None = None,
) -> PlayerAwardsIngestionReport:
    options = options or PlayerAwardsIngestOptions()
    metrics = _clean_metrics(options.metrics)
    pages = adapter.fetch_pages(metrics)
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

    overall_report = PlayerAwardsIngestionReport()
    revisions: list[AwardDataRevision] = []
    reports: dict[str, AwardIngestionReport] = {}

    for metric in metrics:
        config = AWARD_SOURCE_CONFIGS[metric]
        page = pages[metric]
        content_hash = hashlib.sha256(page.wikitext.encode("utf-8")).hexdigest()
        parsed_rows = parse_player_award_winners(metric, page.wikitext)
        expected_seasons = expected_award_season_years(
            metric,
            options.start_year,
            options.end_year,
        )

        revision = AwardDataRevision(
            award_key=metric,
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
            threshold_round_count=1,
            threshold_passed=False,
            report_path=None,
            report_hash=None,
            is_active=False,
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
        )
        session.add(revision)
        session.flush()
        revisions.append(revision)

        report = AwardIngestionReport(
            metric=metric,
            source_revision_id=page.revision_id,
            source_url=page.url,
            content_hash=content_hash,
            parsed_rows=len(parsed_rows),
            expected_seasons=expected_seasons,
        )
        reports[metric] = report
        overall_report.awards[metric] = report

        selection_rows: list[PlayerAwardSelection] = []
        for parsed_row in parsed_rows:
            if (
                parsed_row.season_year < options.start_year
                or parsed_row.season_year > options.end_year
            ):
                continue
            report.in_range_rows += 1
            season = seasons.get(parsed_row.season_year)
            selection = _build_selection(
                revision_id=revision.id,
                metric=metric,
                parsed_row=parsed_row,
                season=season,
                player_resolver=player_resolver,
                team_resolver=team_resolver,
                report=report,
            )
            session.add(selection)
            selection_rows.append(selection)
            _count_status(report, selection.status)
            report.selections.append(_selection_report(selection))

        session.flush()
        coverage = _coverage_for_award(
            selection_rows,
            config=config,
            expected_seasons=expected_seasons,
        )
        report.coverage = coverage
        report.threshold_passed = coverage.passed

        revision.status = "active" if coverage.passed else "failed_threshold"
        revision.enabled_metric = metric if coverage.passed else None
        revision.threshold_passed = coverage.passed
        revision.eligible_row_count = sum(
            1 for row in selection_rows if row.status != EXCLUDED
        )
        revision.accepted_row_count = sum(
            1 for row in selection_rows if row.status == ACCEPTED
        )
        revision.eligible_round_count = len(coverage.eligible_windows)
        revision.threshold_round_count = 1

        if coverage.passed:
            session.query(AwardDataRevision).filter(
                AwardDataRevision.award_key == metric,
                AwardDataRevision.id != revision.id,
            ).update({AwardDataRevision.is_active: False}, synchronize_session=False)
            revision.is_active = True

    report_path, report_hash = write_report(overall_report, options.report_path)
    overall_report.report_path = report_path
    overall_report.report_hash = report_hash
    for revision in revisions:
        revision.report_path = report_path
        revision.report_hash = report_hash
    session.flush()
    return overall_report


def _build_selection(
    *,
    revision_id: int,
    metric: str,
    parsed_row: ParsedAwardWinner,
    season: Season | None,
    player_resolver: PlayerResolver,
    team_resolver: TeamResolver,
    report: AwardIngestionReport,
) -> PlayerAwardSelection:
    if parsed_row.exclude_reason is not None:
        status = EXCLUDED
        local_player_id = None
        match_method = parsed_row.exclude_reason
        reviewed = True
        review_note = parsed_row.review_note
        candidates: tuple[dict, ...] = ()
        error = None
        team_resolution = Resolution(status=EXCLUDED, local_id=None, match_method=None)
    else:
        player_resolution = player_resolver.resolve(parsed_row.source_player_label)
        status = player_resolution.status
        local_player_id = player_resolution.local_id if status == ACCEPTED else None
        match_method = player_resolution.match_method
        reviewed = player_resolution.reviewed
        review_note = player_resolution.review_note
        candidates = player_resolution.candidates
        error = player_resolution.error
        team_resolution = team_resolver.resolve(
            parsed_row.source_team_label,
            _title_from_url(parsed_row.source_team_url),
        )
        if team_resolution.status != ACCEPTED:
            report.team_unmatched += 1

    if season is None:
        status = EXCLUDED
        local_player_id = None
        match_method = "season_missing"
        reviewed = True
        review_note = "Local season is missing"
        candidates = ()
        error = "Local season is missing"

    return PlayerAwardSelection(
        revision_id=revision_id,
        award_key=metric,
        award_metric=metric,
        season_id=season.id if season is not None else None,
        season_year=parsed_row.season_year,
        source_row_key=parsed_row.source_row_key,
        source_order=parsed_row.source_order,
        source_position=None,
        source_player_label=parsed_row.source_player_label,
        source_player_url=parsed_row.source_player_url,
        local_player_id=local_player_id,
        source_team_label=parsed_row.source_team_label,
        source_team_url=parsed_row.source_team_url,
        local_team_id=(
            team_resolution.local_id if team_resolution.status == ACCEPTED else None
        ),
        status=status,
        match_method=match_method,
        reviewed=reviewed,
        review_note=review_note,
        candidate_count=len(candidates),
        candidates_json=json.dumps(candidates, default=str),
        error=error,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )


def parse_player_award_winners(
    metric: str,
    wikitext: str,
) -> list[ParsedAwardWinner]:
    config = AWARD_SOURCE_CONFIGS[metric]
    winners: list[ParsedAwardWinner] = []
    source_order = 0
    for table_index, table in enumerate(_award_tables(wikitext, config)):
        rows = mwparserfromhell.parse(table).filter_tags(
            matches=lambda node: node.tag == "tr"
        )
        for row_index, row in enumerate(rows):
            cells = _data_cells(row)
            if not cells or _is_header_row(cells):
                continue
            season = _season_from_cell(cells[0])
            if season is None:
                continue
            season_year, season_label = season
            if season_year < config.first_season_year:
                continue
            row_text = _clean_text(str(row)).casefold()
            if (
                "not awarded" in row_text
                or (
                    season_year in config.not_awarded_years
                    and len(cells) < 3
                )
            ):
                source_order += 1
                winners.append(
                    _excluded_row(
                        config=config,
                        season_year=season_year,
                        season_label=season_label,
                        source_order=source_order,
                        table_index=table_index,
                        row_index=row_index,
                        season_cell=cells[0],
                        reason="not_awarded",
                        note="Source records this season as not awarded.",
                    )
                )
                continue

            if len(cells) < 3:
                continue
            player_cell = cells[1]
            team_cell_index = 4 if metric == REGULAR_SEASON_MVP else 2
            if len(cells) <= team_cell_index:
                continue
            team_cell = cells[team_cell_index]
            player_link = _primary_link(player_cell)
            if player_link is None:
                continue
            team_link = _primary_link(team_cell)
            source_order += 1
            exclude_reason = None
            review_note = None
            if _is_suproleague_transition_row(cells[0]):
                exclude_reason = "suproleague_excluded"
                review_note = (
                    "2000-01 SuproLeague row excluded; local EuroLeague data uses "
                    "the EuroLeague Finals MVP row for this season."
                )
            winners.append(
                ParsedAwardWinner(
                    award_metric=metric,
                    season_year=season_year,
                    season_label=season_label,
                    source_order=source_order,
                    source_row_key=_source_row_key(
                        metric,
                        season_year,
                        table_index,
                        row_index,
                        cells[0],
                    ),
                    source_player_label=player_link.label,
                    source_player_url=player_link.url,
                    source_team_label=team_link.label if team_link else None,
                    source_team_url=team_link.url if team_link else None,
                    exclude_reason=exclude_reason,
                    review_note=review_note,
                )
            )
    return winners


def _excluded_row(
    *,
    config: AwardSourceConfig,
    season_year: int,
    season_label: str,
    source_order: int,
    table_index: int,
    row_index: int,
    season_cell,
    reason: str,
    note: str,
) -> ParsedAwardWinner:
    return ParsedAwardWinner(
        award_metric=config.metric,
        season_year=season_year,
        season_label=season_label,
        source_order=source_order,
        source_row_key=_source_row_key(
            config.metric,
            season_year,
            table_index,
            row_index,
            season_cell,
        ),
        source_player_label="Not awarded",
        source_player_url=None,
        source_team_label=None,
        source_team_url=None,
        exclude_reason=reason,
        review_note=note,
    )


def expected_award_season_years(
    metric: str,
    start_year: int,
    end_year: int,
) -> list[int]:
    config = AWARD_SOURCE_CONFIGS[metric]
    return [
        year
        for year in range(config.first_season_year, config.last_season_year + 1)
        if start_year <= year <= end_year
    ]


def write_report(
    report: PlayerAwardsIngestionReport,
    path: Path | None,
) -> tuple[str | None, str | None]:
    if path is None:
        return None, None
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(asdict(report), indent=2, default=str)
    path.write_text(payload)
    return str(path), hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _coverage_for_award(
    rows: list[PlayerAwardSelection],
    *,
    config: AwardSourceConfig,
    expected_seasons: list[int],
) -> AwardCoverageReport:
    coverage = AwardCoverageReport(
        metric=config.metric,
        expected_seasons=expected_seasons,
        window_size=config.window_size,
        min_unique_winners=config.min_unique_winners,
    )
    rows_by_season = {
        year: [row for row in rows if row.season_year == year]
        for year in expected_seasons
    }
    for year, season_rows in rows_by_season.items():
        accepted_rows = [row for row in season_rows if row.status == ACCEPTED]
        excluded_rows = [row for row in season_rows if row.status == EXCLUDED]
        unresolved_rows = [
            row for row in season_rows if row.status not in {ACCEPTED, EXCLUDED}
        ]
        team_unresolved = [
            row
            for row in accepted_rows
            if row.source_team_label and row.local_team_id is None
        ]
        if not season_rows:
            coverage.missing_seasons.append(year)
        if unresolved_rows or team_unresolved:
            coverage.unresolved_rows.extend(
                _selection_report(row) for row in unresolved_rows + team_unresolved
            )
        if len(accepted_rows) > 1:
            coverage.duplicate_seasons.append(
                {
                    "season_year": year,
                    "source_labels": [row.source_player_label for row in accepted_rows],
                }
            )
        if accepted_rows:
            coverage.accepted_seasons.append(year)
        if excluded_rows:
            coverage.excluded_seasons.append(year)

        if year in config.not_awarded_years:
            season_passed = (
                bool(excluded_rows)
                and not accepted_rows
                and not unresolved_rows
                and not team_unresolved
            )
        else:
            season_passed = (
                len(accepted_rows) == 1
                and not unresolved_rows
                and not team_unresolved
            )
        coverage.seasons[str(year)] = {
            "accepted": len(accepted_rows),
            "excluded": len(excluded_rows),
            "unresolved": len(unresolved_rows),
            "team_unresolved": len(team_unresolved),
            "passed": season_passed,
        }

    coverage.eligible_windows = _eligible_windows(
        rows,
        config=config,
        expected_seasons=expected_seasons,
    )
    coverage.passed = (
        bool(expected_seasons)
        and not coverage.missing_seasons
        and not coverage.unresolved_rows
        and not coverage.duplicate_seasons
        and all(coverage.seasons[str(year)]["passed"] for year in expected_seasons)
        and bool(coverage.eligible_windows)
    )
    return coverage


def _eligible_windows(
    rows: list[PlayerAwardSelection],
    *,
    config: AwardSourceConfig,
    expected_seasons: list[int],
) -> list[dict]:
    expected = set(expected_seasons)
    accepted = sorted(
        (
            row
            for row in rows
            if row.status == ACCEPTED
            and row.local_player_id is not None
            and row.season_year in expected
        ),
        key=lambda row: (row.season_year, row.source_order, row.id or 0),
    )
    by_year = {row.season_year: row for row in accepted}
    awarded_years = [
        year
        for year in sorted(by_year)
        if year not in config.not_awarded_years
    ]
    windows = []
    for index in range(0, len(awarded_years) - config.window_size + 1):
        years = awarded_years[index : index + config.window_size]
        unique_winners = {
            by_year[year].local_player_id
            for year in years
            if by_year[year].local_player_id is not None
        }
        if len(unique_winners) < config.min_unique_winners:
            continue
        windows.append(
            {
                "start_year": years[0],
                "end_year": years[-1],
                "season_years": years,
                "unique_winners": len(unique_winners),
            }
        )
    return windows


def _award_tables(wikitext: str, config: AwardSourceConfig) -> list[str]:
    tables = []
    for table in mwparserfromhell.parse(wikitext).filter_tags(
        matches=lambda node: node.tag == "table"
    ):
        table_text = str(table)
        if (
            "Season" in table_text
            and "Club" in table_text
            and config.table_marker in table_text
        ):
            tables.append(table_text)
    return tables


def _data_cells(row) -> list:
    return list(
        row.contents.filter_tags(
            matches=lambda node: node.tag in ("td", "th"),
            recursive=False,
        )
    )


def _is_header_row(cells: list) -> bool:
    first_text = _clean_text(str(cells[0])).casefold()
    if "season" in first_text:
        return True
    return _season_from_cell(cells[0]) is None


def _season_from_cell(cell) -> tuple[int, str] | None:
    values = [_clean_text(str(cell))]
    code = mwparserfromhell.parse(_remove_refs(str(cell)))
    for link in code.filter_wikilinks(recursive=True):
        values.append(_clean_text(str(link.text if link.text is not None else link.title)))
        values.append(str(link.title).strip())
    for value in values:
        match = re.search(r"((?:19|20)\d{2})\s*[–-]\s*(\d{2})", value)
        if match is not None:
            season_year = int(match.group(1))
            return season_year, _season_label(season_year)
    return None


def _primary_link(cell) -> SourceLink | None:
    code = mwparserfromhell.parse(_remove_refs(str(cell)))
    sortname = _sortname_link(code)
    if sortname is not None:
        return sortname
    for link in code.filter_wikilinks(recursive=True):
        target = str(link.title).strip()
        if not target or target.casefold().startswith(("file:", "image:")):
            continue
        label = _clean_text(str(link.text if link.text is not None else link.title))
        if label:
            return SourceLink(label=label, target=target, url=_wikipedia_url(target))
    label = _clean_text(str(cell))
    if not label or "not awarded" in label.casefold():
        return None
    return SourceLink(label=label, target=None, url=None)


def _sortname_link(code) -> SourceLink | None:
    for template in code.filter_templates(recursive=True):
        if normalize_name(str(template.name)) != "sortname":
            continue
        first = str(template.get(1).value).strip() if template.has(1) else ""
        last = str(template.get(2).value).strip() if template.has(2) else ""
        label = _clean_text(f"{first} {last}")
        if not label:
            return None
        dab = str(template.get("dab").value).strip() if template.has("dab") else None
        target = f"{label} ({dab})" if dab else label
        return SourceLink(label=label, target=target, url=_wikipedia_url(target))
    return None


def _source_row_key(
    metric: str,
    season_year: int,
    table_index: int,
    row_index: int,
    season_cell,
) -> str:
    target = _first_link_target(season_cell) or _clean_text(str(season_cell))
    normalized_target = normalize_name(target).replace(" ", "-") or "row"
    return (
        f"{metric}:{season_year}:table{table_index}:"
        f"row{row_index}:{normalized_target}"
    )


def _first_link_target(cell) -> str | None:
    code = mwparserfromhell.parse(_remove_refs(str(cell)))
    for link in code.filter_wikilinks(recursive=True):
        target = str(link.title).strip()
        if target:
            return target
    return None


def _is_suproleague_transition_row(season_cell) -> bool:
    season = _season_from_cell(season_cell)
    text = _clean_text(str(season_cell)).casefold()
    target = (_first_link_target(season_cell) or "").casefold()
    return (
        season is not None
        and season[0] == 2000
        and "suproleague" in (text + " " + target)
    )


def _clean_text(value: str) -> str:
    text = _remove_refs(value)
    text = mwparserfromhell.parse(text).strip_code(normalize=True, collapse=True)
    text = text.replace("\xa0", " ")
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"\s*\(\d+\)\s*$", "", text).strip()
    text = re.sub(r"\s*(?:\^|\*+|†|‡)+\s*$", "", text).strip()
    return text


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


def _season_label(season_year: int) -> str:
    return f"{season_year}/{str(season_year + 1)[-2:]}"


def _selection_report(row: PlayerAwardSelection) -> dict:
    return {
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


def _count_status(report: AwardIngestionReport, status: str) -> None:
    if status == ACCEPTED:
        report.accepted += 1
    elif status == AMBIGUOUS:
        report.ambiguous += 1
    elif status == EXCLUDED:
        report.excluded += 1
    elif status == UNMATCHED:
        report.unmatched += 1
    else:
        report.unmatched += 1


def _clean_metrics(metrics: tuple[str, ...]) -> tuple[str, ...]:
    cleaned = tuple(dict.fromkeys(metrics))
    unknown = [metric for metric in cleaned if metric not in AWARD_SOURCE_CONFIGS]
    if unknown:
        raise ValueError(f"Unsupported player-award metrics: {', '.join(unknown)}")
    return cleaned or AWARD_METRICS


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Ingest EuroLeague player awards")
    parser.add_argument("--start-season", type=int, default=2000)
    parser.add_argument("--end-season", type=int, default=2025)
    parser.add_argument(
        "--award",
        choices=sorted(AWARD_OPTION_TO_METRICS),
        default="all",
        help="Award source to ingest",
    )
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
        report = ingest_player_awards(
            session,
            HttpPlayerAwardsAdapter(),
            PlayerAwardsIngestOptions(
                start_year=args.start_season,
                end_year=args.end_season,
                metrics=AWARD_OPTION_TO_METRICS[args.award],
                overrides_path=args.overrides,
                report_path=args.report,
            ),
        )
        session.commit()
        for award_report in report.awards.values():
            logger.info(
                "Player award ingestion complete: metric=%s revision=%s rows=%s "
                "accepted=%s unmatched=%s ambiguous=%s excluded=%s active=%s",
                award_report.metric,
                award_report.source_revision_id,
                award_report.in_range_rows,
                award_report.accepted,
                award_report.unmatched,
                award_report.ambiguous,
                award_report.excluded,
                award_report.threshold_passed,
            )
    except Exception:
        session.rollback()
        logger.exception("Error ingesting EuroLeague player awards")
        raise
    finally:
        session.close()
        engine.dispose()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
