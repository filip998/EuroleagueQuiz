import { useState, useEffect, useRef } from "react";
import { autocompletePlayer } from "./api";

export default function PlayerSearch({
  rowTeamCode,
  colTeamCode,
  onSelect,
  onCancel,
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const timer = setTimeout(async () => {
      if (query.length < 1) {
        setResults([]);
        return;
      }
      setLoading(true);
      try {
        const data = await autocompletePlayer(
          query,
          null,
          null
        );
        setResults(data.players || []);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [query, rowTeamCode, colTeamCode]);

  function handleKeyDown(e) {
    if (e.key === "Escape") onCancel();
    if (e.key === "Enter" && results.length === 1) {
      onSelect(results[0]);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-overlay-in"
      style={{ background: "rgba(15, 25, 35, 0.6)", backdropFilter: "blur(4px)" }}
      onClick={onCancel}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-sm max-h-[80vh] flex flex-col animate-modal-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-5 pb-0">
          <div className="flex items-center justify-between mb-1">
            <h3 className="font-display text-2xl tracking-wide text-elq-dark">
              SEARCH PLAYER
            </h3>
            <button
              onClick={onCancel}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-elq-muted hover:text-elq-text hover:bg-elq-bg transition-colors"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M6 18 18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
          <p className="text-xs text-elq-muted mb-4">
            Find a player who played for both{" "}
            <span className="font-semibold text-elq-text">{rowTeamCode}</span>{" "}
            and{" "}
            <span className="font-semibold text-elq-text">{colTeamCode}</span>
          </p>

          {/* Search input */}
          <div className="relative">
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-elq-muted"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"
              />
            </svg>
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type player name..."
              className="w-full pl-10 pr-4 py-3 rounded-xl border-2 border-elq-border bg-elq-bg text-sm focus:border-elq-orange focus:ring-0 focus:outline-none transition-colors"
            />
          </div>
        </div>

        {/* Results */}
        <div className="flex-1 overflow-y-auto p-5 pt-3">
          {loading && (
            <div className="flex items-center justify-center py-8">
              <svg
                className="w-5 h-5 text-elq-orange animate-spin-slow"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
                />
              </svg>
            </div>
          )}

          {!loading && results.length > 0 && (
            <ul className="space-y-1">
              {results.map((p) => (
                <li key={p.player_id}>
                  <button
                    type="button"
                    onClick={() => onSelect(p)}
                    className="w-full text-left px-3 py-2.5 rounded-lg text-sm hover:bg-elq-orange/5 hover:text-elq-orange transition-colors"
                  >
                    {p.full_name}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {!loading && query.length >= 1 && results.length === 0 && (
            <p className="text-sm text-elq-muted text-center py-8">
              No players found
            </p>
          )}
        </div>

        {/* Footer hint */}
        <div className="px-5 py-3 border-t border-elq-border text-[11px] text-elq-muted text-center">
          Press{" "}
          <kbd className="px-1.5 py-0.5 rounded bg-elq-bg border border-elq-border text-[10px] font-mono">
            Esc
          </kbd>{" "}
          to cancel
          {results.length === 1 && (
            <>
              {" "}&middot;{" "}
              <kbd className="px-1.5 py-0.5 rounded bg-elq-bg border border-elq-border text-[10px] font-mono">
                Enter
              </kbd>{" "}
              to select
            </>
          )}
        </div>
      </div>
    </div>
  );
}
