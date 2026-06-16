import { useState } from "react";
import { createCareerGame, createCareerSoloRound, joinCareerGame } from "./api";

export default function CareerQuizSetup({ onSoloRound, onGameCreated, onGameJoined, onBack }) {
  const [mode, setMode] = useState("solo");
  const [playerName, setPlayerName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [targetWins, setTargetWins] = useState(3);
  const [wrongGuessVisibility, setWrongGuessVisibility] = useState("private");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function start() {
    setLoading(true);
    setError("");
    try {
      if (mode === "solo") {
        onSoloRound(await createCareerSoloRound([]));
      } else if (mode === "join") {
        const state = careerGameStateFromResponse(
          await joinCareerGame(joinCode, playerName || "Player 2")
        );
        onGameJoined(state, { playerNumber: 2, isOnline: true });
      } else {
        const state = careerGameStateFromResponse(
          await createCareerGame({
            target_wins: targetWins,
            wrong_guess_visibility: wrongGuessVisibility,
            player1_name: playerName || "Player 1",
          })
        );
        onGameCreated(state, { playerNumber: 1, isOnline: true });
      }
    } catch (err) {
      setError(err.message || "Could not start Career Quiz");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col">
      <div className="h-1 bg-gradient-to-r from-elq-orange to-elq-orange-light" />
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="w-full max-w-lg bg-white rounded-3xl border border-elq-border shadow-sm p-6">
          <button onClick={onBack} className="text-sm text-elq-muted hover:text-elq-orange mb-5">
            ← Back
          </button>
          <h1 className="font-display text-4xl text-elq-dark mb-2">CAREER QUIZ</h1>
          <p className="text-sm text-elq-muted mb-6">
            Guess the player from his Wikipedia career timeline.
          </p>

          <div className="grid grid-cols-3 gap-2 mb-5">
            {[
              ["solo", "Solo"],
              ["create", "Create"],
              ["join", "Join"],
            ].map(([value, label]) => (
              <button
                key={value}
                onClick={() => setMode(value)}
                className={`py-2 rounded-xl text-sm font-bold border transition-colors ${
                  mode === value
                    ? "bg-elq-orange text-white border-elq-orange"
                    : "bg-white border-elq-border text-elq-text"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {mode !== "solo" && (
            <label className="block text-sm font-semibold text-elq-text mb-4">
              Your name
              <input
                value={playerName}
                onChange={(event) => setPlayerName(event.target.value)}
                className="mt-2 w-full px-4 py-3 rounded-xl border-2 border-elq-border bg-elq-bg focus:border-elq-orange focus:outline-none"
                placeholder={mode === "join" ? "Player 2" : "Player 1"}
              />
            </label>
          )}

          {mode === "join" && (
            <label className="block text-sm font-semibold text-elq-text mb-4">
              Join code
              <input
                value={joinCode}
                onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
                className="mt-2 w-full px-4 py-3 rounded-xl border-2 border-elq-border bg-elq-bg font-mono tracking-[0.2em] uppercase focus:border-elq-orange focus:outline-none"
                maxLength={6}
                placeholder="ABC123"
              />
            </label>
          )}

          {mode === "create" && (
            <div className="space-y-4 mb-5">
              <label className="block text-sm font-semibold text-elq-text">
                Target wins
                <select
                  value={targetWins}
                  onChange={(event) => setTargetWins(Number(event.target.value))}
                  className="mt-2 w-full px-4 py-3 rounded-xl border-2 border-elq-border bg-elq-bg focus:border-elq-orange focus:outline-none"
                >
                  {[1, 3, 5, 7].map((value) => (
                    <option key={value} value={value}>First to {value}</option>
                  ))}
                </select>
              </label>
              <label className="block text-sm font-semibold text-elq-text">
                Wrong guesses
                <select
                  value={wrongGuessVisibility}
                  onChange={(event) => setWrongGuessVisibility(event.target.value)}
                  className="mt-2 w-full px-4 py-3 rounded-xl border-2 border-elq-border bg-elq-bg focus:border-elq-orange focus:outline-none"
                >
                  <option value="private">Private</option>
                  <option value="shared">Shared</option>
                </select>
              </label>
            </div>
          )}

          {error && <p className="text-sm text-red-600 mb-4">{error}</p>}
          <button
            onClick={start}
            disabled={loading || (mode === "join" && joinCode.length !== 6)}
            className="w-full py-3 rounded-xl bg-elq-orange text-white font-bold hover:bg-elq-orange-dark disabled:opacity-50 transition-colors"
          >
            {loading ? "Starting..." : mode === "solo" ? "Start Solo" : mode === "join" ? "Join Game" : "Create Game"}
          </button>
        </div>
      </div>
    </div>
  );
}

function careerGameStateFromResponse(response) {
  return response?.state || response?.game || response;
}
