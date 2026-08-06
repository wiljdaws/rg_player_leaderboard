import { test } from "node:test";
import assert from "node:assert/strict";

import { MmrHistoryStore } from "../js/history.js";

function makeStorage() {
  const map = new Map();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, value),
    removeItem: (key) => map.delete(key),
    _map: map,
  };
}

test("gainFor returns null when only one sample exists", () => {
  const storage = makeStorage();
  const store = new MmrHistoryStore({ storage, now: () => 1_000 });
  store.record("1v1", [{ id: "a", mmr: 1000 }], 1_000);
  const gain = store.gainFor("1v1", "a", 1_000);
  assert.equal(gain.gained, null);
  assert.equal(gain.samples, 1);
});

test("gainFor reports the delta against the oldest in-window sample", () => {
  const storage = makeStorage();
  const store = new MmrHistoryStore({ storage, now: () => 0 });
  store.record("1v1", [{ id: "a", mmr: 1000 }], 0);
  store.record("1v1", [{ id: "a", mmr: 1050 }], 20 * 60_000);
  store.record("1v1", [{ id: "a", mmr: 1075 }], 40 * 60_000);
  const gain = store.gainFor("1v1", "a", 40 * 60_000);
  assert.equal(gain.gained, 75);
  assert.equal(gain.spanMs, 40 * 60_000);
});

test("gainFor drops samples older than the rolling window", () => {
  const storage = makeStorage();
  const store = new MmrHistoryStore({ storage, now: () => 0 });
  store.record("1v1", [{ id: "a", mmr: 900 }], 0);
  store.record("1v1", [{ id: "a", mmr: 1000 }], 70 * 60_000); // 900 is out of window
  store.record("1v1", [{ id: "a", mmr: 1020 }], 80 * 60_000);
  const gain = store.gainFor("1v1", "a", 80 * 60_000);
  assert.equal(gain.gained, 20);
});

test("topMovers ranks both positive and negative changes by magnitude", () => {
  const storage = makeStorage();
  const store = new MmrHistoryStore({ storage, now: () => 0 });
  const t0 = 0;
  const t1 = 30 * 60_000;
  store.record("1v1", [
    { id: "a", mmr: 1000 },
    { id: "b", mmr: 900 },
    { id: "c", mmr: 800 },
  ], t0);
  store.record("1v1", [
    { id: "a", mmr: 1050 }, // +50
    { id: "b", mmr: 830 }, // -70
    { id: "c", mmr: 810 }, // +10
  ], t1);

  const players = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
    { id: "c", name: "C" },
  ];
  const movers = store.topMovers("1v1", players, { ts: t1 });
  assert.deepEqual(
    movers.map((m) => [m.player.id, m.gained]),
    [["b", -70], ["a", 50], ["c", 10]],
  );
});

test("topMovers hides players whose window is shorter than 10 minutes", () => {
  const storage = makeStorage();
  const store = new MmrHistoryStore({ storage, now: () => 0 });
  store.record("1v1", [{ id: "a", mmr: 1000 }], 0);
  store.record("1v1", [{ id: "a", mmr: 1050 }], 5 * 60_000);
  const players = [{ id: "a", name: "A" }];
  const movers = store.topMovers("1v1", players, { ts: 5 * 60_000 });
  assert.deepEqual(movers, []);
});

test("topMovers uses the oldest in-window sample for the full-hour comparison", () => {
  const storage = makeStorage();
  const store = new MmrHistoryStore({ storage, now: () => 0 });
  store.record("1v1", [{ id: "a", mmr: 1000 }], 0);
  store.record("1v1", [{ id: "a", mmr: 1030 }], 20 * 60_000);
  store.record("1v1", [{ id: "a", mmr: 1080 }], 50 * 60_000);

  const [mover] = store.topMovers("1v1", [{ id: "a", name: "A" }], {
    ts: 50 * 60_000,
  });
  assert.equal(mover.gained, 80); // compared against t=0, not the intermediate sample
  assert.equal(mover.spanMs, 50 * 60_000);
});

