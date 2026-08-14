// Token-bucket rate limiter for the admin dashboard's Firestore fallback
// path. Defense-in-depth only: the primary cost guard is the CDN snapshot
// in read-stats-query.js, which serves ~99% of dashboard loads. This layer
// caps the remaining Firestore-fallback branch to N fetches/hour per
// browser so a future bug can't re-open the floodgate.
//
// Semantics: whole-bucket refill (not smooth). When tokens hit 0, fetches
// are refused until `refillAt` — at that point the bucket resets to full
// capacity. Persisted in localStorage so refresh + tab-close both count
// against the same hourly budget.

const DEFAULT_CAPACITY = 5;
const DEFAULT_REFILL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_STORAGE_KEY = "rgLB:readStatsFallback:tokenBucket:v1";

function safeStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function readState(storage, storageKey) {
  if (!storage) return null;
  let raw;
  try {
    raw = storage.getItem(storageKey);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const tokens = Number(parsed.tokens);
    const refillAt = Number(parsed.refillAt);
    if (!Number.isFinite(tokens) || !Number.isFinite(refillAt)) return null;
    return { tokens, refillAt };
  } catch {
    return null;
  }
}

function writeState(storage, storageKey, state) {
  if (!storage) return;
  try {
    storage.setItem(storageKey, JSON.stringify(state));
  } catch {
    // Quota / private mode — the limiter degrades to in-memory only.
  }
}

// Normalizes stored state against the current clock. If `refillAt` has
// elapsed OR state is missing/corrupt, returns a fresh full bucket.
function refreshedState(stored, capacity, refillMs, nowMs) {
  if (!stored || nowMs >= stored.refillAt) {
    return { tokens: capacity, refillAt: nowMs + refillMs };
  }
  // Clamp tokens into [0, capacity] to survive schema drift.
  const tokens = Math.max(0, Math.min(capacity, stored.tokens));
  return { tokens, refillAt: stored.refillAt };
}

export function createTokenBucket({
  capacity = DEFAULT_CAPACITY,
  refillMs = DEFAULT_REFILL_MS,
  storage = safeStorage(),
  now = () => Date.now(),
  storageKey = DEFAULT_STORAGE_KEY,
} = {}) {
  function load() {
    return refreshedState(readState(storage, storageKey), capacity, refillMs, now());
  }

  function tryConsume() {
    const state = load();
    if (state.tokens <= 0) {
      return { ok: false, msUntilRefill: Math.max(0, state.refillAt - now()) };
    }
    const next = { tokens: state.tokens - 1, refillAt: state.refillAt };
    writeState(storage, storageKey, next);
    return { ok: true };
  }

  function peek() {
    const state = load();
    return { tokens: state.tokens, msUntilRefill: Math.max(0, state.refillAt - now()) };
  }

  function reset() {
    writeState(storage, storageKey, { tokens: capacity, refillAt: now() + refillMs });
  }

  return { tryConsume, peek, reset };
}
