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
  compact = false,
}) {
  const a = ACCENTS[accent] ?? ACCENTS.player1;

  if (compact) {
    return (
      <div className="elq-auth-safe-top min-h-screen flex flex-col">
        <div className="h-1 bg-elq-orange" />
        <header className="border-b border-elq-border bg-white">
          <div className="mx-auto flex min-h-[58px] w-full max-w-[920px] items-center gap-3 px-4 py-2">
            {onHome && <LogoMini onClick={onHome} className="shrink-0" />}
            <div className="min-w-0">
              <h1 className="font-display text-[1.75rem] leading-none tracking-wide text-elq-dark sm:text-3xl">
                {title}
              </h1>
              {tagline && (
                <p className="mt-0.5 truncate text-xs text-elq-muted sm:text-sm">
                  {tagline}
                </p>
              )}
            </div>
          </div>
        </header>

        <div className="flex-1 px-4 py-4 sm:py-6 lg:py-9">
          <div
            className="mx-auto w-full max-w-[920px]"
            data-testid="game-setup-content"
          >
            <div className="lg:rounded-2xl lg:border lg:border-elq-border lg:bg-white lg:p-7 lg:shadow-lg lg:shadow-black/5">
              {children}
              {error && (
                <div
                  role="alert"
                  className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-center text-sm text-red-700"
                >
                  {error}
                </div>
              )}
            </div>

            {extra && (
              <div className={`${CARD_CLASS} mt-6 p-6 sm:p-8`}>
                {extra}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="elq-auth-safe-top min-h-screen flex flex-col">
      <div className="h-1 bg-gradient-to-r from-elq-orange to-elq-orange-light" />

      <div className="flex-1 flex items-start justify-center p-4 py-8 sm:py-10">
        <div className="w-full max-w-lg" data-testid="game-setup-content">
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
