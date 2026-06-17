from __future__ import annotations

import argparse
import json
import logging
import re
import sys
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from json import JSONDecodeError
from pathlib import Path
from typing import Protocol
from urllib.parse import unquote, urlparse

import httpx
import mwparserfromhell
from sqlalchemy import create_engine, func
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.models import Player
from ingestion.utils import RateLimiter
from ingestion.wikipedia_careers import (
    _basketball_infobox,
    _clean_text,
    _wikipedia_url,
    normalize_name,
)

logger = logging.getLogger(__name__)

DEFAULT_THUMBNAIL_WIDTH = 500
IMAGE_PARAM_NAMES = {"image", "image name", "photo"}
IMAGE_FILE_EXTENSIONS = (
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".svg",
    ".webp",
    ".tif",
    ".tiff",
)


@dataclass(frozen=True)
class WikipediaImagePage:
    page_id: int
    title: str
    url: str
    revision_id: str
    wikitext: str


@dataclass(frozen=True)
class ImageIngestionOptions:
    limit: int | None = None
    force_refresh: bool = False
    thumbnail_width: int = DEFAULT_THUMBNAIL_WIDTH
    commit_interval: int | None = None
    report_path: Path | None = None


@dataclass
class ImageIngestionReport:
    checked: int = 0
    found: int = 0
    missing: int = 0
    skipped: int = 0
    errors: int = 0
    players: list[dict] = field(default_factory=list)


class WikipediaImageAdapter(Protocol):
    def fetch_page(self, title: str) -> WikipediaImagePage | None: ...

    def resolve_image_url(self, file_name: str, thumbnail_width: int) -> str | None: ...


class HttpWikipediaImageAdapter:
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

    def fetch_page(self, title: str) -> WikipediaImagePage | None:
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
        return WikipediaImagePage(
            page_id=int(page["pageid"]),
            title=page["title"],
            url=page.get("fullurl") or _wikipedia_url(page["title"]),
            revision_id=str(revision.get("revid") or ""),
            wikitext=revision.get("slots", {}).get("main", {}).get("content", ""),
        )

    def resolve_image_url(self, file_name: str, thumbnail_width: int) -> str | None:
        self.rate_limiter.wait()
        with httpx.Client(timeout=self.timeout, headers=self._headers()) as client:
            response = client.get(
                "https://en.wikipedia.org/w/api.php",
                params={
                    "action": "query",
                    "prop": "imageinfo",
                    "titles": _file_title(file_name),
                    "iiprop": "url",
                    "iiurlwidth": thumbnail_width,
                    "formatversion": 2,
                    "format": "json",
                },
            )
            response.raise_for_status()
            pages = response.json().get("query", {}).get("pages", [])
        return _image_url_from_pages(pages)

    def _headers(self) -> dict[str, str]:
        return {"User-Agent": self.user_agent}


def _image_url_from_pages(pages: list[dict]) -> str | None:
    if not pages:
        return None
    imageinfo = pages[0].get("imageinfo") or []
    if imageinfo:
        info = imageinfo[0]
        return _clean_url(info.get("thumburl")) or _clean_url(info.get("url"))
    if pages[0].get("missing"):
        return None
    return None


def ingest_wikipedia_images(
    session: Session,
    adapter: WikipediaImageAdapter,
    options: ImageIngestionOptions | None = None,
) -> ImageIngestionReport:
    options = options or ImageIngestionOptions()
    report = ImageIngestionReport(
        skipped=_already_checked_count(session) if not options.force_refresh else 0
    )
    players = _select_players(session, options)
    changed_since_commit = 0

    for player in players:
        changed = _ingest_player_image(session, adapter, player, options, report)
        if changed:
            changed_since_commit += 1
        if (
            options.commit_interval is not None
            and options.commit_interval > 0
            and changed_since_commit >= options.commit_interval
        ):
            session.commit()
            changed_since_commit = 0

    if options.report_path is not None:
        write_report(report, options.report_path)
    return report


