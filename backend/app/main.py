import logging
import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.database import get_db
from app.routers import (
    auth,
    career_quiz,
    games,
    higher_lower,
    photo_quiz,
    players,
    quiz,
    guess_the_list,
    seasons,
    teams,
)
from app.services import tictactoe as tictactoe_service

logger = logging.getLogger(__name__)


def _should_skip_tictactoe_board_cache_warm_for_tests(app: FastAPI) -> bool:
    return (
        "pytest" in sys.modules
        and not getattr(
            app.state,
            "enable_tictactoe_board_cache_warm_in_tests",
            False,
        )
    )


def _warm_tictactoe_board_cache(app: FastAPI) -> None:
    if _should_skip_tictactoe_board_cache_warm_for_tests(app):
        logger.debug("Skipping TicTacToe board cache warm under pytest")
        return

    db_provider = app.dependency_overrides.get(get_db, get_db)
    db_context = db_provider()
    try:
        db = next(db_context)
    except Exception:
        logger.exception("Failed to open database session for TicTacToe board cache warm")
        return
    try:
        tictactoe_service.warm_board_cache(db)
    except Exception:
        logger.exception("Failed to warm TicTacToe board cache")
    finally:
        close = getattr(db_context, "close", None)
        if close is not None:
            close()


@asynccontextmanager
async def lifespan(app: FastAPI):
    _warm_tictactoe_board_cache(app)
    yield


app = FastAPI(
    title="EuroLeague Quiz API",
    description="API for EuroLeague Basketball data — powering quiz and knowledge games",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.cors_origins.split(",") if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Server-Timing"],
)

app.include_router(seasons.router, prefix="/seasons", tags=["Seasons"])
app.include_router(teams.router, prefix="/teams", tags=["Teams"])
app.include_router(players.router, prefix="/players", tags=["Players"])
app.include_router(games.router, prefix="/games", tags=["Games"])
app.include_router(auth.router, prefix="/auth", tags=["Auth"])
app.include_router(quiz.router, prefix="/quiz", tags=["Quiz"])
app.include_router(
    guess_the_list.router,
    prefix="/quiz/guess-the-list",
    tags=["Guess the List"],
)
app.include_router(
    guess_the_list.router,
    prefix="/quiz/roster-guess",
    tags=["Guess the List Legacy"],
    include_in_schema=False,
)
app.include_router(higher_lower.router, prefix="/quiz", tags=["Higher or Lower"])
app.include_router(career_quiz.router, prefix="/quiz", tags=["Career Quiz"])
app.include_router(photo_quiz.router, prefix="/quiz", tags=["Photo Quiz"])


@app.get("/")
def root():
    return {"message": "EuroLeague Quiz API", "docs": "/docs"}
