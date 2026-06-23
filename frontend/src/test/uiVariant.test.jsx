import { describe, it, expect, afterEach, vi } from "vitest";

// uiVariant.js reads import.meta.env.VITE_UI_VARIANT once at module-eval time,
// so each case stubs the env, resets the module registry, then dynamically
// imports a fresh copy.
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("UI_VARIANT", () => {
  it("defaults to 'refined' when VITE_UI_VARIANT is unset", async () => {
    vi.stubEnv("VITE_UI_VARIANT", undefined);
    vi.resetModules();
    const { UI_VARIANT } = await import("../uiVariant");
    expect(UI_VARIANT).toBe("refined");
  });

  it("is 'classic' only when VITE_UI_VARIANT is exactly 'classic'", async () => {
    vi.stubEnv("VITE_UI_VARIANT", "classic");
    vi.resetModules();
    const { UI_VARIANT } = await import("../uiVariant");
    expect(UI_VARIANT).toBe("classic");
  });

  it("falls back to 'refined' for any unrecognized value", async () => {
    vi.stubEnv("VITE_UI_VARIANT", "neon");
    vi.resetModules();
    const { UI_VARIANT } = await import("../uiVariant");
    expect(UI_VARIANT).toBe("refined");
  });
});
