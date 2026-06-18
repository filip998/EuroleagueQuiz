import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import HigherLowerSetup from "../HigherLowerSetup";
import { AuthContext } from "../identityBridge";
import { createHigherLowerGame, getHigherLowerLeaderboard } from "../api";

vi.mock("../api", () => ({
  createHigherLowerGame: vi.fn(),
  getHigherLowerLeaderboard: vi.fn(),
}));

vi.mock("../Logo", () => ({
  LogoMini: ({ onClick }) => (
    <button data-testid="logo-mini" onClick={onClick}>Logo</button>
  ),
  LogoFull: () => <div data-testid="logo-full" />,
  default: () => <div data-testid="logo-full" />,
}));

// The Node 25 test runtime ships an inert experimental `localStorage` global
// that shadows jsdom's, so install a working in-memory Storage. This keeps the
// nickname persistence deterministic and isolated per test.
const originalLocalStorage = globalThis.localStorage;

const signedIn = (user) => ({ isLoaded: true, isSignedIn: true, user });

describe("HigherLowerSetup nickname persistence", () => {
  const mockOnGameCreated = vi.fn();
  const mockOnBack = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    const store = new Map();
    globalThis.localStorage = {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
      clear: () => store.clear(),
    };
    getHigherLowerLeaderboard.mockResolvedValue({ entries: [] });
    createHigherLowerGame.mockResolvedValue({ id: 1, status: "active" });
  });

  afterEach(() => {
    globalThis.localStorage = originalLocalStorage;
  });

  it("does not persist a Clerk-prefilled name into the guest nickname on submit", async () => {
    render(
      <AuthContext.Provider value={signedIn({ username: "clerk_user" })}>
        <HigherLowerSetup onGameCreated={mockOnGameCreated} onBack={mockOnBack} />
      </AuthContext.Provider>
    );

    // The field is prefilled with the Clerk display name, unedited.
    const field = screen.getByPlaceholderText("Your name");
    expect(field.value).toBe("clerk_user");

    // Start the game without touching the name.
    fireEvent.click(screen.getByText("Start Game"));

    await waitFor(() => expect(createHigherLowerGame).toHaveBeenCalled());

    // The Clerk name is used for THIS game...
    expect(createHigherLowerGame).toHaveBeenCalledWith(
      expect.objectContaining({ nickname: "clerk_user" })
    );

    // ...but it must NOT leak into the persistent shared guest nickname, which
    // would otherwise linger across sign-out into anonymous play on every screen.
    expect(globalThis.localStorage.getItem("elq_nickname")).toBeNull();
  });

  it("still persists a name the user actually types (anonymous play)", async () => {
    render(
      <HigherLowerSetup onGameCreated={mockOnGameCreated} onBack={mockOnBack} />
    );

    const field = screen.getByPlaceholderText("Your name");
    fireEvent.change(field, { target: { value: "Bob" } });

    // Editing persists immediately via onChange — independent of submit.
    expect(globalThis.localStorage.getItem("elq_nickname")).toBe("Bob");

    fireEvent.click(screen.getByText("Start Game"));
    await waitFor(() => expect(createHigherLowerGame).toHaveBeenCalled());
    expect(createHigherLowerGame).toHaveBeenCalledWith(
      expect.objectContaining({ nickname: "Bob" })
    );
    expect(globalThis.localStorage.getItem("elq_nickname")).toBe("Bob");
  });
});
