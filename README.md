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

- **TicTacToe** — Claim cells on a 3×3 board by naming players who match both the row and column clue. Clues go beyond teams: shared teammates, nationality, season, position (Guard/Forward/Center), EuroLeague champions, and stat milestones (e.g. 15+ PPG). Solo, local 1v1, and online modes. Opening `/tictactoe` lands on online **Quick Match** — a near-one-click, lichess-style pool grid — with Solo, Local 1v1, and Play-a-Friend one tap away.
- **Guess the List** — Guess rosters, champion rosters, all-time leaders, single-season leaders, All-EuroLeague First+Second Teams, and MVP/Awards windows. Solo, local/online Classic, plus online-only Race with public Quick Match and private Play-a-Friend.
- **Higher or Lower** — Compare player stats and build a streak. Easy, medium, and hard tiers with leaderboards.
- **Career Quiz** — Guess the player from a professional club career timeline built from Wikipedia. EuroLeague data only selects which players are eligible; the displayed career follows Wikipedia alone. Solo practice, 2-player online friend races, and public Quick Match races.
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
Clerk Backend API operations, `ELQ_CLERK_WEBHOOK_SECRET` verifies Clerk/Svix
webhooks, and `ELQ_CLERK_AUTHORIZED_PARTIES` can restrict accepted token `azp`
values. Unknown JWT `kid` refreshes are per-key cached and globally throttled
by `ELQ_CLERK_JWKS_UNKNOWN_KID_MIN_REFRESH_INTERVAL_SECONDS` to avoid JWKS fetch
amplification while still recovering from Clerk key rotation. JWKS fetch/parse
failures surface as service errors rather than anonymous fallback.
`GET /auth/me` requires a valid token and JIT-provisions a local user in the
auth datastore; existing gameplay endpoints remain open to anonymous callers.

Signed-in clients can call `POST /auth/link-guest` with the current opaque
`guest_id` from `frontend/src/identity.js` to claim pre-login guest activity for
future account-owned features. The backend strips and clamps the id to 64
characters, inserts a `user_guest_ids` row, and treats relinking by the same
user as an idempotent no-op. The conflict rule is **first-wins**: once any user
has linked a `guest_id`, a different user receives `409 Conflict` and the
existing link is not moved. This link is additive only; game serializers and
anonymous gameplay remain unchanged.

### Production auth deployment

Azure App Service should keep mutable account data outside the zip-deployed app
directory. Set `ELQ_AUTH_DATABASE_URL=sqlite:////home/data/users.db` and keep
`WEBSITES_ENABLE_APP_SERVICE_STORAGE=true` (or the default enabled setting) so
the `/home` mount survives restarts and deployments. Paths outside `/home` are
ephemeral on App Service Linux; the tracked content database can be redeployed,
but `users.db` must not be committed or shipped.

The backend artifact includes `backend/startup.sh`. Configure the App Service
startup command as `sh startup.sh`; it runs `pip install .`, creates SQLite
parent directories, applies both Alembic heads (`alembic upgrade head` and
`alembic -c alembic_auth.ini upgrade head`), and starts Uvicorn on Azure's
`PORT`. Running SQLite migrations at startup assumes a single App Service
instance. JWT verification is stateless, but the SQLite auth DB is the
single-instance limit; a future scale-out cutover should point
`ELQ_AUTH_DATABASE_URL` at managed Postgres, for example
`postgresql+psycopg://...`.

Set backend auth values only through App Service application settings:
`ELQ_CLERK_SECRET_KEY`, `ELQ_CLERK_WEBHOOK_SECRET`, `ELQ_CLERK_ISSUER`,
`ELQ_CLERK_JWKS_URL`, optional `ELQ_CLERK_AUTHORIZED_PARTIES`, plus
`ELQ_CORS_ORIGINS` for the Static Web App origin. The frontend deploy workflow
injects `VITE_CLERK_PUBLISHABLE_KEY` from a GitHub secret at build time; leaving
it unset intentionally ships a fully anonymous build. Before enabling production
sign-in, configure the Clerk Dashboard for required unique usernames, session
token claims, passkeys, and the OAuth applications for Google, Apple, and
Microsoft. See [`docs/clerk-auth.md`](docs/clerk-auth.md) and
[`docs/azure-deploy.md`](docs/azure-deploy.md).

