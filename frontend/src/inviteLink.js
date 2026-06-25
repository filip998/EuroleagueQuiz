// Helpers for the friend-game shareable invite link (issue #55). Online join
// codes are six uppercase alphanumerics; an invite link is the game's setup
// route carrying that code as a `?join=` query param, e.g.
// `https://host/tictactoe?join=ABC123`. TicTacToe, Career Quiz (`/career`),
// Photo Quiz (`/photo`), and Guess the List (`/list`) all honor invite links;
// the `gamePath` argument keeps this reusable across those game modes.

export const JOIN_PARAM = "join";

// Optional invite sub-mode param. Guess the List serves both Classic and Race
// friend games from one setup route (`/list`), so Race links carry
// `?mode=race` to disambiguate them from bare Classic `?join=` links.
export const MODE_PARAM = "mode";
export const RACE_INVITE_MODE = "race";

const JOIN_CODE_PATTERN = /^[A-Z0-9]{6}$/;

// Normalize an arbitrary value to a valid join code, or "" when it isn't one.
export function normalizeJoinCode(raw) {
  const code = String(raw ?? "").trim().toUpperCase();
  return JOIN_CODE_PATTERN.test(code) ? code : "";
}

// Extract a join code from a URL query string (e.g. `location.search`).
export function parseJoinCode(search) {
  try {
    const params = new URLSearchParams(
      typeof search === "string" ? search : (search ?? "")
    );
    return normalizeJoinCode(params.get(JOIN_PARAM));
  } catch {
    return "";
  }
}

// Read the optional invite `mode` param (lowercased) from a query string. Used
// to tell a Guess the List Race friend invite (`?mode=race&join=...`) apart
// from a Classic invite (`?join=...`). Returns "" when absent or unparseable.
export function parseInviteMode(search) {
  try {
    const params = new URLSearchParams(
      typeof search === "string" ? search : (search ?? "")
    );
    return (params.get(MODE_PARAM) ?? "").trim().toLowerCase();
  } catch {
    return "";
  }
}

function resolveOrigin(origin) {
  if (origin) return origin;
  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin;
  }
  return "";
}

// Build an absolute, shareable invite URL for a join code. Returns "" when the
// code is invalid or no origin is available (e.g. server-side render), so
// callers can hide the link and fall back to the plain code. `extraParams` is
// an optional object of additional query params (e.g. `{ mode: "race" }`); the
// validated `join` param can never be overridden and empty values are skipped.
export function buildInviteUrl(joinCode, gamePath = "/tictactoe", origin, extraParams) {
  const code = normalizeJoinCode(joinCode);
  if (!code) return "";
  const base = resolveOrigin(origin);
  if (!base) return "";
  try {
    const url = new URL(gamePath, base);
    url.searchParams.set(JOIN_PARAM, code);
    if (extraParams && typeof extraParams === "object") {
      for (const [key, value] of Object.entries(extraParams)) {
        if (key === JOIN_PARAM) continue;
        const str = String(value ?? "").trim();
        if (str) url.searchParams.set(key, str);
      }
    }
    return url.toString();
  } catch {
    return "";
  }
}
