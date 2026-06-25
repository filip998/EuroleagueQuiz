import { describe, it, expect, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useMediaQuery } from "../useMediaQuery";

const originalMatchMedia = globalThis.window?.matchMedia;

afterEach(() => {
  if (originalMatchMedia) {
    window.matchMedia = originalMatchMedia;
  } else {
    delete window.matchMedia;
  }
  vi.restoreAllMocks();
});

// A controllable matchMedia stub. jsdom does not implement matchMedia, so each
// test installs its own and can flip `matches` then fire the "change" event.
function installMatchMedia(initialMatches) {
  const listeners = new Set();
  const mql = {
    matches: initialMatches,
    media: "",
    addEventListener: vi.fn((_event, cb) => listeners.add(cb)),
    removeEventListener: vi.fn((_event, cb) => listeners.delete(cb)),
    // Legacy fallbacks (unused when addEventListener exists).
    addListener: vi.fn((cb) => listeners.add(cb)),
    removeListener: vi.fn((cb) => listeners.delete(cb)),
    dispatch(matches) {
      this.matches = matches;
      listeners.forEach((cb) => cb({ matches }));
    },
  };
  window.matchMedia = vi.fn(() => mql);
  return mql;
}

describe("useMediaQuery", () => {
  it("returns false when matchMedia is unavailable", () => {
    delete window.matchMedia;
    const { result } = renderHook(() => useMediaQuery("(min-width: 1024px)"));
    expect(result.current).toBe(false);
  });

  it("returns the initial match state when matchMedia is present", () => {
    installMatchMedia(true);
    const { result } = renderHook(() => useMediaQuery("(min-width: 1024px)"));
    expect(result.current).toBe(true);
  });

  it("updates when the media query change event fires", () => {
    const mql = installMatchMedia(false);
    const { result } = renderHook(() => useMediaQuery("(min-width: 1024px)"));
    expect(result.current).toBe(false);

    act(() => mql.dispatch(true));
    expect(result.current).toBe(true);

    act(() => mql.dispatch(false));
    expect(result.current).toBe(false);
  });

  it("subscribes on mount and unsubscribes on unmount", () => {
    const mql = installMatchMedia(true);
    const { unmount } = renderHook(() => useMediaQuery("(min-width: 1024px)"));
    expect(mql.addEventListener).toHaveBeenCalledWith("change", expect.any(Function));

    unmount();
    expect(mql.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
  });
});