### Run API Server

```bash
cd backend
uvicorn app.main:app --reload
```

### TicTacToe latency instrumentation

Set `ELQ_TICTACTOE_TIMING_ENABLED=true` to emit TicTacToe create/move
`Server-Timing` headers and structured `tictactoe_timing` logs with phase
durations for board generation, move validation, commit, and response
serialization. Setting the TicTacToe router logger to DEBUG records the same
structured logs locally without exposing `Server-Timing` headers to clients; it
is off by default.

TicTacToe board generation caches static reference data per backend process and
warms the cache on API startup. Warm board generation is in-memory selection plus
precomputed cell-validity lookups; after a content database refresh, restart the
backend process or call `reset_board_cache()` before serving new boards.

Run the dependency-light board-generation benchmark from `backend/`:

```bash
.venv/bin/python benchmarks/tictactoe_latency.py --concurrency 5 --repeats 5
```

The initial local baseline is recorded in
[`docs/tictactoe-latency-baseline.md`](docs/tictactoe-latency-baseline.md).

### Run Data Ingestion

```bash
cd backend
python -m ingestion.ingest --start-season 2000 --end-season 2025
python -m ingestion.ingest --step stat-milestones
python -m ingestion.ingest --step champions --start-season 2000 --end-season 2025
python -m ingestion.ingest --step all-euroleague --start-season 2000 --end-season 2025
python -m ingestion.ingest --step player-awards --start-season 2000 --end-season 2025
```

The aggregate ingestion path refreshes TicTacToe stat-milestone eligibility after
season stats are rebuilt. `--step stat-milestones` reruns only that derived-table
precompute when raw `player_season_stats` / `game_player_stats` data already
exists.

`--step champions` refreshes curated EuroLeague champion teams and title-squad
flags in `seasons.champion_team_id` and `player_season_teams.is_champion`.
Guess the List Champions rounds use those existing flags as champion-roster
lists with roster hints; the tracked database currently has 24 playable champion
seasons from 2000-2025, excluding canceled 2019-20 and the curated 2025-26
champion until title-roster rows are ingested.

`--step all-euroleague` refreshes review-gated All-EuroLeague Team selections
from the Wikipedia API into `award_data_revisions` and
`player_award_selections`. Reviewed player/team aliases live in
`backend/ingestion/all_euroleague_overrides.json`; the active tracked database
ships First+Second Team rounds for 25 awarded seasons (2000-2025, excluding the
unawarded 2019-20 season). After running this ingestion or any migration
locally, include the intentional `backend/data/euroleague.db` change in the PR
and upload it to Azure before deploying.

`--step player-awards` refreshes review-gated Regular Season MVP and Final Four
MVP winners from the Wikipedia API into the same award revision tables. Gameplay
uses active accepted rows as unique-winner windows: 7 awarded seasons for
Regular Season MVP and 10 awarded seasons for Final Four MVP, with repeated
winners collapsed into one answer slot and reveal details listing the winning
season(s). The 2019-20 canceled season is stored as intentionally not awarded;
the 2000-01 Final Four source excludes the SuproLeague row and uses the local
EuroLeague Finals MVP row.

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
`POST /auth/link-guest` is one such required-auth endpoint; it records
`guest_id` ownership in `user_guest_ids` for future ratings/history attribution,
using a first-wins unique `guest_id` rule and delete-orphan cascade from
`users`.

Mutating quiz operations use a **Game action** seam in `backend/app/game_actions.py`.
Routers, WebSocket handlers, and timer jobs run game actions through this helper so the
application layer owns commit/rollback and game modules stay HTTP-agnostic.

