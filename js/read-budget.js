// Runtime Firestore read budget.
//
// Copies the HUD's logRead pattern (rg_hud.user.js:1461-1514) — module-scoped
// counters, rolling windows, charge(label, count) increments by
// Math.max(1, snapshot.size || 1) — MINUS the per-op console.log tax. On the
// site we chatter with Firestore an order of magnitude more than the HUD, so
// logging every read would itself be a perf tax.
//
// Public surface is `createReadBudget({ soft, hard, windowMs, storageKey })`
// returning `{ charge, snapshot, reset, onTrip, isTripped }`.
//
// Persistence: window state is debounced to localStorage on a 5s timer so a
// storm of charges doesn't turn into a storm of setItem calls. The
// `trippedUntil` flag is persisted with the same debounce; a reload during
// the cool-off window sees `isTripped() === true` and the gateway can
// short-circuit before spinning up any listeners.

const FIFTEEN_MIN_MS = 15 * 60_000;
const DEFAULT_STORAGE_KEY = "rgLB:readBudget:v1";
const FLUSH_DEBOUNCE_MS = 5_000;

// Small helper so tests can inject a fake clock / storage / setTimeout.
function safeStorage(storage) {
  if (!storage) return null;
  try {
    const probeKey = "__rgLB_probe__";
    storage.setItem(probeKey, "1");
    storage.removeItem(probeKey);
    return storage;
  } catch {
    return null;
  }
}

function readPersisted(storage, key) {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function createReadBudget(options = {}) {
  const {
    soft = 500,
    hard = 2000,
    windowMs = 60 * 60_000,
    storageKey = DEFAULT_STORAGE_KEY,
    storage = typeof localStorage !== "undefined" ? localStorage : null,
    now = () => Date.now(),
    setTimeoutImpl = typeof setTimeout !== "undefined" ? setTimeout : null,
    clearTimeoutImpl = typeof clearTimeout !== "undefined" ? clearTimeout : null,
    logger = typeof console !== "undefined" ? console : null,
  } = options;

  const store = safeStorage(storage);

  // Seed from persisted state so a page reload lands on the same window and
  // any active cool-off flag survives.
  const seed = readPersisted(store, storageKey) || {};
  const nowMs = now();

  let windowStartMs = Number.isFinite(seed.windowStartMs) ? seed.windowStartMs : nowMs;
  let total = Number.isFinite(seed.total) ? seed.total : 0;
  let perLabel = seed.perLabel && typeof seed.perLabel === "object" ? { ...seed.perLabel } : {};
  let trippedUntil = Number.isFinite(seed.trippedUntil) ? seed.trippedUntil : 0;
  let softWarnedForWindow = Boolean(seed.softWarnedForWindow);
  const tripListeners = new Set();
  // Track whether we've already fired trip listeners for the current cool-off
  // so we don't multi-fire on repeated charges after tripping.
  let firedTripForActiveWindow = trippedUntil > nowMs;

  // If the persisted window is already expired at boot, roll it forward so
  // the very first charge doesn't get pooled into stale counters.
  if (nowMs - windowStartMs > windowMs) {
    windowStartMs = nowMs;
    total = 0;
    perLabel = {};
    softWarnedForWindow = false;
  }

  let flushHandle = null;
  let flushDirty = false;

  function persistNow() {
    if (!store) return;
    try {
      store.setItem(
        storageKey,
        JSON.stringify({
          total,
          perLabel,
          windowStartMs,
          windowMs,
          trippedUntil,
          softWarnedForWindow,
        }),
      );
    } catch {
      // localStorage full or unavailable — the counter is best-effort.
    }
    flushDirty = false;
  }

  function scheduleFlush() {
    flushDirty = true;
    if (!setTimeoutImpl) {
      // No timer available — flush eagerly so callers still get persistence.
      persistNow();
      return;
    }
    if (flushHandle != null) return;
    flushHandle = setTimeoutImpl(() => {
      flushHandle = null;
      if (flushDirty) persistNow();
    }, FLUSH_DEBOUNCE_MS);
  }

  function rollWindowIfNeeded(atMs) {
    if (atMs - windowStartMs <= windowMs) return false;
    windowStartMs = atMs;
    total = 0;
    perLabel = {};
    softWarnedForWindow = false;
    // Do NOT clear trippedUntil — the cool-off is independent of the window.
    // We only clear firedTripForActiveWindow once the cool-off itself expires
    // (checked lazily in charge/isTripped).
    return true;
  }

  function isTripped() {
    return trippedUntil > now();
  }

  function charge(label, count = 1) {
    const at = now();
    const charged = Math.max(1, Number(count) || 1);
    const rolled = rollWindowIfNeeded(at);

    // Cool-off expiry: once trippedUntil elapses, allow future trip listeners.
    if (firedTripForActiveWindow && trippedUntil <= at) {
      firedTripForActiveWindow = false;
      trippedUntil = 0;
    }

    total += charged;
    const safeLabel = typeof label === "string" && label ? label : "unlabeled";
    perLabel[safeLabel] = (perLabel[safeLabel] || 0) + charged;

    // Soft cap: warn once per window.
    if (total > soft && !softWarnedForWindow) {
      softWarnedForWindow = true;
      logger?.warn?.(
        `[rgLB] read budget soft cap crossed: ${total}/${soft} in current window`,
      );
    }

    // Hard cap: trip once. Set cool-off, fire listeners, persist eagerly so
    // a reload immediately after the trip inherits the cool-off.
    if (total > hard && !firedTripForActiveWindow) {
      firedTripForActiveWindow = true;
      trippedUntil = at + FIFTEEN_MIN_MS;
      persistNow(); // synchronous — the trip is load-bearing
      const snap = snapshot();
      for (const cb of tripListeners) {
        try { cb(snap); } catch (err) { logger?.error?.("[rgLB] trip listener threw", err); }
      }
    } else if (rolled) {
      scheduleFlush();
    } else {
      scheduleFlush();
    }
  }

  function snapshot() {
    return {
      total,
      perLabel: { ...perLabel },
      tripped: isTripped(),
      softTripped: total > soft,
      windowStartMs,
      windowMs,
      soft,
      hard,
      trippedUntil,
    };
  }

  function reset(opts = {}) {
    total = 0;
    perLabel = {};
    windowStartMs = now();
    softWarnedForWindow = false;
    if (opts.resetTrip) {
      trippedUntil = 0;
      firedTripForActiveWindow = false;
    }
    persistNow();
    if (flushHandle != null && clearTimeoutImpl) {
      clearTimeoutImpl(flushHandle);
      flushHandle = null;
      flushDirty = false;
    }
  }

  function onTrip(callback) {
    if (typeof callback !== "function") return () => {};
    tripListeners.add(callback);
    return () => tripListeners.delete(callback);
  }

  return {
    charge,
    snapshot,
    reset,
    onTrip,
    isTripped,
  };
}
