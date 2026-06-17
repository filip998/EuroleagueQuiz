// Bearer-token bridge between the React/Clerk layer and the plain-module API
// layer. `api.js` cannot call React hooks, so the Clerk provider registers a
// token getter here and `api.js` reads it per request.
//
// Anonymous play is the default: when no provider is registered (signed out or
// Clerk not configured) `getAuthToken()` resolves to `null`, so no
// `Authorization` header is ever attached. The registered provider also guards
// itself on the live signed-in state, so a momentarily-stale registration can
// never leak a token for a signed-out user. A provider that throws, rejects, or
// stalls is treated as "no token" so a token hiccup never breaks a REST call.

let tokenProvider = null;

// Cap how long a token fetch may delay a request before falling back to
// anonymous, so a slow Clerk refresh can't hang public gameplay calls.
const TOKEN_TIMEOUT_MS = 5000;

// Register the async token getter (e.g. Clerk's `getToken`). Returns a disposer
// that clears the provider only if it is still the one registered here, so a
// late unmount cleanup can't wipe a newer provider.
export function setAuthTokenProvider(provider) {
  const fn = typeof provider === "function" ? provider : null;
  tokenProvider = fn;
  return () => {
    if (tokenProvider === fn) tokenProvider = null;
  };
}

export function clearAuthTokenProvider() {
  tokenProvider = null;
}

// Resolve the current Bearer token, or `null` when signed out / unavailable.
// Never throws and never hangs: provider errors and timeouts degrade to null.
export async function getAuthToken() {
  const provider = tokenProvider;
  if (!provider) return null;
  try {
    const token = await Promise.race([
      Promise.resolve().then(provider),
      new Promise((resolve) => setTimeout(() => resolve(null), TOKEN_TIMEOUT_MS)),
    ]);
    return token || null;
  } catch {
    return null;
  }
}
