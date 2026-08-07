import { test } from "node:test";
import assert from "node:assert/strict";

import { computeRowChanges, MAX_CHANGES_PER_POLL } from "../js/firebase.js";

// Convenience: build a row with just the fields the delta engine looks at.
function row(id, { mmr = 1500, currentStreak = 0 } = {}) {
  return { id, mmr, currentStreak };
}

test("first poll (previous=null) returns changes:[]", () => {
  const next = [row("a", { mmr: 1500 }), row("b", { mmr: 1400 })];
  assert.deepEqual(computeRowChanges(null, next), []);
});

test("identical polls return changes:[]", () => {
  const rows = [row("a", { mmr: 1500, currentStreak: 3 }), row("b", { mmr: 1400 })];
  // Fresh objects to make sure identity check isn't ref-based.
  const same = [row("a", { mmr: 1500, currentStreak: 3 }), row("b", { mmr: 1400 })];
  assert.deepEqual(computeRowChanges(rows, same), []);
});

test("mmr-up detected across polls", () => {
  const prev = [row("a", { mmr: 1200 })];
  const next = [row("a", { mmr: 1245 })];
  const changes = computeRowChanges(prev, next);
  assert.deepEqual(changes, [{ id: "a", kind: "mmr-up", from: 1200, to: 1245 }]);
});

test("mmr-down detected across polls", () => {
  const prev = [row("a", { mmr: 1500 })];
  const next = [row("a", { mmr: 1480 })];
  const changes = computeRowChanges(prev, next);
  assert.deepEqual(changes, [{ id: "a", kind: "mmr-down", from: 1500, to: 1480 }]);
});

test("entered-top100 detected for new ids", () => {
  const prev = [row("a", { mmr: 1500 })];
  const next = [row("a", { mmr: 1500 }), row("newguy", { mmr: 1300 })];
  const changes = computeRowChanges(prev, next);
  assert.deepEqual(changes, [{ id: "newguy", kind: "entered-top100" }]);
});

test("left-top100 detected on the departing row", () => {
  const prev = [row("a", { mmr: 1500 }), row("gone", { mmr: 1200 })];
  const next = [row("a", { mmr: 1500 })];
  const changes = computeRowChanges(prev, next);
  assert.deepEqual(changes, [{ id: "gone", kind: "left-top100" }]);
});

test("streak-up detected when currentStreak grows", () => {
  const prev = [row("a", { mmr: 1500, currentStreak: 4 })];
  const next = [row("a", { mmr: 1500, currentStreak: 5 })];
  const changes = computeRowChanges(prev, next);
  assert.deepEqual(changes, [{ id: "a", kind: "streak-up", from: 4, to: 5 }]);
});

test("streak-broken detected when currentStreak drops to zero", () => {
  const prev = [row("a", { mmr: 1500, currentStreak: 5 })];
  const next = [row("a", { mmr: 1500, currentStreak: 0 })];
  const changes = computeRowChanges(prev, next);
  assert.deepEqual(changes, [{ id: "a", kind: "streak-broken", from: 5, to: 0 }]);
});

test("streak-broken detected when currentStreak goes negative", () => {
  const prev = [row("a", { mmr: 1500, currentStreak: 3 })];
  const next = [row("a", { mmr: 1500, currentStreak: -1 })];
  const changes = computeRowChanges(prev, next);
  assert.deepEqual(changes, [{ id: "a", kind: "streak-broken", from: 3, to: -1 }]);
});

test("streak drop while still positive still counts as broken", () => {
  // Going from 5 → 2 without a loss shouldn't normally happen, but if the
  // HUD ever emits it we should treat it as a break rather than silent noise.
  const prev = [row("a", { mmr: 1500, currentStreak: 5 })];
  const next = [row("a", { mmr: 1500, currentStreak: 2 })];
  const changes = computeRowChanges(prev, next);
  assert.deepEqual(changes, [{ id: "a", kind: "streak-broken", from: 5, to: 2 }]);
});

test("mmr and streak deltas emit as separate events on the same row", () => {
  const prev = [row("a", { mmr: 1200, currentStreak: 4 })];
  const next = [row("a", { mmr: 1245, currentStreak: 5 })];
  const changes = computeRowChanges(prev, next);
  assert.deepEqual(changes, [
    { id: "a", kind: "mmr-up", from: 1200, to: 1245 },
    { id: "a", kind: "streak-up", from: 4, to: 5 },
  ]);
});

test("mixed change set: up, down, entered, left in one poll", () => {
  const prev = [
    row("winner", { mmr: 1200 }),
    row("loser", { mmr: 1500 }),
    row("gone", { mmr: 1100 }),
  ];
  const next = [
    row("winner", { mmr: 1250 }),
    row("loser", { mmr: 1480 }),
    row("newguy", { mmr: 1300 }),
  ];
  const changes = computeRowChanges(prev, next);
  // Order: iterate next first (winner up, loser down, newguy entered),
  // then departures (gone left).
  assert.deepEqual(changes, [
    { id: "winner", kind: "mmr-up", from: 1200, to: 1250 },
    { id: "loser", kind: "mmr-down", from: 1500, to: 1480 },
    { id: "newguy", kind: "entered-top100" },
    { id: "gone", kind: "left-top100" },
  ]);
});

test("changes list is capped so a churn burst can't flood consumers", () => {
  const prev = [];
  const next = [];
  for (let i = 0; i < MAX_CHANGES_PER_POLL + 20; i += 1) {
    next.push(row(`p${i}`, { mmr: 1500 }));
  }
  const changes = computeRowChanges(prev, next);
  assert.equal(changes.length, MAX_CHANGES_PER_POLL);
  // Everything under the cap should be entered-top100 events.
  assert.ok(changes.every((c) => c.kind === "entered-top100"));
});

test("rows missing an id are skipped rather than crashing the diff", () => {
  const prev = [row("a", { mmr: 1200 })];
  const next = [{ mmr: 1250 /* no id */ }, row("a", { mmr: 1250 })];
  const changes = computeRowChanges(prev, next);
  assert.deepEqual(changes, [{ id: "a", kind: "mmr-up", from: 1200, to: 1250 }]);
});

test("non-numeric mmr fields don't emit spurious events", () => {
  const prev = [{ id: "a", mmr: null, currentStreak: null }];
  const next = [{ id: "a", mmr: undefined, currentStreak: undefined }];
  assert.deepEqual(computeRowChanges(prev, next), []);
});

test("previousRows non-array (defensive) returns []", () => {
  assert.deepEqual(computeRowChanges(undefined, [row("a")]), []);
  assert.deepEqual(computeRowChanges("bad", [row("a")]), []);
});
