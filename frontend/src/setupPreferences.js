// Shared, versioned, try/catch-safe "last setup preferences" used to restore a
// player's previous setup choices when they hit Play Again and land back on a
// setup screen.
//
// Mirrors the storage safety of identity.js. Only a small whitelist of
// non-sensitive replay choices is persisted per game. Join codes, game ids,
// guest ids, auth tokens, and player names are intentionally absent from every
// schema, so they can never be stored even if a caller passes them. Corrupt,
// stale, or out-of-range values fall back to defaults without throwing.
//
// Quick Match preset keys mirror the matchmaking preset modules
// (quickMatch.js / careerQuickMatch.js / photoQuickMatch.js /
// guessTheListRaceQuickMatch.js). If a preset key is ever renamed there, the
// stored value simply fails validation and falls back to the default badge.

const STORAGE_PREFIX = "elq_setup_prefs_v1_";

const oneOf =
  (...allowed) =>
  (value) =>
    allowed.includes(value);

const seasonInRange = (min, max) => (value) =>
  Number.isInteger(value) && value >= min && value <= max;

// Drop an inconsistent season range entirely so a corrupted store can never
// seed a start later than its end. Both fields are validated individually
// first; this only removes the pair when start > end.
function dropInconsistentSeasonRange(prefs) {
  if (
    Object.prototype.hasOwnProperty.call(prefs, "seasonStart") &&
    Object.prototype.hasOwnProperty.call(prefs, "seasonEnd") &&
    prefs.seasonStart > prefs.seasonEnd
  ) {
    const rest = { ...prefs };
    delete rest.seasonStart;
    delete rest.seasonEnd;
    return rest;
  }
  return prefs;
}

// Per-game field whitelists + validators. A field is persisted/loaded only when
// present AND valid. Anything not listed here can never be stored.
const SCHEMAS = {
  higherlower: {
    fields: {
      tier: oneOf("easy", "medium", "hard"),
      seasonStart: seasonInRange(2007, 2025),
      seasonEnd: seasonInRange(2007, 2025),
    },
    normalize: dropInconsistentSeasonRange,
  },
  tictactoe: {
    fields: {
      mode: oneOf("solo", "local", "online"),
      onlineSub: oneOf("quick", "friend"),
      friendSub: oneOf("create", "join"),
      targetWins: oneOf(2, 3, 5),
      timerMode: oneOf("15s", "40s", "unlimited"),
      quickPreset: oneOf("blitz", "standard", "long"),
    },
  },
  career: {
    fields: {
      mode: oneOf("solo", "online"),
      onlineSub: oneOf("quick", "friend"),
      friendSub: oneOf("create", "join"),
      targetWins: oneOf(1, 3, 5, 7),
      wrongGuessVisibility: oneOf("private", "shared"),
      quickPreset: oneOf("quick", "standard", "long"),
    },
  },
  photo: {
    fields: {
      mode: oneOf("solo", "online"),
      onlineSub: oneOf("quick", "friend"),
      friendSub: oneOf("create", "join"),
      targetWins: oneOf(1, 3, 5, 7),
      wrongGuessVisibility: oneOf("private", "shared"),
      quickPreset: oneOf("quick", "standard", "long"),
    },
  },
  guessTheList: {
    fields: {
      mode: oneOf("solo", "local", "online"),
      onlineGameType: oneOf("classic", "race"),
      classicSub: oneOf("create", "join"),
      raceSub: oneOf("quick", "friend"),
      friendSub: oneOf("create", "join"),
      targetWins: oneOf(2, 3, 5),
      raceTargetWins: oneOf(1, 2, 3),
      timerMode: oneOf("15s", "40s", "unlimited"),
      categoryType: oneOf(
        "roster",
        "all_time",
        "single_season",
        "all_euroleague",
        "award_winners",
        "champions",
      ),
      seasonStart: seasonInRange(2000, 2025),
      seasonEnd: seasonInRange(2000, 2025),
      quickPreset: oneOf("quick", "standard", "long"),
    },
    normalize: dropInconsistentSeasonRange,
  },
};

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
    // Storage may be unavailable (private mode, quota, disabled). Replay
    // preferences are best-effort, so degrade silently to defaults.
  }
}

function pickValidFields(fields, source) {
  const result = {};
  for (const [field, validate] of Object.entries(fields)) {
    if (
      Object.prototype.hasOwnProperty.call(source, field) &&
      validate(source[field])
    ) {
      result[field] = source[field];
    }
  }
  return result;
}

// Returns a sanitized object of known-good fields for the game, or {} when no
// usable preferences exist. Never throws.
export function loadSetupPreferences(gameKey) {
  const schema = SCHEMAS[gameKey];
  if (!schema) return {};
  const raw = readStorage(STORAGE_PREFIX + gameKey);
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const valid = pickValidFields(schema.fields, parsed);
  return schema.normalize ? schema.normalize(valid) : valid;
}

// Persists the whitelisted subset of `prefs` for the game. Unknown/invalid
// fields are dropped before writing, so callers may pass a full state snapshot.
// Never throws.
export function saveSetupPreferences(gameKey, prefs) {
  const schema = SCHEMAS[gameKey];
  if (!schema || !prefs || typeof prefs !== "object" || Array.isArray(prefs)) {
    return;
  }
  let clean = pickValidFields(schema.fields, prefs);
  if (schema.normalize) clean = schema.normalize(clean);
  writeStorage(STORAGE_PREFIX + gameKey, JSON.stringify(clean));
}
