from datetime import datetime, timezone
import hashlib

import httpx
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models import Player
from ingestion.wikipedia_images import (
    DEFAULT_THUMBNAIL_WIDTH,
    ImageIngestionOptions,
    WikipediaImagePage,
    _image_url_from_pages,
    extract_infobox_image_file,
    ingest_wikipedia_images,
    normalize_image_file,
)


@pytest.fixture
def session():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)
    db = factory()
    try:
        yield db
    finally:
        db.close()
        Base.metadata.drop_all(engine)


class FakeWikipediaImageAdapter:
    def __init__(self, *, pages=None, images=None, fetch_errors=None):
        self.pages = pages or {}
        self.images = images or {}
        self.fetch_errors = {
            title: list(errors)
            for title, errors in (fetch_errors or {}).items()
        }
        self.fetched_titles = []
        self.resolved_images = []

    def fetch_page(self, title: str):
        self.fetched_titles.append(title)
        errors = self.fetch_errors.get(title) or []
        if errors:
            exc = errors.pop(0)
            self.fetch_errors[title] = errors
            raise exc
        return self.pages.get(title)

    def resolve_image_url(self, file_name: str, thumbnail_width: int):
        self.resolved_images.append((file_name, thumbnail_width))
        return self.images.get(file_name)


def test_extract_infobox_image_file_uses_basketball_infobox_only():
    wikitext = """
{{Infobox person
| image = Wrong.jpg
}}
{{Infobox basketball biography
| name = Milos Teodosic
| image = [[File:Miloš Teodosić 2016.jpg|thumb|caption]]
}}
"""

    assert extract_infobox_image_file(wikitext) == "Miloš Teodosić 2016.jpg"


def test_extract_infobox_image_file_uses_fallback_params_and_strips_prefixes():
    wikitext = """
{{Infobox basketball biography
| name = Legend
| photo = Image:Legend portrait.png<ref>source</ref>
}}
"""

    assert extract_infobox_image_file(wikitext) == "Legend portrait.png"
    assert normalize_image_file("File:Another legend.webp|thumb|caption") == "Another legend.webp"


def test_imageinfo_resolver_accepts_shared_commons_files_marked_missing_locally():
    assert _image_url_from_pages(
        [
            {
                "missing": True,
                "known": True,
                "imagerepository": "shared",
                "imageinfo": [
                    {
                        "thumburl": "https://upload.wikimedia.org/thumb.jpg",
                        "url": "https://upload.wikimedia.org/original.jpg",
                    }
                ],
            }
        ]
    ) == "https://upload.wikimedia.org/thumb.jpg"


def test_ingest_decodes_percent_encoded_wikipedia_title_and_stores_image(session):
    player = _player(
        session,
        "Milos",
        "Teodosic",
        wikipedia_url="https://en.wikipedia.org/wiki/Milo%C5%A1_Teodosi%C4%87#Career",
    )
    adapter = FakeWikipediaImageAdapter(
        pages={"Miloš Teodosić": _page("Miloš Teodosić", _wikitext("Milos.jpg"))},
        images={"Milos.jpg": "https://upload.wikimedia.org/milos.jpg"},
    )

    report = ingest_wikipedia_images(session, adapter)

    assert adapter.fetched_titles == ["Miloš Teodosić"]
    assert adapter.resolved_images == [("Milos.jpg", DEFAULT_THUMBNAIL_WIDTH)]
    assert report.checked == 1
    assert report.found == 1
    assert report.missing == 0
    assert player.wikipedia_image_url == "https://upload.wikimedia.org/milos.jpg"
    assert player.wikipedia_image_checked_at is not None


def test_ingest_marks_successfully_fetched_page_without_image_as_checked(session):
    player = _player(
        session,
        "No",
        "Image",
        wikipedia_url="https://en.wikipedia.org/wiki/No_Image",
    )
    adapter = FakeWikipediaImageAdapter(
        pages={"No Image": _page("No Image", "{{Infobox person|image = Wrong.jpg}}")},
    )

    report = ingest_wikipedia_images(session, adapter)

    assert report.checked == 1
    assert report.missing == 1
    assert report.errors == 0
    assert player.wikipedia_image_url is None
    assert player.wikipedia_image_checked_at is not None


