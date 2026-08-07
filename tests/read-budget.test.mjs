import { test } from "node:test";
import assert from "node:assert/strict";

import { createReadBudget } from "../js/read-budget.js";

// ------ helpers ------

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    _map: map,
  };
}

function makeClock(startAt = 1_000_000) {
  let ms = startAt;
  return {
    now: () => ms,
    advance(by) { ms += by; },
    set(to) { ms = to; },
  };
}

function makeFakeTimers() {
  // Minimal drop-in for setTimeout / clearTimeout that flushes on demand.
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeoutImpl(fn) {
      const id = nextId++;
      pending.set(id, fn);
      return id;
    },
    clearTimeoutImpl(id) { pending.delete(id); },
    flush() {
      for (const [id, fn] of Array.from(pending.entries())) {
        pending.delete(id);
        fn();
      }
    },
    pendingCount() { return pending.size; },
  };
}

function silentLogger() {
  const calls = { warn: [], error: [], info: [], log: [] };
  return {
    logger: {
      warn: (...args) => calls.warn.push(args),
      error: (...args) => calls.error.push(args),
      info: (...args) => calls.info.push(args),
      log: (...args) => calls.log.push(args),
    },
    calls,
  };
}

const STORAGE_KEY = "rgLB:readBudget:test";

// ------ tests ------

test("charge accumulates and snapshot reflects it", () => {
  const clock = makeClock();
  const { logger } = silentLogger();
  const timers = makeFakeTimers();
  const b = createReadBudget({
    soft: 100, hard: 200, windowMs: 60_000,
    storageKey: STORAGE_KEY,
    storage: makeStorage(),
    now: clock.now,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    logger,
  });

  b.charge("a", 3);
  b.charge("b", 5);
  b.charge("a", 2);
  const snap = b.snapshot();
  assert.equal(snap.total, 10);
  assert.equal(snap.perLabel.a, 5);
  assert.equal(snap.perLabel.b, 5);
  assert.equal(snap.tripped, false);
});

test("charge coerces sub-1 counts up to 1 (mirrors HUD logRead)", () => {
  const clock = makeClock();
  const { logger } = silentLogger();
  const b = createReadBudget({
    soft: 100, hard: 200, windowMs: 60_000,
    storageKey: STORAGE_KEY, storage: makeStorage(),
    now: clock.now, logger,
  });
  b.charge("empty-snap", 0);
  b.charge("neg", -3);
  b.charge("nan", NaN);
  const snap = b.snapshot();
  assert.equal(snap.total, 3);
});

test("window reset after windowMs clears counters but preserves cool-off", () => {
  const clock = makeClock();
  const { logger } = silentLogger();
  const storage = makeStorage();
  const b = createReadBudget({
    soft: 10, hard: 20, windowMs: 60_000,
    storageKey: STORAGE_KEY, storage,
    now: clock.now, logger,
  });

  b.charge("foo", 5);
  assert.equal(b.snapshot().total, 5);

  // Advance past the window boundary.
  clock.advance(60_001);
  b.charge("foo", 2);
  const snap = b.snapshot();
  assert.equal(snap.total, 2, "new window should have reset the counter");
  assert.equal(snap.perLabel.foo, 2);
});

test("soft trip fires warning exactly once per window", () => {
  const clock = makeClock();
  const { logger, calls } = silentLogger();
  const b = createReadBudget({
    soft: 10, hard: 1000, windowMs: 60_000,
    storageKey: STORAGE_KEY, storage: makeStorage(),
    now: clock.now, logger,
  });

  b.charge("x", 11);
  b.charge("x", 5);
  b.charge("x", 5);
  assert.equal(calls.warn.length, 1, "soft warn should fire exactly once");

  // New window should re-arm the soft warning.
  clock.advance(60_001);
  b.charge("x", 20);
  assert.equal(calls.warn.length, 2, "new window should re-arm soft warn");
});

