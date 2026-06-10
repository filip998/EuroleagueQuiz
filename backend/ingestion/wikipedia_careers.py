from __future__ import annotations

import argparse
import hashlib
import json
import logging
import re
import sys
import unicodedata
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Protocol
from urllib.parse import quote

import httpx
import mwparserfromhell
from sqlalchemy import create_engine, func
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.models import (
    CareerDataRevision,
    Game,
    GamePlayerStats,
    Player,
    PlayerCareerSourceMapping,
    PlayerCareerStint,
    PlayerSeasonTeam,
    Season,
    Team,
)
from ingestion.utils import RateLimiter

logger = logging.getLogger(__name__)

ACCEPTED = "accepted"
AMBIGUOUS = "ambiguous"
BIRTH_CONFLICT = "birth_conflict"
PARSE_FAILED = "parse_failed"
REJECTED = "rejected"
UNMATCHED = "unmatched"

SOURCE_NAME = "wikipedia"
DEFAULT_CANDIDATE_LIMIT = 500


@dataclass(frozen=True)
class WikipediaPageCandidate:
    page_id: int
    title: str
    snippet: str | None = None


@dataclass(frozen=True)
class WikipediaPage:
    page_id: int
    title: str
    url: str
    revision_id: str
    wikitext: str
    birth_date: date | None = None
    is_basketball_player: bool = False


@dataclass(frozen=True)
class ParsedCareerRow:
    team_label: str
    team_target: str | None
    raw_years: str
    raw_start: str
    raw_end: str | None
    start_year: int
    end_year: int | None
    is_current: bool
    is_loan: bool
    row_key: str


@dataclass(frozen=True)
class TeamResolution:
    team_key: str
    label: str
    url: str | None = None
    local_team_id: int | None = None


@dataclass(frozen=True)
class CareerMembership:
    source_name: str
    source_player_key: str | None
    source_team_key: str
    source_team_label: str
    source_team_url: str | None
    source_row_key: str | None
    local_team_id: int | None
    raw_start: str | None
    raw_end: str | None
    start_year: int | None
    end_year: int | None
    is_current: bool
    is_loan: bool = False
    exclusion_reason: str | None = None
    order_hint: int = 0


@dataclass(frozen=True)
class PlayerOverride:
    page_title: str | None = None
    status: str | None = None
    note: str | None = None
    extra_stints: tuple[dict, ...] = ()


@dataclass(frozen=True)
class IngestOptions:
    limit: int | None = DEFAULT_CANDIDATE_LIMIT
    force_refresh: bool = False
    min_eligible_players: int = settings.career_quiz_min_eligible_players
    overrides_path: Path | None = None
    report_path: Path | None = None
    candidates_report_path: Path | None = None


@dataclass(frozen=True)
class CandidateSelection:
    rank: int
    player_id: int
    name: str
    selection_source: str
    games_played: int
    early_roster_seasons: int
    total_roster_seasons: int


@dataclass
class IngestionReport:
    revision: str
    matched: int = 0
    unmatched: int = 0
    ambiguous: int = 0
    birth_conflicts: int = 0
    rejected: int = 0
    parse_failed: int = 0
    too_few_stints: int = 0
    filtered_team_rows: int = 0
    eligible_players: int = 0
    threshold: int = settings.career_quiz_min_eligible_players
    threshold_passed: bool = False
    candidate_players: list[dict] = field(default_factory=list)
    players: list[dict] = field(default_factory=list)


class WikipediaCareerAdapter(Protocol):
    def search_pages(self, name: str) -> list[WikipediaPageCandidate]: ...

    def fetch_page(self, title: str) -> WikipediaPage | None: ...


