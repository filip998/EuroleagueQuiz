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

import httpx
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.models import (
    CareerDataRevision,
    GamePlayerStats,
    Player,
    PlayerCareerStint,
    PlayerWikidataMapping,
)
from ingestion.utils import RateLimiter

logger = logging.getLogger(__name__)

ACCEPTED = "accepted"
AMBIGUOUS = "ambiguous"
BIRTH_CONFLICT = "birth_conflict"
REJECTED = "rejected"
UNMATCHED = "unmatched"

YEAR_PRECISION = 9
MONTH_PRECISION = 10
DAY_PRECISION = 11

WIKIDATA_BASKETBALL_PLAYER_QID = "Q3665646"
KNOWN_CLUB_TYPE_QIDS = {"Q13393265", "Q847017"}
EXCLUDED_TEAM_LABEL_TERMS = (
    "national",
    "under-",
    "under ",
    "college",
    "all-star",
    "all star",
)
INCLUDED_TEAM_LABEL_TERMS = (
    "basketball",
    "sports club",
    "basketball club",
    "basketball team",
)


@dataclass(frozen=True)
class WikidataPlayerCandidate:
    qid: str
    label: str
    birth_date: date | None = None
    aliases: tuple[str, ...] = ()
    description: str | None = None


@dataclass(frozen=True)
class WikidataTeamMembership:
    team_qid: str
    team_label: str
    start: str | None = None
    start_precision: int | None = None
    end: str | None = None
    end_precision: int | None = None
    statement_id: str | None = None
    is_professional_club: bool = True
    exclusion_reason: str | None = None
    is_loan: bool = False


@dataclass(frozen=True)
class PlayerOverride:
    wikidata_qid: str | None = None
    status: str | None = None
    note: str | None = None


@dataclass(frozen=True)
class IngestOptions:
    limit: int | None = None
    force_refresh: bool = False
    min_eligible_players: int = settings.career_quiz_min_eligible_players
    overrides_path: Path | None = None
    report_path: Path | None = None


@dataclass
class IngestionReport:
    revision: str
    matched: int = 0
    unmatched: int = 0
    ambiguous: int = 0
    birth_conflicts: int = 0
    rejected: int = 0
    too_few_stints: int = 0
    filtered_team_rows: int = 0
    eligible_players: int = 0
    threshold: int = settings.career_quiz_min_eligible_players
    threshold_passed: bool = False
    players: list[dict] = field(default_factory=list)


class WikidataCareerAdapter(Protocol):
    def search_basketball_players(self, name: str) -> list[WikidataPlayerCandidate]: ...

    def fetch_player_memberships(self, qid: str) -> list[WikidataTeamMembership]: ...

    def fetch_player_candidate(self, qid: str) -> WikidataPlayerCandidate | None: ...


