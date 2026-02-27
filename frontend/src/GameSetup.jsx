import { useState } from "react";
import { createGame, joinGame } from "./api";

const MODES = [
  {
    value: "single_player",
    label: "Solo",
    desc: "Test your knowledge",
    icon: (
      <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" />
      </svg>
    ),
  },
  {
    value: "local_two_player",
    label: "Local 1v1",
    desc: "Same screen",
    icon: (
      <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z" />
      </svg>
    ),
  },
  {
    value: "online_friend",
    label: "Online",
    desc: "Challenge a friend",
    icon: (
      <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 0 0 8.716-6.747M12 21a9.004 9.004 0 0 1-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 0 1 7.843 4.582M12 3a8.997 8.997 0 0 0-7.843 4.582m15.686 0A11.953 11.953 0 0 1 12 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0 1 21 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0 1 12 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 0 1 3 12c0-1.605.42-3.113 1.157-4.418" />
      </svg>
    ),
  },
];

export default function GameSetup({ onGameCreated, onBack }) {
  const [mode, setMode] = useState("single_player");
  const [targetWins, setTargetWins] = useState(3);
  const [timerMode, setTimerMode] = useState("40s");
  const [player1Name, setPlayer1Name] = useState("");
  const [player2Name, setPlayer2Name] = useState("");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const [showJoin, setShowJoin] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [joinName, setJoinName] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const resp = await createGame({
        mode,
        target_wins: targetWins,
        timer_mode: timerMode,
        player1_name: player1Name || null,
        player2_name: mode !== "online_friend" ? (player2Name || null) : null,
      });
      if (mode === "online_friend") {
        onGameCreated(resp, { playerNumber: 1, isOnline: true });
      } else {
        onGameCreated(resp);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleJoin(e) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const resp = await joinGame(joinCode.toUpperCase(), joinName || null);
      onGameCreated(
        { game: resp.game },
        { playerNumber: 2, isOnline: true, gameId: resp.game_id }
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (showJoin) {
    return (
      <div className="min-h-screen flex flex-col">
        <div className="h-1 bg-gradient-to-r from-elq-orange to-elq-orange-light" />
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="w-full max-w-md animate-fade-in-up">
            <button
              onClick={() => setShowJoin(false)}
              className="mb-6 text-elq-muted hover:text-elq-text transition-colors flex items-center gap-2 text-sm font-medium"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18" />
              </svg>
              Back
            </button>

            <h1 className="font-display text-4xl tracking-wide text-elq-dark mb-8">
              JOIN GAME
            </h1>

            <div className="bg-white rounded-2xl shadow-lg shadow-black/5 border border-elq-border p-8">
              <form onSubmit={handleJoin} className="space-y-6">
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-elq-muted mb-2">
                    Game Code
                  </label>
                  <input
                    value={joinCode}
                    onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                    placeholder="ABC123"
                    maxLength={6}
                    className="w-full px-4 py-3 text-center text-2xl font-mono tracking-[0.5em] rounded-xl border-2 border-elq-border bg-elq-bg focus:border-elq-orange focus:ring-0 focus:outline-none transition-colors"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-elq-muted mb-2">
                    Your Name
                  </label>
                  <input
                    value={joinName}
                    onChange={(e) => setJoinName(e.target.value)}
                    placeholder="Enter your name"
                    className="w-full px-4 py-3 rounded-xl border-2 border-elq-border bg-elq-bg focus:border-elq-orange focus:ring-0 focus:outline-none transition-colors"
                  />
                </div>

                <button
                  type="submit"
                  disabled={loading || joinCode.length !== 6}
                  className="w-full py-3.5 px-6 bg-elq-orange text-white font-semibold rounded-xl hover:bg-elq-orange-dark active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading ? "Joining..." : "Join Game"}
                </button>

                {error && (
                  <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm text-center">
                    {error}
                  </div>
                )}
              </form>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <div className="h-1 bg-gradient-to-r from-elq-orange to-elq-orange-light" />

      <div className="flex-1 flex items-center justify-center p-4 py-8">
        <div className="w-full max-w-lg">
          {/* Back to games */}
          {onBack && (
            <div className="mb-4 animate-fade-in-up">
              <button onClick={onBack} className="text-sm text-elq-muted hover:text-elq-text transition-colors flex items-center gap-1.5">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18" />
                </svg>
                All Games
              </button>
            </div>
          )}
          {/* Header */}
          <div className="text-center mb-8 animate-fade-in-up">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-elq-orange/10 mb-4">
              <svg className="w-7 h-7 text-elq-orange" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L10 14v1c0 1.1.9 2 2 2v3.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
              </svg>
            </div>
            <h1 className="font-display text-5xl sm:text-6xl tracking-wide text-elq-dark leading-none">
              EUROLEAGUE
            </h1>
            <p className="font-display text-3xl sm:text-4xl text-elq-orange tracking-wider mt-1">
              QUIZ
            </p>
            <div className="w-12 h-0.5 bg-elq-orange mx-auto mt-4" />
          </div>

          {/* Main card */}
          <form onSubmit={handleSubmit}>
            <div
              className="bg-white rounded-2xl shadow-lg shadow-black/5 border border-elq-border p-6 sm:p-8 animate-fade-in-up"
              style={{ animationDelay: "100ms" }}
            >
              {/* Mode selector */}
              <label className="block text-xs font-semibold uppercase tracking-wider text-elq-muted mb-3">
                Game Mode
              </label>
              <div className="grid grid-cols-3 gap-3 mb-6">
                {MODES.map((m) => (
                  <button
                    key={m.value}
                    type="button"
                    onClick={() => setMode(m.value)}
                    className={`relative p-4 rounded-xl border-2 transition-all text-center ${
                      mode === m.value
                        ? "border-elq-orange bg-elq-orange/5 text-elq-orange"
                        : "border-elq-border hover:border-gray-300 text-elq-muted hover:text-elq-text"
                    }`}
                  >
                    <div className="flex justify-center mb-2">{m.icon}</div>
                    <div className="font-semibold text-sm text-elq-text">{m.label}</div>
                    <div className="text-[11px] text-elq-muted mt-0.5">{m.desc}</div>
                  </button>
                ))}
              </div>

              <div className="border-t border-elq-border my-6" />

              {/* Settings */}
              <label className="block text-xs font-semibold uppercase tracking-wider text-elq-muted mb-3">
                Settings
              </label>
              <div className="grid grid-cols-2 gap-4 mb-6">
                <div>
                  <label className="block text-sm text-elq-text mb-1.5">First to</label>
                  <select
                    value={targetWins}
                    onChange={(e) => setTargetWins(Number(e.target.value))}
                    className="w-full px-3 py-2.5 rounded-xl border-2 border-elq-border bg-elq-bg text-sm focus:border-elq-orange focus:ring-0 focus:outline-none transition-colors appearance-none cursor-pointer"
                  >
                    <option value={2}>2 wins</option>
                    <option value={3}>3 wins</option>
                    <option value={5}>5 wins</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-elq-text mb-1.5">Turn timer</label>
                  <select
                    value={timerMode}
                    onChange={(e) => setTimerMode(e.target.value)}
                    className="w-full px-3 py-2.5 rounded-xl border-2 border-elq-border bg-elq-bg text-sm focus:border-elq-orange focus:ring-0 focus:outline-none transition-colors appearance-none cursor-pointer"
                  >
                    <option value="15s">15 seconds</option>
                    <option value="40s">40 seconds</option>
                    <option value="unlimited">Unlimited</option>
                  </select>
                </div>
              </div>

              {/* Player names */}
              <div className="space-y-4 mb-8">
                <div>
                  <label className="block text-sm text-elq-text mb-1.5">
                    {mode === "online_friend" ? "Your Name" : "Player 1"}
                  </label>
                  <input
                    value={player1Name}
                    onChange={(e) => setPlayer1Name(e.target.value)}
                    placeholder="Player 1"
                    className="w-full px-4 py-2.5 rounded-xl border-2 border-elq-border bg-elq-bg focus:border-elq-orange focus:ring-0 focus:outline-none transition-colors"
                  />
                </div>
                {mode !== "online_friend" && (
                  <div>
                    <label className="block text-sm text-elq-text mb-1.5">Player 2</label>
                    <input
                      value={player2Name}
                      onChange={(e) => setPlayer2Name(e.target.value)}
                      placeholder="Player 2"
                      className="w-full px-4 py-2.5 rounded-xl border-2 border-elq-border bg-elq-bg focus:border-elq-orange focus:ring-0 focus:outline-none transition-colors"
                    />
                  </div>
                )}
              </div>

              {/* Submit */}
              <button
                type="submit"
                disabled={loading}
                className="w-full py-3.5 px-6 bg-elq-orange text-white font-bold rounded-xl hover:bg-elq-orange-dark active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed text-lg tracking-wide"
              >
                {loading
                  ? "Creating..."
                  : mode === "online_friend"
                    ? "Create Online Game"
                    : "Start Game"}
              </button>

              {error && (
                <div className="mt-4 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm text-center">
                  {error}
                </div>
              )}
            </div>
          </form>

          {/* Join link */}
          <div
            className="text-center mt-6 animate-fade-in-up"
            style={{ animationDelay: "200ms" }}
          >
            <button
              type="button"
              onClick={() => setShowJoin(true)}
              className="text-sm text-elq-muted hover:text-elq-orange transition-colors"
            >
              Have a code?{" "}
              <span className="font-semibold underline underline-offset-2">
                Join a game
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