class HttpWikipediaCareerAdapter:
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

    def search_pages(self, name: str) -> list[WikipediaPageCandidate]:
        self.rate_limiter.wait()
        with httpx.Client(timeout=self.timeout, headers=self._headers()) as client:
            response = client.get(
                "https://en.wikipedia.org/w/api.php",
                params={
                    "action": "query",
                    "list": "search",
                    "srsearch": f'"{name}" basketball',
                    "srlimit": 8,
                    "format": "json",
                },
            )
            response.raise_for_status()
            hits = response.json().get("query", {}).get("search", [])
        return [
            WikipediaPageCandidate(
                page_id=int(hit["pageid"]),
                title=hit["title"],
                snippet=hit.get("snippet"),
            )
            for hit in hits
            if hit.get("pageid") and hit.get("title")
        ]

    def fetch_page(self, title: str) -> WikipediaPage | None:
        self.rate_limiter.wait()
        with httpx.Client(timeout=self.timeout, headers=self._headers()) as client:
            response = client.get(
                "https://en.wikipedia.org/w/api.php",
                params={
                    "action": "query",
                    "prop": "revisions|info",
                    "titles": title,
                    "rvprop": "ids|content",
                    "rvslots": "main",
                    "inprop": "url",
                    "redirects": 1,
                    "formatversion": 2,
                    "format": "json",
                },
            )
            response.raise_for_status()
            pages = response.json().get("query", {}).get("pages", [])
        if not pages or pages[0].get("missing"):
            return None
        page = pages[0]
        revisions = page.get("revisions") or []
        if not revisions:
            return None
        revision = revisions[0]
        wikitext = revision.get("slots", {}).get("main", {}).get("content", "")
        return WikipediaPage(
            page_id=int(page["pageid"]),
            title=page["title"],
            url=page.get("fullurl") or _wikipedia_url(page["title"]),
            revision_id=str(revision.get("revid") or ""),
            wikitext=wikitext,
            birth_date=parse_birth_date(wikitext),
            is_basketball_player=is_basketball_player_page(wikitext),
        )

    def _headers(self) -> dict[str, str]:
        return {"User-Agent": self.user_agent}


class CareerTeamResolver:
    def __init__(self, session: Session, aliases: dict[str, str] | None = None):
        self.teams = session.query(Team).order_by(Team.name).all()
        self.by_code = {team.euroleague_code.upper(): team for team in self.teams}
        self.aliases = {
            normalize_name(alias): code.upper()
            for alias, code in (aliases or {}).items()
            if code.upper() in self.by_code
        }
        self.by_normalized_name: dict[str, list[Team]] = {}
        for team in self.teams:
            self.by_normalized_name.setdefault(normalize_name(team.name), []).append(team)

    def resolve(self, label: str, target: str | None = None) -> TeamResolution:
        label = _clean_team_label(label)
        for value in (target, label):
            if not value:
                continue
            normalized = normalize_name(value)
            if normalized in self.aliases:
                team = self.by_code[self.aliases[normalized]]
                return TeamResolution(
                    team_key=_local_team_key(team),
                    label=label,
                    url=_wikipedia_url(target) if target else None,
                    local_team_id=team.id,
                )
            exact = self.by_normalized_name.get(normalized, [])
            if len(exact) == 1:
                team = exact[0]
                return TeamResolution(
                    team_key=_local_team_key(team),
                    label=label,
                    url=_wikipedia_url(target) if target else None,
                    local_team_id=team.id,
                )

        source_key = target or label
        return TeamResolution(
            team_key=f"WIKI:{normalize_title(source_key)}",
            label=label,
            url=_wikipedia_url(target) if target else None,
        )


def ingest_wikipedia_careers(
    session: Session,
    adapter: WikipediaCareerAdapter,
    options: IngestOptions | None = None,
) -> IngestionReport:
    options = options or IngestOptions()
    revision = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    report = IngestionReport(revision=revision, threshold=options.min_eligible_players)
    overrides, team_aliases = load_overrides(options.overrides_path)
    team_resolver = CareerTeamResolver(session, team_aliases)
    candidate_players = _select_candidate_players(session, options.limit)
    report.candidate_players = [asdict(selection) for _, selection in candidate_players]
    _write_candidates_if_requested(report.candidate_players, options.candidates_report_path)
    _clear_career_cache(session)

    for player, _selection in candidate_players:
        player_report = _ingest_player(
            session,
            adapter,
            team_resolver,
            player,
            overrides,
            options,
        )
        report.players.append(player_report)
        status = player_report["status"]
        if status == ACCEPTED:
            report.matched += 1
            if player_report.get("eligible"):
                report.eligible_players += 1
            else:
                report.too_few_stints += 1
            report.filtered_team_rows += int(player_report.get("filtered_team_rows", 0))
        elif status == AMBIGUOUS:
            report.ambiguous += 1
        elif status == BIRTH_CONFLICT:
            report.birth_conflicts += 1
        elif status == REJECTED:
            report.rejected += 1
        elif status == PARSE_FAILED:
            report.parse_failed += 1
        else:
            report.unmatched += 1

    report.threshold_passed = report.eligible_players >= options.min_eligible_players
    report_path, report_hash = _write_report_if_requested(report, options.report_path)
    _record_revision(session, report, report_path, report_hash)
    return report


