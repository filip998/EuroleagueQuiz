import { describe, it, expect, vi } from "vitest";
import {
  optimizeHeadshot,
  headshotSrcSet,
  handleHeadshotError,
  HEADSHOT_WIDTHS,
} from "../imageUrl";

const CDN = "https://media-cdn.incrowdsports.com/1068c6e6-fae9-4844-a650-4c60e9f46a84.png";

describe("optimizeHeadshot — allowlisted CDN rewrite", () => {
  it("rewrites an https CDN url to a width-bounded webp", () => {
    expect(optimizeHeadshot(CDN, { width: 384 })).toBe(`${CDN}?width=384&format=webp`);
  });

  it("defaults to a 256px webp when no width is given", () => {
    expect(optimizeHeadshot(CDN)).toBe(`${CDN}?width=256&format=webp`);
  });

  it("preserves the http scheme for http CDN urls", () => {
    const http = "http://media-cdn.incrowdsports.com/abc.png";
    expect(optimizeHeadshot(http, { width: 128 })).toBe(`${http}?width=128&format=webp`);
  });

  it("handles protocol-relative CDN urls and keeps them protocol-relative", () => {
    const rel = "//media-cdn.incrowdsports.com/abc.png";
    expect(optimizeHeadshot(rel, { width: 96 })).toBe(`${rel}?width=96&format=webp`);
  });

  it("matches the CDN host case-insensitively", () => {
    const upper = "https://MEDIA-CDN.INCROWDSPORTS.COM/abc.png";
    expect(optimizeHeadshot(upper, { width: 128 })).toBe(
      "https://media-cdn.incrowdsports.com/abc.png?width=128&format=webp"
    );
  });

  it("is idempotent — re-running overwrites params instead of stacking them", () => {
    const once = optimizeHeadshot(CDN, { width: 384 });
    expect(optimizeHeadshot(once, { width: 384 })).toBe(once);
    expect(optimizeHeadshot(once, { width: 768 })).toBe(`${CDN}?width=768&format=webp`);
  });

  it("supports a custom format", () => {
    expect(optimizeHeadshot(CDN, { width: 256, format: "avif" })).toBe(
      `${CDN}?width=256&format=avif`
    );
  });

  it("clamps out-of-range widths into [16, 2048]", () => {
    expect(optimizeHeadshot(CDN, { width: 5 })).toBe(`${CDN}?width=16&format=webp`);
    expect(optimizeHeadshot(CDN, { width: 9000 })).toBe(`${CDN}?width=2048&format=webp`);
  });

  it("falls back to the default width for invalid widths", () => {
    expect(optimizeHeadshot(CDN, { width: NaN })).toBe(`${CDN}?width=256&format=webp`);
    expect(optimizeHeadshot(CDN, { width: 0 })).toBe(`${CDN}?width=256&format=webp`);
    expect(optimizeHeadshot(CDN, { width: -10 })).toBe(`${CDN}?width=256&format=webp`);
  });
});

describe("optimizeHeadshot — pass-through (non-CDN / unexpected)", () => {
  it("returns unrelated hosts unchanged", () => {
    const url = "https://example.com/players/p.png";
    expect(optimizeHeadshot(url, { width: 256 })).toBe(url);
  });

  it("returns Wikimedia image urls unchanged", () => {
    const url =
      "https://upload.wikimedia.org/wikipedia/commons/thumb/4/49/x.jpg/500px-x.jpg";
    expect(optimizeHeadshot(url, { width: 256 })).toBe(url);
  });

  it("does NOT rewrite lookalike hosts", () => {
    const lookalike = "https://media-cdn.incrowdsports.com.evil.com/x.png";
    const subdomain = "https://evil.media-cdn.incrowdsports.com/x.png";
    expect(optimizeHeadshot(lookalike, { width: 256 })).toBe(lookalike);
    expect(optimizeHeadshot(subdomain, { width: 256 })).toBe(subdomain);
  });

  it("does NOT rewrite non-http(s) schemes on the CDN host", () => {
    const ftp = "ftp://media-cdn.incrowdsports.com/x.png";
    expect(optimizeHeadshot(ftp, { width: 256 })).toBe(ftp);
  });

  it("returns relative paths, data and blob urls unchanged", () => {
    expect(optimizeHeadshot("players/p.png", { width: 256 })).toBe("players/p.png");
    expect(optimizeHeadshot("/players/p.png", { width: 256 })).toBe("/players/p.png");
    expect(optimizeHeadshot("data:image/png;base64,AAAA", { width: 256 })).toBe(
      "data:image/png;base64,AAAA"
    );
    expect(optimizeHeadshot("blob:https://app/abc", { width: 256 })).toBe(
      "blob:https://app/abc"
    );
  });

  it("returns empty / non-string values unchanged", () => {
    expect(optimizeHeadshot("", { width: 256 })).toBe("");
    expect(optimizeHeadshot("   ", { width: 256 })).toBe("   ");
    expect(optimizeHeadshot(null, { width: 256 })).toBe(null);
    expect(optimizeHeadshot(undefined, { width: 256 })).toBe(undefined);
    expect(optimizeHeadshot(42, { width: 256 })).toBe(42);
  });
});

