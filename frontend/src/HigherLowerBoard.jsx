import { useState } from "react";
import { submitHigherLowerAnswer } from "./api";
import { LogoMini } from "./Logo";

// Country code mapping for flag emojis
const COUNTRY_FLAGS = {
  "United States of America": "🇺🇸", "Spain": "🇪🇸", "Italy": "🇮🇹", "Serbia": "🇷🇸",
  "France": "🇫🇷", "Greece": "🇬🇷", "Turkiye": "🇹🇷", "Lithuania": "🇱🇹",
  "Germany": "🇩🇪", "Russian Federation": "🇷🇺", "Croatia": "🇭🇷", "Slovenia": "🇸🇮",
  "Israel": "🇮🇱", "Poland": "🇵🇱", "Senegal": "🇸🇳", "Australia": "🇦🇺",
  "Argentina": "🇦🇷", "Brazil": "🇧🇷", "Canada": "🇨🇦", "United Kingdom": "🇬🇧",
  "Montenegro": "🇲🇪", "North Macedonia": "🇲🇰", "Bosnia and Herzegovina": "🇧🇦",
  "Georgia": "🇬🇪", "Latvia": "🇱🇻", "Estonia": "🇪🇪", "Finland": "🇫🇮",
  "Czech Republic": "🇨🇿", "Czechia": "🇨🇿", "Nigeria": "🇳🇬", "Cameroon": "🇨🇲",
  "Congo": "🇨🇬", "Angola": "🇦🇴", "Portugal": "🇵🇹", "Belgium": "🇧🇪",
  "Netherlands": "🇳🇱", "Sweden": "🇸🇪", "Ukraine": "🇺🇦", "Japan": "🇯🇵",
  "China": "🇨🇳", "Korea": "🇰🇷", "Dominican Republic": "🇩🇴", "Puerto Rico": "🇵🇷",
  "Venezuela": "🇻🇪", "Mexico": "🇲🇽", "Egypt": "🇪🇬", "Tunisia": "🇹🇳",
  "Morocco": "🇲🇦", "Mali": "🇲🇱", "Guinea": "🇬🇳", "Ivory Coast": "🇨🇮",
  "Cote d'Ivoire": "🇨🇮", "Romania": "🇷🇴", "Bulgaria": "🇧🇬", "Hungary": "🇭🇺",
  "Austria": "🇦🇹", "Switzerland": "🇨🇭", "Denmark": "🇩🇰", "Norway": "🇳🇴",
  "Ireland": "🇮🇪", "Albania": "🇦🇱", "Kosovo": "🇽🇰", "Slovakia": "🇸🇰",
  "New Zealand": "🇳🇿", "Jamaica": "🇯🇲", "Bahamas": "🇧🇸", "Haiti": "🇭🇹",
  "Trinidad and Tobago": "🇹🇹", "U.S. Virgin Islands": "🇻🇮", "Guadeloupe": "🇬🇵",
  "Martinique": "🇲🇶", "Cape Verde": "🇨🇻", "Cabo Verde": "🇨🇻", "Gabon": "🇬🇦",
  "Central African Republic": "🇨🇫", "South Sudan": "🇸🇸", "Democratic Republic of the Congo": "🇨🇩",
  "Republic of the Congo": "🇨🇬", "Chad": "🇹🇩", "Belarus": "🇧🇾",
};

function getFlag(nationality) {
  if (!nationality) return "🌍";
  return COUNTRY_FLAGS[nationality] || "🌍";
}

function formatValue(v) {
  if (v == null) return "—";
  return Number.isInteger(v) ? v.toString() : v.toFixed(1);
}