def load_overrides(path: Path | None) -> tuple[dict[int, PlayerOverride], dict[str, str]]:
    if path is None or not path.exists():
        return {}, {}
    data = json.loads(path.read_text())
    overrides: dict[int, PlayerOverride] = {}
    for entry in data.get("players", []):
        player_id = int(entry["player_id"])
        overrides[player_id] = PlayerOverride(
            page_title=entry.get("page_title"),
            status=entry.get("status"),
            note=entry.get("note"),
            extra_stints=tuple(entry.get("extra_stints", [])),
        )
    return overrides, dict(data.get("team_aliases", {}))


def normalize_name(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value)
    ascii_value = "".join(ch for ch in normalized if not unicodedata.combining(ch))
    return re.sub(r"[^a-z0-9]+", " ", ascii_value.lower()).strip()


def normalize_title(value: str) -> str:
    return "_".join(normalize_name(value).split())


def season_label(season_year: int | None) -> str | None:
    if season_year is None:
        return None
    return f"{season_year}/{str(season_year + 1)[-2:]}"


def is_basketball_player_page(wikitext: str) -> bool:
    normalized = normalize_name(wikitext[:20_000])
    return (
        "infobox basketball biography" in normalized
        or "basketball player" in normalized
        or ("career history" in normalized and "basketball" in normalized)
    )


def parse_birth_date(wikitext: str) -> date | None:
    code = mwparserfromhell.parse(wikitext)
    for template in code.filter_templates(recursive=True):
        name = normalize_name(str(template.name))
        if name not in {"birth date", "birth date and age", "birth date and age2"}:
            continue
        values = [
            _clean_text(str(param.value))
            for param in template.params
            if normalize_name(str(param.name)).isdigit()
        ]
        parsed = _date_from_parts(values[:3])
        if parsed is not None:
            return parsed

    birth_value = _first_template_param(wikitext, "birth_date")
    if birth_value:
        parsed_template = parse_birth_date(str(birth_value))
        if parsed_template is not None:
            return parsed_template
        return _parse_written_date(_clean_text(str(birth_value)))
    return None


def parse_career_rows(wikitext: str) -> list[ParsedCareerRow]:
    template = _basketball_infobox(wikitext)
    if template is None:
        return []
    params = {
        normalize_name(str(param.name)).replace(" ", ""): str(param.value).strip()
        for param in template.params
    }
    rows: list[ParsedCareerRow] = []
    for index in range(1, 101):
        years_value = params.get(f"years{index}")
        team_value = params.get(f"team{index}")
        if not years_value and not team_value:
            continue
        if not years_value or not team_value:
            continue
        parsed_years = parse_year_range(years_value)
        parsed_team = parse_team_value(team_value)
        if parsed_years is None or parsed_team is None:
            continue
        team_label, team_target, team_is_loan = parsed_team
        raw_start, raw_end, start_year, end_year, is_current = parsed_years
        rows.append(
            ParsedCareerRow(
                team_label=team_label,
                team_target=team_target,
                raw_years=_clean_text(years_value),
                raw_start=raw_start,
                raw_end=raw_end,
                start_year=start_year,
                end_year=end_year,
                is_current=is_current,
                is_loan=team_is_loan or _is_loan_text(team_value),
                row_key=f"team{index}",
            )
        )
    return rows


def parse_year_range(value: str) -> tuple[str, str | None, int, int | None, bool] | None:
    source = _remove_refs(value)
    text = _clean_text(value)
    text = (
        text.replace("–", "-")
        .replace("—", "-")
        .replace("−", "-")
        .replace(" to ", "-")
    )
    searchable = (
        source.replace("–", "-")
        .replace("—", "-")
        .replace("−", "-")
        .replace(" to ", "-")
    )
    years = [int(match) for match in re.findall(r"\b(?:19|20)\d{2}\b", searchable)]
    if not years:
        return None
    start_year = years[0]
    is_current = bool(re.search(r"\b(present|current)\b", text, re.IGNORECASE))
    if is_current:
        return str(start_year), None, start_year, None, True
    if len(years) == 1:
        return str(start_year), str(start_year), start_year, start_year, False
    raw_end = years[1]
    end_year = raw_end if "{{nbay" in source.lower() else raw_end - 1
    if end_year < start_year:
        end_year = start_year
    return str(start_year), str(raw_end), start_year, end_year, False


