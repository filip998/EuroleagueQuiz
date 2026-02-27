import { useState, useEffect } from "react";
import { createHigherLowerGame, getHigherLowerLeaderboard } from "./api";

const SEASONS = Array.from({ length: 23 }, (_, i) => 2003 + i);

const TIERS = [
  {
    value: "easy",
    label: "Easy",
    desc: "Height, age, seasons & teams",
    color: "text-emerald-600",
    bg: "bg-emerald-50",
    border: "border-emerald-200",
    activeBg: "bg-emerald-600",
  },
  {
    value: "medium",
    label: "Medium",
    desc: "Points, assists, rebounds, PIR",
    color: "text-amber-600",
    bg: "bg-amber-50",
    border: "border-amber-200",
    activeBg: "bg-amber-600",
  },
  {
    value: "hard",
    label: "Hard",
    desc: "3PT, career-highs, steals, blocks",
    color: "text-red-600",
    bg: "bg-red-50",
    border: "border-red-200",
    activeBg: "bg-red-600",
  },
];

export default function HigherLowerSetup({ onGameCreated, onBack }) {
  const [tier, setTier] = useState("easy");
  const [seasonStart, setSeasonStart] = useState(2003);
  const [seasonEnd, setSeasonEnd] = useState(2025);
  const [nickname, setNickname] = useState(() => localStorage.getItem("hol_nickname") || "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [leaderboard, setLeaderboard] = useState([]);
  const [lbLoading, setLbLoading] = useState(false);

  useEffect(() => {
    setLbLoading(true);
    getHigherLowerLeaderboard(tier)
      .then((data) => setLeaderboard(data.entries || []))
      .catch(() => setLeaderboard([]))
      .finally(() => setLbLoading(false));
  }, [tier]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!nickname.trim()) return;
    setError(null);
    setLoading(true);
    try {
      localStorage.setItem("hol_nickname", nickname.trim());
      const resp = await createHigherLowerGame({
        tier,
        season_range_start: seasonStart,
        season_range_end: seasonEnd,
        nickname: nickname.trim(),
      });
      onGameCreated(resp);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const activeTier = TIERS.find((t) => t.value === tier);

  return (
    <div className="min-h-screen flex flex-col">
      <div className="h-1 bg-gradient-to-r from-elq-orange to-elq-orange-light" />

      <div className="flex-1 flex items-start justify-center p-4 py-6 sm:py-10">
        <div className="w-full max-w-lg">
          {/* Header */}
          <div className="text-center mb-8 animate-fade-in-up">
            <button
              onClick={onBack}
              className="text-sm text-elq-muted hover:text-elq-text transition-colors mb-4 inline-flex items-center gap-1"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18" />
              </svg>
              Back
            </button>
            <div className="flex items-center justify-center gap-3 mb-2">
              <span className="text-3xl">⬆️</span>
              <h1 className="font-display text-4xl sm:text-5xl tracking-wide text-elq-dark">HIGHER OR LOWER</h1>
              <span className="text-3xl">⬇️</span>
            </div>
            <p className="text-elq-muted text-sm">Who has the bigger stat? Build your streak!</p>
          </div>

          <form onSubmit={handleSubmit}>
            <div className="bg-white rounded-2xl border border-elq-border shadow-sm p-5 sm:p-7 animate-fade-in-up" style={{ animationDelay: "100ms" }}>
              {/* Tier selector */}
              <label className="block text-xs font-semibold uppercase tracking-wider text-elq-muted mb-3">
                Difficulty
              </label>
              <div className="grid grid-cols-3 gap-2 mb-6">
                {TIERS.map((t) => (
                  <button
                    key={t.value}
                    type="button"
                    onClick={() => setTier(t.value)}
                    className={`relative rounded-xl border-2 p-3 text-center transition-all duration-200 ${
                      tier === t.value
                        ? `${t.border} ${t.bg} scale-[1.02] shadow-sm`
                        : "border-elq-border bg-white hover:border-elq-muted/50"
                    }`}
                  >
                    <div className={`text-sm font-bold ${tier === t.value ? t.color : "text-elq-dark"}`}>
                      {t.label}
                    </div>
                    <div className="text-[10px] text-elq-muted mt-0.5 leading-tight">{t.desc}</div>
                  </button>
                ))}
              </div>

              <div className="border-t border-elq-border my-5" />

              {/* Season range */}
              <label className="block text-xs font-semibold uppercase tracking-wider text-elq-muted mb-3">
                Season Range
              </label>
              <div className="grid grid-cols-2 gap-4 mb-6">
                <div>
                  <label className="block text-sm text-elq-text mb-1.5">From</label>
                  <select
                    value={seasonStart}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setSeasonStart(v);
                      if (v > seasonEnd) setSeasonEnd(v);
                    }}
                    className="w-full px-3 py-2.5 rounded-xl border-2 border-elq-border bg-elq-bg text-sm focus:border-elq-orange focus:ring-0 focus:outline-none transition-colors appearance-none cursor-pointer"
                  >
                    {SEASONS.map((y) => (
                      <option key={y} value={y}>{y}/{String(y + 1).slice(2)}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-elq-text mb-1.5">To</label>
                  <select
                    value={seasonEnd}
                    onChange={(e) => setSeasonEnd(Number(e.target.value))}
                    className="w-full px-3 py-2.5 rounded-xl border-2 border-elq-border bg-elq-bg text-sm focus:border-elq-orange focus:ring-0 focus:outline-none transition-colors appearance-none cursor-pointer"
                  >
                    {SEASONS.filter((y) => y >= seasonStart).map((y) => (
                      <option key={y} value={y}>{y}/{String(y + 1).slice(2)}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="border-t border-elq-border my-5" />

              {/* Nickname */}
              <label className="block text-xs font-semibold uppercase tracking-wider text-elq-muted mb-3">
                Player
              </label>
              <div className="mb-6">
                <input
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  placeholder="Your nickname"
                  maxLength={30}
                  required
                  className="w-full px-4 py-2.5 rounded-xl border-2 border-elq-border bg-elq-bg focus:border-elq-orange focus:ring-0 focus:outline-none transition-colors"
                />
              </div>

              {/* Submit */}
              <button
                type="submit"
                disabled={loading || !nickname.trim()}
                className="w-full py-3.5 px-6 bg-elq-orange text-white font-bold rounded-xl hover:bg-elq-orange-dark active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed text-lg tracking-wide"
              >
                {loading ? "Starting..." : "Start Game"}
              </button>
              {error && (
                <div className="mt-4 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm text-center">
                  {error}
                </div>
              )}
            </div>
          </form>

          {/* Leaderboard */}
          <div className="mt-6 bg-white rounded-2xl border border-elq-border shadow-sm p-5 sm:p-7 animate-fade-in-up" style={{ animationDelay: "200ms" }}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-elq-muted">
                🏆 Leaderboard — {activeTier?.label}
              </h3>
              {lbLoading && (
                <svg className="w-4 h-4 text-elq-muted animate-spin-slow" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
                </svg>
              )}
            </div>
            {leaderboard.length === 0 ? (
              <p className="text-sm text-elq-muted text-center py-4">No scores yet. Be the first!</p>
            ) : (
              <div className="space-y-1.5">
                {leaderboard.map((entry, i) => (
                  <div
                    key={i}
                    className={`flex items-center justify-between px-3 py-2 rounded-lg text-sm ${
                      i === 0
                        ? "bg-amber-50 border border-amber-200"
                        : i === 1
                          ? "bg-slate-50 border border-slate-200"
                          : i === 2
                            ? "bg-orange-50/50 border border-orange-200/50"
                            : "bg-elq-bg"
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <span className="w-6 text-center font-bold text-elq-muted text-xs">
                        {i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`}
                      </span>
                      <span className="font-medium text-elq-dark">{entry.nickname}</span>
                    </div>
                    <span className="font-bold text-elq-orange tabular-nums">{entry.streak} 🔥</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
