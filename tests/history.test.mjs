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

test("topGainers ranks positive movers only", () => {
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
    { id: "a", mmr: 1050 },
    { id: "b", mmr: 890 },
    { id: "c", mmr: 810 },
  ], t1);

  const players = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
    { id: "c", name: "C" },
  ];
  const gainers = store.topGainers("1v1", players, { ts: t1 });
  assert.deepEqual(
    gainers.map((g) => [g.player.id, g.gained]),
    [["a", 50], ["c", 10]],
  );
});

test("record dedupes samples with an identical mmr within 30s", () => {
  const storage = makeStorage();
  const store = new MmrHistoryStore({ storage, now: () => 0 });
  store.record("1v1", [{ id: "a", mmr: 1000 }], 0);
  store.record("1v1", [{ id: "a", mmr: 1000 }], 10_000);
  const series = store.data.playlists["1v1"].players.a;
  assert.equal(series.length, 1);
});

test("wins playlist rows are ignored (no MMR present)", () => {
  const storage = makeStorage();
  const store = new MmrHistoryStore({ storage, now: () => 0 });
  store.record("wins", [{ id: "a", wins: 5, matches: 10 }], 0);
  const gain = store.gainFor("wins", "a", 0);
  assert.equal(gain.samples, 0);
});
