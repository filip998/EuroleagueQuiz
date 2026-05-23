# EuroLeague Quiz context

## Domain terms

### Game action

A single operation that may read or mutate game state. Examples include creating a game, joining a game, submitting a TicTacToe move, answering a Higher or Lower prompt, giving up a Roster Guess round, or applying a timer expiry.

A Game action is the unit that should cross the transaction seam: the application layer starts the action, the game module performs domain work without committing or rolling back, and the application layer commits on success or rolls back on failure. Response presentation can happen after a successful Game action commits.

### Online Game Realtime Module

The Module that owns online game realtime transport, server-authoritative turn timing, reconnect/state-sync semantics, and realtime message/result presentation for online TicTacToe and online Roster Guess.

The Online Game Realtime Module Interface is the shared seam used by game-specific Adapters. TicTacToe and Roster Guess Adapters provide game rules, state serialization, completed-round serialization, and action mapping; the shared Implementation owns WebSocket connections, broadcast cleanup, timer scheduling/cancellation, timer expiry, disconnect cleanup, and schema-compliant error/result messages. This keeps realtime reliability changes local while preserving the Game action transaction seam.
