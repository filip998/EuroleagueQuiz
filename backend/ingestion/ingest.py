import argparse
import logging
import sys
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.config import settings
from ingestion.aggregate_stats import aggregate_season_stats
from ingestion.fetch_boxscores import fetch_boxscores
from ingestion.fetch_rosters import fetch_rosters
from ingestion.fetch_seasons import fetch_season_data
from ingestion.utils import RateLimiter
from ingestion.wikipedia_images import (
    DEFAULT_THUMBNAIL_WIDTH,
    HttpWikipediaImageAdapter,
    ImageIngestionOptions,
    ingest_wikipedia_images,
    write_report,
)

logger = logging.getLogger(__name__)


def main():
    parser = argparse.ArgumentParser(description="EuroLeague data ingestion")
    parser.add_argument("--start-season", type=int, default=2000)
    parser.add_argument("--end-season", type=int, default=2025)
    parser.add_argument(
        "--step",
        choices=["all", "seasons", "rosters", "boxscores", "aggregate", "wikipedia-images"],
        default="all",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Limit players inspected by the wikipedia-images step",
    )
    parser.add_argument(
        "--force-refresh",
        action="store_true",
        help="Re-check already inspected players for the wikipedia-images step",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=50,
        help="Rows to commit between batches for the wikipedia-images step",
    )
    parser.add_argument(
        "--thumbnail-width",
        type=int,
        default=DEFAULT_THUMBNAIL_WIDTH,
        help="Requested Wikimedia thumbnail width for the wikipedia-images step",
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=None,
        help="Optional JSON report path for the wikipedia-images step",
    )
    parser.add_argument(
        "--skip-boxscores",
        action="store_true",
        help="Skip boxscore fetching and aggregation (for seasons without game data)",
    )
    parser.add_argument(
        "--log-level",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        default="INFO",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stdout,
    )

    connect_args = {}
    if "sqlite" in settings.database_url:
        connect_args["check_same_thread"] = False

    engine = create_engine(
        settings.database_url,
        connect_args=connect_args,
        echo=False,
    )
    SessionFactory = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    rate_limiter = RateLimiter(settings.api_rate_limit_seconds)

    if args.step == "wikipedia-images":
        session = SessionFactory()
        try:
            report = ingest_wikipedia_images(
                session,
                HttpWikipediaImageAdapter(rate_limiter=rate_limiter),
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
            logger.info(
                "Wikipedia image enrichment complete: checked=%s found=%s missing=%s skipped=%s errors=%s",
                report.checked,
                report.found,
                report.missing,
                report.skipped,
                report.errors,
            )
        except Exception:
            session.rollback()
            logger.exception("Error processing Wikipedia image enrichment")
            raise
        finally:
            session.close()
        return

    for year in range(args.start_season, args.end_season + 1):
        logger.info(f"Processing season {year}-{year + 1}")
        session = SessionFactory()
        try:
            if args.step in ("all", "seasons"):
                fetch_season_data(session, year, rate_limiter)
            if args.step in ("all", "rosters"):
                fetch_rosters(session, year, rate_limiter)
            if args.step in ("all", "boxscores") and not args.skip_boxscores:
                fetch_boxscores(session, year, rate_limiter)
            if args.step in ("all", "aggregate") and not args.skip_boxscores:
                aggregate_season_stats(session, year)
            session.commit()
            logger.info(f"Season {year} committed successfully")
        except Exception:
            session.rollback()
            logger.exception(f"Error processing season {year}")
        finally:
            session.close()


if __name__ == "__main__":
    main()
