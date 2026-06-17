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
- **Photo Quiz** — Guess the player from a headshot. Solo practice, 2-player online friend races, and public Quick Match races, drawn from players with a Wikipedia page and either a EuroLeague CDN or Wikipedia image.

## Backend

### Setup

```bash
cd backend
pip install -e .
alembic upgrade head
alembic -c alembic_auth.ini upgrade head
```

The backend uses two separate databases. `ELQ_DATABASE_URL` points at the
tracked EuroLeague content database (`backend/data/euroleague.db`), which ships
with deployments and may be overwritten. `ELQ_AUTH_DATABASE_URL` points at the
mutable user datastore and defaults locally to `sqlite:///data/users.db`; set it
to an absolute durable path such as `sqlite:////home/data/users.db` on Azure App
Service. A later managed Postgres cutover can use a driver-qualified URL such
as `postgresql+psycopg://...`. Local `backend/data/users.db*` files are
gitignored and must not be committed.

Clerk-backed account auth is configured with `ELQ_CLERK_ISSUER` and
`ELQ_CLERK_JWKS_URL` so the backend can verify `Authorization: Bearer <token>`
session JWTs against Clerk's cached JWKS. `ELQ_CLERK_SECRET_KEY` is reserved for
Clerk Backend API operations, and `ELQ_CLERK_AUTHORIZED_PARTIES` can restrict
accepted token `azp` values. Unknown JWT `kid` refreshes are per-key cached and
globally throttled by `ELQ_CLERK_JWKS_UNKNOWN_KID_MIN_REFRESH_INTERVAL_SECONDS`
to avoid JWKS fetch amplification while still recovering from Clerk key
rotation. JWKS fetch/parse failures surface as service errors rather than
anonymous fallback. `GET /auth/me` requires a valid token and JIT-provisions a
local user in the auth datastore; existing gameplay endpoints remain open to
anonymous callers.

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

### Run Wikipedia Photo Ingestion

Photo Quiz uses cached Wikipedia infobox images for players who have a Wikipedia page but no EuroLeague CDN headshot. The image ingestion command inspects unchecked `players.wikipedia_url` rows, stores a resolved Wikimedia image URL in `wikipedia_image_url` when the basketball infobox has an image, and always sets `wikipedia_image_checked_at` for successful inspections so normal re-runs skip already checked players.

```bash
cd backend
python -m ingestion.wikipedia_images --report data/wikipedia-image-report.json
```

### API Docs

Once the server is running, visit `http://localhost:8000/docs` for the interactive API documentation.

### Architecture Notes

User account data lives in a dedicated auth datastore with its own SQLAlchemy
engine/session/Base (`backend/app/auth_database.py`) and its own Alembic
environment (`backend/alembic_auth/`, run with `alembic -c alembic_auth.ini`).
The auth schema is kept portable for a later managed Postgres move: UUIDs are
stored as strings, timestamps are normalized to UTC-aware datetimes in the
application layer, and migrations avoid SQLite-only types or PRAGMAs.

The backend acts as a Clerk resource server for authenticated requests. Auth
dependencies under `backend/app/auth/` verify Clerk session JWTs with a cached
JWKS, map the Clerk `sub` to `users.clerk_user_id`, JIT-provision missing local
users, and expose required (`get_current_user`) and additive
(`get_optional_user`) FastAPI dependencies. Invalid or absent tokens never gate
anonymous gameplay unless an endpoint explicitly opts into required auth.

Mutating quiz operations use a **Game action** seam in `backend/app/game_actions.py`.
Routers, WebSocket handlers, and timer jobs run game actions through this helper so the
application layer owns commit/rollback and game modules stay HTTP-agnostic.

Online TicTacToe, Roster Guess, Career Quiz, and Photo Quiz share an **Online Game Realtime Module**. The backend
Module in `backend/app/services/realtime.py` owns WebSocket connection cleanup,
broadcast envelopes, server-side turn timers for timer-enabled games, disconnect-grace timers,
timer expiry, targeted broadcasts, and schema-compliant error/result messages. Game-specific
Adapters in `backend/app/services/realtime_adapters.py` map TicTacToe, Roster Guess, Career
Quiz, and Photo Quiz rules into that shared Interface. TicTacToe online disconnects use a configurable
`ELQ_ONLINE_DISCONNECT_GRACE_SECONDS` window before broadcasting a terminal `opponent_left`
forfeit; explicit online resign broadcasts a terminal `resigned` result immediately.

Career Quiz adds a **Wikipedia Career Ingestion Module** under `backend/ingestion/`.
It resolves local EuroLeague players to English Wikipedia pages, parses basketball
infobox career-history rows, resolves team labels to stable keys, merges local EuroLeague
roster stints as validation/fill data, stores cached Career Timelines, and records a
Career Data Revision. Solo Career Quiz rounds use signed Solo Round Tokens so the answer
is not stored in browser state or persisted as a solo game row.
Player image/link data lives directly on `players`: EuroLeague CDN headshots are stored in
`euroleague_image_url`, Wikipedia page URLs in `wikipedia_url`, and Wikipedia infobox photo
enrichment in `wikipedia_image_url` / `wikipedia_image_checked_at`. Existing game payloads
continue to expose the frontend-compatible `image_url` JSON key for the EuroLeague image.
Photo Quiz uses those same columns for its eligible pool and resolves images CDN-first:
`euroleague_image_url` wins when present, otherwise `wikipedia_image_url` is used. Solo
Photo Quiz rounds use signed Solo Round Tokens and expose only the resolved clue image until
the answer is guessed correctly or revealed. Online Photo Quiz friend games use
`POST /quiz/photo/games`, `/games/join`, `/games/{id}/guess`, `/no-answer-offer`,
`/no-answer-response`, `GET /quiz/photo/games/{id}`, and `WS /quiz/photo/ws/{id}`;
the round clue is the resolved `image_url`. Public Photo Quiz Quick Match uses
`POST /quiz/photo/quick-match`, `POST /quiz/photo/quick-match/cancel`, and
`GET /quiz/photo/quick-match/pools` with `quick` / `standard` / `long` presets
that set first-to-1 / first-to-3 / first-to-5, keep wrong guesses private, and
server-skip idle public rounds after the per-round timeout.
Multiplayer Career Quiz and Photo Quiz resolved-round state includes
`latest_completed_round.next_round_starts_at` during the three-second reveal lock; the
backend rejects next-round guesses with `round_locked` until that UTC timestamp elapses.
Multiplayer Career Quiz and Photo Quiz guess and no-answer mutations must include the client-visible
`round_number`; Photo Quiz no-answer responses must also echo the current
`pending_no_answer_offer_version` from state so replayed responses cannot resolve a later offer.
Stale actions are rejected with `round_stale` or a conflict so the frontend can resync
without applying old input to the current round. Career Quiz and Photo Quiz multiplayer use WebSocket
push as their primary sync path, while plain `GET /quiz/{career|photo}/games/{id}` remains the
refresh and fallback-sync Interface.

