import { useState } from "react";
import { createGame } from "./api";

export default function GameSetup({ onGameCreated }) {
  const [mode, setMode] = useState("single_player");
  const [targetWins, setTargetWins] = useState(3);
  const [timerMode, setTimerMode] = useState("40s");
  const [player1Name, setPlayer1Name] = useState("");
  const [player2Name, setPlayer2Name] = useState("");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const game = await createGame({
        mode,
        target_wins: targetWins,
        timer_mode: timerMode,
        player1_name: player1Name || null,
        player2_name: player2Name || null,
      });
      onGameCreated(game);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 400, margin: "40px auto" }}>
      <h2>New TicTacToe Game</h2>
      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: 12 }}>
          <label>Mode: </label>
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="single_player">Single Player (Local)</option>
            <option value="local_two_player">Two Players (Local)</option>
            <option value="online_friend" disabled>
              Online (coming soon)
            </option>
          </select>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label>First to: </label>
          <select
            value={targetWins}
            onChange={(e) => setTargetWins(Number(e.target.value))}
          >
            <option value={2}>2 wins</option>
            <option value={3}>3 wins</option>
            <option value={5}>5 wins</option>
          </select>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label>Turn timer: </label>
          <select
            value={timerMode}
            onChange={(e) => setTimerMode(e.target.value)}
          >
            <option value="15s">15 seconds</option>
            <option value="40s">40 seconds</option>
            <option value="unlimited">Unlimited</option>
          </select>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label>Player 1 name: </label>
          <input
            value={player1Name}
            onChange={(e) => setPlayer1Name(e.target.value)}
            placeholder="Player 1"
          />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label>Player 2 name: </label>
          <input
            value={player2Name}
            onChange={(e) => setPlayer2Name(e.target.value)}
            placeholder="Player 2"
          />
        </div>

        <button type="submit" disabled={loading}>
          {loading ? "Creating..." : "Start Game"}
        </button>
        {error && <p style={{ color: "red" }}>{error}</p>}
      </form>
    </div>
  );
}