export default function HigherLowerBoard({ initialState, onNewGame, onHome }) {
  const [gameId] = useState(initialState.game_id);
  const [pair, setPair] = useState(initialState.pair);
  const [streak, setStreak] = useState(0);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null); // { correct, left_value, right_value, choice }
  const [gameOver, setGameOver] = useState(null); // { streak, is_personal_best, leaderboard_position }
  const [animating, setAnimating] = useState(false);

  async function handleChoice(choice) {
    if (loading || result || gameOver) return;
    setLoading(true);
    try {
      const res = await submitHigherLowerAnswer(gameId, choice);
      setResult({
        correct: res.correct,
        left_value: res.left_value,
        right_value: res.right_value,
        choice,
      });

      if (res.correct) {
        setStreak(res.streak);
        // Brief reveal, then transition to next pair
        setAnimating(true);
        setTimeout(() => {
          setPair(res.next_pair);
          setResult(null);
          setAnimating(false);
        }, 1500);
      } else {
        setStreak(res.streak);
        setGameOver({
          streak: res.streak,
          is_personal_best: res.is_personal_best,
          leaderboard_position: res.leaderboard_position,
        });
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }

  // Game over screen
  if (gameOver && result) {
    return (
      <div className="min-h-screen flex flex-col">
        <div className="h-1 bg-gradient-to-r from-elq-orange to-elq-orange-light" />
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="text-center animate-fade-in-up max-w-md w-full">
            <div className="text-6xl mb-4">
              {gameOver.streak === 0 ? "😬" : gameOver.streak < 5 ? "👏" : gameOver.streak < 10 ? "🔥" : "🏆"}
            </div>
            <h2 className="font-display text-5xl text-elq-dark mb-2">GAME OVER</h2>
            <p className="text-elq-muted text-lg mb-6">
              {gameOver.streak === 0 ? "Better luck next time!" : `${gameOver.streak} correct in a row!`}
            </p>

            {/* Last answer reveal */}
            <div className="bg-white rounded-2xl border border-red-200 p-4 mb-6">
              <div className="text-xs text-elq-muted uppercase tracking-wider mb-3">{pair.category_label}</div>
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1 text-center">
                  <div className="text-lg font-semibold text-elq-dark">{pair.left.name}</div>
                  <div className="text-2xl font-bold text-elq-dark mt-1">{formatValue(result.left_value)}</div>
                </div>
                <div className="text-elq-muted text-sm font-medium">vs</div>
                <div className="flex-1 text-center">
                  <div className="text-lg font-semibold text-elq-dark">{pair.right.name}</div>
                  <div className="text-2xl font-bold text-elq-dark mt-1">{formatValue(result.right_value)}</div>
                </div>
              </div>
            </div>

            {/* Stats */}
            <div className="space-y-2 mb-8">
              {gameOver.is_personal_best && gameOver.streak > 0 && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-2 text-sm font-semibold text-amber-700">
                  🎉 New Personal Best!
                </div>
              )}
              {gameOver.leaderboard_position <= 10 && gameOver.streak > 0 && (
                <div className="bg-elq-orange/10 border border-elq-orange/20 rounded-xl px-4 py-2 text-sm font-semibold text-elq-orange">
                  🏆 #{gameOver.leaderboard_position} on the Leaderboard!
                </div>
              )}
            </div>

            <div className="flex gap-3 justify-center">
              <button
                onClick={onNewGame}
                className="px-8 py-3 bg-elq-orange text-white font-bold rounded-xl hover:bg-elq-orange-dark active:scale-[0.98] transition-all text-lg"
              >
                Play Again
              </button>
              {onHome && (
                <button
                  onClick={onHome}
                  className="px-8 py-3 bg-white border border-elq-border text-elq-text font-bold rounded-xl hover:bg-elq-bg transition-all"
                >
                  Home
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const showValues = !!result;

  return (
    <div className="min-h-screen flex flex-col">
      {/* Orange accent */}
      <div className="h-1 bg-gradient-to-r from-elq-orange to-elq-orange-light" />

      {/* Header */}
      <div className="bg-white border-b border-elq-border">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between">
          <LogoMini onClick={onHome || onNewGame} />
          <span className="font-display text-lg tracking-wide text-elq-dark">
            HIGHER OR LOWER
          </span>
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-bold text-elq-orange tabular-nums">{streak}</span>
            <span className="text-sm">🔥</span>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col items-center justify-center px-4 py-6 sm:py-10 max-w-2xl mx-auto w-full">
        {/* Category label */}
        <div className="mb-6 text-center animate-fade-in-up">
          <div className="inline-flex items-center gap-2 bg-white border border-elq-border rounded-full px-5 py-2 shadow-sm">
            <span className="text-xs font-semibold uppercase tracking-wider text-elq-muted">
              Who has more
            </span>
            <span className="text-sm font-bold text-elq-dark">{pair.category_label}</span>
            <span className="text-xs font-semibold uppercase tracking-wider text-elq-muted">?</span>
          </div>
        </div>

        {/* Two cards */}
        <div className={`w-full grid grid-cols-2 gap-4 sm:gap-6 mb-8 ${animating ? "opacity-50 transition-opacity duration-300" : ""}`}>
          {/* Left card */}
          <button
            type="button"
            onClick={() => handleChoice("left")}
            disabled={loading || !!result}
            className={`group relative bg-white rounded-2xl border-2 p-5 sm:p-7 text-center transition-all duration-300 ${
              result
                ? result.left_value >= result.right_value && result.left_value !== result.right_value
                  ? "border-emerald-400 bg-emerald-50/50 shadow-lg shadow-emerald-100"
                  : "border-elq-border"
                : "border-elq-border hover:border-elq-player1/50 hover:shadow-lg hover:scale-[1.02] active:scale-[0.98] cursor-pointer"
            }`}
          >
            <div className="text-4xl mb-3">{getFlag(pair.left.nationality)}</div>
            <div className="font-semibold text-elq-dark text-base sm:text-lg leading-tight mb-1">
              {pair.left.name}
            </div>
            <div className="text-xs text-elq-muted mb-4">{pair.left.nationality || "Unknown"}</div>

            {showValues ? (
              <div className={`text-3xl sm:text-4xl font-bold tabular-nums animate-fade-in-up ${
                result.left_value > result.right_value
                  ? "text-emerald-600"
                  : result.left_value === result.right_value
                    ? "text-amber-600"
                    : "text-elq-dark"
              }`}>
                {formatValue(result.left_value)}
              </div>
            ) : (
              <div className="text-3xl sm:text-4xl font-bold text-elq-muted/30">?</div>
            )}

            {!result && (
              <div className="mt-3 text-xs font-semibold text-elq-player1 opacity-0 group-hover:opacity-100 transition-opacity">
                ← HIGHER
              </div>
            )}
          </button>

          {/* Right card */}
          <button
            type="button"
            onClick={() => handleChoice("right")}
            disabled={loading || !!result}
            className={`group relative bg-white rounded-2xl border-2 p-5 sm:p-7 text-center transition-all duration-300 ${
              result
                ? result.right_value >= result.left_value && result.left_value !== result.right_value
                  ? "border-emerald-400 bg-emerald-50/50 shadow-lg shadow-emerald-100"
                  : "border-elq-border"
                : "border-elq-border hover:border-elq-player2/50 hover:shadow-lg hover:scale-[1.02] active:scale-[0.98] cursor-pointer"
            }`}
          >
            <div className="text-4xl mb-3">{getFlag(pair.right.nationality)}</div>
            <div className="font-semibold text-elq-dark text-base sm:text-lg leading-tight mb-1">
              {pair.right.name}
            </div>
            <div className="text-xs text-elq-muted mb-4">{pair.right.nationality || "Unknown"}</div>

            {showValues ? (
              <div className={`text-3xl sm:text-4xl font-bold tabular-nums animate-fade-in-up ${
                result.right_value > result.left_value
                  ? "text-emerald-600"
                  : result.left_value === result.right_value
                    ? "text-amber-600"
                    : "text-elq-dark"
              }`}>
                {formatValue(result.right_value)}
              </div>
            ) : (
              <div className="text-3xl sm:text-4xl font-bold text-elq-muted/30">?</div>
            )}

            {!result && (
              <div className="mt-3 text-xs font-semibold text-elq-player2 opacity-0 group-hover:opacity-100 transition-opacity">
                HIGHER →
              </div>
            )}
          </button>
        </div>

        {/* Same button */}
        {!result && (
          <button
            type="button"
            onClick={() => handleChoice("same")}
            disabled={loading}
            className="px-8 py-2.5 bg-white border-2 border-elq-border text-elq-text font-semibold rounded-xl hover:border-amber-400 hover:bg-amber-50 active:scale-[0.98] transition-all text-sm"
          >
            = Same
          </button>
        )}

        {/* Result feedback */}
        {result && !gameOver && (
          <div className={`animate-fade-in-up text-center ${result.correct ? "text-emerald-600" : "text-red-600"}`}>
            <div className="text-2xl mb-1">{result.correct ? "✅" : "❌"}</div>
            <div className="text-sm font-semibold">
              {result.correct ? "Correct!" : "Wrong!"}
            </div>
          </div>
        )}

        {/* Streak display */}
        {streak > 0 && !gameOver && (
          <div className="mt-6 text-center">
            <div className="inline-flex items-center gap-2 bg-elq-orange/10 border border-elq-orange/20 rounded-full px-4 py-1.5">
              <span className="text-sm font-bold text-elq-orange tabular-nums">{streak}</span>
              <span className="text-xs text-elq-orange font-medium">streak 🔥</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