TicTacToe stat-milestone clue eligibility is precomputed in
`quiz_ttt_stat_milestone_players` by
`backend/app/services/tictactoe_stat_milestones.py` and refreshed from ingestion
after aggregate stats, or directly with `python -m ingestion.ingest --step
stat-milestones`. Shipped thresholds are EuroLeague-calibrated and must keep at
least 40 eligible players: 15+ PPG, 6+ RPG, 5+ APG, and 15+ PIR season averages
with a 10-game minimum, plus 30+ points in one game and 1,000+ EuroLeague career
points summed from `player_season_stats`. The 3,000-point legend tier is defined
for future use but not shipped as an axis because its pool is below the guard.

Online TicTacToe, Guess the List, Career Quiz, and Photo Quiz share an **Online Game Realtime Module**. The backend
Module in `backend/app/services/realtime.py` owns WebSocket connection cleanup,
broadcast envelopes, server-side turn timers for timer-enabled games, disconnect-grace timers,
timer expiry, targeted broadcasts, and schema-compliant error/result messages. Game-specific
Adapters in `backend/app/services/realtime_adapters.py` map TicTacToe, Guess the List, Career
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
the round clue is the resolved `image_url`. Public Career Quiz Quick Match uses
`POST /quiz/career/quick-match`, `POST /quiz/career/quick-match/cancel`, and
`GET /quiz/career/quick-match/pools` with `quick` / `standard` / `long`
presets that set first-to-1 / first-to-3 / first-to-5, keep wrong guesses
private, hide public join codes, and server-skip idle public rounds after 20
seconds. Public Photo Quiz Quick Match uses
`POST /quiz/photo/quick-match`, `POST /quiz/photo/quick-match/cancel`, and
`GET /quiz/photo/quick-match/pools` with `quick` / `standard` / `long` presets
that set first-to-1 / first-to-3 / first-to-5, keep wrong guesses private, allow
a mutual "Nobody knows" offer/accept to skip early, and server-skip idle public
rounds after the per-round timeout when players do not agree.
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
Guess the List Race also requires the client-visible `round_number` on claims and uses
`latest_completed_round.next_round_starts_at` for its 12-second full-roster reveal lock
between simultaneous 120-second claim rounds. Race friend games use
`POST /quiz/guess-the-list/race/games`, `/race/games/join`,
`POST /quiz/guess-the-list/games/{id}/guess`, `GET /quiz/guess-the-list/games/{id}`,
and `WS /quiz/guess-the-list/ws/{id}`; public quick-match games hide join codes and
can only be joined through the matchmaking path.

The frontend mirrors that Interface with `frontend/src/realtimeSchema.js` and
`frontend/src/useOnlineGameRealtime.js`, so reconnect, background state sync,
waiting-for-opponent polling, cleanup, and action dispatch stay out of the game boards.
TicTacToe Quick Match setup screens can poll
`GET /quiz/tictactoe/quick-match/pools` every 5 seconds for per-preset
`searching` and `in_progress` presence counts derived from public pool rows.
Career Quiz and Photo Quiz expose the same presence shape at
`GET /quiz/career/quick-match/pools` and `GET /quiz/photo/quick-match/pools`,
counting only public searches and active public matches. Guess the List Race
does the same under `GET /quiz/guess-the-list/quick-match/pools`; public Race entries
are created with `POST /quiz/guess-the-list/quick-match`, cancelled with
`POST /quiz/guess-the-list/quick-match/cancel`, and use presets
`quick`, `standard`, and `long` (first-to-1/2/3). Those length-only pools
intentionally remove era selection; each public Race round randomizes among
roster, all-time leaderboard, and single-season leaderboard lists.

Mutating TicTacToe, Guess the List, Career Quiz, and Photo Quiz HTTP endpoints now use the same realtime
message envelopes as WebSocket broadcasts: successful actions return
`{ "type": "state", "payload": { "game": ..., "result": ..., "completed_round": ..., "terminal": ... } }`
and Game action errors return `{ "type": "error", "payload": { "code": ..., "message": ... } }`
with the corresponding HTTP status. Read-only `GET /games/{id}` endpoints still
return plain game state for polling and refresh hydration.

Online `create`/`join` requests for TicTacToe, Guess the List, Career Quiz, and Photo Quiz accept an
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

### Home page & UI variant (Refined Light)

