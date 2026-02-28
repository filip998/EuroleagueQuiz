# EuroLeague Quiz

Web application for quizzes and knowledge games focused on **EuroLeague Basketball** (from 2000 onward).

## Project Structure

```
backend/   — Python/FastAPI API server, data ingestion, SQLAlchemy models
frontend/  — React (Vite) UI
scripts/   — Startup scripts (start-backend.bat, start-frontend.bat)
```

## Quick Start

Run the startup scripts from the project root:

```bash
# Terminal 1 — backend (creates venv, installs deps, runs migrations, starts server)
scripts\start-backend.bat

# Terminal 2 — frontend (installs npm deps, starts dev server)
scripts\start-frontend.bat
```

Then open `http://localhost:5173` to play.

## Games

- **TicTacToe** — Claim cells on a 3×3 board by naming players who match both row and column team criteria. Solo, local 1v1, and online modes.
- **Roster Guess** — Guess the full roster of a EuroLeague team from a specific season. Solo and multiplayer.
- **Higher or Lower** — Compare player stats and build a streak. Easy, medium, and hard tiers with leaderboards.

## Backend

### Setup

```bash
cd backend
pip install -e .
alembic upgrade head
```

### Run API Server

```bash
cd backend
uvicorn app.main:app --reload
```

### Run Data Ingestion

```bash
cd backend
python -m ingestion.ingest --start-season 2000 --end-season 2025
```

### API Docs

Once the server is running, visit `http://localhost:8000/docs` for the interactive API documentation.

## Frontend

### Setup

```bash
cd frontend
npm install
```

### Run Dev Server

```bash
cd frontend
npm run dev
```

Opens at `http://localhost:5173`.

## Testing

### Backend (pytest)

```bash
cd backend
pytest                              # all tests (excludes smoke)
pytest tests/test_api.py            # API tests only
pytest tests/test_tictactoe_api.py  # TicTacToe tests only
pytest tests/test_higher_lower.py   # Higher or Lower tests only
```

### Frontend Unit Tests (Vitest + React Testing Library)

```bash
cd frontend
npm test            # run once
npm run test:watch  # watch mode
```

### Frontend E2E Tests (Playwright)

```bash
cd frontend
npm run test:e2e
```

Playwright auto-starts both backend and frontend. Requires the backend venv to exist (`backend/.venv`).

### Smoke Tests (post-deploy)

```bash
cd backend
pytest tests/smoke/ --base-url https://euroleague-quiz-backend-app.azurewebsites.net
```

## CI/CD

The project uses GitHub Actions for continuous integration and deployment:

1. **PR to `main`** → `ci.yml` runs: backend tests, frontend unit tests, build check, E2E tests. All must pass before merging.
2. **Merge to `main`** → `deploy.yml` runs: tests again as a gate → deploys backend to Azure App Service + frontend to Azure Static Web Apps → post-deploy smoke tests verify the live API.

**Do not push directly to `main`.** Always use a pull request so CI checks run first.
