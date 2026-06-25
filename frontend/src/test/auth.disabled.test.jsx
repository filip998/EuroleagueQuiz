import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

// Minimal Clerk mock: with no publishable key these surfaces are never rendered,
// but auth.jsx imports the module at the top level, so we stub it to keep the
// test hermetic and avoid loading the real SDK.
vi.mock("@clerk/clerk-react", async () => {
  const React = await import("react");
  const passthrough = ({ children }) => React.createElement(React.Fragment, null, children);
  const UserButton = () => null;
  UserButton.MenuItems = () => null;
  UserButton.Link = () => null;
  UserButton.Action = () => null;
  return {
    ClerkProvider: passthrough,
    RedirectToSignIn: () => null,
    SignedIn: passthrough,
    SignedOut: passthrough,
    SignInButton: passthrough,
    SignUpButton: passthrough,
    UserButton,
    UserProfile: () => null,
    useAuth: () => ({ getToken: async () => null }),
    useUser: () => ({ isLoaded: true, isSignedIn: false, user: null }),
  };
});

let AuthMenu;
let AuthProvider;
let ProfileRoute;
let authEnabled;

beforeAll(async () => {
  // Force Clerk OFF: an empty key trims to falsy, so `clerkEnabled` is false.
  vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "");
  const mod = await import("../auth.jsx");
  AuthMenu = mod.AuthMenu;
  AuthProvider = mod.AuthProvider;
  ProfileRoute = mod.ProfileRoute;
  authEnabled = mod.authEnabled;
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe("auth without Clerk configured (anonymous build)", () => {
  it("reports auth as disabled so no top reserve is applied", () => {
    expect(authEnabled).toBe(false);
  });

  it("AuthMenu renders nothing", () => {
    const { container } = render(
      <MemoryRouter>
        <AuthMenu />
      </MemoryRouter>
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("AuthProvider renders children unchanged without a Router", () => {
    render(<AuthProvider>
      <div data-testid="child">hello</div>
    </AuthProvider>);
    expect(screen.getByTestId("child")).toHaveTextContent("hello");
  });

  it("ProfileRoute redirects home instead of showing a profile", () => {
    render(
      <MemoryRouter initialEntries={["/profile"]}>
        <Routes>
          <Route path="/" element={<div data-testid="home">Home</div>} />
          <Route path="/profile/*" element={<ProfileRoute />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByTestId("home")).toBeInTheDocument();
  });
});