The frontend mirrors that Interface with `frontend/src/realtimeSchema.js` and
`frontend/src/useOnlineGameRealtime.js`, so reconnect, background state sync,
waiting-for-opponent polling, cleanup, and action dispatch stay out of the game boards.
TicTacToe Quick Match setup screens can poll
`GET /quiz/tictactoe/quick-match/pools` every 5 seconds for per-preset
`searching` and `in_progress` presence counts derived from public pool rows.
Photo Quiz exposes the same presence shape at `GET /quiz/photo/quick-match/pools`,
counting only public Photo Quiz searches and active public matches.

Mutating TicTacToe, Roster Guess, Career Quiz, and Photo Quiz HTTP endpoints now use the same realtime
message envelopes as WebSocket broadcasts: successful actions return
`{ "type": "state", "payload": { "game": ..., "result": ..., "completed_round": ..., "terminal": ... } }`
and Game action errors return `{ "type": "error", "payload": { "code": ..., "message": ... } }`
with the corresponding HTTP status. Read-only `GET /games/{id}` endpoints still
return plain game state for polling and refresh hydration.

Online `create`/`join` requests for TicTacToe, Roster Guess, Career Quiz, and Photo Quiz accept an
optional `guest_id`. The backend treats it as an opaque, untrusted token: services clamp it
to 64 characters (`None` when blank) and persist it on the player slot
(`player1_guest_id` / `player2_guest_id`) without ever serializing it into shared game
state. The field is never required, so anonymous play keeps working when no `guest_id` is
sent.

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

### Shared Pre-Game Setup UX

Every game's pre-game screen is built from three shared building blocks in `frontend/src/`:

- `GameSetupShell.jsx` — common chrome (Home logo, per-game accent header, canonical
  card, error slot, optional second card such as the Higher or Lower leaderboard).
- `GameModeSelector.jsx` — the controlled Solo / Local 1v1 / Online mode cards. Selecting
  **Online** reveals a slim **Create / Join** sub-toggle, so joining a friend's game lives
  inside the same screen instead of a separate "join game" page. It renders nothing for
  single-mode games (Higher or Lower).
- `WaitingLobby.jsx` — the shared "waiting for opponent" screen (join code with
  copy-to-clipboard, auto-start helper text, and Cancel) used by every online board.
  For TicTacToe it also renders a copyable **shareable invite link**
  (`${origin}/tictactoe?join=ABC123`); opening that link lands on TicTacToe setup with
  the code prefilled in Online → Join, so the invitee only adds a name and joins. The
  link helpers live in `frontend/src/inviteLink.js` (`buildInviteUrl` / `parseJoinCode`).

`GameSetup.jsx` (TicTacToe), `RosterGuessSetup.jsx`, `CareerQuizSetup.jsx`,
`PhotoQuizSetup.jsx`, and `HigherLowerSetup.jsx` compose these, mapping the canonical UI
keys (`solo` / `local` / `online`, sub `create` / `join`) onto their own backend modes.

### Guest Identity

`frontend/src/identity.js` is the single source of a lightweight, persistent guest
identity used by online matchmaking:

- `getGuestId()` returns a stable opaque id generated once via `crypto.randomUUID()`
  (with a fallback) and cached in `localStorage` under `elq_guest_id`. A blank or
  oversized stored value is regenerated. All storage access is `try/catch`-safe, so
  identity degrades to anonymous play when storage is unavailable.
- `getNickname()` / `setNickname()` persist the shared display name under `elq_nickname`
  (clamped to `NICKNAME_MAX_LENGTH = 30`, the Higher or Lower backend limit), migrating
  the legacy `hol_nickname` key on first read.

Every setup screen prefills its name field from `getNickname()` and persists edits via
`setNickname()`; the shared nickname is not overwritten while a screen is in Local 1v1
mode (where "Player 1" is a placeholder rather than the user's name). `frontend/src/api.js`
attaches `guest_id` to TicTacToe, Roster Guess, and Career Quiz online `create`/`join`
requests; the nickname rides the existing `player1_name` / `player_name` field.


## Testing

### Backend (pytest)

```bash
cd backend
pytest                              # all tests (excludes smoke)
pytest tests/test_api.py            # API tests only
pytest tests/test_tictactoe_api.py  # TicTacToe tests only
pytest tests/test_higher_lower.py   # Higher or Lower tests only
pytest tests/test_career_quiz.py    # Career Quiz tests only
pytest tests/test_photo_quiz.py     # Photo Quiz tests only
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
