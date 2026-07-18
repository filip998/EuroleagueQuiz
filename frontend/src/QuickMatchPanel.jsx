import { formatPresence as defaultFormatPresence } from "./quickMatch";

/**
 * Game-agnostic one-click Quick Match pool grid (lichess-style): tapping a preset
 * card *is* the action — it calls `onPick(presetKey)` immediately rather than
 * selecting a preset for a separate submit button. It carries no game specifics,
 * so any game can reuse it by passing its own `presets` array, live `pools`
 * presence, and an `onPick` handler.
 *
 * Cards split the design into two layers so the one-tap action reads as tappable
 * on every device. The AFFORDANCE — a small, always-visible right chevron — is
 * unconditional and at-rest (it needs no hover/focus), so touch users get a
 * persistent cue without hiding the live presence count. The hover FLOURISH is a
 * mouse/keyboard-only progressive enhancement: hovering or keyboard-focusing a
 * card (`:focus-visible`, not hover-only) turns its border/name orange, lifts it,
 * recolors the chevron orange, and swaps the presence line for a solid orange
 * "Play ▶" pill. No card looks pre-selected at rest; `defaultPreset` earns only a
 * quiet ★ Recommended badge.
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
  layout = "list",
  helper = null,
  footer = null,
}) {
  if (layout === "featured") {
    const featured =
      presets.find((preset) => preset.key === defaultPreset) ?? presets[0];
    const secondary = presets.filter((preset) => preset.key !== featured?.key);

    const renderPresence = (preset) =>
      preset.key === pendingPreset
        ? "Searching…"
        : formatPresence(pools?.[preset.key]);

    const renderCard = (preset, isFeatured) => {
      const isPending = preset.key === pendingPreset;
      return (
        <button
          key={preset.key}
          type="button"
          onClick={() => onPick(preset.key)}
          disabled={disabled}
          data-testid={`quick-pick-${preset.key}`}
          aria-busy={isPending}
          className={`group w-full rounded-xl border bg-white text-left transition-[border-color,background-color,box-shadow,transform] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-elq-orange focus-visible:ring-offset-2 disabled:cursor-not-allowed ${
            isFeatured
              ? "border-2 border-elq-cta bg-orange-50/60 p-3"
              : "border-elq-border p-3"
          } ${
            disabled && !isPending
              ? "opacity-50"
              : "hover:border-elq-cta/60 hover:shadow-sm active:scale-[0.99]"
          }`}
        >
          <span className="flex items-center justify-between gap-3">
            <span className="min-w-0">
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-bold text-elq-text">
                  {preset.label}
                </span>
                {preset.key === defaultPreset && (
                  <span className="rounded-full bg-orange-200 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-elq-cta-dark">
                    Recommended
                  </span>
                )}
              </span>
              <span className="mt-1 block text-xs text-elq-muted">
                {preset.detail}
              </span>
            </span>
            {isFeatured ? (
              <span className="inline-flex min-h-11 min-w-[76px] shrink-0 items-center justify-center rounded-xl bg-elq-cta px-4 text-sm font-bold text-white group-hover:bg-elq-cta-dark">
                {isPending ? "Wait…" : "Play"}
              </span>
            ) : (
              <svg
                aria-hidden="true"
                data-testid={`affordance-${preset.key}`}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-4 w-4 shrink-0 text-elq-cta"
              >
                <path d="m9 6 6 6-6 6" />
              </svg>
            )}
          </span>
          <span
            className={`mt-2 block truncate text-[11px] text-elq-muted ${
              isFeatured ? "" : "sm:text-right"
            }`}
            data-testid={`presence-${preset.key}`}
          >
            {renderPresence(preset)}
          </span>
        </button>
      );
    };

    return (
      <div>
        <div className="mb-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-elq-muted">
            {label}
          </p>
          {helper && <p className="mt-0.5 text-xs text-elq-muted">{helper}</p>}
        </div>
        {featured && renderCard(featured, true)}
        <div className="mt-2 grid grid-cols-2 gap-2">
          {secondary.map((preset) => renderCard(preset, false))}
        </div>
        {footer && (
          <p className="mt-3 text-center text-xs text-elq-muted">{footer}</p>
        )}
      </div>
    );
  }

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
            "col-start-1 row-start-1 w-full truncate text-[11px] text-elq-muted text-right",
            "transition-opacity",
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
              <div className="flex items-center gap-2 min-w-0">
                <div className="grid grid-cols-1 items-center min-w-0">
                  <div className={presenceClass} data-testid={`presence-${p.key}`}>
                    {isPending ? "Searching…" : formatPresence(pools?.[p.key])}
                  </div>
                  {reveal && (
                    <span
                      aria-hidden="true"
                      data-testid={`play-${p.key}`}
                      className="col-start-1 row-start-1 justify-self-end inline-flex items-center gap-1 rounded-full bg-elq-cta px-3 py-1 text-xs font-bold text-white shadow-sm pointer-events-none transition-all opacity-0 motion-safe:translate-x-1 group-hover:opacity-100 group-focus-visible:opacity-100 motion-safe:group-hover:translate-x-0 motion-safe:group-focus-visible:translate-x-0"
                    >
                      Play
                      <span aria-hidden="true">▶</span>
                    </span>
                  )}
                </div>
                {reveal && (
                  <svg
                    aria-hidden="true"
                    data-testid={`affordance-${p.key}`}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-4 w-4 shrink-0 text-elq-muted pointer-events-none transition-all group-hover:text-elq-orange group-focus-visible:text-elq-orange motion-safe:group-hover:translate-x-0.5 motion-safe:group-focus-visible:translate-x-0.5"
                  >
                    <path d="m9 6 6 6-6 6" />
                  </svg>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
