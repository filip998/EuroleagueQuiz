/* eslint-disable react-refresh/only-export-components */
import React, { useCallback, useSyncExternalStore } from "react";

const SIGNED_IN_KEY = "elq_e2e_clerk_signed_in";
const CHANGE_EVENT = "elq-e2e-clerk-change";
const E2E_TOKEN = import.meta.env.VITE_E2E_CLERK_TOKEN || "";
const E2E_USER = {
  id: import.meta.env.VITE_E2E_CLERK_USER_ID || "user_e2e_clerk",
  username: import.meta.env.VITE_E2E_CLERK_USERNAME || "e2e_clerk",
  fullName: import.meta.env.VITE_E2E_CLERK_FULL_NAME || "E2E Clerk",
  firstName: import.meta.env.VITE_E2E_CLERK_FIRST_NAME || "E2E",
  imageUrl: "https://example.test/e2e-clerk.png",
  primaryEmailAddress: {
    emailAddress: import.meta.env.VITE_E2E_CLERK_EMAIL || "e2e.clerk@example.test",
  },
};

const listeners = new Set();

function readSignedIn() {
  try {
    return globalThis.localStorage?.getItem(SIGNED_IN_KEY) === "1";
  } catch {
    return false;
  }
}

function notify() {
  for (const listener of listeners) listener();
  globalThis.dispatchEvent?.(new Event(CHANGE_EVENT));
}

function setSignedIn(value) {
  try {
    if (value) {
      globalThis.localStorage?.setItem(SIGNED_IN_KEY, "1");
    } else {
      globalThis.localStorage?.removeItem(SIGNED_IN_KEY);
    }
  } finally {
    notify();
  }
}

function subscribe(listener) {
  listeners.add(listener);
  globalThis.addEventListener?.("storage", listener);
  globalThis.addEventListener?.(CHANGE_EVENT, listener);
  return () => {
    listeners.delete(listener);
    globalThis.removeEventListener?.("storage", listener);
    globalThis.removeEventListener?.(CHANGE_EVENT, listener);
  };
}

function useSignedIn() {
  return useSyncExternalStore(subscribe, readSignedIn, () => false);
}

function passthrough({ children }) {
  return <>{children}</>;
}

export function ClerkProvider({ children }) {
  return <>{children}</>;
}

export function RedirectToSignIn() {
  setSignedIn(false);
  return null;
}

export function SignedIn({ children }) {
  return useSignedIn() ? <>{children}</> : null;
}

export function SignedOut({ children }) {
  return useSignedIn() ? null : <>{children}</>;
}

function clickableChild(children, onClick) {
  if (React.isValidElement(children)) {
    const existing = children.props.onClick;
    return React.cloneElement(children, {
      onClick: (event) => {
        existing?.(event);
        if (!event.defaultPrevented) onClick();
      },
    });
  }
  return (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  );
}

export function SignInButton({ children }) {
  return clickableChild(children, () => setSignedIn(true));
}

export function SignUpButton({ children }) {
  return clickableChild(children, () => setSignedIn(true));
}

export function UserButton({ children }) {
  const signOut = useCallback(() => setSignedIn(false), []);
  return (
    <div data-testid="e2e-user-button">
      <button type="button" onClick={signOut}>
        Signed in as {E2E_USER.username}
      </button>
      {children}
    </div>
  );
}

UserButton.MenuItems = passthrough;
UserButton.Link = function UserButtonLink({ label, href }) {
  return (
    <a href={href} data-testid="e2e-user-button-link">
      {label}
    </a>
  );
};

export function UserProfile() {
  return <div data-testid="e2e-user-profile">{E2E_USER.username}</div>;
}

async function getToken() {
  return readSignedIn() ? E2E_TOKEN || null : null;
}

export function useAuth() {
  return { getToken };
}

export function useUser() {
  const isSignedIn = useSignedIn();
  return {
    isLoaded: true,
    isSignedIn,
    user: isSignedIn ? E2E_USER : null,
  };
}
