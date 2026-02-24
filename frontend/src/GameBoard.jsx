import { useState, useEffect, useCallback, useRef } from "react";
import { getGame, submitMove, offerDraw, respondDraw, connectWebSocket } from "./api";
import PlayerSearch from "./PlayerSearch";

const CELL_COLORS = {
  1: "#4a90d9",
  2: "#e74c3c",
};

export default function GameBoard({ initialState, onNewGame, onlineInfo }) {
  const [game, setGame] = useState(initialState?.game || initialState);
  const [selectedCell, setSelectedCell] = useState(null);
  const [lastResult, setLastResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [timeLeft, setTimeLeft] = useState(null);
  const wsRef = useRef(null);

  const isOnline = onlineInfo?.isOnline;
  const myPlayer = onlineInfo?.playerNumber;

  // Connect WebSocket for online games
  useEffect(() => {
    if (!isOnline || !game?.id) return;
    const ws = connectWebSocket(game.id, myPlayer, (data) => {
      if (data.error) {
        setError(data.error);
      } else {
        setGame(data);
        setError(null);
      }
    });
    wsRef.current = ws;
    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [isOnline, game?.id, myPlayer]);

  // Poll for opponent joining while waiting
  useEffect(() => {
    if (!isOnline || game?.status !== "waiting_for_opponent") return;
    const interval = setInterval(async () => {
      try {
        const fresh = await getGame(game.id);
        if (fresh.status === "active") {
          setGame(fresh);
        }
      } catch {}
    }, 2000);
    return () => clearInterval(interval);
  }, [isOnline, game?.id, game?.status]);

  const round = game?.round;

  // Reset timer whenever the current player changes
  useEffect(() => {
    if (!game?.turn_seconds || game.status !== "active") return;
    setTimeLeft(game.turn_seconds);
  }, [game?.current_player, game?.round_number, game?.turn_seconds, game?.status]);

  // Countdown tick
  useEffect(() => {
    if (!game?.turn_seconds || game.status !== "active" || timeLeft === null) return;
    if (timeLeft <= 0) {
      if (!isOnline) {
        setGame((prev) => ({
          ...prev,
          current_player: prev.current_player === 1 ? 2 : 1,
        }));
      }
      setLastResult("⏰ Time's up! Turn switches.");
      setSelectedCell(null);
      return;
    }
    const timer = setTimeout(() => setTimeLeft((t) => t - 1), 1000);
    return () => clearTimeout(timer);
  }, [timeLeft, game?.turn_seconds, game?.status, isOnline]);

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
    // In online mode, only allow clicks on your turn
    if (isOnline && game.current_player !== myPlayer) return;
    setSelectedCell(cell);
    setError(null);
    setLastResult(null);
  }

  async function handlePlayerSelect(player) {
    if (!selectedCell) return;
    setLoading(true);
    setError(null);
    try {
      if (isOnline && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          action: "move",
          row_index: selectedCell.row_index,
          col_index: selectedCell.col_index,
          player_id: player.player_id,
        }));
      } else {
        const res = await submitMove(game.id, {
          row_index: selectedCell.row_index,
          col_index: selectedCell.col_index,
          player_id: player.player_id,
        });
        setGame(res.game);
        setLastResult(res.result);
      }
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
      if (isOnline && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ action: "offer_draw" }));
      } else {
        const res = await offerDraw(game.id);
        setGame(res.game);
        setLastResult("draw_offered");
      }
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
      if (isOnline && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ action: "respond_draw", accept }));
      } else {
        const res = await respondDraw(game.id, accept);
        setGame(res.game);
        setLastResult(accept ? "draw_accepted" : "draw_declined");
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  // Waiting for opponent screen (online host)
  if (game?.status === "waiting_for_opponent") {
    return (
      <div style={{ maxWidth: 400, margin: "60px auto", textAlign: "center" }}>
        <h2>Waiting for Opponent</h2>
        <p>Share this code with your friend:</p>
        <div
          style={{
            fontSize: 48,
            fontFamily: "monospace",
            letterSpacing: 8,
            padding: "20px 0",
            background: "#f0f0f0",
            borderRadius: 8,
            margin: "20px 0",
            userSelect: "all",
          }}
        >
          {game.join_code}
        </div>
        <p style={{ color: "#666" }}>
          The game will start automatically when they join.
        </p>
        <button onClick={onNewGame} style={{ marginTop: 20 }}>
          Cancel
        </button>
      </div>
    );
  }

  if (!game || !round) {
    return <p>Loading game...</p>;
  }

  const currentPlayerName =
    game.current_player === 1 ? game.player1_name : game.player2_name;
  const isMyTurn = !isOnline || game.current_player === myPlayer;

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
      {/* Online indicator */}
      {isOnline && (
        <div style={{ fontSize: 12, color: "#666", marginBottom: 8 }}>
          🌐 Online — You are {game.current_player === myPlayer
            ? game[`player${myPlayer}_name`]
            : game[`player${myPlayer}_name`]} (Player {myPlayer})
          {!isMyTurn && " — Waiting for opponent..."}
        </div>
      )}

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
          {game.turn_seconds && game.status === "active" && timeLeft !== null && (
            <div
              style={{
                fontSize: 22,
                fontWeight: "bold",
                marginTop: 4,
                color: timeLeft <= 5 ? "#e74c3c" : "#333",
              }}
            >
              ⏱ {timeLeft}s
            </div>
          )}
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
                  !claimed && game.status === "active" && !game.pending_draw && isMyTurn;
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
              {(!isOnline || myPlayer === game.pending_draw.respond_to) && (
                <>
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
                </>
              )}
            </div>
          ) : (
            isMyTurn && (
              <button onClick={handleOfferDraw} disabled={loading}>
                Offer Draw
              </button>
            )
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
