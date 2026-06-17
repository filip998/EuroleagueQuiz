import { formatPresence as defaultFormatPresence } from "./quickMatch";

/**
 * Game-agnostic one-click Quick Match pool grid (lichess-style): tapping a preset
 * card *is* the action — it calls `onPick(presetKey)` immediately rather than
 * selecting a preset for a separate submit button. It carries no game specifics,
 * so any game can reuse it by passing its own `presets` array, live `pools`
 * presence, and an `onPick` handler.
 *
 * While a pick is in flight the parent sets `disabled` (which disables every
 * card so a fast multi-tap can't open several waiting games) and `pendingPreset`
 * (which shows the searching state on the chosen card). `defaultPreset` is
 * highlighted as the recommended choice. `formatPresence` defaults to the shared
 * formatter but can be overridden for a different presence shape.
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
          return (
            <button
              key={p.key}
              type="button"
              onClick={() => onPick(p.key)}
              disabled={disabled}
              data-testid={`quick-pick-${p.key}`}
              aria-busy={isPending}
              className={`w-full flex items-center justify-between gap-3 p-3.5 rounded-xl border-2 text-left transition-all disabled:cursor-not-allowed ${
                isDefault
                  ? "border-elq-orange bg-elq-orange/5"
                  : "border-elq-border hover:border-gray-300"
              } ${disabled && !isPending ? "opacity-50" : ""}`}
            >
              <div>
                <div className="flex items-center gap-2">
                  <span className={`font-semibold text-sm ${isDefault ? "text-elq-orange" : "text-elq-text"}`}>
                    {p.label}
                  </span>
                  {isDefault && (
                    <span className="text-[10px] font-bold uppercase tracking-wider text-elq-orange bg-elq-orange/10 rounded px-1.5 py-0.5">
                      Default
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-elq-muted mt-0.5">{p.detail}</div>
              </div>
              <div
                className="text-[11px] text-elq-muted text-right whitespace-nowrap"
                data-testid={`presence-${p.key}`}
              >
                {isPending ? "Searching…" : formatPresence(pools?.[p.key])}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