def extract_infobox_image_file(wikitext: str) -> str | None:
    template = _basketball_infobox(wikitext)
    if template is None:
        return None

    for param in template.params:
        if normalize_name(str(param.name)) not in IMAGE_PARAM_NAMES:
            continue
        file_name = normalize_image_file(str(param.value))
        if file_name:
            return file_name
    return None


def normalize_image_file(value: str) -> str | None:
    if not value or not value.strip():
        return None

    code = mwparserfromhell.parse(_strip_refs(value))
    for link in code.filter_wikilinks(recursive=True):
        file_name = _strip_file_prefix(str(link.title).strip())
        if _looks_like_file_name(file_name):
            return file_name

    text = _clean_text(str(code))
    text = re.sub(r"^\s*\[\[", "", text)
    text = re.sub(r"\]\]\s*$", "", text)
    text = _strip_file_prefix(text)
    if "|" in text:
        parts = [part.strip() for part in text.split("|") if part.strip()]
        text = next((part for part in parts if _looks_like_file_name(part)), parts[0] if parts else "")
    if _looks_like_file_name(text):
        return text
    return None


def wikipedia_title_from_url(url: str | None) -> str | None:
    if url is None or not url.strip():
        return None
    parsed = urlparse(url.strip())
    path = parsed.path or url.strip()
    marker = "/wiki/"
    if marker not in path:
        return None
    title = path.split(marker, 1)[1].strip("/")
    if not title:
        return None
    return unquote(title).replace("_", " ")


def write_report(report: ImageIngestionReport, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(asdict(report), indent=2, default=str))


def _ingest_player_image(
    session: Session,
    adapter: WikipediaImageAdapter,
    player: Player,
    options: ImageIngestionOptions,
    report: ImageIngestionReport,
) -> bool:
    title = wikipedia_title_from_url(player.wikipedia_url)
    if title is None:
        _mark_missing(player, "invalid_wikipedia_url", report)
        return True

    try:
        page = adapter.fetch_page(title)
    except (httpx.HTTPError, JSONDecodeError, ValueError) as exc:
        _record_error(player, title, "fetch_error", exc, report)
        return _clear_checked_timestamp(player)

    if page is None:
        _mark_missing(player, "page_missing", report, title=title)
        return True

    file_name = extract_infobox_image_file(page.wikitext)
    if file_name is None:
        _mark_missing(player, "image_param_missing", report, title=page.title)
        return True

    try:
        image_url = adapter.resolve_image_url(file_name, options.thumbnail_width)
    except (httpx.HTTPError, JSONDecodeError, ValueError) as exc:
        _record_error(player, page.title, "image_resolution_error", exc, report, file_name=file_name)
        return _clear_checked_timestamp(player)

    if image_url is None:
        _mark_missing(player, "image_url_missing", report, title=page.title, file_name=file_name)
        return True

    checked_at = _utcnow()
    player.wikipedia_image_url = image_url
    player.wikipedia_image_checked_at = checked_at
    session.add(player)
    report.checked += 1
    report.found += 1
    report.players.append(
        {
            "player_id": player.id,
            "name": _player_name(player),
            "status": "found",
            "title": page.title,
            "file_name": file_name,
            "image_url": image_url,
            "checked_at": checked_at.isoformat(),
        }
    )
    return True


def _select_players(session: Session, options: ImageIngestionOptions) -> list[Player]:
    query = (
        session.query(Player)
        .filter(Player.wikipedia_url.is_not(None))
        .filter(func.trim(Player.wikipedia_url) != "")
        .order_by(Player.id)
    )
    if not options.force_refresh:
        query = query.filter(Player.wikipedia_image_checked_at.is_(None))
    if options.limit is not None:
        query = query.limit(options.limit)
    return list(query.all())


def _already_checked_count(session: Session) -> int:
    return int(
        session.query(func.count(Player.id))
        .filter(Player.wikipedia_url.is_not(None))
        .filter(func.trim(Player.wikipedia_url) != "")
        .filter(Player.wikipedia_image_checked_at.is_not(None))
        .scalar()
        or 0
    )