class HttpWikidataCareerAdapter:
    def __init__(
        self,
        *,
        user_agent: str = settings.wikidata_user_agent,
        rate_limiter: RateLimiter | None = None,
        timeout: float = 30.0,
    ):
        self.user_agent = user_agent
        self.rate_limiter = rate_limiter or RateLimiter(settings.api_rate_limit_seconds)
        self.timeout = timeout

    def search_basketball_players(self, name: str) -> list[WikidataPlayerCandidate]:
        self.rate_limiter.wait()
        with httpx.Client(timeout=self.timeout, headers=self._headers()) as client:
            response = client.get(
                "https://www.wikidata.org/w/api.php",
                params={
                    "action": "wbsearchentities",
                    "language": "en",
                    "format": "json",
                    "search": name,
                    "limit": 10,
                },
            )
            response.raise_for_status()
            hits = response.json().get("search", [])

        candidates: list[WikidataPlayerCandidate] = []
        for hit in hits:
            qid = hit.get("id")
            if not qid:
                continue
            candidate = self.fetch_player_candidate(qid)
            if candidate is not None:
                candidates.append(candidate)
        return candidates

    def fetch_player_candidate(self, qid: str) -> WikidataPlayerCandidate | None:
        entity = self._fetch_entity(qid)
        if entity is None or not _has_claim_entity(entity, "P106", WIKIDATA_BASKETBALL_PLAYER_QID):
            return None
        return WikidataPlayerCandidate(
            qid=qid,
            label=_entity_label(entity) or qid,
            birth_date=_claim_time_date(entity, "P569"),
            aliases=tuple(_entity_aliases(entity)),
            description=_entity_description(entity),
        )

    def fetch_player_memberships(self, qid: str) -> list[WikidataTeamMembership]:
        entity = self._fetch_entity(qid)
        if entity is None:
            return []
        p54_claims = entity.get("claims", {}).get("P54", [])
        team_ids = [
            team_qid
            for claim in p54_claims
            if (team_qid := _claim_main_entity_qid(claim)) is not None
        ]
        team_entities = self._fetch_entities(team_ids)
        instance_ids = sorted(
            {
                instance_qid
                for team in team_entities.values()
                for claim in team.get("claims", {}).get("P31", [])
                if (instance_qid := _claim_main_entity_qid(claim)) is not None
            }
        )
        instance_entities = self._fetch_entities(instance_ids)
        instance_labels = {
            qid: _entity_label(entity) or qid for qid, entity in instance_entities.items()
        }

        memberships: list[WikidataTeamMembership] = []
        for claim in p54_claims:
            team_qid = _claim_main_entity_qid(claim)
            if team_qid is None:
                continue
            team_entity = team_entities.get(team_qid, {})
            label = _entity_label(team_entity) or team_qid
            team_instance_ids = [
                instance_qid
                for p31_claim in team_entity.get("claims", {}).get("P31", [])
                if (instance_qid := _claim_main_entity_qid(p31_claim)) is not None
            ]
            team_instance_labels = [
                instance_labels.get(instance_qid, instance_qid)
                for instance_qid in team_instance_ids
            ]
            is_professional, exclusion_reason = _classify_team(
                label, team_instance_ids, team_instance_labels
            )
            start, start_precision = _claim_qualifier_time(claim, "P580")
            end, end_precision = _claim_qualifier_time(claim, "P582")
            memberships.append(
                WikidataTeamMembership(
                    team_qid=team_qid,
                    team_label=label,
                    start=start,
                    start_precision=start_precision,
                    end=end,
                    end_precision=end_precision,
                    statement_id=claim.get("id"),
                    is_professional_club=is_professional,
                    exclusion_reason=exclusion_reason,
                    is_loan=_claim_mentions_loan(claim),
                )
            )
        return memberships

    def _fetch_entity(self, qid: str) -> dict | None:
        return self._fetch_entities([qid]).get(qid)

    def _fetch_entities(self, qids: list[str]) -> dict[str, dict]:
        unique_qids = sorted({qid for qid in qids if qid})
        if not unique_qids:
            return {}
        entities: dict[str, dict] = {}
        for chunk in _chunks(unique_qids, 50):
            self.rate_limiter.wait()
            with httpx.Client(timeout=self.timeout, headers=self._headers()) as client:
                response = client.get(
                    "https://www.wikidata.org/w/api.php",
                    params={
                        "action": "wbgetentities",
                        "ids": "|".join(chunk),
                        "props": "labels|aliases|descriptions|claims",
                        "languages": "en",
                        "format": "json",
                    },
                )
                response.raise_for_status()
                entities.update(response.json().get("entities", {}))
        return {qid: entity for qid, entity in entities.items() if "missing" not in entity}

    def _sparql(self, query: str) -> list[dict]:
        self.rate_limiter.wait()
        with httpx.Client(timeout=self.timeout, headers=self._headers()) as client:
            response = client.get(
                "https://query.wikidata.org/sparql",
                params={"query": query},
                headers={**self._headers(), "Accept": "application/sparql-results+json"},
            )
            response.raise_for_status()
            return response.json().get("results", {}).get("bindings", [])

    def _headers(self) -> dict[str, str]:
        return {"User-Agent": self.user_agent}


def ingest_wikidata_careers(
    session: Session,
    adapter: WikidataCareerAdapter,
    options: IngestOptions | None = None,
) -> IngestionReport:
    options = options or IngestOptions()
    revision = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    report = IngestionReport(revision=revision, threshold=options.min_eligible_players)
    overrides = load_overrides(options.overrides_path)

    for player in _iter_candidate_players(session, options.limit):
        player_report = _ingest_player(session, adapter, player, overrides, options)
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
        else:
            report.unmatched += 1

    report.threshold_passed = report.eligible_players >= options.min_eligible_players
    report_path, report_hash = _write_report_if_requested(report, options.report_path)
    _record_revision(session, report, report_path, report_hash)
    return report


def load_overrides(path: Path | None) -> dict[int, PlayerOverride]:
    if path is None or not path.exists():
        return {}
    data = json.loads(path.read_text())
    overrides: dict[int, PlayerOverride] = {}
    for entry in data.get("players", []):
        player_id = int(entry["player_id"])
        overrides[player_id] = PlayerOverride(
            wikidata_qid=entry.get("wikidata_qid"),
            status=entry.get("status"),
            note=entry.get("note"),
        )
    return overrides


