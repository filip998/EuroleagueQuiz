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
alembic -c alembic_auth.ini upgrade head
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

`tests/test_api.py` and `tests/test_higher_lower.py` use the tracked SQLite database and Higher or Lower tests create/finish games, so check `git status` after local backend test runs and include `backend/data/euroleague.db` changes only when they are intentional. Auth datastore tests use temporary SQLite databases; do not create or commit `backend/data/users.db*`.

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
python -m ingestion.wikipedia_images --report data/wikipedia-image-report.json
alembic revision --autogenerate -m "description"
alembic upgrade head
alembic -c alembic_auth.ini revision --autogenerate -m "description"
alembic -c alembic_auth.ini upgrade head
```

The SQLite database (`backend/data/euroleague.db`) is tracked and included in the backend deployment artifact. After schema changes, migrations, or ingestion changes that update data, include the resulting database change in the PR. For out-of-band production database refreshes, use:

```bash
az webapp deploy --resource-group euroleague-quiz-rg --name euroleague-quiz-backend-app --src-path backend/data/euroleague.db --target-path data/euroleague.db --type static --restart true
```

There is also a Windows helper: `scripts\upload-db.bat`.

## High-level architecture

The backend has the tracked EuroLeague content datastore plus a separate auth/user datastore, all configured through `app.config.Settings`:

- `backend/ingestion/` is a CLI pipeline around the `euroleague-api` package. `ingest.py` loops seasons, creates a SQLAlchemy session, applies a `RateLimiter`, runs selected steps (`fetch_seasons`, `fetch_rosters`, `fetch_boxscores`, `aggregate_stats`), and commits once per season.
- `backend/ingestion/wikipedia_careers.py` populates cached Career Quiz timelines from Wikipedia basketball infobox career rows. EuroLeague data chooses eligible players; gameplay uses the cached Wikipedia timeline and does not call Wikipedia live.
- `backend/app/` is the FastAPI API. `app/main.py` wires routers for seasons, teams, players, games, and quiz modes. The quiz routers are mounted under `/quiz` and cover TicTacToe, Roster Guess, Higher or Lower, Career Quiz, and Photo Quiz.
- `backend/app/auth_database.py` defines the dedicated SQLAlchemy engine, `SessionLocal`, declarative Base, and `get_auth_db` dependency for mutable user data. It is controlled by `ELQ_AUTH_DATABASE_URL`, defaults locally to `sqlite:///data/users.db`, and should point at durable Azure storage such as `sqlite:////home/data/users.db` until the planned Postgres cutover. A future managed Postgres URL should use the installed psycopg driver, e.g. `postgresql+psycopg://...`.
- `backend/app/auth/` verifies Clerk session JWTs for the backend resource-server path. Configure `ELQ_CLERK_ISSUER` and `ELQ_CLERK_JWKS_URL` explicitly; `ELQ_CLERK_SECRET_KEY` is available for Clerk Backend API operations and `ELQ_CLERK_AUTHORIZED_PARTIES` optionally validates token `azp`. JWKS unknown-`kid` refreshes use per-key negative caching plus `ELQ_CLERK_JWKS_UNKNOWN_KID_MIN_REFRESH_INTERVAL_SECONDS` as a global throttle so forged random kids cannot force a network fetch per request. JWKS fetch/parse failures are service errors, not invalid-token anonymous fallback. `get_current_user` requires a valid Bearer token and JIT-provisions a local `User`; `get_optional_user` returns a `User` or `None` and must preserve anonymous gameplay on missing/invalid auth.
- `POST /auth/link-guest` requires `get_current_user` and records the signed-in user's current opaque `guest_id` in the auth datastore `user_guest_ids` table for future ratings/history attribution. It normalizes guest ids the same way gameplay services do (strip and clamp to 64 chars), is idempotent for the same user, and enforces a first-wins conflict rule with a unique `guest_id`: a different user receives `409 Conflict` and the link is not moved. The `User.guest_ids` relationship uses ORM delete-orphan cascade as the SQLite-safe cleanup path; the FK also has `ON DELETE CASCADE` for Postgres/direct-delete compatibility. This endpoint is additive only and must not change game serializers or anonymous gameplay.
- `backend/app/services/` contains quiz rules and database logic. Mutating quiz operations run through the game action seam in `backend/app/game_actions.py`, so application-layer helpers own commit/rollback and game modules stay HTTP-agnostic.
- `backend/app/services/realtime.py` is the shared Online Game Realtime Module for online TicTacToe, Roster Guess, Career Quiz, and Photo Quiz. It owns WebSocket connection cleanup, state/error envelopes, server-side turn timers, disconnect-grace timers, timer expiry, targeted broadcasts, and schema-compliant messages. TicTacToe enables disconnect-grace forfeits (`ELQ_ONLINE_DISCONNECT_GRACE_SECONDS`) and terminal `opponent_left`/`resigned` results through `backend/app/services/realtime_adapters.py`; Roster Guess, Career Quiz, and Photo Quiz keep the shared transport/timer interface without disconnect forfeits. Photo Quiz public Quick Match uses the shared timer machinery as a per-round idle timeout that auto-resolves the current public round as a no-answer skip; friend games keep cooperative mutual-skip.