The home page ships in two interchangeable variants, selected once at build time
by the `VITE_UI_VARIANT` environment variable and resolved in
`frontend/src/uiVariant.js`:

- **`refined`** *(default)* — the "Refined Light" home: a centered hero
  (`HOW WELL DO YOU KNOW THE EUROLEAGUE?`), a static stat strip, and a
  `Choose your game` lobby with a flagship **Tic-Tac-Toe** card beside a 2×2 grid
  of the four other modes. The lobby has one clear action hierarchy: the flagship
  carries the single filled primary CTA — **Quick Match** (qualified as online 1v1 by
  adjacent helper copy) plus a low-emphasis `Solo · Local · Friend →` text link — while
  the four mini cards use calm, low-emphasis **Play →** links that open each game's
  setup on its **Solo** default (Quick Match is then one tap away inside setup). Each
  card keeps its existing route, `HomeQuickMatchCta` / `HomePlayCta`, and test IDs.
- **`classic`** — the original flat five-card grid, preserved pixel-for-pixel. Set
  `VITE_UI_VARIANT=classic` (e.g. in `frontend/.env.development` or the deploy build)
  to fall back instantly with no code change.

`App.jsx` exposes `HomePageClassic`, `HomePageRefined`, and a `HomePage({ variant })`
selector (defaulting to `UI_VARIANT`) so the route stays `<HomePage />` and tests can
render either variant deterministically. `main.jsx` writes the active variant to
`document.documentElement.dataset.ui` at boot.

**Accessible color tokens.** The refined variant darkens shared tokens in
`frontend/src/index.css` to meet WCAG AA, scoped under a higher-specificity
`html[data-ui="refined"]` block so the classic defaults in `@theme` are untouched:

- `--color-elq-muted` → `#566677` (≈5.9:1 on white, ≈5.5:1 on `--color-elq-bg`) for
  body/label/placeholder text.
- New `--color-elq-cta` / `--color-elq-cta-dark` drive the primary-CTA fill; the
  refined variant points them at `#C2410C` / `#9A3412` so white button text clears AA
  (≈5.2:1), while classic maps them to the original `#FF6600` / `#E85D00`. The shared
  `HomeQuickMatchCta` / `HomePlayCta` use these tokens two ways via an `emphasis` prop:
  the default `primary` is the filled `bg-elq-cta` button, and `quiet` is a low-emphasis
  `text-elq-cta` accent text link (no fill) — `#C2410C` clears AA as body text too
  (≈5.2:1).

A `prefers-reduced-motion: reduce` guard disables the entrance reveals
(`.animate-fade-in-up`, `.animate-slide-down`) without ever gating content visibility.

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

`GameSetup.jsx` (TicTacToe), `GuessTheListSetup.jsx`, `CareerQuizSetup.jsx`,
`PhotoQuizSetup.jsx`, and `HigherLowerSetup.jsx` compose these, mapping the canonical UI
keys (`solo` / `local` / `online`, sub `create` / `join`) onto their own backend modes.

### TicTacToe Quick Match: default landing + one-click pooling

Opening `/tictactoe` lands directly on **Online → Quick Match**, so the matchmaking pool
grid — directly below the standardized **Your Name** field — is the first interactive content
players see (Solo, Local 1v1, and Play-a-Friend stay one tap away
via `GameModeSelector`; a valid `?join=` invite still lands on Online → Play a Friend →
Join with the code prefilled). The flow is near one-click — there is **no separate "Find
Match" button**. Tapping a pool card *is* the action: it immediately enters that pool and
the board switches to the searching lobby. Standard (Best of 3 · 40s) is highlighted as the
default. There is no name gate — the optional name field prefills with the saved nickname or
a stable auto-generated guest name, and clearing it falls back to anonymous play. While a
pick is in flight every pool card (and the mode controls) freeze, so a fast multi-tap can't
open several waiting games for the same guest. The home TicTacToe card also carries a
visible **Quick Match** call-to-action that jumps straight into the same default.

These pieces are built game-agnostic so other games can adopt Quick Match by mirroring the
shared-component pattern:

