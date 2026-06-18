/* eslint-disable react-refresh/only-export-components */
import { cloneElement, isValidElement, useSyncExternalStore } from "react";

const SIGNED_IN_KEY = "elq_e2e_clerk_signed_in";
const listeners = new Set();

const mockUser = {
  id: import.meta.env.VITE_E2E_CLERK_USER_ID || "user_e2e_clerk",
  username: import.meta.env.VITE_E2E_CLERK_USERNAME || "signed_tester",
  fullName: import.meta.env.VITE_E2E_CLERK_FULL_NAME || "Signed Tester",
  firstName: import.meta.env.VITE_E2E_CLERK_FIRST_NAME || "Signed",
};

function readSignedIn() {
  try {
    return globalThis.localStorage?.getItem(SIGNED_IN_KEY) === "1";
  } catch {
    return false;
  }
}

function writeSignedIn(signedIn) {
  try {
    if (signedIn) {
      globalThis.localStorage?.setItem(SIGNED_IN_KEY, "1");
    } else {
      globalThis.localStorage?.removeItem(SIGNED_IN_KEY);
    }
  } catch {
    // Keep the in-browser mock best-effort, mirroring the app identity helpers.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener) {
  listeners.add(listener);
  const onStorage = (event) => {
    if (event.key === SIGNED_IN_KEY) listener();
  };
  globalThis.addEventListener?.("storage", onStorage);
  return () => {
    listeners.delete(listener);
    globalThis.removeEventListener?.("storage", onStorage);
  };
}

function useSignedIn() {
  return useSyncExternalStore(subscribe, readSignedIn, () => false);
}

function withClick(children, onClick, fallbackLabel) {
  if (isValidElement(children)) {
    return cloneElement(children, {
      onClick: (event) => {
        children.props.onClick?.(event);
        onClick();
      },
    });
  }
  return (
    <button type="button" onClick={onClick}>
      {fallbackLabel}
    </button>
  );
}

export function ClerkProvider({ children }) {
  return children;
}

export function RedirectToSignIn() {
  return <div data-testid="e2e-redirect-sign-in" />;
}

export function SignedIn({ children }) {
  return useSignedIn() ? children : null;
}

export function SignedOut({ children }) {
  return useSignedIn() ? null : children;
}

export function SignInButton({ children }) {
  return withClick(children, () => writeSignedIn(true), "Sign in");
}

export function SignUpButton({ children }) {
  return withClick(children, () => writeSignedIn(true), "Sign up");
}

export function UserButton({ children }) {
  return (
    <div data-testid="e2e-user-button">
      <button type="button" onClick={() => writeSignedIn(false)}>
        Sign out
      </button>
      {children}
    </div>
  );
}

UserButton.MenuItems = function MenuItems({ children }) {
  return children;
};

UserButton.Link = function Link({ label, labelIcon, href }) {
  return (
    <a href={href}>
      {labelIcon}
      {label}
    </a>
  );
};

export function UserProfile() {
  return <div data-testid="e2e-user-profile">Mock Clerk profile</div>;
}

export function useAuth() {
  const signedIn = useSignedIn();
  return {
    getToken: async () => (signedIn ? import.meta.env.VITE_E2E_CLERK_TOKEN || null : null),
  };
}

export function useUser() {
  const signedIn = useSignedIn();
  return {
    isLoaded: true,
    isSignedIn: signedIn,
    user: signedIn ? mockUser : null,
  };
}
