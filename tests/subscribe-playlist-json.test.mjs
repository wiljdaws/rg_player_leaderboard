import { test } from "node:test";
import assert from "node:assert/strict";

// Stub localStorage before importing anything that reaches for it. The JSON
// path calls readPlaylistCache/writePlaylistCache, which look at
// globalThis.localStorage.
const _localStorageMap = new Map();
globalThis.localStorage = {
  getItem: (key) => (_localStorageMap.has(key) ? _localStorageMap.get(key) : null),
  setItem: (key, value) => { _localStorageMap.set(key, String(value)); },
  removeItem: (key) => { _localStorageMap.delete(key); },
  clear: () => { _localStorageMap.clear(); },
};

const { subscribePlaylistJson } = await import("../js/firebase.js");

function makeResponse({ status = 200, body = null, etag = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name.toLowerCase() === "etag" ? etag : null) },
    json: async () => body,
  };
}

function makeSchedulers() {
  const timers = [];
  return {
    setInterval: (fn) => {
      const handle = { fn, cleared: false };
      timers.push(handle);
      return handle;
    },
    clearInterval: (handle) => {
      if (handle) handle.cleared = true;
    },
    tick: async (handle) => {
      if (handle && !handle.cleared) await handle.fn();
    },
    timers,
  };
}

function makeHandlers() {
  const nexts = [];
  const errors = [];
  return {
    handlers: {
      next: (payload) => nexts.push(payload),
      error: (err) => errors.push(err),
    },
    nexts,
    errors,
  };
}

test("subscribePlaylistJson emits rows on happy-path fetch", async () => {
  _localStorageMap.clear();
  const rows = [
    { id: "a_1v1", playlist: "1v1", name: "A", mmr: 20000 },
    { id: "b_1v1", playlist: "1v1", name: "B", mmr: 19000 },
  ];
  const fetchImpl = async (url) => {
    assert.match(url, /leaderboard-1v1\.json$/);
    return makeResponse({ status: 200, body: { rows }, etag: '"abc"' });
  };
  const sched = makeSchedulers();
  const { handlers, nexts, errors } = makeHandlers();

  const unsubscribe = subscribePlaylistJson("1v1", handlers, {
    fetch: fetchImpl,
    setInterval: sched.setInterval,
    clearInterval: sched.clearInterval,
    urlTemplate: "https://cdn.test/leaderboard-{playlist}.json",
    pollMs: 30_000,
    maxFailures: 3,
    logger: { info: () => {}, error: () => {} },
  });

  // First poll runs synchronously inside subscribePlaylistJson; await one
  // microtask flush by awaiting a resolved promise.
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(errors.length, 0);
  assert.equal(nexts.length, 1);
  assert.deepEqual(nexts[0].rows, rows);
  assert.equal(nexts[0].fromCache, false);

  unsubscribe();
  assert.ok(sched.timers[0].cleared, "interval should be cleared on unsubscribe");
});

test("subscribePlaylistJson sends If-None-Match after first successful fetch", async () => {
  _localStorageMap.clear();
  const seenHeaders = [];
  let call = 0;
  const fetchImpl = async (_url, init) => {
    seenHeaders.push({ ...(init?.headers || {}) });
    call += 1;
    if (call === 1) {
      return makeResponse({ status: 200, body: { rows: [{ id: "x" }] }, etag: '"v1"' });
    }
    return makeResponse({ status: 304 });
  };
  const sched = makeSchedulers();
  const { handlers, nexts, errors } = makeHandlers();

  const unsubscribe = subscribePlaylistJson("1v1", handlers, {
    fetch: fetchImpl,
    setInterval: sched.setInterval,
    clearInterval: sched.clearInterval,
    urlTemplate: "https://cdn.test/leaderboard-{playlist}.json",
    pollMs: 30_000,
    maxFailures: 3,
    logger: { info: () => {}, error: () => {} },
  });

  await Promise.resolve();
  await Promise.resolve();

  // Trigger the scheduled tick manually.
  await sched.tick(sched.timers[0]);

  assert.equal(seenHeaders.length, 2);
  assert.equal(seenHeaders[0]["If-None-Match"], undefined);
  assert.equal(seenHeaders[1]["If-None-Match"], '"v1"');
  // 304 must not re-emit next.
  assert.equal(nexts.length, 1);
  assert.equal(errors.length, 0);

  unsubscribe();
});

