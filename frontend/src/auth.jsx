// Clerk wiring for the SPA. This is the ONLY module that imports
// `@clerk/clerk-react`, so the rest of the app (api.js, identityBridge.js, setup
// screens) stays Clerk-agnostic and trivially testable.
//
// Auth is purely additive: when no publishable key is configured the app runs
// exactly as before (no provider, no token, no auth UI). When configured, signed
// -in users get a Bearer token on REST calls and a prefilled display name, while
// signed-out users keep playing anonymously with zero friction.

import { useEffect, useMemo, useRef } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import {
  ClerkProvider,
  RedirectToSignIn,
  SignedIn,
  SignedOut,
  SignInButton,
  SignUpButton,
  UserButton,
  UserProfile,
  useAuth,
  useUser,
} from "@clerk/clerk-react";
import { AuthContext } from "./identityBridge";
import { setAuthTokenProvider } from "./authToken";
import { getGuestId } from "./identity";
import { linkGuest } from "./api";
import { LogoMini } from "./Logo";

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY?.trim();

// Auth is enabled only when a (non-whitespace) publishable key is present.
const clerkEnabled = Boolean(PUBLISHABLE_KEY);

// Build-time flag mirroring control presence: `AuthMenu` renders iff this is
// true, so `main.jsx` keys the `data-auth-chrome` top-reserve off it (issue
// #293) without importing Clerk anywhere else.
// eslint-disable-next-line react-refresh/only-export-components
export const authEnabled = clerkEnabled;

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
// signed-out AuthContext default applies everywhere (fully anonymous). When
// configured, mounts <ClerkProvider> wired to react-router navigation so Clerk's
// path-routed surfaces (the /profile UserProfile, UserButton links,
// RedirectToSignIn) navigate the SPA softly instead of doing a full reload.
//
// Must be rendered under a Router (see main.jsx) so the inner component can call
// useNavigate. The anonymous early-return keeps that hook out of the no-Clerk
// path, so a key-less build never needs a Router.
export function AuthProvider({ children }) {
  if (!clerkEnabled) return children;
  return <ClerkProviderWithRouter>{children}</ClerkProviderWithRouter>;
}

function ClerkProviderWithRouter({ children }) {
  const navigate = useNavigate();
  return (
    <ClerkProvider
      publishableKey={PUBLISHABLE_KEY}
      afterSignOutUrl="/"
      routerPush={(to) => navigate(to)}
      routerReplace={(to) => navigate(to, { replace: true })}
    >
      <ClerkAuthBridge>{children}</ClerkAuthBridge>
    </ClerkProvider>
  );
}

const SIGN_IN_BTN_CLASS =
  "px-4 py-1.5 rounded-full bg-elq-cta text-white text-sm font-semibold shadow-sm hover:bg-elq-cta-dark active:scale-[0.98] transition-all whitespace-nowrap";
const SIGN_UP_BTN_CLASS =
  "px-4 py-1.5 rounded-full bg-white text-elq-text text-sm font-semibold border border-elq-border shadow-sm hover:border-elq-orange/40 active:scale-[0.98] transition-all whitespace-nowrap";

// Icon for the custom "Profile" entry in the UserButton menu (labelIcon is
// required by Clerk).
function ProfileIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z"
      />
    </svg>
  );
}

// Fixed header auth control: Sign in / Sign up when signed out, the Clerk user
// menu when signed in. The user menu keeps Clerk's built-in "Manage account" /
// "Sign out" items and adds a "Profile" link to our dedicated /profile route.
// Renders nothing when Clerk isn't configured.
export function AuthMenu() {
  if (!clerkEnabled) return null;
  return (
    <div className="fixed top-3 right-3 z-50 flex flex-nowrap items-center gap-2">
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
        <UserButton afterSignOutUrl="/">
          <UserButton.MenuItems>
            <UserButton.Link
              label="Profile"
              labelIcon={<ProfileIcon />}
              href="/profile"
            />
          </UserButton.MenuItems>
        </UserButton>
      </SignedIn>
    </div>
  );
}

// Dedicated profile page mounted at the /profile/* splat route (see App.jsx).
// Surfaces username, email, display name, and avatar via Clerk's prebuilt
// <UserProfile/> (path-routed, so its sub-pages live under /profile/*). When
// Clerk isn't configured, or when the visitor is signed out, it redirects home
// so anonymous builds and deep links never get stuck on an empty page.
export function ProfileRoute() {
  if (!clerkEnabled) return <Navigate to="/" replace />;
  return <ProfileScreen />;
}

function ProfileScreen() {
  const navigate = useNavigate();
  return (
    <div className="elq-auth-safe-top min-h-screen flex flex-col">
      <div className="h-1 bg-gradient-to-r from-elq-orange to-elq-orange-light" />
      <div className="flex-1 flex flex-col items-center p-4 py-8 sm:py-10">
        <div className="w-full max-w-3xl">
          <div className="mb-6 animate-fade-in-up">
            <LogoMini onClick={() => navigate("/")} />
          </div>
          <SignedIn>
            <div className="flex justify-center animate-fade-in-up">
              <UserProfile path="/profile" routing="path" />
            </div>
          </SignedIn>
          <SignedOut>
            <Navigate to="/" replace />
          </SignedOut>
        </div>
      </div>
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
