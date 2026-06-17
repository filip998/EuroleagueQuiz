import { presetLabel, formatPresence, useQuickMatchPools } from "./quickMatch";

/**
 * "Searching the pool…" lobby shown on the online board while a Quick Match game
 * sits in `waiting_for_opponent`. Mirrors the shared WaitingLobby chrome but,
 * instead of a join code, surfaces the chosen preset and live presence counts
 * and lets the player cancel the search. The board's realtime hook flips this
 * screen to the active board automatically once an opponent is matched.
 *
 * `usePools`/`getPresetLabel` default to the TicTacToe pool source but let other
 * games (e.g. Photo Quiz) reuse this lobby with their own pool feed and labels.
 * Both must be stable module-level references so the hook order stays constant.
 * `title` lets a game override the heading; it defaults to the shared copy.
 */
export default function QuickMatchSearchingLobby({
  preset,
  onCancel,
  cancelling = false,
  usePools = useQuickMatchPools,
  getPresetLabel = presetLabel,
  title = "SEARCHING THE POOL…",
}) {
  const { pools } = usePools(true);
  const counts = preset && pools ? pools[preset] : null;

  return (
    <div className="min-h-screen flex flex-col">
      <div className="h-1 bg-gradient-to-r from-elq-orange to-elq-orange-light" />
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="text-center animate-fade-in-up">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-elq-orange/10 mb-6 animate-pulse-ring">
            <svg className="w-8 h-8 text-elq-orange animate-spin-slow" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
            </svg>
          </div>
          <h2 className="font-display text-4xl text-elq-dark mb-3">{title}</h2>
          <p className="text-elq-muted mb-6">
            Looking for an opponent in{" "}
            <strong className="text-elq-text">{getPresetLabel(preset)}</strong>
          </p>

          <div className="inline-flex items-center gap-2 bg-elq-bg border border-elq-border rounded-full px-4 py-2 mb-8">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-sm text-elq-muted" data-testid="searching-presence">
              {formatPresence(counts)}
            </span>
          </div>

          <p className="text-sm text-elq-muted mb-8">
            You&rsquo;ll be matched automatically when another player joins.
          </p>

          {onCancel && (
            <div>
              <button
                type="button"
                onClick={onCancel}
                disabled={cancelling}
                className="text-sm text-elq-muted hover:text-elq-orange transition-colors underline underline-offset-2 disabled:opacity-50 disabled:no-underline"
              >
                {cancelling ? "Cancelling…" : "Cancel search"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