- `QuickMatchPanel.jsx` — the reusable one-click pool grid. Props: `presets`, live `pools`
  presence, `onPick(presetKey)`, `disabled`, `pendingPreset`, `defaultPreset`, `label`, and
  an optional `formatPresence`. It carries no game specifics.
- `QuickMatchSearchingLobby.jsx` — the generalized "searching the pool…" lobby. `usePools`,
  `getPresetLabel`, and `title` are props (defaulting to the TicTacToe pool source/copy), so
  Career Quiz and Photo Quiz reuse it with their own pool feeds and labels.
- `HomeQuickMatchCta.jsx` — the reusable home-card CTA `<Link>` (pass the setup route in
  `to`); it sits beside a card's main link without nesting anchors. An `emphasis` prop
  selects the filled primary button (`primary`, default) or a low-emphasis accent text
  link (`quiet`); `HomePlayCta` is the same component with a "Play" label and play icon.
- `identity.js` `getGuestName()` / `getDisplayName()` — the guest-name fallback (see Guest
  Identity below).

**Extension checklist** — a new game adopts Quick Match by adding: (1) a backend
`MatchmakingAdapter` + presets (the matchmaking engine is already generic); (2) a frontend
presets array plus a pools hook built from `useQuickMatchPoolsFrom(enabled, fetchPools)`;
(3) wiring its setup screen to `QuickMatchPanel` (one-click) and its board to
`QuickMatchSearchingLobby`; and (4) a `HomeQuickMatchCta` on its home card. No new
shared-component code is required.

### Guess the List Race Quick Match

Guess the List keeps Solo, Local 1v1, and Online as its top-level setup choices. Inside
Online, players choose **Classic** (the existing turn-based Create/Join flow) or **Race**.
Race is online-only: both players see the same list and claim players simultaneously,
with each player awarded to the first competitor to name them. Friend races use the
selected list type and season range; public Quick Match races use length-only pools
and randomize each round among roster, all-time leaderboard, and single-season
leaderboard lists. The round ends when the 120-second timer expires or the full list is
claimed; higher claim count wins the round, ties award no point, and non-terminal rounds
reveal the full list for 12 seconds before the next one unlocks.

Race reuses the shared Quick Match components: `/list?quick=1` opens Online → Race →
Quick Match (the refined home card's calm **Play →** link opens Solo, while the
`?quick=1` deep link and the classic home card still jump to Race Quick Match), and the
board uses
`QuickMatchSearchingLobby` for public pool searches. Race also supports private
Play-a-Friend Create/Join inside the Race tab; Classic online remains unchanged.

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
- `getGuestName()` returns a stable, auto-generated guest name (e.g. `Guest 4821`) persisted
  under `elq_guest_name` (separate from `elq_nickname`, so it never overwrites a deliberate
  nickname) with a page-lifetime memory fallback like `getGuestId()`. `getDisplayName()`
  returns the saved nickname when set, otherwise that guest name — this is what the
  near-one-click TicTacToe Quick Match prefills so online play needs no name gate.

Every setup screen renders the same shared **`frontend/src/NameField.jsx`** for the player
name — one **"Your Name"** label, one `"Your name"` placeholder, one optional (never
required) rule, a `NICKNAME_MAX_LENGTH` cap, and one position **above** the pool grid / match
settings (Higher or Lower, which has no pools, puts it at the top of the form). It is
prefilled from `getDisplayName()` (the saved nickname, otherwise a stable guest name) so the
field is never empty and there is no name gate, and edits persist via `setNickname()`. The
shared nickname is not overwritten while a screen is in Local 1v1 mode, where the same
component is reused with "Player 1" / "Player 2" labels rather than the user's name. Higher
or Lower no longer hard-requires the field: a blank name falls back to the stable guest name
on submit, so its leaderboard still receives a value while the input stays optional. For the
other games, clearing the field sends no name, so anonymous play keeps working.
`frontend/src/api.js` attaches `guest_id` to TicTacToe, Roster
Guess, Career Quiz, and Photo Quiz online `create`/`join` requests; the nickname rides the
existing `player1_name` / `player_name` field.

### Account Auth (Clerk, frontend)

