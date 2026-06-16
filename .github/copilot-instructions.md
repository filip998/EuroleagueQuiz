# Copilot Instructions - EuroLeague Quiz

## Repository shape

- `backend/` - Python 3.11 FastAPI API, SQLAlchemy models, Alembic migrations, and data ingestion.
- `frontend/` - React 19 + Vite 7 single-page app with Vitest, React Testing Library, ESLint, Tailwind, and Playwright.
- `scripts/` - Windows convenience scripts for starting the backend/frontend and uploading the SQLite database.

## Build, test, and lint commands

### Backend

```bash
cd backend
pip install -e ".[dev]"
alembic upgrade head
uvicorn app.main:app --reload
```

The API runs at `http://localhost:8000`; interactive docs are at `/docs`. On Windows, `scripts\start-backend.bat` creates the venv, installs dependencies, runs migrations, and starts the server.

```bash
cd backend
pytest tests/ --ignore=tests/smoke -v                 # backend CI test suite
pytest tests/test_api.py -v                           # one backend test file
pytest tests/test_api.py::test_get_team -v            # one pytest test
pytest tests/test_higher_lower.py -v                  # Higher or Lower tests
pytest tests/test_tictactoe_api.py -v                 # TicTacToe tests
pytest tests/smoke/ --base-url http://localhost:8000  # smoke tests against a live API
```

### Frontend

```bash
cd frontend
npm ci
npm run dev        # local dev server at http://localhost:5173
npm run build      # Vite production build
npm run lint       # ESLint
npm test           # Vitest unit tests, run once
npm run test:watch # Vitest watch mode
```

Run narrower frontend tests with Vitest/Playwright arguments:

```bash
cd frontend
npm test -- src/test/api.test.js
npm test -- src/test/api.test.js -t "createGame sends POST"
npm run test:e2e
npm run test:e2e -- e2e/app.spec.js
npm run test:e2e -- -g "Higher or Lower Flow"
```

Playwright auto-starts the backend and frontend from `frontend/playwright.config.js`; it expects `backend/.venv` to exist because the backend web server command uses `.venv/bin/uvicorn`. In CI/Linux setup, install browsers with `cd frontend && npx playwright install chromium --with-deps`.

### Data ingestion and migrations

```bash
cd backend
python -m ingestion.ingest --start-season 2000 --end-season 2025
python -m ingestion.ingest --step rosters --start-season 2024 --end-season 2024
python -m ingestion.ingest --skip-boxscores --start-season 2024 --end-season 2024
alembic revision --autogenerate -m "description"
alembic upgrade head
```

The SQLite database (`backend/data/euroleague.db`) is tracked and included in the backend deployment artifact. After schema changes, migrations, or ingestion changes that update data, include the resulting database change in the PR. For out-of-band production database refreshes, use:

```bash
az webapp deploy --resource-group euroleague-quiz-rg --name euroleague-quiz-backend-app --src-path backend/data/euroleague.db --target-path data/euroleague.db --type static --restart true
```

There is also a Windows helper: `scripts\upload-db.bat`.

## High-level architecture

The backend has two connected subsystems sharing the same SQLAlchemy model layer and `app.config.Settings`:

- `backend/ingestion/` is a CLI pipeline around the `euroleague-api` package. `ingest.py` loops seasons, creates a SQLAlchemy session, applies a `RateLimiter`, runs selected steps (`fetch_seasons`, `fetch_rosters`, `fetch_boxscores`, `aggregate_stats`), and commits once per season.
- `backend/app/` is the FastAPI API. `app/main.py` wires routers for seasons, teams, players, games, and quiz modes. The quiz routers are mounted under `/quiz` and cover TicTacToe, Roster Guess, and Higher or Lower.
- `backend/app/services/` contains the game/database logic for quiz modes. Routers convert service/domain errors into `HTTPException`s, commit successful mutations, roll back failed mutations, and broadcast WebSocket state for online modes.

The core data model uses upstream EuroLeague string codes (`euroleague_code`) for external player/team identity and integer primary keys internally. `PlayerSeasonTeam` is the central join table for player/team/season membership; `PlayerSeasonStats` hangs off it for aggregates, while `GamePlayerStats` stores per-game box score rows linked to `Game`.

The frontend is route-driven from `frontend/src/App.jsx`. Each game mode has a setup component and a board/play component. `frontend/src/api.js` is the single place for REST and WebSocket paths; `VITE_API_URL` controls the API base URL and `WS_BASE` is derived from it. TicTacToe and Roster Guess can recover online game info from `sessionStorage`; Higher or Lower passes initial game state through router state and does not survive a hard refresh.

CI runs on pull requests to `main`: backend pytest, frontend Vitest, frontend build, then Playwright E2E after backend tests and build pass. Deploys from `main` run backend/frontend tests again, deploy the backend to Azure App Service and frontend to Azure Static Web Apps, then run smoke tests against the live backend.

## Key conventions

- Settings belong in `backend/app/config.py` via `pydantic-settings`; environment variables use the `ELQ_` prefix, such as `ELQ_DATABASE_URL`.
- Use `get_db` from `backend/app/database.py` for request-scoped sessions. Keep manual `SessionLocal` usage to non-request flows such as WebSocket/timer contexts.
- Add SQLAlchemy models under `backend/app/models/`, inherit from `app.database.Base`, and re-export them from `backend/app/models/__init__.py`.
- Add Pydantic v2 schemas under `backend/app/schemas/`; ORM-backed schemas use `model_config = {"from_attributes": True}`.
- Keep HTTP routing thin: validate request shape in schemas/routers, put quiz rules and DB mutations in services, and translate service exceptions to HTTP status codes in routers.
- Mount new backend domains through `app/main.py`; quiz game endpoints should stay under `/quiz/...` to match the frontend API layer.
- When changing API paths or payload shapes, update `frontend/src/api.js` and the matching tests in `frontend/src/test/` and/or `frontend/e2e/`.
- Frontend unit tests mock network calls at the API layer (`global.fetch` in `src/test/api.test.js`); Playwright tests exercise the real FastAPI backend and Vite dev server.
- Backend API and Higher or Lower tests use the real SQLite database at `backend/data/euroleague.db`; TicTacToe API tests build an isolated temporary SQLite database with deterministic random seeding.
- For significant features, API changes, game mode changes, architecture changes, or workflow changes, update both `README.md` and this instructions file.
