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

**Backend (pytest):**
```bash
cd backend
.venv\Scripts\activate
pytest                              # all tests (excludes smoke)
pytest tests/test_api.py            # API tests only
pytest tests/test_tictactoe_api.py  # TicTacToe tests only
pytest tests/smoke/ --base-url http://localhost:8000  # smoke tests against live API
```

**Frontend unit tests (Vitest + React Testing Library):**
```bash
cd frontend
npm test          # run once
npm run test:watch  # watch mode
```
Test files live in `frontend/src/test/`. Tests cover: App navigation, API layer, GameSetup, PlayerSearch, HigherLowerBoard.

**Frontend E2E tests (Playwright):**
```bash
cd frontend
npm run test:e2e
```
E2E tests live in `frontend/e2e/`. Playwright auto-starts both backend and frontend via `webServer` config. Requires the backend venv to exist (`backend/.venv`).

### Run Data Ingestion
```bash
cd backend
.venv\Scripts\activate
python -m ingestion.ingest --start-season 2000 --end-season 2025  # full ingestion
python -m ingestion.ingest --step rosters --start-season 2024 --end-season 2024  # single step/season
```

### Deploy to Production

**Workflow: push to a branch → open PR → merge to `main`**

1. **Open a PR to `main`** → `.github/workflows/ci.yml` runs automatically:
   - Backend tests (pytest)
   - Frontend unit tests (vitest, 41 tests)
   - Frontend build check (npm run build)
   - Frontend E2E tests (Playwright, 6 tests) — runs after backend tests + build pass
   - ❌ If any check fails, the PR is blocked.

2. **Merge the PR** → `.github/workflows/deploy.yml` runs automatically:
   - Runs backend + frontend tests again as a safety gate
   - Deploys **backend** to Azure App Service (`euroleague-quiz-backend-app`)
   - Builds and deploys **frontend** to Azure Static Web Apps
   - Runs **post-deploy smoke tests** against the live API to verify the deployment

**Do NOT push directly to `main`.** Always use a PR so CI checks run first.

To run checks locally before pushing:
```bash
cd backend && pytest tests/ --ignore=tests/smoke  # backend tests
cd frontend && npm test                             # frontend unit tests
cd frontend && npm run test:e2e                     # E2E tests (needs backend venv)
cd frontend && npm run build                        # build check
```

### Upload Database to Azure (required after schema or data changes)
The SQLite database (`backend/data/euroleague.db`) is `.gitignore`d and NOT deployed via CI/CD.
**You must upload it to Azure whenever:**
- New tables are added (Alembic migrations)
- Data ingestion is re-run
- Any schema change is made

Steps:
1. Run migrations locally: `cd backend && .venv\Scripts\activate && alembic upgrade head`
2. Upload via Azure CLI:
   ```bash
   az webapp deploy --resource-group euroleague-quiz-rg --name euroleague-quiz-backend-app --src-path backend/data/euroleague.db --target-path data/euroleague.db --type static --restart true
   ```
   Note: Azure CLI is installed at `C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin\az.cmd`. If `az` is not in PATH, add it: `$env:PATH += ";C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin"`.
3. The `--restart true` flag automatically restarts the App Service after upload.

**IMPORTANT:** Always remind the user to upload the database after making schema or data changes. When possible, run this command automatically after confirming with the user.

A convenience script is also available: `scripts\upload-db.bat`

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
- **Tests (backend)**: Use FastAPI's `TestClient`. TicTacToe tests use isolated in-memory SQLite; API tests use the real database. Smoke tests (`tests/smoke/`) use `httpx` against a live URL.
- **Tests (frontend)**: Vitest + React Testing Library for unit tests (`src/test/`). Playwright for E2E tests (`e2e/`). Mock API calls in unit tests; E2E tests run against the real backend.
- **Documentation**: When making significant changes (new features, new game modes, architecture changes, new workflows, or API changes), update both `README.md` and this instructions file to keep them in sync.
