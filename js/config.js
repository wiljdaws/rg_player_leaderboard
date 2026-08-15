export const FIREBASE_CONFIG = Object.freeze({
  apiKey: "AIzaSyD29s2Jku_DZ42keIQAETgKg7HWt__QEwY",
  authDomain: "rgleaderboard.firebaseapp.com",
  projectId: "rgleaderboard",
  storageBucket: "rgleaderboard.firebasestorage.app",
  messagingSenderId: "247848634543",
  appId: "1:247848634543:web:6a7e506d60544d46cc6c5a",
  measurementId: "G-JW3Q972P9T",
});

export const PLAYLISTS = Object.freeze(["1v1", "2v2", "3v3", "wins", "tournament"]);

export const PLAYLIST_LABELS = Object.freeze({
  "1v1": "1v1 Ranked",
  "2v2": "2v2 Ranked",
  "3v3": "3v3 Ranked",
  wins: "Wins",
  tournament: "Tournament",
});

export const MAX_PLAYLIST_ROWS = 100;

export const ADMIN_EMAILS = Object.freeze([
  "underflagfg@gmail.com",
  "therootedengineer@gmail.com",
]);

// Pinned so an upstream SDK change can't quietly break the site.
export const SDK = "10.12.2";

// Read-path source selection. Firestore is the historical default; "static"
// serves public reads from a pre-built JSON blob on the CDN so HUD writes no
// longer charge N reads across every open tab.
export const READ_SOURCE_MODES = Object.freeze(["firestore", "static"]);
export const READ_SOURCE_DEFAULT = "static";

// Served straight from GitHub raw. jsDelivr's branch-alias cache holds files
// for ~12h and purges get rate-limited at 1-min publish cadence, so we skip
// the CDN and let clients revalidate against the origin via ETag.
export const STATIC_JSON_URL_TEMPLATE =
  "https://raw.githubusercontent.com/wiljdaws/rg_player_leaderboard/data/leaderboard/{playlist}.json";
// Every 60s — CDN is refreshed every ~1 min now so anything longer just
// stalls the tooltip's "X ago" text.
export const STATIC_JSON_POLL_MS = 60_000;
// Falls back to firestore on repeated fetch errors so a bad CDN deploy can't
// take the site down.
export const STATIC_JSON_MAX_CONSECUTIVE_FAILURES = 3;

const READ_SOURCE_STORAGE_KEY = "rgPlayerLb:readSource";

function normalizeReadSource(value) {
  return READ_SOURCE_MODES.includes(value) ? value : null;
}

function safeLocalStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

// Priority: URL param > localStorage > default. `?readSource=static&persist=1`
// writes the choice to localStorage so we can bucket users during rollout
// without a redeploy; `?readSource=firestore` (or any invalid value) clears
// the persisted value when persist=1 is present.
export function resolveReadSource({ url = null, storage = safeLocalStorage() } = {}) {
  let params = null;
  try {
    if (url) {
      params = new URL(url).searchParams;
    } else if (typeof globalThis !== "undefined" && globalThis.location?.href) {
      params = new URL(globalThis.location.href).searchParams;
    }
  } catch {
    params = null;
  }

  const paramValue = params ? normalizeReadSource(params.get("readSource")) : null;
  const persist = params ? params.get("persist") === "1" : false;

  if (paramValue) {
    if (persist && storage) {
      try { storage.setItem(READ_SOURCE_STORAGE_KEY, paramValue); } catch {}
    }
    return paramValue;
  }

  // If persist=1 was passed with an invalid readSource, treat it as "clear."
  if (persist && storage && params && params.has("readSource")) {
    try { storage.removeItem(READ_SOURCE_STORAGE_KEY); } catch {}
  }

  if (storage) {
    try {
      const stored = normalizeReadSource(storage.getItem(READ_SOURCE_STORAGE_KEY));
      if (stored) return stored;
    } catch {}
  }

  return READ_SOURCE_DEFAULT;
}

export function isPlaylist(value) {
  return PLAYLISTS.includes(value);
}

export function isAdminUser(user) {
  return Boolean(user?.email && ADMIN_EMAILS.includes(user.email));
}

// Visitors stay on the published JSON. Live Firestore reads are for
// the tournament tab (small, public) and for signed-in admins.
export function publicPlaylistUsesLiveFirestore({ playlist, source, isAdmin } = {}) {
  if (playlist === "tournament") return true;
  return Boolean(isAdmin) && source === "firestore";
}

export function publicPlaylistAllowsFirestoreFallback(isAdmin) {
  return Boolean(isAdmin);
}

export function isRankedPlaylist(playlist) {
  return playlist === "1v1" || playlist === "2v2" || playlist === "3v3";
}
