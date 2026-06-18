# EuroLeague Quiz context

## Domain terms

### Game action

A single operation that may read or mutate game state. Examples include creating a game, joining a game, submitting a TicTacToe move, answering a Higher or Lower prompt, giving up a Guess the List round, offering a Career Quiz no-answer resolution, or applying a timer expiry.

A Game action is the unit that should cross the transaction seam: the application layer starts the action, the game module performs domain work without committing or rolling back, and the application layer commits on success or rolls back on failure. Response presentation can happen after a successful Game action commits.

### Game Action Orchestration Module

The Module that sits above the Game action transaction seam and owns Game action response envelopes plus optional post-commit realtime side effects for online TicTacToe, online Guess the List, and online Career Quiz.

The Game Action Orchestration Module keeps `run_game_action` as the transaction seam. After a Game action commits, it refreshes and serializes game state, builds the same realtime state envelope used by WebSocket broadcasts, starts or cancels online turn timers when required, and broadcasts state when required. Unexpected post-commit realtime side-effect failures are logged with exception details, but the committed state envelope still wins because the Game action cannot be rolled back after commit. Game-specific Adapters own action-name dispatch, completed-round decisions, timer decisions, and special handling for unbound actions such as create and join where no existing game is loaded before the action runs. Per-transport action allowlists are enforced at the Game Action Orchestration Module's public transport methods before dispatch enters the shared internal command path, keeping the internal Game action command transport-agnostic. WebSocket handlers support only the action-name subset valid over realtime transport; HTTP online actions require acting-player identity through the same `player` query parameter used by WebSocket connections, while local and solo modes ignore it.

### Online Game Realtime Module

The Module that owns online game realtime transport, server-authoritative turn timing for timer-enabled games, reconnect/state-sync semantics, targeted broadcasts, and realtime message/result presentation for online TicTacToe, online Guess the List, and online Career Quiz.

The Online Game Realtime Module Interface is the shared seam used by game-specific Adapters. TicTacToe, Guess the List, and Career Quiz Adapters provide game rules, state serialization, completed-round serialization, and action mapping; the shared Implementation owns WebSocket connections, broadcast cleanup, timer scheduling/cancellation when a game exposes turn timers, timer expiry, disconnect cleanup, targeted actor-only broadcasts, and schema-compliant error/result messages. This keeps realtime reliability changes local while preserving the Game action transaction seam.

### Career Quiz

A quiz where the clue is a player's professional club career timeline and the answer is the player. Career Quiz timelines come purely from pre-ingested Wikipedia career-history data; gameplay should not call Wikipedia live. EuroLeague data only decides which players are eligible — it is never merged into the displayed career.

### Career Timeline

The ordered list of professional club stints shown as the Career Quiz clue. Career Timeline entries use season-style labels, include only eligible professional club stints, and may be incomplete when Wikipedia data is incomplete.

### Eligible Career Player

A local EuroLeague player who is allowed to appear as a Career Quiz answer. An Eligible Career Player has EuroLeague game/stat data, an accepted career source mapping, and a valid Career Timeline after filtering.

### Wikipedia Career Ingestion Module

The Module that fetches, parses, audits, and caches Wikipedia career-history data for Career Quiz. Its Interface owns MediaWiki API access, infobox career-row parsing, review reporting, and the eligible-player threshold check so gameplay modules only read cached career data.

### Wikipedia Page Resolver

The Module that resolves a local EuroLeague player to an English Wikipedia page using MediaWiki data only. Its Interface owns page search, candidate-page fetching, basketball-page validation, birth-date disambiguation, disambiguation-page rejection, review statuses, and source page metadata.

### Career Team Resolver

The Module that resolves Wikipedia career team labels and wikilink targets to stable Career Timeline team keys. Its Interface owns source-controlled aliases, local EuroLeague team matching, non-EuroLeague Wikipedia team keys, and unresolved-team reporting.

### Career Timeline Builder

The Module that converts parsed Wikipedia career rows into cached Career Timeline entries. Its Interface owns Wikipedia year display (calendar-year style such as `1999–2004`), repeated-team return preservation, loan flags, and filtered-row reasons. EuroLeague roster data is not merged into the timeline.

### Solo Round Token

An opaque signed token representing a stateless solo quiz round. The token lets the backend validate a solo guess without persisting a game row or exposing the answer in the browser payload.

### Career Data Revision

A persisted marker for the current cached Career Quiz dataset. Solo Round Tokens include the Career Data Revision so stale tokens are rejected after Wikipedia career data is refreshed.
