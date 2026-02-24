import { useState, useEffect, useCallback } from "react";
import { getGame, submitMove, offerDraw, respondDraw } from "./api";
import PlayerSearch from "./PlayerSearch";

const CELL_COLORS = {
  1: "#4a90d9",
  2: "#e74c3c",
};

export default function GameBoard({ initialState, onNewGame }) {
  const [game, setGame] = useState(initialState);
  const [selectedCell, setSelectedCell] = useState(null);
  const [lastResult, setLastResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const round = game?.round;

  const refreshGame = useCallback(async () => {
    if (!game) return;
    try {
      const fresh = await getGame(game.id);
      setGame(fresh);
    } catch (err) {
      setError(err.message);
    }
  }, [game?.id]);

  function handleCellClick(cell) {
    if (game.status !== "active") return;
    if (cell.claimed_by_player) return;
    if (game.pending_draw) return;
    setSelectedCell(cell);
    setError(null);
    setLastResult(null);
  }

  async function handlePlayerSelect(player) {
    if (!selectedCell) return;
    setLoading(true);
    setError(null);
    try {
      const res = await submitMove(game.id, {
        row_index: selectedCell.row_index,
        col_index: selectedCell.col_index,
        player_id: player.player_id,
      });
      setGame(res.game);
      setLastResult(res.result);
      setSelectedCell(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleOfferDraw() {
    setLoading(true);
    setError(null);
    try {
      const res = await offerDraw(game.id);
      setGame(res.game);
      setLastResult("draw_offered");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleRespondDraw(accept) {
    setLoading(true);
    setError(null);
    try {
      const res = await respondDraw(game.id, accept);
      setGame(res.game);
      setLastResult(accept ? "draw_accepted" : "draw_declined");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (!game || !round) {
    return <p>Loading game...</p>;
  }

  const currentPlayerName =
    game.current_player === 1 ? game.player1_name : game.player2_name;

  const resultMessages = {
    correct: "✅ Correct! Turn switches.",
    incorrect: "❌ Incorrect. Turn switches.",
    round_won: "🏆 Round won!",
    round_drawn: "🤝 Round drawn — new board!",
    match_won: "🎉 Match won!",
    draw_offered: "🤝 Draw offered.",
    draw_accepted: "🤝 Draw accepted — new board!",
    draw_declined: "Draw declined — game continues.",
  };

  return (
    <div style={{ maxWidth: 600, margin: "20px auto", textAlign: "center" }}>
      {/* Scoreboard */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 16,
          padding: "12px 20px",
          background: "#f5f5f5",
          borderRadius: 8,
        }}
      >
        <div>
          <strong style={{ color: CELL_COLORS[1] }}>{game.player1_name}</strong>
          <div style={{ fontSize: 28, fontWeight: "bold" }}>
            {game.player1_score}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 12, color: "#999" }}>
            Round {game.round_number} · First to {game.target_wins}
          </div>
          <div style={{ fontSize: 14, marginTop: 4 }}>
            {game.status === "finished"
              ? `🎉 ${game.winner_player === 1 ? game.player1_name : game.player2_name} wins!`
              : `🎯 ${currentPlayerName}'s turn`}
          </div>
        </div>
        <div>
          <strong style={{ color: CELL_COLORS[2] }}>{game.player2_name}</strong>
          <div style={{ fontSize: 28, fontWeight: "bold" }}>
            {game.player2_score}
          </div>
        </div>
      </div>

      {/* Result banner */}
      {lastResult && (
        <div
          style={{
            padding: 8,
            marginBottom: 12,
            background: "#ffffcc",
            borderRadius: 4,
          }}
        >
          {resultMessages[lastResult] || lastResult}
        </div>
      )}

      {error && (
        <div
          style={{
            padding: 8,
            marginBottom: 12,
            background: "#ffcccc",
            borderRadius: 4,
          }}
        >
          {error}
        </div>
      )}

      {/* Board */}
      <table
        style={{
          borderCollapse: "collapse",
          margin: "0 auto",
          tableLayout: "fixed",
        }}
      >
        <thead>
          <tr>
            <th style={{ width: 100 }}></th>
            {round.columns.map((col, ci) => (
              <th
                key={ci}
                style={{
                  width: 120,
                  padding: 8,
                  fontSize: 12,
                  textAlign: "center",
                  background: "#e8e8e8",
                  border: "2px solid #ccc",
                }}
              >
                {col.team_name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[0, 1, 2].map((ri) => (
            <tr key={ri}>
              <th
                style={{
                  padding: 8,
                  fontSize: 12,
                  textAlign: "center",
                  background: "#e8e8e8",
                  border: "2px solid #ccc",
                }}
              >
                {round.rows[ri].team_name}
              </th>
              {[0, 1, 2].map((ci) => {
                const cell = round.cells.find(
                  (c) => c.row_index === ri && c.col_index === ci
                );
                const claimed = cell?.claimed_by_player;
                const isClickable =
                  !claimed && game.status === "active" && !game.pending_draw;
                return (
                  <td
                    key={ci}
                    onClick={() => isClickable && handleCellClick(cell)}
                    style={{
                      width: 120,
                      height: 80,
                      border: "2px solid #ccc",
                      textAlign: "center",
                      verticalAlign: "middle",
                      cursor: isClickable ? "pointer" : "default",
                      background: claimed
                        ? CELL_COLORS[claimed] + "33"
                        : isClickable
                          ? "#fafafa"
                          : "#f5f5f5",
                      fontSize: 12,
                      fontWeight: claimed ? "bold" : "normal",
                      color: claimed ? CELL_COLORS[claimed] : "#999",
                    }}
                  >
                    {claimed
                      ? cell.claimed_player_name || `P${claimed}`
                      : ""}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      {/* Draw controls */}
      {game.status === "active" && (
        <div style={{ marginTop: 16 }}>
          {game.pending_draw ? (
            <div>
              <p>
                {game.pending_draw.offered_by === 1
                  ? game.player1_name
                  : game.player2_name}{" "}
                offers a draw.{" "}
                {game.pending_draw.respond_to === 1
                  ? game.player1_name
                  : game.player2_name}
                , do you accept?
              </p>
              <button
                onClick={() => handleRespondDraw(true)}
                disabled={loading}
                style={{ marginRight: 8 }}
              >
                Accept Draw
              </button>
              <button
                onClick={() => handleRespondDraw(false)}
                disabled={loading}
              >
                Decline
              </button>
            </div>
          ) : (
            <button onClick={handleOfferDraw} disabled={loading}>
              Offer Draw
            </button>
          )}
        </div>
      )}

      {/* New game button */}
      {game.status === "finished" && (
        <div style={{ marginTop: 20 }}>
          <button onClick={onNewGame} style={{ fontSize: 16, padding: "8px 24px" }}>
            New Game
          </button>
        </div>
      )}

      {/* Player search modal */}
      {selectedCell && (
        <PlayerSearch
          rowTeamCode={selectedCell.row_team_code}
          colTeamCode={selectedCell.col_team_code}
          onSelect={handlePlayerSelect}
          onCancel={() => setSelectedCell(null)}
        />
      )}
    </div>
  );
}
