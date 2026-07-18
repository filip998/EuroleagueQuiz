import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { autocompletePlayer, autocompleteGuessTheListPlayer } from "./api";
import { buildCluePromptParts } from "./cluePrompt";
import { useListKeyboardNav } from "./useListKeyboardNav";
import { useDialogFocus } from "./useDialogFocus";

function axisLabel(axis) {
  return axis?.display_label || axis?.team_name || "Clue";
}

function playerInitials(name) {
  const parts = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts.at(-1)[0]}`.toUpperCase();
}

export default function PlayerSearch({
  rowAxis,
  colAxis,
  onSelect,
  onCancel,
  guessTheListMode,
  triggerRef,
  fallbackFocusRef,
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState(null);
  const inputRef = useRef(null);
  const titleId = useId();
  const inputId = useId();
  const listId = useId();
  const optionIdPrefix = useId();
  const dialogRef = useDialogFocus({
    onClose: onCancel,
    initialFocusRef: inputRef,
    triggerRef,
    fallbackFocusRef,
  });
  const cluePrompt = guessTheListMode
    ? ""
    : buildCluePromptParts(rowAxis, colAxis)
        .map((part) => part.strong ?? part.text ?? "")
        .join("");

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      if (query.length < 1) {
        setResults([]);
        setSearchError(null);
        setLoading(false);
        return;
      }

      setLoading(true);
      setSearchError(null);
      try {
        const data = guessTheListMode
          ? await autocompleteGuessTheListPlayer(query)
          : await autocompletePlayer(query, null, null);
        if (!cancelled) setResults(data.players || []);
      } catch {
        if (!cancelled) {
          setResults([]);
          setSearchError("Player search is unavailable. Try again.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, guessTheListMode]);

  const { activeIndex, activeItemRef, handleKeyDown } = useListKeyboardNav(
    results,
    onSelect,
    !loading && !searchError
  );
  const activeOptionId =
    activeIndex >= 0 ? `${optionIdPrefix}-${results[activeIndex]?.player_id}` : undefined;
  // Single predicate shared by the rendered listbox and its aria-expanded so
  // the two can never disagree (e.g. stale results still counted as "expanded"
  // while the loading/error view is what's actually on screen).
  const showResultsList = !loading && !searchError && results.length > 0;

  function handleQueryChange(event) {
    const value = event.target.value;
    setQuery(value);
    // Invalidate the previous query's results/highlight immediately instead of
    // waiting out the 250ms debounce below. Otherwise an old result set (and
    // its keyboard highlight) stays "live" while the user keeps typing, so an
    // Enter pressed right after an edit can select a player that no longer
    // matches what's in the box.
    setResults([]);
    setSearchError(null);
    // Keep the "Searching…" state (rather than a misleading "No players
    // found" flash) continuously covering the gap until the debounced search
    // below actually starts.
    setLoading(value.length >= 1);
  }

  return createPortal(
    <div
      className="animate-overlay-in fixed inset-0 z-50 flex items-end bg-slate-950/50 sm:items-center sm:justify-center sm:p-4"
      onClick={onCancel}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="ttt-responsive-dialog flex h-[min(66dvh,580px)] min-h-[min(300px,calc(100dvh-16px))] max-h-[calc(100dvh-16px)] w-full flex-col rounded-t-3xl bg-white shadow-2xl outline-none sm:h-auto sm:max-h-[calc(100dvh-56px)] sm:min-h-[min(460px,calc(100dvh-56px))] sm:max-w-md sm:rounded-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div
          aria-hidden="true"
          className="mx-auto mt-3 h-1 w-9 shrink-0 rounded-full bg-slate-300 sm:hidden"
        />

        <div className="shrink-0 px-4 pb-3 pt-3 sm:px-5 sm:pt-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 id={titleId} className="text-xl font-bold text-elq-dark">
              Choose a player
            </h2>
            <button
              type="button"
              onClick={onCancel}
              aria-label="Close"
              className="flex h-11 w-11 items-center justify-center rounded-xl text-elq-muted transition-colors hover:bg-elq-bg hover:text-elq-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-elq-orange"
            >
              <svg
                aria-hidden="true"
                className="h-5 w-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {guessTheListMode ? (
            <p className="mb-4 text-sm text-elq-muted">
              Search for a player you think was on this roster
            </p>
          ) : (
            <div
              aria-label={cluePrompt}
              className="mb-4 flex flex-wrap items-center gap-2"
            >
              <span className="rounded-lg border border-elq-border bg-slate-50 px-2.5 py-2 text-xs font-semibold text-elq-text">
                {axisLabel(rowAxis)}
              </span>
              <span aria-hidden="true" className="font-bold text-elq-muted">
                +
              </span>
              <span className="rounded-lg border border-elq-border bg-slate-50 px-2.5 py-2 text-xs font-semibold text-elq-text">
                {axisLabel(colAxis)}
              </span>
            </div>
          )}

          <label htmlFor={inputId} className="sr-only">
            Search EuroLeague players
          </label>
          <div className="relative">
            <svg
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-elq-muted"
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
              id={inputId}
              role="combobox"
              aria-autocomplete="list"
              aria-controls={listId}
              aria-expanded={showResultsList}
              aria-activedescendant={activeOptionId}
              aria-busy={loading}
              value={query}
              onChange={handleQueryChange}
              onKeyDown={handleKeyDown}
              placeholder="Type player name..."
              autoComplete="off"
              className="min-h-12 w-full rounded-xl border-2 border-elq-border bg-slate-50 py-3 pl-11 pr-12 text-base transition-colors focus:border-elq-cta focus:bg-white focus:outline-none focus:ring-0"
            />
            {query && (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  setResults([]);
                  setLoading(false);
                  setSearchError(null);
                  inputRef.current?.focus();
                }}
                aria-label="Clear search"
                className="absolute right-1 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-lg bg-slate-200 text-elq-muted hover:text-elq-text"
              >
                <svg
                  aria-hidden="true"
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2.5}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 sm:px-5">
          <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-elq-muted">
            Players
          </div>

          <div aria-live="polite" aria-atomic="true">
            {loading && (
              <div role="status" className="flex items-center justify-center gap-2 py-8 text-sm text-elq-muted">
                <svg
                  aria-hidden="true"
                  className="h-5 w-5 animate-spin-slow text-elq-cta"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
                </svg>
                Searching…
              </div>
            )}

            {!loading && searchError && (
              <p role="status" className="py-8 text-center text-sm text-red-700">
                {searchError}
              </p>
            )}

            {showResultsList && (
              <ul id={listId} role="listbox" aria-label="Player results" className="space-y-1">
                {results.map((player, index) => {
                  const highlighted = index === activeIndex;
                  return (
                    <li
                      key={player.player_id}
                      id={`${optionIdPrefix}-${player.player_id}`}
                      role="option"
                      ref={index === activeIndex ? activeItemRef : undefined}
                      aria-selected={index === activeIndex}
                      tabIndex={-1}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => onSelect(player)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          onSelect(player);
                        }
                      }}
                      className={`flex min-h-14 w-full cursor-pointer items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-elq-orange ${
                        highlighted ? "bg-orange-50" : "hover:bg-slate-50"
                      }`}
                    >
                      <span
                        aria-hidden="true"
                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-slate-300 bg-slate-100 text-xs font-bold text-elq-muted"
                      >
                        {playerInitials(player.full_name)}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-bold text-elq-dark">
                          {player.full_name}
                        </span>
                        {(player.nationality || player.era) && (
                          <span className="mt-0.5 block truncate text-xs text-elq-muted">
                            {[player.nationality, player.era].filter(Boolean).join(" \u00b7 ")}
                          </span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}

            {!loading &&
              !searchError &&
              query.length >= 1 &&
              results.length === 0 && (
                <p role="status" className="py-8 text-center text-sm text-elq-muted">
                  No players found
                </p>
              )}

            {!loading && !searchError && query.length === 0 && (
              <p className="py-8 text-center text-sm text-elq-muted">
                Start typing to find a player.
              </p>
            )}
          </div>
        </div>

        <div className="hidden shrink-0 border-t border-elq-border px-5 py-3 text-center text-[11px] text-elq-muted sm:block">
          <kbd className="rounded border border-elq-border bg-elq-bg px-1.5 py-0.5 font-mono text-[10px]">
            &uarr;
          </kbd>{" "}
          <kbd className="rounded border border-elq-border bg-elq-bg px-1.5 py-0.5 font-mono text-[10px]">
            &darr;
          </kbd>{" "}
          navigate
          <span aria-hidden="true"> · </span>
          <kbd className="rounded border border-elq-border bg-elq-bg px-1.5 py-0.5 font-mono text-[10px]">
            Enter
          </kbd>{" "}
          select
          <span aria-hidden="true"> · </span>
          <kbd className="rounded border border-elq-border bg-elq-bg px-1.5 py-0.5 font-mono text-[10px]">
            Esc
          </kbd>{" "}
          close
        </div>
      </div>
    </div>,
    document.body
  );
}
