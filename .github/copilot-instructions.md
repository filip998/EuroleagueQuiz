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
pytest tests/test_tictactoe_api.py -v                 # TicTacToe tests
pytest tests/test_roster_guess_api.py -v              # Roster Guess tests
pytest tests/test_higher_lower.py -v                  # Higher or Lower tests
pytest tests/test_career_quiz.py -v                   # Career Quiz tests
pytest tests/test_realtime_module.py -v               # shared realtime module tests
pytest tests/smoke/ --base-url http://localhost:8000  # smoke tests against a live API
```

`tests/test_api.py` and `tests/test_higher_lower.py` use the tracked SQLite database and Higher or Lower tests create/finish games, so check `git status` after local backend test runs and include `backend/data/euroleague.db` changes only when they are intentional.

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
npm test -- src/test/CareerQuizBoard.test.jsx
npm run test:e2e
npm run test:e2e -- e2e/app.spec.js
npm run test:e2e -- -g "Higher or Lower Flow"
```

Playwright auto-starts the backend and frontend from `frontend/playwright.config.js`; it expects `backend/.venv` to exist because the backend web server command uses `.venv/bin/uvicorn`. Use `E2E_BACKEND_PORT` and `E2E_FRONTEND_PORT` to override the default `8000`/`5173` ports. In CI/Linux setup, install browsers with `cd frontend && npx playwright install chromium --with-deps`.

### Data ingestion and migrations

