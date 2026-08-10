// So the page can paint last-known standings before Firestore reconnects.

const PLAYLIST_PREFIX = "rgPlayerLb:playlist:v1:";
const ICON_KEY = "rgPlayerLb:iconKey:v1";
const ADMIN_ROSTER = "rgPlayerLb:adminRoster:v1";
// 1 hour. Long enough to survive a bad CDN deploy, short enough that
// nobody sees hours-stale timestamps painted from localStorage.
export const LOCAL_CACHE_TTL_MS = 60 * 60 * 1000;
// Only used for the "who's on which version" diagnostic. Writes clear
// it when the data actually changes.
export const ROSTER_CACHE_TTL_MS = 60 * 60 * 1000;

function storage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function readTimedCache(key, ttlMs = LOCAL_CACHE_TTL_MS) {
  const store = storage();
  if (!store) return null;
  try {
    const parsed = JSON.parse(store.getItem(key) || "null");
    if (!parsed || !Array.isArray(parsed.rows)) return null;
    const fetchedAt = Number(parsed.fetchedAt) || 0;
    if (!fetchedAt || Date.now() - fetchedAt > ttlMs) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeTimedCache(key, rows) {
  const store = storage();
  if (!store) return false;
  try {
    store.setItem(key, JSON.stringify({ rows, fetchedAt: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

export function readPlaylistCache(playlist) {
  return readTimedCache(`${PLAYLIST_PREFIX}${playlist}`);
}
export function writePlaylistCache(playlist, rows) {
  return writeTimedCache(`${PLAYLIST_PREFIX}${playlist}`, rows);
}
export function readIconKeyCache() {
  return readTimedCache(ICON_KEY);
}
export function writeIconKeyCache(rows) {
  return writeTimedCache(ICON_KEY, rows);
}
export function readAdminRosterCache() {
  return readTimedCache(ADMIN_ROSTER, ROSTER_CACHE_TTL_MS);
}
export function writeAdminRosterCache(rows) {
  return writeTimedCache(ADMIN_ROSTER, rows);
}
export function clearAdminRosterCache() {
  try { storage()?.removeItem(ADMIN_ROSTER); } catch {}
}
