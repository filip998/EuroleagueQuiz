# Copilot Instructions — EuroLeague Quiz

## Project Structure

```
backend/   — Python/FastAPI API server, data ingestion, SQLAlchemy models
frontend/  — React (Vite) UI
scripts/   — Startup scripts
```

## Skills

### Run Backend
```bash
cd backend
.venv\Scripts\activate      # Windows (or source .venv/bin/activate on Linux/Mac)
alembic upgrade head
uvicorn app.main:app --reload
```
Or use the script: `scripts\start-backend.bat` (auto-creates venv, installs deps, runs migrations, starts server).
Backend runs at http://localhost:8000 (docs at /docs).

### Run Frontend
```bash
cd frontend
npm install   # first time only
npm run dev
```
Or use the script: `scripts\start-frontend.bat`.
Frontend runs at http://localhost:5173.

### Run Both
Open two terminals and run `scripts\start-backend.bat` and `scripts\start-frontend.bat`.

### Run Tests
```bash
cd backend
.venv\Scripts\activate
pytest                           # all tests
pytest tests/test_api.py         # API tests only
pytest tests/test_tictactoe_api.py  # TicTacToe tests only
```

### Run Data Ingestion
```bash
cd backend
.venv\Scripts\activate
python -m ingestion.ingest --start-season 2000 --end-season 2025  # full ingestion
python -m ingestion.ingest --step rosters --start-season 2024 --end-season 2024  # single step/season
```

### Deploy to Production
After making changes, commit and push to `main` to trigger automatic deployment via GitHub Actions:
```bash
git add -A
git commit -m "description of changes"
git push origin main
```
This runs `.github/workflows/deploy.yml` which:
- Deploys the **backend** to Azure App Service (`euroleague-quiz-backend-app`)
- Builds the **frontend** with `npm ci && npm run build` and deploys to Azure Static Web Apps
Always run `npm run build` in `frontend/` locally before pushing to catch build errors early.

### Create Migration
```bash
cd backend
.venv\Scripts\activate
alembic revision --autogenerate -m "description"
alembic upgrade head
```

## Build & Run (legacy, use skills above)

```bash
cd backend
pip install -e ".[dev]"     # install with dev/test dependencies
```

## Architecture

This is a **EuroLeague Basketball quiz app** with two main subsystems, both under `backend/`:

1. **`backend/ingestion/`** — CLI pipeline that fetches data from the EuroLeague API (`euroleague-api` package) and writes it to the database. Runs per-season with a `RateLimiter` to respect API limits. Steps: `seasons → rosters → boxscores → aggregate`.

2. **`backend/app/`** — FastAPI REST API that reads the same database and serves quiz-oriented endpoints (random player, season leaders, roster lookup, player clubs) plus the TicTacToe game engine (`/quiz/tictactoe/*`).

3. **`frontend/`** — React (Vite) single-page app for the TicTacToe quiz game UI.

Both backend subsystems share `backend/app/models/` (SQLAlchemy) and `backend/app/config.py` (settings via `pydantic-settings`, env prefix `ELQ_`).

### Data model

The central join table is `PlayerSeasonTeam` — it links a player to a team for a specific season and is the anchor for both `PlayerSeasonStats` (aggregated) and the roster endpoints. `GamePlayerStats` stores per-game box scores linked to `Game`.

Entities are identified by `euroleague_code` (string codes like `"BAR"` for teams, `"P001234"` for players) from the upstream API. Internal integer `id` columns are autoincrement surrogates.

## Conventions

- **Config**: All settings go through `app.config.Settings` (pydantic-settings). Environment variables use the `ELQ_` prefix (e.g., `ELQ_DATABASE_URL`).
- **Database**: Default is SQLite at `backend/data/euroleague.db`. The `get_db` dependency yields a session per request.
- **Models**: SQLAlchemy declarative models in `backend/app/models/`, all inherit from `app.database.Base`. Each model file covers one domain entity. Re-exported via `app/models/__init__.py`.
- **Schemas**: Pydantic v2 models in `backend/app/schemas/` with `model_config = {"from_attributes": True}` for ORM compatibility.
- **Routers**: One router per domain in `backend/app/routers/`, mounted in `app/main.py` with a URL prefix matching the domain name.
- **Services**: Game logic in `backend/app/services/` (e.g., `tictactoe.py`). Services are pure domain logic, called by routers.
- **Ingestion**: Each step is a separate module (`fetch_seasons.py`, `fetch_rosters.py`, `fetch_boxscores.py`, `aggregate_stats.py`). They accept a SQLAlchemy session and a `RateLimiter`, and commit is handled by the caller in `ingest.py`.
- **Tests**: Use FastAPI's `TestClient`. TicTacToe tests use isolated in-memory SQLite; API tests use the real database.