The core data model uses upstream EuroLeague string codes (`euroleague_code`) for external player/team identity and integer primary keys internally. `PlayerSeasonTeam` is the central join table for player/team/season membership; `PlayerSeasonStats` hangs off it for aggregates, while `GamePlayerStats` stores per-game box score rows linked to `Game`. Career Quiz adds cached `PlayerCareerStint`, source mapping, and data revision models.
Player image/link data is stored on `players`: `euroleague_image_url` is the EuroLeague CDN headshot, `wikipedia_url` is the canonical player page, and `wikipedia_image_url` / `wikipedia_image_checked_at` are populated by the Wikipedia photo enrichment ingestion. Existing game serializers still expose a JSON key named `image_url` for frontend compatibility, sourced from `euroleague_image_url`. Photo Quiz uses players with a Wikipedia page and either a EuroLeague CDN image or Wikipedia image; its image resolver returns `euroleague_image_url` first and falls back to `wikipedia_image_url`.

The frontend is route-driven from `frontend/src/App.jsx`. Each game mode has a setup component and a board/play component. Every setup screen is composed from three shared components in `frontend/src/`: `GameSetupShell.jsx` (common chrome — Home logo, per-game accent header, canonical card, error slot, optional second card), `GameModeSelector.jsx` (controlled Solo / Local 1v1 / Online mode cards where Online expands a Create / Join sub-toggle, and which renders nothing for single-mode games like Higher or Lower), and `WaitingLobby.jsx` (the shared waiting-for-opponent screen with copy-to-clipboard join code and Cancel used by `GameBoard.jsx` and `CareerQuizBoard.jsx`; for TicTacToe it also shows a copyable shareable invite link built by `frontend/src/inviteLink.js` as `${origin}/tictactoe?join=ABC123`, and the TicTacToe setup route prefills Online → Join from that `?join=` code via `parseJoinCode` — no backend change, v1 is TicTacToe only). Setups map the canonical UI keys (`solo`/`local`/`online`, sub `create`/`join`) onto their own backend modes and keep their existing `onGameCreated`/`onGameJoined`/`onSoloRound`/`onBack` prop contracts. `frontend/src/api.js` is the single place for REST and WebSocket paths; `VITE_API_URL` controls the API base URL and `WS_BASE` is derived from it. `frontend/src/realtimeSchema.js` and `frontend/src/useOnlineGameRealtime.js` mirror the shared realtime envelope interface for reconnect, background sync, waiting-for-opponent polling, cleanup, and action dispatch. TicTacToe Quick Match setup screens can poll `GET /quiz/tictactoe/quick-match/pools` every 5 seconds for per-preset `searching` and `in_progress` counts derived from public quick-match rows. Opening `/tictactoe` defaults to Online → Quick Match (the matchmaking pool grid is the first content; Solo / Local 1v1 / Play-a-Friend stay one tap away via `GameModeSelector`, and a valid `?join=` invite instead lands on Online → Play a Friend → Join with the code prefilled). The flow is near one-click: there is no "Find Match" button — tapping a pool card in `QuickMatchPanel.jsx` immediately calls `quickMatchTicTacToe` and the board switches to `QuickMatchSearchingLobby.jsx`; a synchronous in-flight ref plus a `pendingPreset`/`disabled` state freeze every card and the mode controls so a fast multi-tap can't open several waiting games for the same guest. These are game-agnostic and built for reuse: `QuickMatchPanel.jsx` (props `presets`, `pools`, `onPick`, `disabled`, `pendingPreset`, `defaultPreset`, optional `formatPresence`), `QuickMatchSearchingLobby.jsx` (props `usePools`, `getPresetLabel`, `title` default to the TicTacToe source/copy so Photo Quiz reuses it unchanged), and `HomeQuickMatchCta.jsx` (a home-card CTA `<Link to>` rendered beside a card's main link without nesting anchors). A new game adopts Quick Match by adding a backend `MatchmakingAdapter` + presets (the engine is already generic), a frontend presets array + a pools hook from `useQuickMatchPoolsFrom(enabled, fetchPools)`, wiring its setup to `QuickMatchPanel` and its board to `QuickMatchSearchingLobby`, and a `HomeQuickMatchCta` on its home card — no shared-component changes required.

