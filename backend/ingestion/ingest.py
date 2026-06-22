import argparse
import logging
import sys
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.config import settings
from ingestion.all_euroleague import (
    DEFAULT_OVERRIDES_PATH as ALL_EUROLEAGUE_OVERRIDES_PATH,
)
from ingestion.all_euroleague import (
    HttpAllEuroLeagueAdapter,
    IngestOptions as AllEuroLeagueIngestOptions,
    ingest_all_euroleague,
)
from ingestion.player_awards import (
    AWARD_OPTION_TO_METRICS,
    HttpPlayerAwardsAdapter,
    PlayerAwardsIngestOptions,
    ingest_player_awards,
)
from app.services.tictactoe_stat_milestones import build_stat_milestone_eligibility
from ingestion.aggregate_stats import aggregate_season_stats
from ingestion.champions import enrich_champion_flags, format_champion_report
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
        choices=[
            "all",
            "seasons",
            "rosters",
            "boxscores",
            "aggregate",
            "stat-milestones",
            "champions",
            "wikipedia-images",
            "all-euroleague",
            "player-awards",
        ],
        default="all",
    )
    parser.add_argument(
        "--award",
        choices=sorted(AWARD_OPTION_TO_METRICS),
        default="all",
        help="Award source to ingest for the player-awards step",
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
        help="Optional JSON report path for report-producing ingestion steps",
    )
    parser.add_argument(
        "--overrides",
        type=Path,
        default=None,
        help="Optional overrides JSON path for review-gated source mapping steps",
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

    if args.step == "stat-milestones":
        refresh_stat_milestone_eligibility(SessionFactory)
        return

    if args.step == "champions":
        refresh_champion_flags(SessionFactory, args.start_season, args.end_season)
        return

    if args.step == "all-euroleague":
        refresh_all_euroleague(
            SessionFactory,
            args.start_season,
            args.end_season,
            args.report,
            args.overrides,
        )
        return

    if args.step == "player-awards":
        refresh_player_awards(
            SessionFactory,
            args.start_season,
            args.end_season,
            args.report,
            args.overrides,
            args.award,
        )
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

    if args.step in ("all", "aggregate") and not args.skip_boxscores:
        refresh_stat_milestone_eligibility(SessionFactory)
    if args.step == "all":
        refresh_champion_flags(SessionFactory, args.start_season, args.end_season)


def refresh_stat_milestone_eligibility(SessionFactory) -> None:
    session = SessionFactory()
    try:
        counts = build_stat_milestone_eligibility(session)
        session.commit()
        logger.info(
            "TicTacToe stat milestone eligibility refreshed: %s",
            ", ".join(f"{key}={count}" for key, count in sorted(counts.items())),
        )
    except Exception:
        session.rollback()
        logger.exception("Error refreshing TicTacToe stat milestone eligibility")
        raise
    finally:
        session.close()


def refresh_champion_flags(SessionFactory, start_year: int, end_year: int) -> None:
    session = SessionFactory()
    try:
        reports = enrich_champion_flags(
            session,
            start_year=start_year,
            end_year=end_year,
        )
        session.commit()
        logger.info(
            "EuroLeague champion title-squad flags refreshed: %s",
            format_champion_report(reports),
        )
    except Exception:
        session.rollback()
        logger.exception("Error refreshing EuroLeague champion title-squad flags")
        raise
    finally:
        session.close()


def refresh_all_euroleague(
    SessionFactory,
    start_year: int,
    end_year: int,
    report_path: Path | None,
    overrides_path: Path | None,
) -> None:
    session = SessionFactory()
    try:
        report = ingest_all_euroleague(
            session,
            HttpAllEuroLeagueAdapter(),
            AllEuroLeagueIngestOptions(
                start_year=start_year,
                end_year=end_year,
                overrides_path=overrides_path or ALL_EUROLEAGUE_OVERRIDES_PATH,
                report_path=report_path,
            ),
        )
        session.commit()
        logger.info(
            "All-EuroLeague selections refreshed: rows=%s accepted=%s "
            "unmatched=%s ambiguous=%s enabled_metric=%s active=%s",
            report.in_range_rows,
            report.accepted,
            report.unmatched,
            report.ambiguous,
            report.enabled_metric,
            report.threshold_passed,
        )
    except Exception:
        session.rollback()
        logger.exception("Error refreshing All-EuroLeague selections")
        raise
    finally:
        session.close()


def refresh_player_awards(
    SessionFactory,
    start_year: int,
    end_year: int,
    report_path: Path | None,
    overrides_path: Path | None,
    award: str,
) -> None:
    session = SessionFactory()
    try:
        report = ingest_player_awards(
            session,
            HttpPlayerAwardsAdapter(),
            PlayerAwardsIngestOptions(
                start_year=start_year,
                end_year=end_year,
                metrics=AWARD_OPTION_TO_METRICS[award],
                overrides_path=overrides_path or ALL_EUROLEAGUE_OVERRIDES_PATH,
                report_path=report_path,
            ),
        )
        session.commit()
        for award_report in report.awards.values():
            logger.info(
                "Player awards refreshed: metric=%s rows=%s accepted=%s "
                "unmatched=%s ambiguous=%s excluded=%s active=%s",
                award_report.metric,
                award_report.in_range_rows,
                award_report.accepted,
                award_report.unmatched,
                award_report.ambiguous,
                award_report.excluded,
                award_report.threshold_passed,
            )
    except Exception:
        session.rollback()
        logger.exception("Error refreshing EuroLeague player awards")
        raise
    finally:
        session.close()


if __name__ == "__main__":
    main()