test("hard trip sets trippedUntil and isTripped survives simulated reload", () => {
  const clock = makeClock(2_000_000);
  const { logger } = silentLogger();
  const storage = makeStorage();
  const b1 = createReadBudget({
    soft: 10, hard: 20, windowMs: 60_000,
    storageKey: STORAGE_KEY, storage,
    now: clock.now, logger,
  });

  let tripSnap = null;
  b1.onTrip((snap) => { tripSnap = snap; });

  b1.charge("burst", 21);
  assert.equal(b1.isTripped(), true);
  assert.ok(tripSnap && tripSnap.tripped, "trip callback should have fired");
  assert.ok(tripSnap.trippedUntil > clock.now(), "cool-off should extend past now");

  // Simulated reload: fresh instance reads same storage.
  const b2 = createReadBudget({
    soft: 10, hard: 20, windowMs: 60_000,
    storageKey: STORAGE_KEY, storage,
    now: clock.now, logger,
  });
  assert.equal(b2.isTripped(), true, "reload during cool-off should stay tripped");

  // After 15 minutes, cool-off expires.
  clock.advance(15 * 60_000 + 1);
  assert.equal(b2.isTripped(), false, "cool-off should expire after 15 minutes");
});

test("debounced flush persists via fake setTimeout", () => {
  const clock = makeClock();
  const { logger } = silentLogger();
  const storage = makeStorage();
  const timers = makeFakeTimers();
  const b = createReadBudget({
    soft: 1000, hard: 2000, windowMs: 60_000,
    storageKey: STORAGE_KEY, storage,
    now: clock.now,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    logger,
  });

  b.charge("a", 3);
  b.charge("a", 4);
  // Before the timer fires, storage may only have seed state (empty).
  assert.equal(timers.pendingCount(), 1, "one debounced flush scheduled");

  timers.flush();
  const persisted = JSON.parse(storage.getItem(STORAGE_KEY));
  assert.equal(persisted.total, 7);
  assert.equal(persisted.perLabel.a, 7);
});

test("labels are tallied independently", () => {
  const clock = makeClock();
  const { logger } = silentLogger();
  const b = createReadBudget({
    soft: 1000, hard: 2000, windowMs: 60_000,
    storageKey: STORAGE_KEY, storage: makeStorage(),
    now: clock.now, logger,
  });
  b.charge("leaderboardFallback", 10);
  b.charge("iconKey", 4);
  b.charge("adminRoster", 100);
  b.charge("leaderboardFallback", 5);
  const snap = b.snapshot();
  assert.equal(snap.total, 119);
  assert.deepEqual(snap.perLabel, {
    leaderboardFallback: 15,
    iconKey: 4,
    adminRoster: 100,
  });
});

test("reset clears counters but not trippedUntil unless resetTrip:true", () => {
  const clock = makeClock();
  const { logger } = silentLogger();
  const storage = makeStorage();
  const b = createReadBudget({
    soft: 10, hard: 20, windowMs: 60_000,
    storageKey: STORAGE_KEY, storage,
    now: clock.now, logger,
  });

  b.charge("x", 25);
  assert.equal(b.isTripped(), true);

  b.reset();
  const snap = b.snapshot();
  assert.equal(snap.total, 0);
  assert.deepEqual(snap.perLabel, {});
  assert.equal(b.isTripped(), true, "reset() alone should NOT clear cool-off");

  b.reset({ resetTrip: true });
  assert.equal(b.isTripped(), false, "reset({ resetTrip: true }) clears cool-off");
});

test("onTrip returns an unsubscribe function", () => {
  const clock = makeClock();
  const { logger } = silentLogger();
  const b = createReadBudget({
    soft: 10, hard: 20, windowMs: 60_000,
    storageKey: STORAGE_KEY, storage: makeStorage(),
    now: clock.now, logger,
  });
  let fired = 0;
  const off = b.onTrip(() => { fired++; });
  off();
  b.charge("x", 30);
  assert.equal(fired, 0, "unsubscribed listener should not fire");
});

test("trip does not multi-fire when charges keep landing after tripping", () => {
  const clock = makeClock();
  const { logger } = silentLogger();
  const b = createReadBudget({
    soft: 10, hard: 20, windowMs: 60_000,
    storageKey: STORAGE_KEY, storage: makeStorage(),
    now: clock.now, logger,
  });
  let fired = 0;
  b.onTrip(() => { fired++; });
  b.charge("x", 21);
  b.charge("x", 5);
  b.charge("x", 5);
  assert.equal(fired, 1, "trip should fire exactly once per active window");
});