TicTacToe, Roster Guess, Career Quiz, and Photo Quiz can recover online game info from `sessionStorage`; Higher or Lower, Career Quiz solo, and Photo Quiz solo pass initial game state through router state and do not survive a hard refresh. Photo Quiz ships Solo and Online friend frontend flows at routes `/photo` (setup), `/photo/play` (solo), and `/photo/:gameId` (online), cloning the Career Quiz screens with a player photo clue (graceful fallback on image load error) instead of a career timeline; the backend lives under `/quiz/photo` and also supports public Quick Match routes `POST /quiz/photo/quick-match`, `POST /quiz/photo/quick-match/cancel`, and `GET /quiz/photo/quick-match/pools`. Photo Quiz Quick Match presets are `quick` (first-to-1), `standard` (first-to-3), and `long` (first-to-5), all with private wrong guesses; pool counts include only `is_public=true` games. Career Quiz and Photo Quiz multiplayer expose `latest_completed_round.next_round_starts_at` during the three-second reveal countdown; the backend rejects next-round guesses with `round_locked` until that UTC timestamp elapses. Career Quiz and Photo Quiz multiplayer guess and no-answer mutations must include the client-visible `round_number`; Photo Quiz no-answer responses must also include the current `pending_no_answer_offer_version` from state to prevent replaying a response against a later offer. Stale actions are rejected with `round_stale` or a conflict envelope.

