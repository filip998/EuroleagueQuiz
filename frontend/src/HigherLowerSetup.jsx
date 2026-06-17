import { useState, useEffect } from "react";
import { createHigherLowerGame, getHigherLowerLeaderboard } from "./api";
import { getNickname, setNickname as saveNickname } from "./identity";
import GameSetupShell from "./GameSetupShell";

const HEADER_ICON = (
  <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 7.5 7.5 3m0 0L12 7.5M7.5 3v13.5m13.5 0L16.5 21m0 0L12 16.5m4.5 4.5V7.5" />
  </svg>
);

const SEASONS = Array.from({ length: 19 }, (_, i) => 2007 + i);

const TIERS = [
  {
    value: "easy",
    label: "Easy",
    desc: "Height, age, seasons & teams",
    color: "text-emerald-600",
    bg: "bg-emerald-50",
    border: "border-emerald-200",
  },
  {
    value: "medium",
    label: "Medium",
    desc: "Points, assists, rebounds, PIR",
    color: "text-amber-600",
    bg: "bg-amber-50",
    border: "border-amber-200",
  },
  {
    value: "hard",
    label: "Hard",
    desc: "3PT, career-highs, steals, blocks",
    color: "text-red-600",
    bg: "bg-red-50",
    border: "border-red-200",
  },
];

export default function HigherLowerSetup({ onGameCreated, onBack }) {
  const [tier, setTier] = useState("easy");
  const [seasonStart, setSeasonStart] = useState(2007);
  const [seasonEnd, setSeasonEnd] = useState(2025);
  const [nickname, setNickname] = useState(() => getNickname());
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
      saveNickname(nickname);
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

  const leaderboard_card = (
    <>
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
    </>
  );

  return (
    <GameSetupShell
      accent="emerald"
      icon={HEADER_ICON}
      title="HIGHER OR LOWER"
      tagline="Who has the bigger stat? Build your streak!"
      onHome={onBack}
      error={error}
      extra={leaderboard_card}
    >
      <form onSubmit={handleSubmit}>
        <label className="block text-xs font-semibold uppercase tracking-wider text-elq-muted mb-3">
          Difficulty
        </label>
        <div className="grid grid-cols-3 gap-2 mb-6">
          {TIERS.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => setTier(t.value)}
              aria-pressed={tier === t.value}
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

        <label className="block text-xs font-semibold uppercase tracking-wider text-elq-muted mb-3">
          Player
        </label>
        <div className="mb-6">
          <input
            value={nickname}
            onChange={(e) => {
              setNickname(e.target.value);
              saveNickname(e.target.value);
            }}
            placeholder="Your nickname"
            maxLength={30}
            required
            className="w-full px-4 py-2.5 rounded-xl border-2 border-elq-border bg-elq-bg focus:border-elq-orange focus:ring-0 focus:outline-none transition-colors"
          />
        </div>

        <button
          type="submit"
          disabled={loading || !nickname.trim()}
          className="w-full py-3.5 px-6 bg-elq-orange text-white font-bold rounded-xl hover:bg-elq-orange-dark active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed text-lg tracking-wide"
        >
          {loading ? "Starting..." : "Start Game"}
        </button>
      </form>
    </GameSetupShell>
  );
}
