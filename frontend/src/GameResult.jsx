const CONFETTI_PIECES = [
  { left: "6%", delay: "0s", duration: "2.7s", color: "#FF6600" },
  { left: "14%", delay: "0.25s", duration: "3.1s", color: "#2563EB" },
  { left: "22%", delay: "0.5s", duration: "2.5s", color: "#DC2626" },
  { left: "30%", delay: "0.1s", duration: "3.3s", color: "#059669" },
  { left: "38%", delay: "0.45s", duration: "2.8s", color: "#FF8533" },
  { left: "46%", delay: "0.2s", duration: "3.0s", color: "#D97706" },
  { left: "54%", delay: "0.55s", duration: "2.6s", color: "#2563EB" },
  { left: "62%", delay: "0.15s", duration: "3.2s", color: "#FF6600" },
  { left: "70%", delay: "0.4s", duration: "2.9s", color: "#DC2626" },
  { left: "78%", delay: "0.05s", duration: "3.4s", color: "#059669" },
  { left: "86%", delay: "0.5s", duration: "2.7s", color: "#FF8533" },
  { left: "94%", delay: "0.3s", duration: "3.1s", color: "#2563EB" },
];

// Lightweight celebratory confetti shown only to the winner. Purely decorative:
// pointer-events-none and aria-hidden so it never blocks the result or assistive tech.
function VictoryConfetti() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      {CONFETTI_PIECES.map((p, i) => (
        <span
          key={i}
          className="absolute -top-4 w-2 h-3 rounded-[1px]"
          style={{
            left: p.left,
            background: p.color,
            animation: `confetti-fall ${p.duration} linear ${p.delay} forwards`,
          }}
        />
      ))}
    </div>
  );
}

/**
 * GameResult
 * Shared, consistent end-of-game result screen used by every game board. Renders
 * a full-page inline result (orange accent bar + centered card) with a medallion,
 * headline, optional subtitle, optional game-specific content, and the two
 * canonical actions: a primary restart ("Play Again") and a secondary "Home".
 *
 * Replaces the previous mix of inline pages, a dismissible modal, and a one-liner
 * across boards, and standardizes the restart/home button labels.
 *
 * Props:
 * - emoji:         medallion glyph (default 🏆).
 * - title:         headline text (e.g. "<NAME> WINS!" or "GAME OVER").
 * - subtitle:      optional secondary line (string or node).
 * - children:      optional game-specific content rendered under the subtitle.
 * - onPlayAgain:   restart handler; the primary button renders only when provided.
 * - playAgainLabel:restart label (default "Play Again").
 * - onHome:        home handler; the secondary button renders only when provided.
 * - homeLabel:     home label (default "Home").
 * - celebrate:     when true, overlays winner confetti.
 */
export default function GameResult({
  emoji = "\u{1F3C6}",
  title,
  subtitle = null,
  children = null,
  onPlayAgain = null,
  playAgainLabel = "Play Again",
  onHome = null,
  homeLabel = "Home",
  celebrate = false,
}) {
  return (
    <div className="min-h-screen flex flex-col">
      <div className="h-1 bg-gradient-to-r from-elq-orange to-elq-orange-light" />
      <div className="relative flex-1 flex items-center justify-center p-4">
        {celebrate && <VictoryConfetti />}
        <div className="text-center animate-fade-in-up max-w-md w-full">
          <div className="text-6xl mb-4">{emoji}</div>
          <h2 className="font-display text-5xl text-elq-dark mb-2">{title}</h2>
          {subtitle != null && subtitle !== "" && (
            <p className="text-elq-muted text-lg mb-6">{subtitle}</p>
          )}
          {children}
          <div className="flex gap-3 justify-center">
            {onPlayAgain && (
              <button
                onClick={onPlayAgain}
                className="px-8 py-3 bg-elq-orange text-white font-bold rounded-xl hover:bg-elq-orange-dark active:scale-[0.98] transition-all text-lg"
              >
                {playAgainLabel}
              </button>
            )}
            {onHome && (
              <button
                onClick={onHome}
                className="px-8 py-3 bg-white border border-elq-border text-elq-text font-bold rounded-xl hover:bg-elq-bg transition-all"
              >
                {homeLabel}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
