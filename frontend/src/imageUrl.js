// Helpers for serving small, modern-format player headshots from the EuroLeague
// CDN. The CDN (`media-cdn.incrowdsports.com`) ships ~2.4 MB PNGs that the boards
// render at tiny sizes, which slows the correct-guess reveal. Requesting a
// width-bounded WebP (`?width=N&format=webp`) cuts a headshot from ~2.4 MB to a
// few KB. Only this exact, allowlisted host is rewritten; every other URL passes
// through untouched so unexpected/self-hosted images keep working.

const CDN_HOST = "media-cdn.incrowdsports.com";

const MIN_WIDTH = 16;
const MAX_WIDTH = 2048;
const DEFAULT_WIDTH = 256;
const DEFAULT_FORMAT = "webp";

// Width presets sized to the rendered CSS box with headroom for high-DPI (2-3x)
// screens. The CDN preserves aspect ratio, so only width is requested.
export const HEADSHOT_WIDTHS = {
  cell: 96, // TicTacToe claimed cell (~24px rendered)
  avatar: 128, // roster / axis avatars (~36-40px rendered)
  answer: 256, // Career / Photo answer reveal (~80px rendered)
  clue: 384, // Photo Quiz clue base (max-w-sm = 384px)
  clue2x: 768, // Photo Quiz clue high-DPI candidate
};

function clampWidth(width) {
  const n = Math.round(Number(width));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n));
}

// Returns `{ url, protocolRelative }` when `value` is an http(s) URL on the
// allowlisted CDN host, otherwise `null` (caller passes the value through).
// Handles absolute `http`/`https` and protocol-relative (`//host/...`) URLs.
function parseCdnUrl(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const protocolRelative = value.startsWith("//");
  let parsed;
  try {
    parsed = new URL(protocolRelative ? `https:${value}` : value);
  } catch {
    return null; // relative path, data:/blob:, or otherwise unparseable
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.hostname.toLowerCase() !== CDN_HOST) return null;
  return { url: parsed, protocolRelative };
}

function serialize(parsed, protocolRelative) {
  const out = parsed.toString();
  return protocolRelative ? out.replace(/^https:/, "") : out;
}

// Rewrites an allowlisted CDN headshot URL to a width-bounded modern format.
// Any non-string, non-CDN, or unexpected URL is returned unchanged. Idempotent:
// re-running overwrites the `width`/`format` params rather than stacking them.
export function optimizeHeadshot(url, { width, format = DEFAULT_FORMAT } = {}) {
  const cdn = parseCdnUrl(url);
  if (!cdn) return url;
  cdn.url.searchParams.set("width", String(clampWidth(width)));
  cdn.url.searchParams.set("format", format);
  return serialize(cdn.url, cdn.protocolRelative);
}

// Builds a `srcSet` string for responsive / high-DPI CDN headshots. Returns
// `undefined` for non-CDN URLs (and empty/invalid width lists) so callers fall
// back to a plain `src` with no `srcSet`/`sizes`.
export function headshotSrcSet(url, widths, { format = DEFAULT_FORMAT } = {}) {
  if (!Array.isArray(widths) || widths.length === 0) return undefined;
  if (!parseCdnUrl(url)) return undefined;
  const seen = new Set();
  const entries = [];
  for (const w of widths) {
    const cw = clampWidth(w);
    if (seen.has(cw)) continue;
    seen.add(cw);
    entries.push(`${optimizeHeadshot(url, { width: cw, format })} ${cw}w`);
  }
  return entries.length ? entries.join(", ") : undefined;
}

// Framework-free `<img onError>` handler. On the first failure of an optimized
// source it retries the ORIGINAL url (dropping `srcSet` so the browser uses the
// plain `src`); if the original also fails — or the url was never rewritten — it
// runs `finalHandler` (the board's existing hide / placeholder behavior).
// Comparing the live `src` attribute, rather than a sticky flag, keeps this
// correct when React reuses an <img> node for a different url.
export function handleHeadshotError(event, originalUrl, finalHandler) {
  const img = event?.currentTarget;
  if (
    img &&
    typeof originalUrl === "string" &&
    originalUrl !== "" &&
    img.getAttribute("src") !== originalUrl
  ) {
    img.removeAttribute("srcset");
    img.src = originalUrl;
    return;
  }
  if (typeof finalHandler === "function") finalHandler(event);
}