Sign-in is **purely additive** and built on Clerk's prebuilt components, so anonymous play
keeps working with zero friction. The integration is isolated to a few modules:

- `frontend/src/auth.jsx` is the **only** module that imports `@clerk/clerk-react`. It exposes
  `AuthProvider` (wraps the app in `<ClerkProvider>` when `VITE_CLERK_PUBLISHABLE_KEY` is set,
  otherwise renders children unchanged; when enabled it also wires Clerk's `routerPush`/
  `routerReplace` to react-router so path-routed surfaces navigate the SPA softly), `AuthMenu`
  (a fixed header control showing Sign in / Sign up when signed out and `<UserButton/>` with a
  custom **Profile** menu link when signed in), `ProfileRoute` (the `/profile/*` page — see
  below), and a future-use `RequireAuth` stub for protected routes. When the publishable key is
  missing the whole thing is inert: no provider mounts, no token is issued, `AuthMenu` renders
  nothing, `ProfileRoute` redirects home, and a one-line dev `console.info` notes sign-in is off.
- `frontend/src/authToken.js` is a tiny, framework-free token registry
  (`setAuthTokenProvider` / `clearAuthTokenProvider` / `getAuthToken`). It decouples `api.js`
  from Clerk: `api.js` simply `await getAuthToken()` in `request()` and adds an
  `Authorization: Bearer …` header **only when a token is present**. The Clerk bridge registers
  a provider only while signed in and the effect cleanup clears it on sign-out, so signed-out
  REST calls structurally cannot attach a token. `getAuthToken()` also races the provider
  against a timeout and swallows errors to `null`, so token trouble never breaks a request.
- `frontend/src/identityBridge.js` bridges Clerk into a neutral `AuthContext` (default
  "signed out", so setup screens and unit tests render with no provider). `resolveDisplayName`
  is the pure precedence rule — Clerk `username` → `fullName` → `firstName`, clamped to
  `NICKNAME_MAX_LENGTH`, never the email address — falling back to the guest value.
  `useClerkPrefilledName(getFallback)` is the hook every setup screen uses for its name field:
  it seeds from the guest fallback, upgrades to the Clerk name once it loads (via the
  "adjust state while rendering" pattern, no effect), and never clobbers a value the user has
  typed — so the Local 1v1 "Player 1" placeholder and manual edits are preserved.
- After sign-in the bridge makes a **best-effort** `POST /auth/link-guest` (with the Bearer
  token and the current `getGuestId()`), once per `(user, guest)` pair. It fetches the token
  first and bails if absent, only marks the pair linked on success (so a transient failure
  retries on a later mount), and swallows all failures so a missing or briefly-unavailable
  endpoint never blocks sign-in.

- The **profile view** lives at the `/profile/*` route (`ProfileRoute` in `auth.jsx`, lazily
  imported by `App.jsx` so `App` stays Clerk-free). It renders Clerk's prebuilt `<UserProfile/>`
  (path-routed) inside the app chrome, surfacing username, email, display name, and avatar, and is
  reachable from the `<UserButton/>` menu's **Profile** link. Signed-out visitors and key-less
  builds are redirected home, so deep links never strand anyone on an empty page.
- **Required unique username:** new sign-ups (email **and** social) must set a unique username —
  this is a Clerk Dashboard setting, and a session-token claim makes the backend mirror it onto the
  local `User` on first provision. The signed-in username then flows into every setup screen's name
  field via `useClerkPrefilledName`. See [`docs/clerk-auth.md`](docs/clerk-auth.md) for the exact
  dashboard steps.

Set `VITE_CLERK_PUBLISHABLE_KEY` in `frontend/.env.development` for local sign-in or as the
GitHub Actions secret consumed by `deploy.yml`; leave it blank for fully anonymous builds.


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
2. **Merge to `main`** → `deploy.yml` runs: tests again as a gate → deploys backend to Azure App Service + frontend to Azure Static Web Apps → App Service startup applies content/auth migrations → post-deploy smoke tests verify the live API.

**Do not push directly to `main`.** Always use a pull request so CI checks run first.