def normalize_name(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value)
    ascii_value = "".join(ch for ch in normalized if not unicodedata.combining(ch))
    return re.sub(r"[^a-z0-9]+", " ", ascii_value.lower()).strip()


def season_label(season_year: int | None) -> str | None:
    if season_year is None:
        return None
    return f"{season_year}/{str(season_year + 1)[-2:]}"


def season_year_for_start(value: str | None, precision: int | None) -> int | None:
    parsed = _date_parts(value)
    if parsed is None:
        return None
    year, month, _ = parsed
    if precision is not None and precision <= YEAR_PRECISION:
        return year
    return year if month >= 7 else year - 1


def season_year_for_end(value: str | None, precision: int | None) -> int | None:
    parsed = _date_parts(value)
    if parsed is None:
        return None
    year, month, _ = parsed
    if precision is not None and precision <= YEAR_PRECISION:
        return year - 1
    return year if month >= 7 else year - 1


def _ingest_player(
    session: Session,
    adapter: WikidataCareerAdapter,
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

    candidates = []
    if override and override.wikidata_qid:
        candidate = adapter.fetch_player_candidate(override.wikidata_qid)
        if candidate is not None:
            candidates = [candidate]
    else:
        candidates = adapter.search_basketball_players(full_name)

    match, status, method = _select_match(player, full_name, candidates, bool(override))
    mapping = _upsert_mapping(
        session,
        player,
        wikidata_qid=match.qid if match else None,
        wikidata_label=match.label if match else None,
        wikidata_birth_date=match.birth_date if match else None,
        status=status,
        match_method=method,
        reviewed=bool(override),
        review_note=override.note if override else None,
        candidates=candidates,
    )

    if status != ACCEPTED or match is None:
        _replace_stints(session, mapping, [])
        return {
            "player_id": player.id,
            "name": full_name,
            "status": status,
            "candidate_count": len(candidates),
        }

    raw_memberships = adapter.fetch_player_memberships(match.qid)
    stints, filtered = _build_stints(mapping, match.qid, raw_memberships)
    _replace_stints(session, mapping, stints)
    eligible = sum(1 for stint in stints if stint.include_in_quiz) >= 3
    return {
        "player_id": player.id,
        "name": full_name,
        "status": ACCEPTED,
        "wikidata_qid": match.qid,
        "eligible": eligible,
        "included_stints": sum(1 for stint in stints if stint.include_in_quiz),
        "filtered_team_rows": filtered,
    }


def _iter_candidate_players(session: Session, limit: int | None) -> list[Player]:
    query = (
        session.query(GamePlayerStats.player_id)
        .distinct()
        .order_by(GamePlayerStats.player_id)
    )
    if limit is not None:
        query = query.limit(limit)
    player_ids = [row[0] for row in query.all()]
    if not player_ids:
        return []
    return (
        session.query(Player)
        .filter(Player.id.in_(player_ids))
        .order_by(Player.id)
        .all()
    )


def _select_match(
    player: Player,
    full_name: str,
    candidates: list[WikidataPlayerCandidate],
    override: bool,
) -> tuple[WikidataPlayerCandidate | None, str, str | None]:
    normalized = normalize_name(full_name)
    filtered = [
        candidate
        for candidate in candidates
        if normalized
        in {
            normalize_name(candidate.label),
            *(normalize_name(alias) for alias in candidate.aliases),
        }
    ]
    candidates = filtered or candidates

    if override and len(candidates) == 1:
        return candidates[0], ACCEPTED, "override"
    if not candidates:
        return None, UNMATCHED, None
    if len(candidates) == 1:
        candidate = candidates[0]
        if _birth_dates_conflict(player.birth_date, candidate.birth_date):
            return None, BIRTH_CONFLICT, "single_name_birth_conflict"
        return candidate, ACCEPTED, "single_name"

    birth_matches = [
        candidate
        for candidate in candidates
        if player.birth_date is not None and candidate.birth_date == player.birth_date
    ]
    if len(birth_matches) == 1:
        return birth_matches[0], ACCEPTED, "birth_date"
    return None, AMBIGUOUS, "multiple_candidates"


def _build_stints(
    mapping: PlayerWikidataMapping,
    player_qid: str,
    memberships: list[WikidataTeamMembership],
) -> tuple[list[PlayerCareerStint], int]:
    sorted_memberships = sorted(
        memberships,
        key=lambda membership: (
            season_year_for_start(membership.start, membership.start_precision) or 9999,
            membership.team_label,
        ),
    )
    stints: list[PlayerCareerStint] = []
    filtered = 0
    last_included_team: str | None = None
    last_potential_club_index = max(
        (
            index
            for index, membership in enumerate(sorted_memberships)
            if membership.is_professional_club
            and season_year_for_start(membership.start, membership.start_precision)
            is not None
        ),
        default=-1,
    )
    sequence_index = 1
    for index, membership in enumerate(sorted_memberships):
        start_year = season_year_for_start(membership.start, membership.start_precision)
        end_year = season_year_for_end(membership.end, membership.end_precision)
        exclusion_reason = membership.exclusion_reason
        include = True
        if not membership.is_professional_club:
            include = False
            exclusion_reason = exclusion_reason or "not_professional_club"
        elif start_year is None:
            include = False
            exclusion_reason = "missing_start_year"
        elif membership.end is None and index != last_potential_club_index:
            include = False
            exclusion_reason = "missing_non_final_end_year"
        elif membership.team_qid == last_included_team:
            include = False
            exclusion_reason = "consecutive_duplicate"

        if include:
            last_included_team = membership.team_qid
        else:
            filtered += 1

        stint = PlayerCareerStint(
            mapping_id=mapping.id,
            player_id=mapping.player_id,
            sequence_index=sequence_index,
            wikidata_player_qid=player_qid,
            wikidata_team_qid=membership.team_qid,
            wikidata_team_label=membership.team_label,
            wikidata_statement_id=membership.statement_id,
            raw_start=membership.start,
            raw_start_precision=membership.start_precision,
            raw_end=membership.end,
            raw_end_precision=membership.end_precision,
            start_season=season_label(start_year),
            end_season=season_label(end_year),
            start_season_year=start_year,
            end_season_year=end_year,
            is_current=membership.end is None,
            is_loan=membership.is_loan,
            include_in_quiz=include,
            exclusion_reason=exclusion_reason,
        )
        stints.append(stint)
        sequence_index += 1
    return stints, filtered


def _replace_stints(
    session: Session,
    mapping: PlayerWikidataMapping,
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
    wikidata_qid: str | None = None,
    wikidata_label: str | None = None,
    wikidata_birth_date: date | None = None,
    match_method: str | None = None,
    reviewed: bool = False,
    review_note: str | None = None,
    candidates: list[WikidataPlayerCandidate] | None = None,
) -> PlayerWikidataMapping:
    mapping = session.query(PlayerWikidataMapping).filter_by(player_id=player.id).first()
    if mapping is None:
        mapping = PlayerWikidataMapping(player_id=player.id, status=status)
        session.add(mapping)
        session.flush()

    mapping.wikidata_qid = wikidata_qid
    mapping.wikidata_label = wikidata_label
    mapping.wikidata_birth_date = wikidata_birth_date
    mapping.status = status
    mapping.match_method = match_method
    mapping.reviewed = reviewed
    mapping.review_note = review_note
    mapping.candidate_count = len(candidates or [])
    mapping.candidates_json = json.dumps([asdict(candidate) for candidate in candidates or []], default=str)
    mapping.error = None
    mapping.last_checked_at = datetime.utcnow()
    return mapping


def _record_revision(
    session: Session,
    report: IngestionReport,
    report_path: str | None,
    report_hash: str | None,
) -> None:
    if report.threshold_passed:
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


def _write_report_if_requested(
    report: IngestionReport, path: Path | None
) -> tuple[str | None, str | None]:
    if path is None:
        return None, None
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(asdict(report), indent=2, default=str)
    path.write_text(payload)
    return str(path), hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _player_name(player: Player) -> str:
    return " ".join(part for part in [player.first_name, player.last_name] if part).strip()


def _birth_dates_conflict(local: date | None, wikidata: date | None) -> bool:
    return local is not None and wikidata is not None and local != wikidata


def _binding_value(row: dict, field: str) -> str | None:
    value = row.get(field)
    if isinstance(value, dict):
        return value.get("value")
    return None


def _qid_from_uri(uri: str | None) -> str | None:
    if not uri:
        return None
    return uri.rsplit("/", 1)[-1]


def _entity_label(entity: dict) -> str | None:
    return entity.get("labels", {}).get("en", {}).get("value")


def _entity_description(entity: dict) -> str | None:
    return entity.get("descriptions", {}).get("en", {}).get("value")


def _entity_aliases(entity: dict) -> list[str]:
    return [
        alias.get("value")
        for alias in entity.get("aliases", {}).get("en", [])
        if alias.get("value")
    ]


def _has_claim_entity(entity: dict, property_id: str, qid: str) -> bool:
    return any(
        _claim_main_entity_qid(claim) == qid
        for claim in entity.get("claims", {}).get(property_id, [])
    )


def _claim_main_entity_qid(claim: dict) -> str | None:
    mainsnak = claim.get("mainsnak", {})
    datavalue = mainsnak.get("datavalue", {})
    value = datavalue.get("value", {})
    if isinstance(value, dict) and value.get("entity-type") == "item":
        numeric_id = value.get("numeric-id")
        return f"Q{numeric_id}" if numeric_id is not None else None
    return None


def _claim_time_date(entity: dict, property_id: str) -> date | None:
    claims = entity.get("claims", {}).get(property_id, [])
    if not claims:
        return None
    value = _claim_time_value(claims[0].get("mainsnak", {}))
    return _parse_date(value[0] if value else None)


def _claim_qualifier_time(claim: dict, property_id: str) -> tuple[str | None, int | None]:
    qualifiers = claim.get("qualifiers", {}).get(property_id, [])
    if not qualifiers:
        return None, None
    value = _claim_time_value(qualifiers[0])
    return value if value is not None else (None, None)


def _claim_time_value(snak: dict) -> tuple[str, int | None] | None:
    datavalue = snak.get("datavalue", {})
    value = datavalue.get("value", {})
    if isinstance(value, dict) and value.get("time"):
        return value.get("time"), value.get("precision")
    return None


def _claim_mentions_loan(claim: dict) -> bool:
    text = json.dumps(claim, ensure_ascii=False).lower()
    return "loan" in text


def _classify_team(
    label: str,
    instance_qids: list[str],
    instance_labels: list[str],
) -> tuple[bool, str | None]:
    searchable = " ".join([label, *instance_labels]).lower()
    if "national" in searchable:
        return False, "national_team"
    if "college" in searchable:
        return False, "college_team"
    if any(term in searchable for term in ("under-", "under ", "all-star", "all star")):
        return False, "non_club_team"
    if set(instance_qids) & KNOWN_CLUB_TYPE_QIDS:
        return True, None
    if any(term in searchable for term in INCLUDED_TEAM_LABEL_TERMS):
        return True, None
    if any(term in searchable for term in EXCLUDED_TEAM_LABEL_TERMS):
        return False, "non_club_team"
    return False, "not_professional_club"


def _chunks(values: list[str], size: int) -> list[list[str]]:
    return [values[index : index + size] for index in range(0, len(values), size)]


def _parse_date(value: str | None) -> date | None:
    parts = _date_parts(value)
    if parts is None:
        return None
    year, month, day = parts
    return date(year, month, day)


def _date_parts(value: str | None) -> tuple[int, int, int] | None:
    if not value:
        return None
    match = re.match(r"^\+?(-?\d+)-(\d{2})-(\d{2})", value)
    if not match:
        return None
    year = int(match.group(1))
    if year <= 0:
        return None
    return year, int(match.group(2)), int(match.group(3))


def _safe_int(value: str | None) -> int | None:
    try:
        return int(value) if value is not None else None
    except ValueError:
        return None


def main() -> None:
    parser = argparse.ArgumentParser(description="Wikidata career data ingestion")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--force-refresh", action="store_true")
    parser.add_argument("--overrides", type=Path, default=Path("ingestion/wikidata_overrides.json"))
    parser.add_argument("--report", type=Path, default=Path("data/wikidata-career-report.json"))
    parser.add_argument("--min-eligible", type=int, default=settings.career_quiz_min_eligible_players)
    parser.add_argument("--log-level", choices=["DEBUG", "INFO", "WARNING", "ERROR"], default="INFO")
    args = parser.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stdout,
    )

    connect_args = {"check_same_thread": False} if "sqlite" in settings.database_url else {}
    engine = create_engine(settings.database_url, connect_args=connect_args, echo=False)
    session_factory = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    session = session_factory()
    try:
        report = ingest_wikidata_careers(
            session,
            HttpWikidataCareerAdapter(),
            IngestOptions(
                limit=args.limit,
                force_refresh=args.force_refresh,
                min_eligible_players=args.min_eligible,
                overrides_path=args.overrides,
                report_path=args.report,
            ),
        )
        session.commit()
        logger.info(
            "Wikidata career ingestion finished: eligible=%s threshold=%s passed=%s",
            report.eligible_players,
            report.threshold,
            report.threshold_passed,
        )
        if not report.threshold_passed:
            raise SystemExit(2)
    except Exception:
        session.rollback()
        logger.exception("Wikidata career ingestion failed")
        raise
    finally:
        session.close()


if __name__ == "__main__":
    main()
