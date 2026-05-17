# EuroLeague Quiz context

## Domain terms

### Game action

A single operation that may read or mutate game state. Examples include creating a game, joining a game, submitting a TicTacToe move, answering a Higher or Lower prompt, giving up a Roster Guess round, or applying a timer expiry.

A Game action is the unit that should cross the transaction seam: the application layer starts the action, the game module performs domain work without committing or rolling back, and the application layer commits on success or rolls back on failure. Response presentation can happen after a successful Game action commits.