```bash
cd backend
python -m ingestion.ingest --start-season 2000 --end-season 2025
python -m ingestion.ingest --step rosters --start-season 2024 --end-season 2024
python -m ingestion.ingest --skip-boxscores --start-season 2024 --end-season 2024
python -m ingestion.wikipedia_careers --limit 500 --report data/wikipedia-career-report.json --candidates-report data/wikipedia-career-candidates.json
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
- `backend/ingestion/wikipedia_careers.py` populates cached Career Quiz timelines from Wikipedia basketball infobox career rows. EuroLeague data chooses eligible players; gameplay uses the cached Wikipedia timeline and does not call Wikipedia live.
- `backend/app/` is the FastAPI API. `app/main.py` wires routers for seasons, teams, players, games, and quiz modes. The quiz routers are mounted under `/quiz` and cover TicTacToe, Roster Guess, Higher or Lower, Career Quiz, and Photo Quiz.
- `backend/app/services/` contains quiz rules and database logic. Mutating quiz operations run through the game action seam in `backend/app/game_actions.py`, so application-layer helpers own commit/rollback and game modules stay HTTP-agnostic.
- `backend/app/services/realtime.py` is the shared Online Game Realtime Module for online TicTacToe, Roster Guess, and Career Quiz. It owns WebSocket connection cleanup, state/error envelopes, server-side turn timers, disconnect-grace timers, timer expiry, targeted broadcasts, and schema-compliant messages. TicTacToe enables disconnect-grace forfeits (`ELQ_ONLINE_DISCONNECT_GRACE_SECONDS`) and terminal `opponent_left`/`resigned` results through `backend/app/services/realtime_adapters.py`; Roster Guess and Career Quiz keep the shared transport/timer interface without disconnect forfeits.

The core data model uses upstream EuroLeague string codes (`euroleague_code`) for external player/team identity and integer primary keys internally. `PlayerSeasonTeam` is the central join table for player/team/season membership; `PlayerSeasonStats` hangs off it for aggregates, while `GamePlayerStats` stores per-game box score rows linked to `Game`. Career Quiz adds cached `PlayerCareerStint`, source mapping, and data revision models.
Player image/link data is stored on `players`: `euroleague_image_url` is the EuroLeague CDN headshot, `wikipedia_url` is the canonical player page, and `wikipedia_image_url` / `wikipedia_image_checked_at` are reserved for Wikipedia photo enrichment. Existing game serializers still expose a JSON key named `image_url` for frontend compatibility, sourced from `euroleague_image_url`. Photo Quiz uses players with a Wikipedia page and either a EuroLeague CDN image or Wikipedia image; its image resolver returns `euroleague_image_url` first and falls back to `wikipedia_image_url`.

The frontend is route-driven from `frontend/src/App.jsx`. Each game mode has a setup component and a board/play component. Every setup screen is composed from three shared components in `frontend/src/`: `GameSetupShell.jsx` (common chrome — Home logo, per-game accent header, canonical card, error slot, optional second card), `GameModeSelector.jsx` (controlled Solo / Local 1v1 / Online mode cards where Online expands a Create / Join sub-toggle, and which renders nothing for single-mode games like Higher or Lower), and `WaitingLobby.jsx` (the shared waiting-for-opponent screen with copy-to-clipboard join code and Cancel used by `GameBoard.jsx` and `CareerQuizBoard.jsx`; for TicTacToe it also shows a copyable shareable invite link built by `frontend/src/inviteLink.js` as `${origin}/tictactoe?join=ABC123`, and the TicTacToe setup route prefills Online → Join from that `?join=` code via `parseJoinCode` — no backend change, v1 is TicTacToe only). Setups map the canonical UI keys (`solo`/`local`/`online`, sub `create`/`join`) onto their own backend modes and keep their existing `onGameCreated`/`onGameJoined`/`onSoloRound`/`onBack` prop contracts. `frontend/src/api.js` is the single place for REST and WebSocket paths; `VITE_API_URL` controls the API base URL and `WS_BASE` is derived from it. `frontend/src/realtimeSchema.js` and `frontend/src/useOnlineGameRealtime.js` mirror the shared realtime envelope interface for reconnect, background sync, waiting-for-opponent polling, cleanup, and action dispatch. TicTacToe Quick Match setup screens can poll `GET /quiz/tictactoe/quick-match/pools` every 5 seconds for per-preset `searching` and `in_progress` counts derived from public quick-match rows.

TicTacToe, Roster Guess, and Career Quiz can recover online game info from `sessionStorage`; Higher or Lower and Career Quiz solo pass initial game state through router state and do not survive a hard refresh. Photo Quiz backend core currently supports Solo signed-token rounds and eligible-player autocomplete only; online/realtime and frontend flows are follow-up work. Career Quiz multiplayer exposes `latest_completed_round.next_round_starts_at` during the three-second reveal countdown; the backend rejects next-round guesses with `round_locked` until that UTC timestamp elapses. Career Quiz multiplayer guess and no-answer mutations must include the client-visible `round_number`; stale actions are rejected with `round_stale`.

`frontend/src/identity.js` owns a lightweight guest identity for online matchmaking: `getGuestId()` returns a stable opaque id generated once (via `crypto.randomUUID()` with a fallback) and cached in `localStorage` (`elq_guest_id`), and `getNickname()`/`setNickname()` persist the shared display name (`elq_nickname`, clamped to `NICKNAME_MAX_LENGTH = 30`, migrating the legacy `hol_nickname` key). All storage access is `try/catch`-safe so identity degrades to anonymous play. Every setup screen prefills its name field from `getNickname()` and persists edits via `setNickname()` (not while in Local 1v1 mode, where "Player 1" is a placeholder). `api.js` attaches `guest_id` to TicTacToe/Roster Guess/Career Quiz online `create`/`join` requests; the nickname rides the existing `player1_name`/`player_name` field. The backend persists `guest_id` as an opaque, untrusted token on `player1_guest_id`/`player2_guest_id` (clamped to 64 chars in the service, `None` when blank), never required and never serialized into shared game state, so anonymous play still works.

CI runs on pull requests to `main`: backend pytest, frontend Vitest, frontend build, then Playwright E2E after backend tests and build pass. Deploys from `main` run backend/frontend tests again, deploy the backend to Azure App Service and frontend to Azure Static Web Apps, then run smoke tests against the live backend.

## Key conventions

- Settings belong in `backend/app/config.py` via `pydantic-settings`; environment variables use the `ELQ_` prefix, such as `ELQ_DATABASE_URL`.
- Use `get_db` from `backend/app/database.py` for request-scoped sessions. Keep manual `SessionLocal` usage to non-request flows such as WebSocket/timer contexts.
- Add SQLAlchemy models under `backend/app/models/`, inherit from `app.database.Base`, and re-export them from `backend/app/models/__init__.py`.
- Add Pydantic v2 schemas under `backend/app/schemas/`; ORM-backed schemas use `model_config = {"from_attributes": True}`.
- Keep HTTP routing thin: validate request shape in schemas/routers, put quiz rules and DB mutations in services, and translate service/action exceptions to HTTP status codes in routers.
- Mount new backend domains through `app/main.py`; quiz game endpoints should stay under `/quiz/...` to match the frontend API layer.
- Mutating TicTacToe, Roster Guess, and Career Quiz HTTP endpoints use the same realtime message envelopes as WebSocket broadcasts: successful actions return `{"type":"state","payload":{...}}` and game action errors return `{"type":"error","payload":{...}}`. Read-only `GET /games/{id}` endpoints return plain game state for polling and refresh hydration.
- Online `create`/`join` requests accept an optional opaque `guest_id` (see `frontend/src/identity.js`). Keep it optional and untrusted: schemas must not reject it (no erroring `max_length`), services clamp it to 64 chars and store it on `player1_guest_id`/`player2_guest_id`, and it must never be serialized into shared game state. Anonymous play (no `guest_id`) must keep working.
- When changing API paths or payload shapes, update `frontend/src/api.js` and the matching tests in `frontend/src/test/` and/or `frontend/e2e/`.
- Frontend unit tests mock network calls at the API layer (`global.fetch` in `src/test/api.test.js`); Playwright tests exercise the real FastAPI backend and Vite dev server.
- Backend API and Higher or Lower tests use the real SQLite database at `backend/data/euroleague.db`. TicTacToe and Roster Guess API tests build isolated temporary SQLite databases; Career Quiz, Photo Quiz, and Wikipedia ingestion tests use isolated in-memory SQLite databases with seeded fixtures.
- For significant features, API changes, game mode changes, architecture changes, or workflow changes, update both `README.md` and this instructions file.
