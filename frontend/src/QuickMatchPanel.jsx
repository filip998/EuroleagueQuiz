import { formatPresence as defaultFormatPresence } from "./quickMatch";

/**
 * Game-agnostic one-click Quick Match pool grid (lichess-style): tapping a preset
 * card *is* the action — it calls `onPick(presetKey)` immediately rather than
 * selecting a preset for a separate submit button. It carries no game specifics,
 * so any game can reuse it by passing its own `presets` array, live `pools`
 * presence, and an `onPick` handler.
 *
 * Cards use a "Button Reveal" treatment so the one-tap action is obvious without
 * any card looking pre-selected: at rest every card is a neutral white tile.
 * Hovering or keyboard-focusing a card (`:focus-visible`, not hover-only) turns
 * its border/name orange, lifts it, and swaps the presence line for a solid
 * orange "Play ▶" pill. `defaultPreset` earns only a quiet ★ Recommended badge.
 *
 * While a pick is in flight the parent sets `disabled` (which disables every
 * card so a fast multi-tap can't open several waiting games) and `pendingPreset`
 * (which shows the searching state on the chosen card and suppresses the reveal).
 * `formatPresence` defaults to the shared formatter but can be overridden for a
 * different presence shape.
 */
export default function QuickMatchPanel({
  presets,
  pools,
  onPick,
  disabled = false,
  pendingPreset = null,
  defaultPreset = null,
  label = "Pick a pool",
  formatPresence = defaultFormatPresence,
}) {
  return (
    <div className="mb-6">
      <label className="block text-xs font-semibold uppercase tracking-wider text-elq-muted mb-3">
        {label}
      </label>
      <div className="space-y-2.5">
        {presets.map((p) => {
          const isDefault = p.key === defaultPreset;
          const isPending = p.key === pendingPreset;
          // The hover/focus reveal only applies to live, tappable cards: a pending
          // card shows "Searching…" and a disabled panel stays inert.
          const reveal = !disabled && !isPending;
          const buttonClass = [
            "group w-full flex items-center justify-between gap-3 p-3.5 rounded-xl",
            "border-2 border-elq-border bg-elq-card text-left transition-all",
            "focus-visible:outline-none disabled:cursor-not-allowed",
            reveal &&
              "hover:border-elq-orange focus-visible:border-elq-orange " +
                "hover:bg-elq-orange/4 focus-visible:bg-elq-orange/4 hover:shadow-md focus-visible:shadow-md " +
                "focus-visible:ring-2 focus-visible:ring-elq-orange focus-visible:ring-offset-2 " +
                "motion-safe:hover:-translate-y-0.5 motion-safe:focus-visible:-translate-y-0.5",
            disabled && !isPending && "opacity-50",
          ]
            .filter(Boolean)
            .join(" ");
          const nameClass = [
            "font-semibold text-sm text-elq-text transition-colors",
            reveal &&
              "group-hover:text-elq-orange-dark group-focus-visible:text-elq-orange-dark",
          ]
            .filter(Boolean)
            .join(" ");
          const presenceClass = [
            "col-start-1 row-start-1 text-[11px] text-elq-muted text-right",
            "whitespace-nowrap transition-opacity",
            reveal && "group-hover:opacity-0 group-focus-visible:opacity-0",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <button
              key={p.key}
              type="button"
              onClick={() => onPick(p.key)}
              disabled={disabled}
              data-testid={`quick-pick-${p.key}`}
              aria-busy={isPending}
              className={buttonClass}
            >
              <div>
                <div className="flex items-center gap-2">
                  <span className={nameClass}>{p.label}</span>
                  {isDefault && (
                    <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-elq-orange bg-elq-orange/10">
                      <span aria-hidden="true">★</span>
                      Recommended
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-elq-muted mt-0.5">{p.detail}</div>
              </div>
              <div className="grid items-center justify-items-end">
                <div className={presenceClass} data-testid={`presence-${p.key}`}>
                  {isPending ? "Searching…" : formatPresence(pools?.[p.key])}
                </div>
                {reveal && (
                  <span
                    aria-hidden="true"
                    data-testid={`play-${p.key}`}
                    className="col-start-1 row-start-1 inline-flex items-center gap-1 rounded-full bg-elq-orange px-3 py-1 text-xs font-bold text-white shadow-sm pointer-events-none transition-all opacity-0 motion-safe:translate-x-1 group-hover:opacity-100 group-focus-visible:opacity-100 motion-safe:group-hover:translate-x-0 motion-safe:group-focus-visible:translate-x-0"
                  >
                    Play
                    <span aria-hidden="true">▶</span>
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
