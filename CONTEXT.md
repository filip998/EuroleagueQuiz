# EuroLeague Quiz context

## Domain terms

### Game action

A single operation that may read or mutate game state. Examples include creating a game, joining a game, submitting a TicTacToe move, answering a Higher or Lower prompt, giving up a Roster Guess round, or applying a timer expiry.

A Game action is the unit that should cross the transaction seam: the application layer starts the action, the game module performs domain work without committing or rolling back, and the application layer commits on success or rolls back on failure. Response presentation can happen after a successful Game action commits.

### Game Action Orchestration Module

The Module that sits above the Game action transaction seam and owns Game action response envelopes plus optional post-commit realtime side effects for online TicTacToe and online Roster Guess.

The Game Action Orchestration Module keeps `run_game_action` as the transaction seam. After a Game action commits, it refreshes and serializes game state, builds the same realtime state envelope used by WebSocket broadcasts, starts or cancels online turn timers when required, and broadcasts state when required. Unexpected post-commit realtime side-effect failures are logged with exception details, but the committed state envelope still wins because the Game action cannot be rolled back after commit. Game-specific Adapters own action-name dispatch, completed-round decisions, timer decisions, and special handling for unbound actions such as create and join where no existing game is loaded before the action runs. Per-transport action allowlists are enforced at the Game Action Orchestration Module's public transport methods before dispatch enters the shared internal command path, keeping the internal Game action command transport-agnostic. WebSocket handlers support only the action-name subset valid over realtime transport; HTTP online actions require acting-player identity through the same `player` query parameter used by WebSocket connections, while local and solo modes ignore it.

### Online Game Realtime Module

The Module that owns online game realtime transport, server-authoritative turn timing, reconnect/state-sync semantics, and realtime message/result presentation for online TicTacToe and online Roster Guess.

The Online Game Realtime Module Interface is the shared seam used by game-specific Adapters. TicTacToe and Roster Guess Adapters provide game rules, state serialization, completed-round serialization, and action mapping; the shared Implementation owns WebSocket connections, broadcast cleanup, timer scheduling/cancellation, timer expiry, disconnect cleanup, and schema-compliant error/result messages. This keeps realtime reliability changes local while preserving the Game action transaction seam.
