import { useEffect, useState } from "react";

import { fetchTicTacToeQuickMatchPools } from "./api";

// Quick Match preset metadata. Keys must match the backend matchmaking presets
// (see backend/app/services/matchmaking_adapters.py).
export const QUICK_MATCH_PRESETS = [
  {
    key: "blitz",
    label: "Blitz",
    detail: "Best of 3 · 15s turns",
    targetWins: 3,
    timer: "15s",
  },
  {
    key: "standard",
    label: "Standard",
    detail: "Best of 3 · 40s turns",
    targetWins: 3,
    timer: "40s",
  },
  {
    key: "long",
    label: "Long",
    detail: "Best of 5 · 40s turns",
    targetWins: 5,
    timer: "40s",
  },
];

export const DEFAULT_QUICK_MATCH_PRESET = "standard";

const DEFAULT_POLL_INTERVAL_SECONDS = 5;

export function presetLabel(key) {
  return QUICK_MATCH_PRESETS.find((p) => p.key === key)?.label || key;
}

export function formatPresence(counts) {
  const searching = counts?.searching ?? 0;
  const inProgress = counts?.in_progress ?? 0;
  const searchingLabel = `${searching} searching`;
  const progressLabel = `${inProgress} in progress`;
  return `${searchingLabel} · ${progressLabel}`;
}

/**
 * Polls the per-preset presence counts while `enabled`. Uses a self-scheduling
 * timeout chain (honouring the server's poll_interval_seconds) rather than a
 * fixed interval, and is cleanup-safe: it never calls setState after unmount and
 * always clears its pending timer. On error it keeps the last counts and retries
 * at the default cadence.
 */
export function useQuickMatchPools(enabled) {
  const [pools, setPools] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!enabled) return undefined;

    let cancelled = false;
    let timer = null;

    const schedule = (seconds) => {
      if (cancelled) return;
      const ms = Math.max(1, seconds || DEFAULT_POLL_INTERVAL_SECONDS) * 1000;
      timer = setTimeout(poll, ms);
    };

    async function poll() {
      try {
        const data = await fetchTicTacToeQuickMatchPools();
        if (cancelled) return;
        setPools(data?.pools || {});
        setError(false);
        schedule(data?.poll_interval_seconds);
      } catch {
        if (cancelled) return;
        setError(true);
        schedule(DEFAULT_POLL_INTERVAL_SECONDS);
      }
    }

    poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled]);

  return { pools, error };
}
