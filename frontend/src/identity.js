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
  if (typeof stored === "string" && stored.length > 0 && stored.length <= GUEST_ID_MAX_LENGTH) {
    return stored;
  }
  const guestId = generateGuestId();
  writeStorage(GUEST_ID_KEY, guestId);
  return guestId;
}

export function getNickname() {
  const stored = readStorage(NICKNAME_KEY);
  if (typeof stored === "string" && stored.length > 0) return stored;
  // One-time migration from the legacy Higher or Lower nickname key.
  const legacy = readStorage(LEGACY_NICKNAME_KEY);
  if (typeof legacy === "string" && legacy.trim().length > 0) {
    const migrated = legacy.trim().slice(0, NICKNAME_MAX_LENGTH);
    writeStorage(NICKNAME_KEY, migrated);
    return migrated;
  }
  return "";
}

export function setNickname(name) {
  const trimmed = (name ?? "").trim().slice(0, NICKNAME_MAX_LENGTH);
  if (trimmed) {
    writeStorage(NICKNAME_KEY, trimmed);
  } else {
    removeStorage(NICKNAME_KEY);
  }
  return trimmed;
}
