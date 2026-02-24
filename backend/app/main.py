from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routers import seasons, teams, players, games, quiz

app = FastAPI(
    title="EuroLeague Quiz API",
    description="API for EuroLeague Basketball data — powering quiz and knowledge games",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(seasons.router, prefix="/seasons", tags=["Seasons"])
app.include_router(teams.router, prefix="/teams", tags=["Teams"])
app.include_router(players.router, prefix="/players", tags=["Players"])
app.include_router(games.router, prefix="/games", tags=["Games"])
app.include_router(quiz.router, prefix="/quiz", tags=["Quiz"])


@app.get("/")
def root():
    return {"message": "EuroLeague Quiz API", "docs": "/docs"}