def parse_team_value(value: str) -> tuple[str, str | None, bool] | None:
    code = mwparserfromhell.parse(_remove_refs(value))
    links = code.filter_wikilinks(recursive=True)
    target = str(links[0].title).strip() if links else None
    label = _clean_team_label(code.strip_code(normalize=True, collapse=True))
    if not label:
        return None
    return label, target, _is_loan_text(value)


def _ingest_player(
    session: Session,
    adapter: WikipediaCareerAdapter,
    team_resolver: CareerTeamResolver,
    player: Player,
    overrides: dict[int, PlayerOverride],
    options: IngestOptions,
) -> dict:
    override = overrides.get(player.id)
    full_name = _player_name(player)

    if override and override.status == REJECTED:
        mapping = _upsert_mapping(
            session,
            player,
            status=REJECTED,
            reviewed=True,
            review_note=override.note,
        )
        _replace_stints(session, mapping, [])
        return {"player_id": player.id, "name": full_name, "status": REJECTED}

    page, status, method, candidates, error = _resolve_page(adapter, player, full_name, override)
    mapping = _upsert_mapping(
        session,
        player,
        page=page,
        status=status,
        match_method=method,
        reviewed=bool(override),
        review_note=override.note if override else None,
        candidates=candidates,
        error=error,
    )

    if status != ACCEPTED or page is None:
        _replace_stints(session, mapping, [])
        return {
            "player_id": player.id,
            "name": full_name,
            "status": status,
            "reason": error or status,
            "candidate_count": len(candidates),
            "candidate_titles": [candidate.title for candidate in candidates],
            "error": error,
        }

    parsed_rows = parse_career_rows(page.wikitext)
    if not parsed_rows and not override:
        _replace_stints(session, mapping, [])
        mapping.status = PARSE_FAILED
        mapping.error = "No basketball infobox career rows found"
        return {
            "player_id": player.id,
            "name": full_name,
            "status": PARSE_FAILED,
            "source_player_key": mapping.source_player_key,
            "candidate_count": len(candidates),
            "error": mapping.error,
        }

    memberships = _memberships_from_rows(page, parsed_rows, team_resolver)
    memberships.extend(_extra_memberships(page, override, team_resolver))
    stints, filtered = _build_stints(mapping, memberships)
    _replace_stints(session, mapping, stints)
    eligible = sum(1 for stint in stints if stint.include_in_quiz) >= 3
    return {
        "player_id": player.id,
        "name": full_name,
        "status": ACCEPTED,
        "source_player_key": mapping.source_player_key,
        "eligible": eligible,
        "included_stints": sum(1 for stint in stints if stint.include_in_quiz),
        "filtered_team_rows": filtered,
    }


def _resolve_page(
    adapter: WikipediaCareerAdapter,
    player: Player,
    full_name: str,
    override: PlayerOverride | None,
) -> tuple[WikipediaPage | None, str, str | None, list[WikipediaPageCandidate], str | None]:
    if override and override.page_title:
        page = adapter.fetch_page(override.page_title)
        if page is None:
            return None, UNMATCHED, "override", [], "Override page was not found"
        return page, ACCEPTED, "override", [WikipediaPageCandidate(page.page_id, page.title)], None

    candidates = adapter.search_pages(full_name)
    title_matches: list[WikipediaPage] = []
    viable_pages: list[WikipediaPage] = []
    title_candidates = [
        candidate for candidate in candidates if _title_matches_player(full_name, candidate.title)
    ]
    fallback_candidates = [
        candidate for candidate in candidates if candidate not in title_candidates
    ]

    for candidate in title_candidates:
        page = adapter.fetch_page(candidate.title)
        if page is None or not page.is_basketball_player:
            continue
        viable_pages.append(page)
        title_matches.append(page)

    birth_matches = [
        page for page in viable_pages if player.birth_date is not None and page.birth_date == player.birth_date
    ]
    if len(birth_matches) == 1:
        return birth_matches[0], ACCEPTED, "birth_date", candidates, None
    if len(title_matches) == 1:
        return title_matches[0], ACCEPTED, "title_match", candidates, None
    if len(viable_pages) == 1:
        return viable_pages[0], ACCEPTED, "single_basketball_candidate", candidates, None

    if not viable_pages:
        for candidate in fallback_candidates:
            page = adapter.fetch_page(candidate.title)
            if page is not None and page.is_basketball_player:
                return page, ACCEPTED, "first_basketball_candidate", candidates, None

    if not viable_pages:
        if not candidates:
            return None, UNMATCHED, None, candidates, "No Wikipedia search candidates"
        return (
            None,
            UNMATCHED,
            None,
            candidates,
            "No title-compatible basketball player page among search candidates",
        )

    return None, AMBIGUOUS, "multiple_candidates", candidates, "Multiple title-compatible basketball pages"


