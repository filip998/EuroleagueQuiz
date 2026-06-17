// Canonical UI mode metadata shared by every multi-mode game. Each game maps
// these UI keys ("solo" | "local" | "online") onto its own backend modes.
const MODE_META = {
  solo: {
    label: "Solo",
    desc: "Just you",
    icon: (
      <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" />
      </svg>
    ),
  },
  local: {
    label: "Local 1v1",
    desc: "Same screen",
    icon: (
      <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z" />
      </svg>
    ),
  },
  online: {
    label: "Online",
    desc: "Challenge a friend",
    icon: (
      <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 0 0 8.716-6.747M12 21a9.004 9.004 0 0 1-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 0 1 7.843 4.582M12 3a8.997 8.997 0 0 0-7.843 4.582m15.686 0A11.953 11.953 0 0 1 12 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0 1 21 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0 1 12 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 0 1 3 12c0-1.605.42-3.113 1.157-4.418" />
      </svg>
    ),
  },
};

const DEFAULT_SUB_MODES = [
  ["create", "Create"],
  ["join", "Join"],
];

/**
 * Shared mode picker: a row of mode cards (Solo / Local 1v1 / Online) plus, when
 * Online is selected, a slim sub-toggle. Fully controlled — the parent owns
 * `mode` and `sub`. Renders nothing for single-mode games.
 *
 * `subModes` lets a game customise the Online sub-toggle (e.g. TicTacToe uses
 * Quick Match / Play a Friend); it defaults to Create / Join.
 */
export default function GameModeSelector({
  modes = ["solo", "local", "online"],
  mode,
  onModeChange,
  sub,
  onSubChange,
  subModes = DEFAULT_SUB_MODES,
  disabled = false,
}) {
  if (!modes || modes.length < 2) return null;

  const cols = modes.length === 2 ? "grid-cols-2" : "grid-cols-3";

  return (
    <div>
      <label className="block text-xs font-semibold uppercase tracking-wider text-elq-muted mb-3">
        Game Mode
      </label>
      <div className={`grid ${cols} gap-3 ${mode === "online" ? "mb-4" : "mb-6"}`}>
        {modes.map((key) => {
          const m = MODE_META[key];
          if (!m) return null;
          const active = mode === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => onModeChange(key)}
              disabled={disabled}
              aria-pressed={active}
              className={`relative p-4 rounded-xl border-2 transition-all text-center disabled:cursor-not-allowed disabled:opacity-60 ${
                active
                  ? "border-elq-orange bg-elq-orange/5 text-elq-orange"
                  : "border-elq-border hover:border-gray-300 text-elq-muted hover:text-elq-text"
              }`}
            >
              <div className="flex justify-center mb-2">{m.icon}</div>
              <div className="font-semibold text-sm text-elq-text">{m.label}</div>
              <div className="text-[11px] text-elq-muted mt-0.5">{m.desc}</div>
            </button>
          );
        })}
      </div>

      {mode === "online" && (
        <div
          className={`grid gap-1 p-1 mb-6 bg-elq-bg rounded-xl border border-elq-border`}
          style={{ gridTemplateColumns: `repeat(${subModes.length}, minmax(0, 1fr))` }}
        >
          {subModes.map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => onSubChange(value)}
              disabled={disabled}
              aria-pressed={sub === value}
              className={`py-2 rounded-lg text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                sub === value
                  ? "bg-white text-elq-orange shadow-sm"
                  : "text-elq-muted hover:text-elq-text"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
