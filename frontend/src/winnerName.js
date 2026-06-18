/**
 * Resolve the winning player's display name, or null when the match has no
 * winner (e.g. a public quick-match tie where `winner_player` is null). Boards
 * use this so every end screen renders a consistent "<NAME> WINS!" headline and
 * falls back to "No winner" instead of incorrectly crediting Player 2.
 */
export function winnerDisplayName(game) {
  if (game?.winner_player === 1) return game.player1_name || "Player 1";
  if (game?.winner_player === 2) return game.player2_name || "Player 2";
  return null;
}