test("record dedupes samples with an identical value within 30s", () => {
  const storage = makeStorage();
  const store = new MmrHistoryStore({ storage, now: () => 0 });
  store.record("1v1", [{ id: "a", mmr: 1000 }], 0);
  store.record("1v1", [{ id: "a", mmr: 1000 }], 10_000);
  const series = store.data.playlists["1v1"].players.a;
  assert.equal(series.length, 1);
});

test("wins playlist tracks the wins count instead of MMR", () => {
  const storage = makeStorage();
  const store = new MmrHistoryStore({ storage, now: () => 0 });
  store.record("wins", [{ id: "a", wins: 100, matches: 150 }], 0);
  store.record("wins", [{ id: "a", wins: 103, matches: 154 }], 20 * 60_000);
  const gain = store.gainFor("wins", "a", 20 * 60_000);
  assert.equal(gain.gained, 3);
  assert.equal(gain.samples, 2);
});

test("wins playlist ignores rows missing a wins/matches count", () => {
  const storage = makeStorage();
  const store = new MmrHistoryStore({ storage, now: () => 0 });
  store.record("wins", [{ id: "a", mmr: 1000 }], 0);
  const gain = store.gainFor("wins", "a", 0);
  assert.equal(gain.samples, 0);
});

test("streakFor extends a clean win streak with each pure-win block", () => {
  const storage = makeStorage();
  const store = new MmrHistoryStore({ storage, now: () => 0 });
  store.record("wins", [{ id: "a", wins: 100, matches: 150 }], 0);
  store.record("wins", [{ id: "a", wins: 102, matches: 152 }], 60_000); // +2W
  store.record("wins", [{ id: "a", wins: 105, matches: 155 }], 120_000); // +3W
  const result = store.streakFor("a", 120_000);
  assert.equal(result.streak, 5);
  assert.equal(result.confident, true);
});

test("streakFor flips negative on a pure-loss block", () => {
  const storage = makeStorage();
  const store = new MmrHistoryStore({ storage, now: () => 0 });
  store.record("wins", [{ id: "a", wins: 100, matches: 150 }], 0);
  store.record("wins", [{ id: "a", wins: 102, matches: 152 }], 60_000); // +2W → streak 2
  store.record("wins", [{ id: "a", wins: 102, matches: 154 }], 120_000); // +2L → streak -2
  const result = store.streakFor("a", 120_000);
  assert.equal(result.streak, -2);
});

test("streakFor collapses a mixed block to +/- 1", () => {
  const storage = makeStorage();
  const store = new MmrHistoryStore({ storage, now: () => 0 });
  store.record("wins", [{ id: "a", wins: 100, matches: 150 }], 0);
  // 3 games: 2 wins, 1 loss → mixed, net positive → +1
  store.record("wins", [{ id: "a", wins: 102, matches: 153 }], 60_000);
  const result = store.streakFor("a", 60_000);
  assert.equal(result.streak, 1);
});

test("topStreaks only surfaces positive streaks of at least minStreak", () => {
  const storage = makeStorage();
  const store = new MmrHistoryStore({ storage, now: () => 0 });
  // Player A: 3-win streak
  store.record("wins", [{ id: "a", wins: 100, matches: 150 }], 0);
  store.record("wins", [{ id: "a", wins: 103, matches: 153 }], 60_000);
  // Player B: only 2 wins, below threshold
  store.record("wins", [{ id: "b", wins: 100, matches: 150 }], 0);
  store.record("wins", [{ id: "b", wins: 102, matches: 152 }], 60_000);
  // Player C: 4-loss streak — should never appear
  store.record("wins", [{ id: "c", wins: 100, matches: 150 }], 0);
  store.record("wins", [{ id: "c", wins: 100, matches: 154 }], 60_000);

  const streaks = store.topStreaks(
    [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
      { id: "c", name: "C" },
    ],
    { ts: 60_000 },
  );
  assert.deepEqual(streaks.map((s) => [s.player.id, s.streak]), [["a", 3]]);
});

test("ranked playlist ignores rows missing an MMR", () => {
  const storage = makeStorage();
  const store = new MmrHistoryStore({ storage, now: () => 0 });
  store.record("1v1", [{ id: "a", wins: 5, matches: 10 }], 0);
  const gain = store.gainFor("1v1", "a", 0);
  assert.equal(gain.samples, 0);
});
