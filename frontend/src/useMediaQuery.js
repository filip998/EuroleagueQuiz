import { useEffect, useState } from "react";

// Small, dependency-free media-query hook. It is intentionally guarded so it is
// safe in any environment: when `window.matchMedia` is unavailable (jsdom under
// Vitest, or a non-browser runtime) it resolves to `false` instead of throwing,
// so existing component tests render their default (mobile) branch unchanged. In
// a real browser `useState` reads the correct value on the first render, so
// there is no layout flash.
function getMatches(query) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(query).matches;
}

export function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => getMatches(query));

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return undefined;
    }
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    // Re-sync in case the match state changed between the initial render and the
    // effect (e.g. a fast resize). Setting the same value is a no-op re-render.
    onChange();
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    }
    // Safari < 14 / older engines only expose the deprecated listener API.
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, [query]);

  return matches;
}