def _memberships_from_rows(
    page: WikipediaPage,
    rows: list[ParsedCareerRow],
    team_resolver: CareerTeamResolver,
) -> list[CareerMembership]:
    memberships: list[CareerMembership] = []
    for order, row in enumerate(rows, start=1):
        resolution = team_resolver.resolve(row.team_label, row.team_target)
        memberships.append(
            CareerMembership(
                source_name=SOURCE_NAME,
                source_player_key=str(page.page_id),
                source_team_key=resolution.team_key,
                source_team_label=resolution.label,
                source_team_url=resolution.url,
                source_row_key=row.row_key,
                local_team_id=resolution.local_team_id,
                raw_start=row.raw_start,
                raw_end=row.raw_end,
                start_year=row.start_year,
                end_year=row.end_year,
                is_current=row.is_current,
                is_loan=row.is_loan,
                order_hint=order,
            )
        )
    return memberships


def _extra_memberships(
    page: WikipediaPage,
    override: PlayerOverride | None,
    team_resolver: CareerTeamResolver,
) -> list[CareerMembership]:
    if override is None:
        return []
    memberships: list[CareerMembership] = []
    for index, extra in enumerate(override.extra_stints, start=1):
        team_label = extra.get("team_label")
        start_year = extra.get("start_year")
        if not team_label or start_year is None:
            continue
        end_year = extra.get("end_year")
        resolution = team_resolver.resolve(team_label, extra.get("team_target"))
        memberships.append(
            CareerMembership(
                source_name=SOURCE_NAME,
                source_player_key=str(page.page_id),
                source_team_key=resolution.team_key,
                source_team_label=resolution.label,
                source_team_url=resolution.url,
                source_row_key=f"override:{index}",
                local_team_id=resolution.local_team_id,
                raw_start=str(start_year),
                raw_end=str(end_year) if end_year is not None else None,
                start_year=int(start_year),
                end_year=int(end_year) if end_year is not None else None,
                is_current=bool(extra.get("is_current", end_year is None)),
                is_loan=bool(extra.get("is_loan", False)),
                order_hint=10_000 + index,
            )
        )
    return memberships


def _build_stints(
    mapping: PlayerCareerSourceMapping,
    memberships: list[CareerMembership],
) -> tuple[list[PlayerCareerStint], int]:
    sorted_memberships = _normalize_current_memberships(
        sorted(
            memberships,
            key=lambda membership: (
                membership.start_year if membership.start_year is not None else 9999,
                membership.order_hint,
                membership.source_team_label,
            ),
        )
    )
    stints: list[PlayerCareerStint] = []
    filtered = 0
    last_included_team: str | None = None
    sequence_index = 1
    for membership in sorted_memberships:
        exclusion_reason = membership.exclusion_reason
        include = True
        if membership.start_year is None:
            include = False
            exclusion_reason = "missing_start_year"
        elif membership.end_year is not None and membership.end_year < membership.start_year:
            include = False
            exclusion_reason = "invalid_range"
        elif membership.source_team_key == last_included_team:
            include = False
            exclusion_reason = "consecutive_duplicate"

        if include:
            last_included_team = membership.source_team_key
        else:
            filtered += 1

        stint = PlayerCareerStint(
            mapping_id=mapping.id,
            player_id=mapping.player_id,
            sequence_index=sequence_index,
            source_name=membership.source_name,
            source_player_key=membership.source_player_key,
            source_team_key=membership.source_team_key,
            source_team_label=membership.source_team_label,
            source_team_url=membership.source_team_url,
            source_row_key=membership.source_row_key,
            local_team_id=membership.local_team_id,
            raw_start=membership.raw_start,
            raw_end=membership.raw_end,
            start_season=season_label(membership.start_year),
            end_season=season_label(membership.end_year),
            start_season_year=membership.start_year,
            end_season_year=membership.end_year,
            is_current=membership.is_current,
            is_loan=membership.is_loan,
            include_in_quiz=include,
            exclusion_reason=exclusion_reason,
        )
        stints.append(stint)
        sequence_index += 1
    return stints, filtered