def _mark_missing(
    player: Player,
    reason: str,
    report: ImageIngestionReport,
    *,
    title: str | None = None,
    file_name: str | None = None,
) -> None:
    checked_at = _utcnow()
    player.wikipedia_image_url = None
    player.wikipedia_image_checked_at = checked_at
    report.checked += 1
    report.missing += 1
    entry = {
        "player_id": player.id,
        "name": _player_name(player),
        "status": "missing",
        "reason": reason,
        "checked_at": checked_at.isoformat(),
    }
    if title:
        entry["title"] = title
    if file_name:
        entry["file_name"] = file_name
    report.players.append(entry)


def _record_error(
    player: Player,
    title: str,
    reason: str,
    exc: Exception,
    report: ImageIngestionReport,
    *,
    file_name: str | None = None,
) -> None:
    logger.warning("Wikipedia image enrichment failed for player %s: %s", player.id, exc)
    report.errors += 1
    entry = {
        "player_id": player.id,
        "name": _player_name(player),
        "status": "error",
        "reason": reason,
        "title": title,
        "error": str(exc),
    }
    if file_name:
        entry["file_name"] = file_name
    report.players.append(entry)


def _clear_checked_timestamp(player: Player) -> bool:
    if player.wikipedia_image_checked_at is None:
        return False
    player.wikipedia_image_checked_at = None
    return True


def _strip_refs(value: str) -> str:
    value = re.sub(r"<ref\b[^/>]*/>", "", value, flags=re.IGNORECASE)
    return re.sub(r"<ref\b[^>]*>.*?</ref>", "", value, flags=re.IGNORECASE | re.DOTALL)


def _strip_file_prefix(value: str) -> str:
    decoded = unquote(value.strip())
    return re.sub(r"^\s*(?:file|image)\s*:\s*", "", decoded, flags=re.IGNORECASE)


def _looks_like_file_name(value: str) -> bool:
    cleaned = value.strip()
    if not cleaned or cleaned.lower().startswith(("http://", "https://")):
        return False
    return cleaned.lower().endswith(IMAGE_FILE_EXTENSIONS)


def _file_title(file_name: str) -> str:
    return f"File:{_strip_file_prefix(file_name)}"


def _clean_url(value: str | None) -> str | None:
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


def _player_name(player: Player) -> str:
    return " ".join(part for part in [player.first_name, player.last_name] if part).strip()


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _summary(report: ImageIngestionReport) -> str:
    return (
        "Wikipedia image enrichment complete: "
        f"checked={report.checked} found={report.found} missing={report.missing} "
        f"skipped={report.skipped} errors={report.errors}"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Ingest Wikipedia infobox images for Photo Quiz")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--force-refresh", action="store_true")
    parser.add_argument("--batch-size", type=int, default=50)
    parser.add_argument("--thumbnail-width", type=int, default=DEFAULT_THUMBNAIL_WIDTH)
    parser.add_argument("--report", type=Path, default=None)
    parser.add_argument("--log-level", default="INFO")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=args.log_level.upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stdout,
    )

    connect_args = {}
    if "sqlite" in settings.database_url:
        connect_args["check_same_thread"] = False

    engine = create_engine(settings.database_url, connect_args=connect_args)
    factory = sessionmaker(bind=engine)
    session = factory()
    try:
        report = ingest_wikipedia_images(
            session,
            HttpWikipediaImageAdapter(),
            ImageIngestionOptions(
                limit=args.limit,
                force_refresh=args.force_refresh,
                thumbnail_width=args.thumbnail_width,
                commit_interval=args.batch_size,
            ),
        )
        session.commit()
        if args.report is not None:
            write_report(report, args.report)
        logger.info(_summary(report))
        return 0
    except Exception:
        session.rollback()
        logger.exception("Wikipedia image enrichment failed")
        return 1
    finally:
        session.close()


if __name__ == "__main__":
    raise SystemExit(main())
