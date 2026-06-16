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
- **Career Quiz** — Guess the player from a professional club career timeline built from Wikipedia. EuroLeague data only selects which players are eligible; the displayed career follows Wikipedia alone. Solo practice and 2-player race modes.

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

### Run Wikipedia Career Ingestion

Career Quiz uses cached Wikipedia career-history data; gameplay does not call Wikipedia live. EuroLeague data is used only to choose which players to look up — the cached career timeline comes purely from each player's Wikipedia infobox career history (no roster merging).

```bash
cd backend
python -m ingestion.wikipedia_careers --limit 500 --report data/wikipedia-career-report.json --candidates-report data/wikipedia-career-candidates.json
```

Reviewed page/team overrides live in `backend/ingestion/wikipedia_overrides.json`. The default candidate set is 500 players: 450 recent/top EuroLeague game-count players plus 50 early-era roster-heavy players from 2000–2006. The ingestion command fails the feature-enablement threshold when fewer than 200 eligible players are available. After running this ingestion or any migration locally, upload `backend/data/euroleague.db` to Azure before deploying.

### API Docs

Once the server is running, visit `http://localhost:8000/docs` for the interactive API documentation.

### Architecture Notes

Mutating quiz operations use a **Game action** seam in `backend/app/game_actions.py`.
Routers, WebSocket handlers, and timer jobs run game actions through this helper so the
application layer owns commit/rollback and game modules stay HTTP-agnostic.

Online TicTacToe, Roster Guess, and Career Quiz share an **Online Game Realtime Module**. The backend
Module in `backend/app/services/realtime.py` owns WebSocket connection cleanup,
broadcast envelopes, server-side turn timers for timer-enabled games, timer expiry, targeted broadcasts, and schema-compliant
error/result messages. Game-specific Adapters in `backend/app/services/realtime_adapters.py`
map TicTacToe, Roster Guess, and Career Quiz rules into that shared Interface.

Career Quiz adds a **Wikipedia Career Ingestion Module** under `backend/ingestion/`.
It resolves local EuroLeague players to English Wikipedia pages, parses basketball
infobox career-history rows, resolves team labels to stable keys, merges local EuroLeague
roster stints as validation/fill data, stores cached Career Timelines, and records a
Career Data Revision. Solo Career Quiz rounds use signed Solo Round Tokens so the answer
is not stored in browser state or persisted as a solo game row.
Multiplayer Career Quiz resolved-round state includes
`latest_completed_round.next_round_starts_at` during the three-second reveal lock; the
backend rejects next-round guesses with `round_locked` until that UTC timestamp elapses.
Multiplayer Career Quiz guess and no-answer mutations must include the client-visible
`round_number`; stale actions are rejected with `round_stale` so the frontend can resync
without applying old input to the current round. Career Quiz multiplayer uses WebSocket
push as its primary sync path, while plain `GET /quiz/career/games/{id}` remains the
refresh and fallback-sync Interface.

The frontend mirrors that Interface with `frontend/src/realtimeSchema.js` and
`frontend/src/useOnlineGameRealtime.js`, so reconnect, background state sync,
waiting-for-opponent polling, cleanup, and action dispatch stay out of the game boards.

Mutating TicTacToe, Roster Guess, and Career Quiz HTTP endpoints now use the same realtime
message envelopes as WebSocket broadcasts: successful actions return
`{ "type": "state", "payload": { "game": ..., "result": ..., "completed_round": ..., "terminal": ... } }`
and Game action errors return `{ "type": "error", "payload": { "code": ..., "message": ... } }`
with the corresponding HTTP status. Read-only `GET /games/{id}` endpoints still
return plain game state for polling and refresh hydration.

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
pytest tests/test_career_quiz.py    # Career Quiz tests only
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