def _normalize_current_memberships(
    memberships: list[CareerMembership],
) -> list[CareerMembership]:
    current_indices = [
        index
        for index, membership in enumerate(memberships)
        if membership.is_current and membership.start_year is not None
    ]
    if len(current_indices) <= 1:
        return memberships

    normalized = list(memberships)
    for current_index, next_current_index in zip(current_indices, current_indices[1:]):
        membership = normalized[current_index]
        next_current = normalized[next_current_index]
        next_start = next_current.start_year
        end_year = membership.start_year
        if next_start is not None and next_start > membership.start_year:
            end_year = next_start - 1
        normalized[current_index] = CareerMembership(
            source_name=membership.source_name,
            source_player_key=membership.source_player_key,
            source_team_key=membership.source_team_key,
            source_team_label=membership.source_team_label,
            source_team_url=membership.source_team_url,
            source_row_key=membership.source_row_key,
            local_team_id=membership.local_team_id,
            raw_start=membership.raw_start,
            raw_end=str(end_year + 1),
            start_year=membership.start_year,
            end_year=end_year,
            is_current=False,
            is_loan=membership.is_loan,
            exclusion_reason=membership.exclusion_reason,
            order_hint=membership.order_hint,
        )
    return normalized


def _replace_stints(
    session: Session,
    mapping: PlayerCareerSourceMapping,
    stints: list[PlayerCareerStint],
) -> None:
    session.query(PlayerCareerStint).filter_by(mapping_id=mapping.id).delete()
    session.flush()
    for stint in stints:
        stint.mapping_id = mapping.id
        session.add(stint)
    session.flush()


def _upsert_mapping(
    session: Session,
    player: Player,
    *,
    status: str,
    page: WikipediaPage | None = None,
    match_method: str | None = None,
    reviewed: bool = False,
    review_note: str | None = None,
    candidates: list[WikipediaPageCandidate] | None = None,
    error: str | None = None,
) -> PlayerCareerSourceMapping:
    mapping = session.query(PlayerCareerSourceMapping).filter_by(player_id=player.id).first()
    if mapping is None:
        mapping = PlayerCareerSourceMapping(player_id=player.id, status=status)
        session.add(mapping)
        session.flush()

    mapping.source_name = SOURCE_NAME
    mapping.source_player_key = str(page.page_id) if page else None
    mapping.source_player_label = page.title if page else None
    mapping.source_player_url = page.url if page else None
    mapping.source_revision_id = page.revision_id if page else None
    mapping.source_birth_date = page.birth_date if page else None
    mapping.status = status
    mapping.match_method = match_method
    mapping.reviewed = reviewed
    mapping.review_note = review_note
    mapping.candidate_count = len(candidates or [])
    mapping.candidates_json = json.dumps([asdict(candidate) for candidate in candidates or []], default=str)
    mapping.error = error
    mapping.last_checked_at = datetime.utcnow()
    return mapping


def _record_revision(
    session: Session,
    report: IngestionReport,
    report_path: str | None,
    report_hash: str | None,
) -> None:
    session.query(CareerDataRevision).update({CareerDataRevision.is_active: False})
    revision = CareerDataRevision(
        revision=report.revision,
        status="active" if report.threshold_passed else "failed_threshold",
        eligible_player_count=report.eligible_players,
        threshold_player_count=report.threshold,
        threshold_passed=report.threshold_passed,
        report_path=report_path,
        report_hash=report_hash,
        is_active=report.threshold_passed,
    )
    session.add(revision)
    session.flush()


def _clear_career_cache(session: Session) -> None:
    session.query(PlayerCareerStint).delete()
    session.query(PlayerCareerSourceMapping).delete()
    session.flush()