def test_ingest_skips_already_checked_players_and_second_run_is_idempotent(session):
    player = _player(
        session,
        "Already",
        "Checked",
        wikipedia_url="https://en.wikipedia.org/wiki/Already_Checked",
        checked_at=_utcnow(),
    )
    adapter = FakeWikipediaImageAdapter(
        pages={"Already Checked": _page("Already Checked", _wikitext("Checked.jpg"))},
        images={"Checked.jpg": "https://upload.wikimedia.org/checked.jpg"},
    )

    report = ingest_wikipedia_images(session, adapter)

    assert report.checked == 0
    assert report.skipped == 1
    assert adapter.fetched_titles == []
    assert player.wikipedia_image_url is None

    unchecked = _player(
        session,
        "New",
        "Player",
        wikipedia_url="https://en.wikipedia.org/wiki/New_Player",
    )
    adapter.pages["New Player"] = _page("New Player", _wikitext("New.jpg"))
    adapter.images["New.jpg"] = "https://upload.wikimedia.org/new.jpg"

    first = ingest_wikipedia_images(session, adapter)
    second = ingest_wikipedia_images(session, adapter)

    assert first.checked == 1
    assert first.found == 1
    assert second.checked == 0
    assert second.skipped == 2
    assert unchecked.wikipedia_image_url == "https://upload.wikimedia.org/new.jpg"
    assert adapter.fetched_titles == ["New Player"]


def test_force_refresh_rechecks_already_checked_player(session):
    player = _player(
        session,
        "Force",
        "Refresh",
        wikipedia_url="https://en.wikipedia.org/wiki/Force_Refresh",
        image_url="https://old.example/image.jpg",
        checked_at=_utcnow(),
    )
    adapter = FakeWikipediaImageAdapter(
        pages={"Force Refresh": _page("Force Refresh", _wikitext("Fresh.jpg"))},
        images={"Fresh.jpg": "https://upload.wikimedia.org/fresh.jpg"},
    )

    report = ingest_wikipedia_images(
        session,
        adapter,
        ImageIngestionOptions(force_refresh=True),
    )

    assert report.checked == 1
    assert report.found == 1
    assert report.skipped == 0
    assert adapter.fetched_titles == ["Force Refresh"]
    assert player.wikipedia_image_url == "https://upload.wikimedia.org/fresh.jpg"


def test_transient_fetch_error_is_not_marked_checked_and_retries(session):
    player = _player(
        session,
        "Retry",
        "Player",
        wikipedia_url="https://en.wikipedia.org/wiki/Retry_Player",
    )
    adapter = FakeWikipediaImageAdapter(
        pages={"Retry Player": _page("Retry Player", _wikitext("Retry.jpg"))},
        images={"Retry.jpg": "https://upload.wikimedia.org/retry.jpg"},
        fetch_errors={"Retry Player": [httpx.TimeoutException("timeout")]},
    )

    failed = ingest_wikipedia_images(session, adapter)
    assert failed.checked == 0
    assert failed.errors == 1
    assert player.wikipedia_image_checked_at is None

    retried = ingest_wikipedia_images(session, adapter)

    assert retried.checked == 1
    assert retried.found == 1
    assert player.wikipedia_image_url == "https://upload.wikimedia.org/retry.jpg"
    assert adapter.fetched_titles == ["Retry Player", "Retry Player"]


def test_transient_error_during_force_refresh_clears_stale_checked_timestamp(session):
    player = _player(
        session,
        "Stale",
        "Checked",
        wikipedia_url="https://en.wikipedia.org/wiki/Stale_Checked",
        image_url=None,
        checked_at=_utcnow(),
    )
    adapter = FakeWikipediaImageAdapter(
        fetch_errors={"Stale Checked": [httpx.TimeoutException("timeout")]},
    )

    report = ingest_wikipedia_images(
        session,
        adapter,
        ImageIngestionOptions(force_refresh=True),
    )

    assert report.checked == 0
    assert report.errors == 1
    assert player.wikipedia_image_checked_at is None


def test_empty_wikipedia_urls_are_not_selected(session):
    _player(session, "Blank", "Url", wikipedia_url="   ")
    adapter = FakeWikipediaImageAdapter()

    report = ingest_wikipedia_images(session, adapter)

    assert report.checked == 0
    assert report.skipped == 0
    assert adapter.fetched_titles == []


def _page(title: str, wikitext: str) -> WikipediaImagePage:
    return WikipediaImagePage(
        page_id=abs(hash(title)) % 10000,
        title=title,
        url=f"https://en.wikipedia.org/wiki/{title.replace(' ', '_')}",
        revision_id=f"rev-{title}",
        wikitext=wikitext,
    )


def _wikitext(image_file: str) -> str:
    return f"""
{{{{Infobox basketball biography
| name = Player
| image = {image_file}
}}}}
"""


def _player(
    session,
    first_name: str,
    last_name: str,
    *,
    wikipedia_url: str | None,
    image_url: str | None = None,
    checked_at: datetime | None = None,
) -> Player:
    digest = hashlib.sha1(f"{first_name}|{last_name}".encode()).hexdigest()
    player = Player(
        euroleague_code=f"P{digest[:12]}",
        first_name=first_name,
        last_name=last_name,
        wikipedia_url=wikipedia_url,
        wikipedia_image_url=image_url,
        wikipedia_image_checked_at=checked_at,
    )
    session.add(player)
    session.commit()
    return player


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)