`frontend/src/identity.js` owns a lightweight guest identity for online matchmaking: `getGuestId()` returns a stable opaque id generated once (via `crypto.randomUUID()` with a fallback) and cached in `localStorage` (`elq_guest_id`), and `getNickname()`/`setNickname()` persist the shared display name (`elq_nickname`, clamped to `NICKNAME_MAX_LENGTH = 30`, migrating the legacy `hol_nickname` key). `getGuestName()` returns a stable auto-generated guest name (e.g. `Guest 4821`) persisted under a separate `elq_guest_name` key (with a page-lifetime memory fallback like `getGuestId()`) so it never overwrites a deliberate nickname, and `getDisplayName()` returns `getNickname() || getGuestName()`. All storage access is `try/catch`-safe so identity degrades to anonymous play. Every setup screen prefills its name field from `getNickname()` and persists edits via `setNickname()` (not while in Local 1v1 mode, where "Player 1" is a placeholder); TicTacToe Quick Match prefills from `getDisplayName()` so online play needs no name gate, and clearing the field still sends no name so anonymous play works. `api.js` attaches `guest_id` to TicTacToe/Roster Guess/Career Quiz/Photo Quiz online `create`/`join` requests; the nickname rides the existing `player1_name`/`player_name` field. The backend persists `guest_id` as an opaque, untrusted token on `player1_guest_id`/`player2_guest_id` for TicTacToe, Roster Guess, Career Quiz, and Photo Quiz (clamped to 64 chars in the service, `None` when blank), never required and never serialized into shared game state, so anonymous play still works.

CI runs on pull requests to `main`: backend pytest, frontend Vitest, frontend build, then Playwright E2E after backend tests and build pass. Deploys from `main` run backend/frontend tests again, deploy the backend to Azure App Service and frontend to Azure Static Web Apps, then run smoke tests against the live backend.

## Key conventions

- Settings belong in `backend/app/config.py` via `pydantic-settings`; environment variables use the `ELQ_` prefix, such as `ELQ_DATABASE_URL`.
- Use `get_db` from `backend/app/database.py` for request-scoped sessions. Keep manual `SessionLocal` usage to non-request flows such as WebSocket/timer contexts.
- Add content SQLAlchemy models under `backend/app/models/`, inherit from `app.database.Base`, and re-export them from `backend/app/models/__init__.py`. Auth/user models inherit from `app.auth_database.Base` instead and use the dedicated auth Alembic environment.
- User datastore migrations live under `backend/alembic_auth/` and run with `cd backend && alembic -c alembic_auth.ini upgrade head`; keep them separate from content migrations in `backend/alembic/`. The auth schema should stay Postgres-portable: UUID string primary keys, UTC tz-aware timestamps, cross-dialect types, and no SQLite-only types or PRAGMAs.
- Add Pydantic v2 schemas under `backend/app/schemas/`; ORM-backed schemas use `model_config = {"from_attributes": True}`.
- Keep HTTP routing thin: validate request shape in schemas/routers, put quiz rules and DB mutations in services, and translate service/action exceptions to HTTP status codes in routers.
- Mount new backend domains through `app/main.py`; quiz game endpoints should stay under `/quiz/...` to match the frontend API layer.
- Mutating TicTacToe, Roster Guess, Career Quiz, and Photo Quiz HTTP endpoints use the same realtime message envelopes as WebSocket broadcasts: successful actions return `{"type":"state","payload":{...}}` and game action errors return `{"type":"error","payload":{...}}`. Read-only `GET /games/{id}` endpoints return plain game state for polling and refresh hydration.
- Online `create`/`join` requests accept an optional opaque `guest_id` (see `frontend/src/identity.js`). Keep it optional and untrusted: schemas must not reject it (no erroring `max_length`), services clamp it to 64 chars and store it on `player1_guest_id`/`player2_guest_id`, and it must never be serialized into shared game state. Anonymous play (no `guest_id`) must keep working.
- When changing API paths or payload shapes, update `frontend/src/api.js` and the matching tests in `frontend/src/test/` and/or `frontend/e2e/`.
- Frontend unit tests mock network calls at the API layer (`global.fetch` in `src/test/api.test.js`); Playwright tests exercise the real FastAPI backend and Vite dev server.
- Backend API and Higher or Lower tests use the real SQLite database at `backend/data/euroleague.db`. TicTacToe and Roster Guess API tests build isolated temporary SQLite databases; Career Quiz, Photo Quiz, and Wikipedia ingestion tests use isolated in-memory SQLite databases with seeded fixtures.
- For significant features, API changes, game mode changes, architecture changes, or workflow changes, update both `README.md` and this instructions file.