describe("headshotSrcSet", () => {
  it("builds a width-descriptor srcSet for CDN urls", () => {
    expect(headshotSrcSet(CDN, [384, 768])).toBe(
      `${CDN}?width=384&format=webp 384w, ${CDN}?width=768&format=webp 768w`
    );
  });

  it("builds protocol-relative entries for protocol-relative CDN urls", () => {
    const rel = "//media-cdn.incrowdsports.com/abc.png";
    expect(headshotSrcSet(rel, [384, 768])).toBe(
      `${rel}?width=384&format=webp 384w, ${rel}?width=768&format=webp 768w`
    );
  });

  it("dedupes repeated widths", () => {
    expect(headshotSrcSet(CDN, [384, 384])).toBe(`${CDN}?width=384&format=webp 384w`);
  });

  it("returns undefined for non-CDN urls", () => {
    expect(headshotSrcSet("https://example.com/p.png", [384, 768])).toBeUndefined();
  });

  it("returns undefined for empty or invalid width lists", () => {
    expect(headshotSrcSet(CDN, [])).toBeUndefined();
    expect(headshotSrcSet(CDN, null)).toBeUndefined();
    expect(headshotSrcSet(CDN)).toBeUndefined();
  });
});

describe("handleHeadshotError", () => {
  function imgWith({ src, srcset } = {}) {
    const img = document.createElement("img");
    if (src !== undefined) img.setAttribute("src", src);
    if (srcset !== undefined) img.setAttribute("srcset", srcset);
    return img;
  }

  it("retries the original url and drops srcset on the first (optimized) failure", () => {
    const original = CDN;
    const optimized = optimizeHeadshot(original, { width: 384 });
    const img = imgWith({ src: optimized, srcset: `${optimized} 384w` });
    const final = vi.fn();

    handleHeadshotError({ currentTarget: img }, original, final);

    expect(img.getAttribute("src")).toBe(original);
    expect(img.hasAttribute("srcset")).toBe(false);
    expect(final).not.toHaveBeenCalled();
  });

  it("runs the final handler once the original url also fails", () => {
    const original = CDN;
    const img = imgWith({ src: original }); // already showing the original
    const final = vi.fn();

    handleHeadshotError({ currentTarget: img }, original, final);

    expect(final).toHaveBeenCalledTimes(1);
  });

  it("goes straight to the final handler for non-CDN urls (src never changed)", () => {
    const original = "https://example.com/p.png";
    const img = imgWith({ src: original }); // optimize() left it unchanged
    const final = vi.fn();

    handleHeadshotError({ currentTarget: img }, original, final);

    expect(final).toHaveBeenCalledTimes(1);
    expect(img.getAttribute("src")).toBe(original);
  });

  it("calls the final handler when there is no usable original url", () => {
    const img = imgWith({ src: "whatever" });
    const final = vi.fn();
    handleHeadshotError({ currentTarget: img }, "", final);
    expect(final).toHaveBeenCalledTimes(1);
  });

  it("does not throw when no final handler is provided", () => {
    const img = imgWith({ src: CDN });
    expect(() => handleHeadshotError({ currentTarget: img }, CDN)).not.toThrow();
  });
});

describe("HEADSHOT_WIDTHS", () => {
  it("exposes ascending, sensible preset widths", () => {
    expect(HEADSHOT_WIDTHS.cell).toBeLessThan(HEADSHOT_WIDTHS.avatar);
    expect(HEADSHOT_WIDTHS.avatar).toBeLessThan(HEADSHOT_WIDTHS.answer);
    expect(HEADSHOT_WIDTHS.answer).toBeLessThan(HEADSHOT_WIDTHS.clue);
    expect(HEADSHOT_WIDTHS.clue).toBeLessThan(HEADSHOT_WIDTHS.clue2x);
  });
});
