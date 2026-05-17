# EuroLeague Quiz context

## Domain terms

### Online Game Realtime Module

The module responsible for online game transport, server-authoritative turn timing, reconnect/sync behaviour, and realtime message/result semantics for multiplayer game modes such as TicTacToe and Roster Guess.

The module should hide transport and timing details behind a small interface so game-specific rules can sit behind adapters while shared realtime behaviour remains local.
