import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getGame, createGame, linkGuest, getAuthMe } from "../api";
import { setAuthTokenProvider, clearAuthTokenProvider } from "../authToken";

// Deterministic guest id so link-guest bodies are predictable.
vi.mock("../identity", () => ({
  getGuestId: () => "test-guest-id",
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

function jsonResponse(data, { ok = true, status = 200 } = {}) {
  return Promise.resolve({
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: () => Promise.resolve(data),
  });
}

function lastRequestInit() {
  return mockFetch.mock.calls[mockFetch.mock.calls.length - 1][1];
}

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  clearAuthTokenProvider();
});

describe("api auth token plumbing", () => {
  it("omits Authorization when signed out (anonymous)", async () => {
    mockFetch.mockReturnValue(jsonResponse({ id: 1 }));
    await getGame(1);
    const headers = lastRequestInit().headers;
    expect(headers).toEqual({ "Content-Type": "application/json" });
    expect(headers.Authorization).toBeUndefined();
  });

  it("sends a Bearer token on REST calls when signed in", async () => {
    setAuthTokenProvider(async () => "session-token");
    mockFetch.mockReturnValue(jsonResponse({ id: 1 }));
    await getGame(1);
    expect(lastRequestInit().headers.Authorization).toBe("Bearer session-token");
  });

  it("attaches the token on POST actions too", async () => {
    setAuthTokenProvider(async () => "session-token");
    mockFetch.mockReturnValue(
      jsonResponse({ type: "state", payload: { game: { id: 9 }, terminal: false } })
    );
    await createGame({ mode: "single_player", target_wins: 3 });
    expect(lastRequestInit().headers.Authorization).toBe("Bearer session-token");
  });

  it("stops sending the token once signed out again", async () => {
    setAuthTokenProvider(async () => "session-token");
    mockFetch.mockReturnValue(jsonResponse({ id: 1 }));
    await getGame(1);
    expect(lastRequestInit().headers.Authorization).toBe("Bearer session-token");

    clearAuthTokenProvider();
    await getGame(1);
    expect(lastRequestInit().headers.Authorization).toBeUndefined();
  });

  it("linkGuest posts the guest id with the Bearer token", async () => {
    setAuthTokenProvider(async () => "session-token");
    mockFetch.mockReturnValue(jsonResponse(null, { status: 204 }));
    const result = await linkGuest();
    expect(result).toBeNull(); // 204 No Content tolerated
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/auth/link-guest",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ guest_id: "test-guest-id" }),
      })
    );
    expect(lastRequestInit().headers.Authorization).toBe("Bearer session-token");
  });

  it("linkGuest sends an explicitly-passed token even with no registry provider", async () => {
    // Simulates the auth bridge passing its pre-flight token while the registry
    // provider has been cleared by a racing sign-out: the request must still
    // carry exactly that token (never sent unauthenticated).
    clearAuthTokenProvider();
    mockFetch.mockReturnValue(jsonResponse(null, { status: 204 }));
    await linkGuest("preflight-token");
    expect(lastRequestInit().headers.Authorization).toBe("Bearer preflight-token");
  });

  it("does not POST link-guest at all when no token is available", async () => {
    clearAuthTokenProvider();
    mockFetch.mockReturnValue(jsonResponse(null, { status: 204 }));
    const result = await linkGuest();
    // Best-effort and never unauthenticated: with no token, skip the request
    // entirely rather than send a guaranteed-401 unauthenticated POST.
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("getAuthMe GETs /auth/me with the token", async () => {
    setAuthTokenProvider(async () => "session-token");
    mockFetch.mockReturnValue(jsonResponse({ id: "user_1" }));
    const me = await getAuthMe();
    expect(me).toEqual({ id: "user_1" });
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/auth/me",
      expect.objectContaining({ method: "GET" })
    );
    expect(lastRequestInit().headers.Authorization).toBe("Bearer session-token");
  });
});
