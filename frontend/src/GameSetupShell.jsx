import { LogoMini } from "./Logo";

// Per-game accent tints for the header icon badge. Values are written as literal
// Tailwind class strings (never interpolated) so Tailwind v4's scanner emits them.
const ACCENTS = {
  player1: { badge: "bg-elq-player1/10", icon: "text-elq-player1" },
  player2: { badge: "bg-elq-player2/10", icon: "text-elq-player2" },
  emerald: { badge: "bg-emerald-100", icon: "text-emerald-600" },
  amber: { badge: "bg-amber-100", icon: "text-amber-600" },
  violet: { badge: "bg-violet-100", icon: "text-violet-600" },
};

const CARD_CLASS =
  "bg-white rounded-2xl border border-elq-border shadow-lg shadow-black/5";

/**
 * Uppercase section caption that groups a block of option selects on a setup
 * screen. Shared so every game's Online -> Play a Friend -> Create pane styles
 * and spaces these headings identically (issue #133). It is a group caption,
 * not a form label, so it renders a <p> rather than a <label>.
 */
export function SectionCaption({ children }) {
  return (
    <p className="block text-xs font-semibold uppercase tracking-wider text-elq-muted mb-3">
      {children}
    </p>
  );
}

/**
 * Shared chrome for every game's pre-game setup screen: orange top bar, a
 * LogoMini Home control, a centered per-game identity header (accent icon badge
 * + title + tagline), the canonical white card wrapping the game-specific body,
 * a shared error slot, and an optional second card via `extra`.
 */
export default function GameSetupShell({
  accent = "player1",
  icon,
  title,
  tagline,
  onHome,
  error,
  children,
  extra,
}) {
  const a = ACCENTS[accent] ?? ACCENTS.player1;

  return (
    <div className="min-h-screen flex flex-col">
      <div className="h-1 bg-gradient-to-r from-elq-orange to-elq-orange-light" />

      <div className="flex-1 flex items-start justify-center p-4 py-8 sm:py-10">
        <div className="w-full max-w-lg">
          {onHome && (
            <div className="mb-4 animate-fade-in-up">
              <LogoMini onClick={onHome} />
            </div>
          )}

          <div className="text-center mb-8 animate-fade-in-up">
            <div
              className={`inline-flex items-center justify-center w-14 h-14 rounded-full ${a.badge} mb-4`}
            >
              <span className={a.icon}>{icon}</span>
            </div>
            <h1 className="font-display text-4xl sm:text-5xl tracking-wide text-elq-dark leading-none">
              {title}
            </h1>
            {tagline && <p className="text-elq-muted text-sm mt-3">{tagline}</p>}
          </div>

          <div
            className={`${CARD_CLASS} p-6 sm:p-8 animate-fade-in-up`}
            style={{ animationDelay: "100ms" }}
          >
            {children}
            {error && (
              <div className="mt-4 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm text-center">
                {error}
              </div>
            )}
          </div>

          {extra && (
            <div
              className={`${CARD_CLASS} p-6 sm:p-8 mt-6 animate-fade-in-up`}
              style={{ animationDelay: "200ms" }}
            >
              {extra}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
