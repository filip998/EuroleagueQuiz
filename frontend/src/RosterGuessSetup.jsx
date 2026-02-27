import { useState } from "react";
import { createRosterGame, joinRosterGame } from "./api";
import { LogoMini } from "./Logo";

const MODES = [
  {
    value: "single_player",
    label: "Solo",
    desc: "Relaxed, no timer",
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

const SEASONS = Array.from({ length: 26 }, (_, i) => 2000 + i);

export default function RosterGuessSetup({ onGameCreated, onBack }) {
  const [mode, setMode] = useState("single_player");
  const [targetWins, setTargetWins] = useState(3);
  const [timerMode, setTimerMode] = useState("40s");
  const [seasonStart, setSeasonStart] = useState(2000);
  const [seasonEnd, setSeasonEnd] = useState(2025);
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
      const resp = await createRosterGame({
        mode,
        target_wins: targetWins,
        timer_mode: mode === "single_player" ? "unlimited" : timerMode,
        player1_name: player1Name || null,
        player2_name: mode === "local_two_player" ? (player2Name || null) : null,
        season_range_start: seasonStart,
        season_range_end: seasonEnd,
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
      const resp = await joinRosterGame(joinCode.toUpperCase(), joinName || null);
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
            <h1 className="font-display text-4xl tracking-wide text-elq-dark mb-8">JOIN GAME</h1>
            <div className="bg-white rounded-2xl shadow-lg shadow-black/5 border border-elq-border p-8">
              <form onSubmit={handleJoin} className="space-y-6">
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-elq-muted mb-2">Game Code</label>
                  <input value={joinCode} onChange={(e) => setJoinCode(e.target.value.toUpperCase())} placeholder="ABC123" maxLength={6} className="w-full px-4 py-3 text-center text-2xl font-mono tracking-[0.5em] rounded-xl border-2 border-elq-border bg-elq-bg focus:border-elq-orange focus:ring-0 focus:outline-none transition-colors" />
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-elq-muted mb-2">Your Name</label>
                  <input value={joinName} onChange={(e) => setJoinName(e.target.value)} placeholder="Enter your name" className="w-full px-4 py-3 rounded-xl border-2 border-elq-border bg-elq-bg focus:border-elq-orange focus:ring-0 focus:outline-none transition-colors" />
                </div>
                <button type="submit" disabled={loading || joinCode.length !== 6} className="w-full py-3.5 px-6 bg-elq-orange text-white font-semibold rounded-xl hover:bg-elq-orange-dark active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed">
                  {loading ? "Joining..." : "Join Game"}
                </button>
                {error && <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm text-center">{error}</div>}
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
          {/* Logo */}
          {onBack && (
            <div className="mb-4 animate-fade-in-up">
              <LogoMini onClick={onBack} />
            </div>
          )}
          {/* Header */}
          <div className="text-center mb-8 animate-fade-in-up">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-elq-player2/10 mb-4">
              <svg className="w-7 h-7 text-elq-player2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 0 0 3.741-.479 3 3 0 0 0-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0 1 12 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 0 1 6 18.719m12 0a5.971 5.971 0 0 0-.941-3.197m0 0A5.995 5.995 0 0 0 12 12.75a5.995 5.995 0 0 0-5.058 2.772m0 0a3 3 0 0 0-4.681 2.72 8.986 8.986 0 0 0 3.74.477m.94-3.197a5.971 5.971 0 0 0-.94 3.197M15 6.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-13.5 0a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z" />
              </svg>
            </div>
            <h1 className="font-display text-4xl sm:text-5xl tracking-wide text-elq-dark leading-none">ROSTER GUESS</h1>
            <div className="w-12 h-0.5 bg-elq-orange mx-auto mt-4" />
          </div>

          {/* Card */}
          <form onSubmit={handleSubmit}>
            <div className="bg-white rounded-2xl shadow-lg shadow-black/5 border border-elq-border p-6 sm:p-8 animate-fade-in-up" style={{ animationDelay: "100ms" }}>
              {/* Mode */}
              <label className="block text-xs font-semibold uppercase tracking-wider text-elq-muted mb-3">Game Mode</label>
              <div className="grid grid-cols-3 gap-3 mb-6">
                {MODES.map((m) => (
                  <button key={m.value} type="button" onClick={() => setMode(m.value)}
                    className={`relative p-4 rounded-xl border-2 transition-all text-center ${mode === m.value ? "border-elq-orange bg-elq-orange/5 text-elq-orange" : "border-elq-border hover:border-gray-300 text-elq-muted hover:text-elq-text"}`}
                  >
                    <div className="flex justify-center mb-2">{m.icon}</div>
                    <div className="font-semibold text-sm text-elq-text">{m.label}</div>
                    <div className="text-[11px] text-elq-muted mt-0.5">{m.desc}</div>
                  </button>
                ))}
              </div>

              <div className="border-t border-elq-border my-6" />

              {/* Season range */}
              <label className="block text-xs font-semibold uppercase tracking-wider text-elq-muted mb-3">Season Range</label>
              <div className="grid grid-cols-2 gap-4 mb-6">
                <div>
                  <label className="block text-sm text-elq-text mb-1.5">From</label>
                  <select value={seasonStart} onChange={(e) => setSeasonStart(Number(e.target.value))}
                    className="w-full px-3 py-2.5 rounded-xl border-2 border-elq-border bg-elq-bg text-sm focus:border-elq-orange focus:ring-0 focus:outline-none transition-colors appearance-none cursor-pointer"
                  >
                    {SEASONS.map((y) => <option key={y} value={y}>{y}/{String(y + 1).slice(2)}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-elq-text mb-1.5">To</label>
                  <select value={seasonEnd} onChange={(e) => setSeasonEnd(Number(e.target.value))}
                    className="w-full px-3 py-2.5 rounded-xl border-2 border-elq-border bg-elq-bg text-sm focus:border-elq-orange focus:ring-0 focus:outline-none transition-colors appearance-none cursor-pointer"
                  >
                    {SEASONS.filter((y) => y >= seasonStart).map((y) => <option key={y} value={y}>{y}/{String(y + 1).slice(2)}</option>)}
                  </select>
                </div>
              </div>

              {/* Settings */}
              <label className="block text-xs font-semibold uppercase tracking-wider text-elq-muted mb-3">Settings</label>
              {mode !== "single_player" && (
              <div className="grid grid-cols-2 gap-4 mb-6">
                <div>
                  <label className="block text-sm text-elq-text mb-1.5">First to</label>
                  <select value={targetWins} onChange={(e) => setTargetWins(Number(e.target.value))}
                    className="w-full px-3 py-2.5 rounded-xl border-2 border-elq-border bg-elq-bg text-sm focus:border-elq-orange focus:ring-0 focus:outline-none transition-colors appearance-none cursor-pointer"
                  >
                    <option value={2}>2 wins</option>
                    <option value={3}>3 wins</option>
                    <option value={5}>5 wins</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-elq-text mb-1.5">Turn timer</label>
                  <select value={timerMode} onChange={(e) => setTimerMode(e.target.value)}
                    className="w-full px-3 py-2.5 rounded-xl border-2 border-elq-border bg-elq-bg text-sm focus:border-elq-orange focus:ring-0 focus:outline-none transition-colors appearance-none cursor-pointer"
                  >
                    <option value="15s">15 seconds</option>
                    <option value="40s">40 seconds</option>
                    <option value="unlimited">Unlimited</option>
                  </select>
                </div>
              </div>
              )}

              {/* Names */}
              <div className="space-y-4 mb-8">
                <div>
                  <label className="block text-sm text-elq-text mb-1.5">{mode === "online_friend" || mode === "single_player" ? "Your Name" : "Player 1"}</label>
                  <input value={player1Name} onChange={(e) => setPlayer1Name(e.target.value)} placeholder="Player 1"
                    className="w-full px-4 py-2.5 rounded-xl border-2 border-elq-border bg-elq-bg focus:border-elq-orange focus:ring-0 focus:outline-none transition-colors" />
                </div>
                {mode === "local_two_player" && (
                  <div>
                    <label className="block text-sm text-elq-text mb-1.5">Player 2</label>
                    <input value={player2Name} onChange={(e) => setPlayer2Name(e.target.value)} placeholder="Player 2"
                      className="w-full px-4 py-2.5 rounded-xl border-2 border-elq-border bg-elq-bg focus:border-elq-orange focus:ring-0 focus:outline-none transition-colors" />
                  </div>
                )}
              </div>

              <button type="submit" disabled={loading}
                className="w-full py-3.5 px-6 bg-elq-orange text-white font-bold rounded-xl hover:bg-elq-orange-dark active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed text-lg tracking-wide"
              >
                {loading ? "Creating..." : mode === "online_friend" ? "Create Online Game" : "Start Game"}
              </button>
              {error && <div className="mt-4 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm text-center">{error}</div>}
            </div>
          </form>

          <div className="text-center mt-6 animate-fade-in-up" style={{ animationDelay: "200ms" }}>
            <button type="button" onClick={() => setShowJoin(true)} className="text-sm text-elq-muted hover:text-elq-orange transition-colors">
              Have a code? <span className="font-semibold underline underline-offset-2">Join a game</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
