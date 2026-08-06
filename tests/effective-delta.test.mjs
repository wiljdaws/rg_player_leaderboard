import { test } from "node:test";
import assert from "node:assert/strict";

import { effectiveMmrDelta } from "../js/render.js";

test("effectiveMmrDelta prefers a published session delta", () => {
  const player = {
    id: "a",
    mmr: 1500,
    sessionMmrDelta: 42,
    sessionStartedAt: 1_000,
    sessionLastSeen: 1_000 + 30 * 60_000,
  };
  const historyStore = { gainFor: () => ({ gained: 5, spanMs: 20 * 60_000, samples: 4 }) };
  const result = effectiveMmrDelta(player, "1v1", historyStore, 1_000 + 30 * 60_000);
  assert.equal(result.gained, 42);
  assert.equal(result.source, "published");
  // spanMs uses lastSeen-startedAt (actual playtime), not wall-clock.
  assert.equal(result.spanMs, 30 * 60_000);
});

test("effectiveMmrDelta drops a stale published session (>2h since lastSeen)", () => {
  const player = {
    id: "a",
    mmr: 1500,
    sessionMmrDelta: 42,
    sessionStartedAt: 1_000,
    sessionLastSeen: 1_000 + 30 * 60_000,
  };
  const historyStore = { gainFor: () => ({ gained: 5, spanMs: 20 * 60_000, samples: 4 }) };
  const now = 1_000 + 30 * 60_000 + 3 * 60 * 60_000;
  const result = effectiveMmrDelta(player, "1v1", historyStore, now);
  assert.equal(result.source, "observed");
  assert.equal(result.gained, 5);
});

test("effectiveMmrDelta treats missing sessionLastSeen as fresh (pre-16.7 compat)", () => {
  const player = { id: "a", mmr: 1500, sessionMmrDelta: 42, sessionStartedAt: 1_000 };
  const historyStore = { gainFor: () => ({ gained: 5, spanMs: 20 * 60_000, samples: 4 }) };
  const now = 1_000 + 30 * 60_000;
  const result = effectiveMmrDelta(player, "1v1", historyStore, now);
  assert.equal(result.source, "published");
  assert.equal(result.gained, 42);
  // Without lastSeen the span falls back to now-startedAt.
  assert.equal(result.spanMs, 30 * 60_000);
});

test("effectiveMmrDelta falls back to observed when sessionStartedAt is missing", () => {
  const player = { id: "a", mmr: 1500, sessionMmrDelta: 42 };
  const historyStore = { gainFor: () => ({ gained: 5, spanMs: 20 * 60_000, samples: 4 }) };
  const result = effectiveMmrDelta(player, "1v1", historyStore, 0);
  assert.equal(result.source, "observed");
  assert.equal(result.gained, 5);
});

test("effectiveMmrDelta falls back to observed when no published delta", () => {
  const player = { id: "a", mmr: 1500 };
  const historyStore = { gainFor: () => ({ gained: 12, spanMs: 45 * 60_000, samples: 5 }) };
  const result = effectiveMmrDelta(player, "1v1", historyStore, 0);
  assert.equal(result.source, "observed");
  assert.equal(result.gained, 12);
});

test("effectiveMmrDelta returns none when neither source has data", () => {
  const player = { id: "a", mmr: 1500 };
  const historyStore = { gainFor: () => ({ gained: null, spanMs: 0, samples: 0 }) };
  const result = effectiveMmrDelta(player, "1v1", historyStore, 0);
  assert.equal(result.source, "none");
  assert.equal(result.gained, null);
});
