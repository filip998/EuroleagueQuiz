import argparse
import logging
import sys

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.config import settings
from ingestion.aggregate_stats import aggregate_season_stats
from ingestion.fetch_boxscores import fetch_boxscores
from ingestion.fetch_rosters import fetch_rosters
from ingestion.fetch_seasons import fetch_season_data
from ingestion.utils import RateLimiter

logger = logging.getLogger(__name__)


def main():
    parser = argparse.ArgumentParser(description="EuroLeague data ingestion")
    parser.add_argument("--start-season", type=int, default=2000)
    parser.add_argument("--end-season", type=int, default=2025)
    parser.add_argument(
        "--step",
        choices=["all", "seasons", "rosters", "boxscores", "aggregate"],
        default="all",
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