def _write_report_if_requested(
    report: IngestionReport, path: Path | None
) -> tuple[str | None, str | None]:
    if path is None:
        return None, None
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(asdict(report), indent=2, default=str)
    path.write_text(payload)
    return str(path), hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _write_candidates_if_requested(candidates: list[dict], path: Path | None) -> None:
    if path is None:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"count": len(candidates), "players": candidates}, indent=2))


def _select_candidate_players(
    session: Session,
    limit: int | None,
) -> list[tuple[Player, CandidateSelection]]:
    stats_rows = _game_count_rows(session)
    early_rows = _early_roster_rows(session)
    roster_counts = _total_roster_counts(session)

    selected: dict[int, str] = {}
    if limit is None:
        stats_target = len(stats_rows)
        early_target = len(early_rows)
    else:
        early_target = min(50, max(1, limit // 10))
        stats_target = max(0, limit - early_target)

    for player_id, _games in stats_rows[:stats_target]:
        selected[player_id] = "games_played"

    for player_id, _early_count in early_rows:
        if limit is not None and len(selected) >= limit:
            break
        selected.setdefault(player_id, "early_roster")

    for player_id, _games in stats_rows[stats_target:]:
        if limit is not None and len(selected) >= limit:
            break
        selected.setdefault(player_id, "games_played_fill")

    if limit is not None and len(selected) < limit:
        for player_id, _total_count in sorted(
            roster_counts.items(),
            key=lambda item: (-item[1], item[0]),
        ):
            if len(selected) >= limit:
                break
            selected.setdefault(player_id, "roster_fill")

    player_ids = list(selected)
    if not player_ids:
        return []
    players = (
        session.query(Player)
        .filter(Player.id.in_(player_ids))
        .all()
    )
    players_by_id = {player.id: player for player in players}
    game_counts = dict(stats_rows)
    early_counts = dict(early_rows)
    selections: list[tuple[Player, CandidateSelection]] = []
    for rank, player_id in enumerate(player_ids, start=1):
        player = players_by_id.get(player_id)
        if player is None:
            continue
        selections.append(
            (
                player,
                CandidateSelection(
                    rank=rank,
                    player_id=player.id,
                    name=_player_name(player),
                    selection_source=selected[player_id],
                    games_played=game_counts.get(player_id, 0),
                    early_roster_seasons=early_counts.get(player_id, 0),
                    total_roster_seasons=roster_counts.get(player_id, 0),
                ),
            )
        )
    return selections


def _game_count_rows(session: Session) -> list[tuple[int, int]]:
    rows = (
        session.query(
            GamePlayerStats.player_id,
            func.count(func.distinct(GamePlayerStats.game_id)).label("games_played"),
        )
        .join(Game, Game.id == GamePlayerStats.game_id)
        .join(Season, Season.id == Game.season_id)
        .filter(Season.year >= 2007)
        .group_by(GamePlayerStats.player_id)
        .order_by(
            func.count(func.distinct(GamePlayerStats.game_id)).desc(),
            GamePlayerStats.player_id,
        )
        .all()
    )
    return [(int(player_id), int(games_played or 0)) for player_id, games_played in rows]


def _early_roster_rows(session: Session) -> list[tuple[int, int]]:
    rows = (
        session.query(
            PlayerSeasonTeam.player_id,
            func.count(func.distinct(Season.year)).label("early_roster_seasons"),
        )
        .join(Season, Season.id == PlayerSeasonTeam.season_id)
        .filter(Season.year <= 2006)
        .group_by(PlayerSeasonTeam.player_id)
        .order_by(
            func.count(func.distinct(Season.year)).desc(),
            PlayerSeasonTeam.player_id,
        )
        .all()
    )
    return [(int(player_id), int(seasons or 0)) for player_id, seasons in rows]


def _total_roster_counts(session: Session) -> dict[int, int]:
    rows = (
        session.query(
            PlayerSeasonTeam.player_id,
            func.count(func.distinct(Season.year)).label("roster_seasons"),
        )
        .join(Season, Season.id == PlayerSeasonTeam.season_id)
        .group_by(PlayerSeasonTeam.player_id)
        .all()
    )
    return {int(player_id): int(seasons or 0) for player_id, seasons in rows}


def _player_name(player: Player) -> str:
    return " ".join(part for part in [player.first_name, player.last_name] if part).strip()


def _birth_dates_conflict(local: date | None, wikipedia: date | None) -> bool:
    return local is not None and wikipedia is not None and local != wikipedia


def _title_matches_player(full_name: str, title: str) -> bool:
    normalized_name = normalize_name(full_name)
    normalized_title = normalize_name(re.sub(r"\s*\([^)]*\)", "", title))
    return normalized_title == normalized_name or normalized_title.startswith(f"{normalized_name} ")


def _basketball_infobox(wikitext: str):
    code = mwparserfromhell.parse(wikitext)
    for template in code.filter_templates(recursive=False):
        name = normalize_name(str(template.name))
        if "infobox" in name and "basketball" in name:
            return template
    return None


def _first_template_param(wikitext: str, param_name: str) -> str | None:
    code = mwparserfromhell.parse(wikitext)
    normalized_param_name = normalize_name(param_name)
    for template in code.filter_templates(recursive=True):
        for param in template.params:
            if normalize_name(str(param.name)) == normalized_param_name:
                return str(param.value).strip()
    return None


def _date_from_parts(values: list[str]) -> date | None:
    if len(values) < 3:
        return None
    try:
        year = int(values[0])
        month = max(1, int(values[1]))
        day = max(1, int(values[2]))
        return date(year, month, day)
    except ValueError:
        return None


def _parse_written_date(value: str) -> date | None:
    for fmt in ("%d %B %Y", "%B %d, %Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(value, fmt).date()
        except ValueError:
            continue
    return None


def _clean_text(value: str) -> str:
    text = _remove_refs(value)
    text = mwparserfromhell.parse(text).strip_code(normalize=True, collapse=True)
    text = text.replace("\xa0", " ")
    return re.sub(r"\s+", " ", text).strip()


def _clean_team_label(value: str) -> str:
    label = _clean_text(value)
    label = re.sub(r"^[→\-\s]+", "", label)
    label = re.sub(r"\s*\((?:loan|on loan)\)\s*", "", label, flags=re.IGNORECASE)
    return label.strip()


def _remove_refs(value: str) -> str:
    value = re.sub(r"<ref\b[^/>]*/>", "", value, flags=re.IGNORECASE)
    value = re.sub(r"<ref\b[^>]*>.*?</ref>", "", value, flags=re.IGNORECASE | re.DOTALL)
    return value


def _is_loan_text(value: str) -> bool:
    text = value.lower()
    return "→" in value or "loan" in text


def _local_team_key(team: Team) -> str:
    return f"ELQ:{team.euroleague_code}"


def _wikipedia_url(title: str) -> str:
    return f"https://en.wikipedia.org/wiki/{quote(title.replace(' ', '_'))}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Ingest Wikipedia career data")
    parser.add_argument("--limit", type=int, default=DEFAULT_CANDIDATE_LIMIT)
    parser.add_argument("--min-eligible", type=int, default=settings.career_quiz_min_eligible_players)
    parser.add_argument("--overrides", type=Path, default=Path(__file__).with_name("wikipedia_overrides.json"))
    parser.add_argument("--report", type=Path, default=None)
    parser.add_argument("--candidates-report", type=Path, default=None)
    parser.add_argument("--log-level", default="INFO")
    args = parser.parse_args(argv)

    logging.basicConfig(level=args.log_level.upper(), format="%(levelname)s %(message)s")
    engine = create_engine(settings.database_url)
    factory = sessionmaker(bind=engine)
    session = factory()
    try:
        report = ingest_wikipedia_careers(
            session,
            HttpWikipediaCareerAdapter(),
            IngestOptions(
                limit=args.limit,
                min_eligible_players=args.min_eligible,
                overrides_path=args.overrides,
                report_path=args.report,
                candidates_report_path=args.candidates_report,
            ),
        )
        session.commit()
    except Exception:
        session.rollback()
        logger.exception("Wikipedia career ingestion failed")
        return 1
    finally:
        session.close()

    logger.info(
        "Ingested Wikipedia careers: matched=%s eligible=%s threshold_passed=%s",
        report.matched,
        report.eligible_players,
        report.threshold_passed,
    )
    return 0 if report.threshold_passed else 2


if __name__ == "__main__":
    sys.exit(main())
