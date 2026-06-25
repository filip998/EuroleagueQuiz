import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

// Mutable state shared between the hoisted Clerk mock and the tests so one mock
// can drive both the signed-in and signed-out flows.
const mockState = vi.hoisted(() => ({ signedIn: true }));

vi.mock("@clerk/clerk-react", async () => {
  const React = await import("react");
  const h = React.createElement;
  const frag = (children) => h(React.Fragment, null, children);

  const UserButton = ({ children }) =>
    h("div", { "data-testid": "user-button" }, children);
  UserButton.MenuItems = ({ children }) => frag(children);
  UserButton.Link = ({ label, href }) =>
    h("a", { href, "data-testid": "user-button-link" }, label);
  UserButton.Action = ({ label, onClick }) => h("button", { onClick }, label);

  return {
    ClerkProvider: ({ children }) => frag(children),
    RedirectToSignIn: () => h("div", { "data-testid": "redirect-sign-in" }),
    SignedIn: ({ children }) => (mockState.signedIn ? frag(children) : null),
    SignedOut: ({ children }) => (mockState.signedIn ? null : frag(children)),
    SignInButton: ({ children }) => frag(children),
    SignUpButton: ({ children }) => frag(children),
    UserButton,
    UserProfile: () =>
      h("div", { "data-testid": "user-profile" }, "User Profile"),
    useAuth: () => ({ getToken: async () => "tok" }),
    useUser: () => ({
      isLoaded: true,
      isSignedIn: mockState.signedIn,
      user: mockState.signedIn ? { id: "u1", username: "clerk_user" } : null,
    }),
  };
});

let AuthMenu;
let ProfileRoute;
let authEnabled;

beforeAll(async () => {
  // Enable Clerk by stubbing the publishable key BEFORE importing auth.jsx so
  // its module-level `clerkEnabled` evaluates to true.
  vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_fake");
  const mod = await import("../auth.jsx");
  AuthMenu = mod.AuthMenu;
  ProfileRoute = mod.ProfileRoute;
  authEnabled = mod.authEnabled;
});

afterAll(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  mockState.signedIn = true;
});

describe("AuthMenu profile entry", () => {
  it("reports auth as enabled when a publishable key is configured", () => {
    expect(authEnabled).toBe(true);
  });

  it("exposes a Profile link to /profile in the user menu when signed in", () => {
    render(
      <MemoryRouter>
        <AuthMenu />
      </MemoryRouter>
    );
    const link = screen.getByTestId("user-button-link");
    expect(link).toHaveTextContent("Profile");
    expect(link).toHaveAttribute("href", "/profile");
  });
});

describe("ProfileRoute", () => {
  function renderAt(path) {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/" element={<div data-testid="home">Home</div>} />
          <Route path="/profile/*" element={<ProfileRoute />} />
        </Routes>
      </MemoryRouter>
    );
  }

  it("renders the Clerk UserProfile for a signed-in user", () => {
    mockState.signedIn = true;
    renderAt("/profile");
    expect(screen.getByTestId("user-profile")).toBeInTheDocument();
    expect(screen.queryByTestId("home")).not.toBeInTheDocument();
  });

  it("redirects a signed-out visitor to home", () => {
    mockState.signedIn = false;
    renderAt("/profile");
    expect(screen.getByTestId("home")).toBeInTheDocument();
    expect(screen.queryByTestId("user-profile")).not.toBeInTheDocument();
  });
});
