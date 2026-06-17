// Lightweight, client-side guest identity shared across every setup screen.
//
// - `guest_id` is a stable, opaque token generated once and persisted in
//   localStorage. The backend treats it as untrusted and never requires it, so
//   anonymous play keeps working even when storage is unavailable.
// - `nickname` persists separately and prefills the "Your Name" field on every
//   setup screen.

const GUEST_ID_KEY = "elq_guest_id";
const NICKNAME_KEY = "elq_nickname";
const LEGACY_NICKNAME_KEY = "hol_nickname";

export const NICKNAME_MAX_LENGTH = 30;
const GUEST_ID_MAX_LENGTH = 64;

// Fallback used only when localStorage cannot retain the guest id (private mode,
// quota, disabled storage). Keeps the id stable for the page lifetime so calls
// that must agree on it — Quick Match create then cancel — use the same token.
let memoryGuestId = null;

function readStorage(key) {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Storage may be unavailable (private mode, quota, disabled cookies).
  }
}

function removeStorage(key) {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    // Ignore — see writeStorage.
  }
}

function generateGuestId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function getGuestId() {
  const stored = readStorage(GUEST_ID_KEY);
  if (
    typeof stored === "string" &&
    stored.trim().length > 0 &&
    stored.length <= GUEST_ID_MAX_LENGTH
  ) {
    return stored;
  }
  // Storage couldn't supply a usable id. If a previous call already minted one
  // that storage refused to retain, reuse it so the id stays stable for the page
  // lifetime — Quick Match cancel and self-match prevention key on a consistent
  // guest_id, so a token that changes per call would break them.
  if (memoryGuestId) return memoryGuestId;
  const guestId = generateGuestId();
  writeStorage(GUEST_ID_KEY, guestId);
  if (readStorage(GUEST_ID_KEY) !== guestId) {
    memoryGuestId = guestId;
  }
  return guestId;
}

export function getNickname() {
  const stored = readStorage(NICKNAME_KEY);
  if (typeof stored === "string" && stored.length > 0) return stored;
  // One-time migration from the legacy Higher or Lower nickname key. Remove the
  // legacy key so it can't resurrect a cleared nickname on a later read.
  const legacy = readStorage(LEGACY_NICKNAME_KEY);
  if (typeof legacy === "string" && legacy.trim().length > 0) {
    const migrated = legacy.trim().slice(0, NICKNAME_MAX_LENGTH);
    writeStorage(NICKNAME_KEY, migrated);
    removeStorage(LEGACY_NICKNAME_KEY);
    return migrated;
  }
  removeStorage(LEGACY_NICKNAME_KEY);
  return "";
}

export function setNickname(name) {
  const trimmed = (name ?? "").trim().slice(0, NICKNAME_MAX_LENGTH);
  if (trimmed) {
    writeStorage(NICKNAME_KEY, trimmed);
  } else {
    removeStorage(NICKNAME_KEY);
  }
  // Once the nickname is managed through the shared key, drop the legacy key
  // so a stale Higher or Lower value can't reappear after the user clears it.
  removeStorage(LEGACY_NICKNAME_KEY);
  return trimmed;
}
