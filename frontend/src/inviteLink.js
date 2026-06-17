// Helpers for the friend-game shareable invite link (issue #55). Online join
// codes are six uppercase alphanumerics; an invite link is the game's setup
// route carrying that code as a `?join=` query param, e.g.
// `https://host/tictactoe?join=ABC123`. v1 ships TicTacToe only, but the
// `gamePath` argument keeps this reusable for other game modes later.

export const JOIN_PARAM = "join";

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

function resolveOrigin(origin) {
  if (origin) return origin;
  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin;
  }
  return "";
}

// Build an absolute, shareable invite URL for a join code. Returns "" when the
// code is invalid or no origin is available (e.g. server-side render), so
// callers can hide the link and fall back to the plain code.
export function buildInviteUrl(joinCode, gamePath = "/tictactoe", origin) {
  const code = normalizeJoinCode(joinCode);
  if (!code) return "";
  const base = resolveOrigin(origin);
  if (!base) return "";
  try {
    const url = new URL(gamePath, base);
    url.searchParams.set(JOIN_PARAM, code);
    return url.toString();
  } catch {
    return "";
  }
}