test("subscribePlaylistJson falls back to firestore after 3 consecutive failures", async () => {
  _localStorageMap.clear();
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    return makeResponse({ status: 500 });
  };
  const sched = makeSchedulers();
  const { handlers, nexts, errors } = makeHandlers();

  let fallbackCalledWith = null;
  let fallbackUnsubbed = false;
  const firestoreFallback = (playlist, handlersForFallback) => {
    fallbackCalledWith = { playlist, handlersForFallback };
    return () => { fallbackUnsubbed = true; };
  };

  const unsubscribe = subscribePlaylistJson("1v1", handlers, {
    fetch: fetchImpl,
    setInterval: sched.setInterval,
    clearInterval: sched.clearInterval,
    urlTemplate: "https://cdn.test/leaderboard-{playlist}.json",
    pollMs: 30_000,
    maxFailures: 3,
    firestoreFallback,
    logger: { info: () => {}, error: () => {} },
  });

  // First poll runs on kick-off.
  await Promise.resolve();
  await Promise.resolve();
  // Two more scheduled ticks.
  await sched.tick(sched.timers[0]);
  await sched.tick(sched.timers[0]);

  assert.equal(fetchCalls, 3, "should attempt fetch three times before falling back");
  assert.equal(errors.length, 1, "should emit one wrapped error on threshold");
  assert.match(errors[0].message, /falling back to Firestore/);
  assert.ok(fallbackCalledWith, "firestore fallback should have been invoked");
  assert.equal(fallbackCalledWith.playlist, "1v1");
  assert.equal(fallbackCalledWith.handlersForFallback, handlers);
  assert.ok(sched.timers[0].cleared, "polling interval should be cleared when fallback kicks in");

  unsubscribe();
  assert.ok(fallbackUnsubbed, "fallback unsubscribe should be called on top-level unsubscribe");
});

test("subscribePlaylistJson emits changes:[] on first poll and deltas on subsequent polls", async () => {
  _localStorageMap.clear();
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    if (call === 1) {
      return makeResponse({
        status: 200,
        body: {
          rows: [
            { id: "a_1v1", mmr: 1200, currentStreak: 4 },
            { id: "gone_1v1", mmr: 1100, currentStreak: 0 },
          ],
        },
        etag: '"v1"',
      });
    }
    return makeResponse({
      status: 200,
      body: {
        rows: [
          { id: "a_1v1", mmr: 1245, currentStreak: 5 },
          { id: "newguy_1v1", mmr: 1150, currentStreak: 0 },
        ],
      },
      etag: '"v2"',
    });
  };
  const sched = makeSchedulers();
  const { handlers, nexts, errors } = makeHandlers();

  const unsubscribe = subscribePlaylistJson("1v1", handlers, {
    fetch: fetchImpl,
    setInterval: sched.setInterval,
    clearInterval: sched.clearInterval,
    urlTemplate: "https://cdn.test/leaderboard-{playlist}.json",
    pollMs: 30_000,
    maxFailures: 3,
    logger: { info: () => {}, error: () => {} },
  });

  await Promise.resolve();
  await Promise.resolve();

  // First poll: no baseline yet → changes:[]
  assert.equal(errors.length, 0);
  assert.equal(nexts.length, 1);
  assert.deepEqual(nexts[0].changes, []);

  await sched.tick(sched.timers[0]);

  // Second poll: MMR up on a, streak up on a, newguy entered, gone_1v1 left.
  assert.equal(nexts.length, 2);
  assert.deepEqual(nexts[1].changes, [
    { id: "a_1v1", kind: "mmr-up", from: 1200, to: 1245 },
    { id: "a_1v1", kind: "streak-up", from: 4, to: 5 },
    { id: "newguy_1v1", kind: "entered-top100" },
    { id: "gone_1v1", kind: "left-top100" },
  ]);

  unsubscribe();
});

test("subscribePlaylistJson paints from local cache before first fetch", async () => {
  _localStorageMap.clear();
  // Seed the localStorage cache the same way local-cache.js writes it.
  const cached = { rows: [{ id: "cached_1v1", name: "Cached" }], fetchedAt: Date.now() };
  _localStorageMap.set("rgPlayerLb:playlist:v1:1v1", JSON.stringify(cached));

  const rows = [{ id: "fresh_1v1", name: "Fresh" }];
  const fetchImpl = async () =>
    makeResponse({ status: 200, body: { rows }, etag: '"e1"' });

  const sched = makeSchedulers();
  const { handlers, nexts, errors } = makeHandlers();

  const unsubscribe = subscribePlaylistJson("1v1", handlers, {
    fetch: fetchImpl,
    setInterval: sched.setInterval,
    clearInterval: sched.clearInterval,
    urlTemplate: "https://cdn.test/leaderboard-{playlist}.json",
    pollMs: 30_000,
    maxFailures: 3,
    logger: { info: () => {}, error: () => {} },
  });

  await Promise.resolve();
  await Promise.resolve();

  assert.equal(errors.length, 0);
  assert.ok(nexts.length >= 2, "should paint cached rows then fresh rows");
  assert.equal(nexts[0].fromCache, true);
  assert.deepEqual(nexts[0].rows, cached.rows);
  // Cache paint must not populate changes — cached rows aren't a valid
  // baseline (they may be stale) and the render layer shouldn't animate
  // against an unknown timeline.
  assert.deepEqual(nexts[0].changes, []);
  assert.equal(nexts[1].fromCache, false);
  assert.deepEqual(nexts[1].rows, rows);
  // First live poll: no live baseline yet → changes:[] too.
  assert.deepEqual(nexts[1].changes, []);

  unsubscribe();
});
