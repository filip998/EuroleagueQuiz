import { describe, it, expect, afterEach } from "vitest";
import {
  setAuthTokenProvider,
  clearAuthTokenProvider,
  getAuthToken,
} from "../authToken";

afterEach(() => {
  clearAuthTokenProvider();
});

describe("authToken", () => {
  it("returns null when no provider is registered (anonymous default)", async () => {
    expect(await getAuthToken()).toBeNull();
  });

  it("returns the token from the registered provider", async () => {
    setAuthTokenProvider(async () => "session-token");
    expect(await getAuthToken()).toBe("session-token");
  });

  it("treats a provider that throws as no token", async () => {
    setAuthTokenProvider(async () => {
      throw new Error("token refresh failed");
    });
    expect(await getAuthToken()).toBeNull();
  });

  it("treats a null/empty provider result as no token", async () => {
    setAuthTokenProvider(async () => null);
    expect(await getAuthToken()).toBeNull();
    setAuthTokenProvider(async () => "");
    expect(await getAuthToken()).toBeNull();
  });

  it("disposer clears only its own provider", async () => {
    const disposeFirst = setAuthTokenProvider(async () => "first");
    setAuthTokenProvider(async () => "second");
    // The first disposer must not wipe the newer provider.
    disposeFirst();
    expect(await getAuthToken()).toBe("second");
  });

  it("clearAuthTokenProvider removes the provider", async () => {
    setAuthTokenProvider(async () => "token");
    clearAuthTokenProvider();
    expect(await getAuthToken()).toBeNull();
  });
});
