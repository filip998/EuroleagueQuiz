// Identity bridge between Clerk and the guest identity in `identity.js`.
//
// This module deliberately does NOT import `@clerk/clerk-react`; it reads the
// signed-in user from a neutral React context that the Clerk provider (in
// `auth.jsx`) publishes into. The context default is "signed out", so setup
// screens render correctly in unit tests with no provider, and anonymous play
// is unchanged.

import { createContext, useCallback, useContext, useState } from "react";
import { NICKNAME_MAX_LENGTH } from "./identity";

const SIGNED_OUT = { isLoaded: true, isSignedIn: false, user: null };

// Published by `AuthProvider` in `auth.jsx`. Consumers get the signed-out
// default when no provider is mounted (e.g. tests, or Clerk not configured).
export const AuthContext = createContext(SIGNED_OUT);

export function useAuthIdentity() {
  return useContext(AuthContext);
}

// Pick a display name from a Clerk user, clamped to the shared nickname limit so
// a signed-in user can't overflow backend validation. Email is intentionally
// excluded so PII is never used as a public player name.
function clerkDisplayName(user) {
  if (!user) return "";
  const candidates = [user.username, user.fullName, user.firstName];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim().slice(0, NICKNAME_MAX_LENGTH);
    }
  }
  return "";
}

// Pure precedence helper: prefer the Clerk display name, fall back to the guest
// value. Exported for direct unit testing of the precedence rule.
export function resolveDisplayName(user, fallback = "") {
  return clerkDisplayName(user) || fallback;
}

// The Clerk display name for the current user, or "" when signed out / loading.
export function useClerkName() {
  const { isSignedIn, user } = useAuthIdentity();
  return isSignedIn ? clerkDisplayName(user) : "";
}

// Name-field state for a setup screen that prefers the signed-in Clerk name and
// falls back to the guest value. Clerk loads asynchronously, so the field seeds
// from the guest fallback and is upgraded to the Clerk name once it arrives, and
// reverts to the guest fallback if Clerk signs out in-place — but only while the
// user hasn't edited the field, so typed input (including the Local 1v1
// "Player 1" case) is never clobbered and a signed-in name never lingers into
// anonymous play after sign-out.
//
// This uses the "adjust state while rendering" pattern (storing the previous
// Clerk name and reconciling during render) rather than an effect, so there is
// no extra commit/paint and no setState-in-effect.
export function useClerkPrefilledName(getFallback) {
  const clerkName = useClerkName();
  const [edited, setEdited] = useState(false);
  const [name, setNameState] = useState(() => clerkName || getFallback());
  const [prevClerkName, setPrevClerkName] = useState(clerkName);

  if (clerkName !== prevClerkName) {
    setPrevClerkName(clerkName);
    // Mirror the live Clerk state into an unedited field: adopt the Clerk name
    // when signed in, fall back to the guest value when it clears on sign-out.
    if (!edited) setNameState(clerkName || getFallback());
  }

  const setName = useCallback((next) => {
    setEdited(true);
    setNameState(next);
  }, []);

  return [name, setName];
}
