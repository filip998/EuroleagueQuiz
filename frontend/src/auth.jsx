// Clerk wiring for the SPA. This is the ONLY module that imports
// `@clerk/clerk-react`, so the rest of the app (api.js, identityBridge.js, setup
// screens) stays Clerk-agnostic and trivially testable.
//
// Auth is purely additive: when no publishable key is configured the app runs
// exactly as before (no provider, no token, no auth UI). When configured, signed
// -in users get a Bearer token on REST calls and a prefilled display name, while
// signed-out users keep playing anonymously with zero friction.

import { useEffect, useMemo, useRef } from "react";
import {
  ClerkProvider,
  RedirectToSignIn,
  SignedIn,
  SignedOut,
  SignInButton,
  SignUpButton,
  UserButton,
  useAuth,
  useUser,
} from "@clerk/clerk-react";
import { AuthContext } from "./identityBridge";
import { setAuthTokenProvider } from "./authToken";
import { getGuestId } from "./identity";
import { linkGuest } from "./api";

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY?.trim();

// Auth is enabled only when a (non-whitespace) publishable key is present.
const clerkEnabled = Boolean(PUBLISHABLE_KEY);

if (!clerkEnabled && import.meta.env.DEV) {
  console.info(
    "[auth] VITE_CLERK_PUBLISHABLE_KEY is not set — running anonymously (sign-in disabled)."
  );
}

// Lives under <ClerkProvider>, so Clerk hooks are valid here. Bridges Clerk
// state into the neutral AuthContext, registers the REST token provider, and
// best-effort links the current guest id to the signed-in user.
function ClerkAuthBridge({ children }) {
  const { isLoaded, isSignedIn, user } = useUser();
  const { getToken } = useAuth();

  // Register the REST token provider only while signed in. When signed out (or
  // on sign-out) the effect cleanup clears the provider, so api.js structurally
  // cannot attach a token — the "no token when signed out" guarantee holds
  // without relying on refs or render-time mutation. Re-registers if getToken's
  // identity changes so the closure always calls the current getToken.
  useEffect(() => {
    if (!isLoaded || !isSignedIn) return undefined;
    return setAuthTokenProvider(async () => (await getToken()) ?? null);
  }, [isLoaded, isSignedIn, getToken]);

  // Best-effort guest -> user link, once per (user, guest) pair. We fetch the
  // token first and bail if absent so the request is never sent unauthenticated;
  // we only mark "linked" on success, so a transient failure retries on a later
  // mount. Failures are swallowed and never block sign-in.
  const linkedRef = useRef(null);
  useEffect(() => {
    if (!isLoaded || !isSignedIn || !user) return undefined;
    const key = `${user.id}:${getGuestId()}`;
    if (linkedRef.current === key) return undefined;
    let cancelled = false;
    (async () => {
      const token = await getToken().catch(() => null);
      if (cancelled || !token) return;
      try {
        await linkGuest(token);
        if (!cancelled) linkedRef.current = key;
      } catch {
        // Best-effort: leave unlinked so a later mount can retry.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn, user, getToken]);

  const value = useMemo(
    () => ({
      isLoaded,
      isSignedIn: Boolean(isSignedIn),
      user: isSignedIn ? user : null,
    }),
    [isLoaded, isSignedIn, user]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// Wraps the app. When Clerk isn't configured, renders children unchanged so the
// signed-out AuthContext default applies everywhere (fully anonymous).
export function AuthProvider({ children }) {
  if (!clerkEnabled) return children;
  return (
    <ClerkProvider publishableKey={PUBLISHABLE_KEY} afterSignOutUrl="/">
      <ClerkAuthBridge>{children}</ClerkAuthBridge>
    </ClerkProvider>
  );
}

const SIGN_IN_BTN_CLASS =
  "px-4 py-1.5 rounded-full bg-elq-orange text-white text-sm font-semibold shadow-sm hover:bg-elq-orange-dark active:scale-[0.98] transition-all";
const SIGN_UP_BTN_CLASS =
  "px-4 py-1.5 rounded-full bg-white text-elq-text text-sm font-semibold border border-elq-border shadow-sm hover:border-elq-orange/40 active:scale-[0.98] transition-all";

// Fixed header auth control: Sign in / Sign up when signed out, the Clerk user
// menu when signed in. Renders nothing when Clerk isn't configured.
export function AuthMenu() {
  if (!clerkEnabled) return null;
  return (
    <div className="fixed top-3 right-3 z-50 flex items-center gap-2">
      <SignedOut>
        <SignInButton mode="modal">
          <button type="button" className={SIGN_IN_BTN_CLASS}>
            Sign in
          </button>
        </SignInButton>
        <SignUpButton mode="modal">
          <button type="button" className={SIGN_UP_BTN_CLASS}>
            Sign up
          </button>
        </SignUpButton>
      </SignedOut>
      <SignedIn>
        <UserButton afterSignOutUrl="/" />
      </SignedIn>
    </div>
  );
}

// Future-use protected-route wrapper (unused in v1). Renders children when
// signed in; otherwise redirects to Clerk sign-in (or a provided fallback).
export function RequireAuth({ children, fallback }) {
  if (!clerkEnabled) return fallback ?? null;
  return (
    <>
      <SignedIn>{children}</SignedIn>
      <SignedOut>{fallback ?? <RedirectToSignIn />}</SignedOut>
    </>
  );
}
