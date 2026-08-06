import { test } from "node:test";
import assert from "node:assert/strict";

import { FlagDirectory, labelForFlagUrl } from "../js/flag-directory.js";

function makeStorage() {
  const map = new Map();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, value),
    removeItem: (key) => map.delete(key),
    _map: map,
  };
}

test("labelForFlagUrl uppercases short country-code basenames", () => {
  assert.equal(labelForFlagUrl("https://flagcdn.com/us.svg"), "US");
  assert.equal(labelForFlagUrl("https://flagcdn.com/w80/gb.png"), "GB");
});

test("labelForFlagUrl keeps a short readable basename", () => {
  assert.equal(labelForFlagUrl("https://example.com/rainbow.png"), "rainbow");
});

test("labelForFlagUrl falls back to hostname when the basename is too long", () => {
  assert.equal(
    labelForFlagUrl("https://i.imgur.com/aaaaaaaaaaaaaaaaaaaa.png"),
    "i.imgur.com",
  );
});

test("labelForFlagUrl resolves known imgur codes to country names", () => {
  assert.equal(labelForFlagUrl("https://i.imgur.com/saBa4s8.png"), "Brazil");
  assert.equal(labelForFlagUrl("https://i.imgur.com/B6VOEig.png"), "France");
  assert.equal(labelForFlagUrl("https://i.imgur.com/FiyMewtg.jpg"), "Japan");
  assert.equal(labelForFlagUrl("https://i.imgur.com/TsLtfjT.jpeg"), "Mexico");
});

test("labelForFlagUrl resolves known base64 flags by prefix", () => {
  const us = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFwAAAAxCAMAAABgWz7uAAAAnFBMVEX///+xIzOwHS6w<truncated payload>";
  assert.equal(labelForFlagUrl(us), "United States");
});

test("labelForFlagUrl returns 'flag' for unknown data URIs", () => {
  assert.equal(labelForFlagUrl("data:image/png;base64,SOMEUNKNOWNBASE64"), "flag");
});

test("registerRows adds unique flag URLs from player rows", () => {
  const storage = makeStorage();
  const dir = new FlagDirectory({ storage });
  dir.registerRows([
    { flag: "https://flagcdn.com/us.svg" },
    { flag: "https://flagcdn.com/gb.svg" },
    { flag: "https://flagcdn.com/us.svg" },
    { flag: "" },
    { flag: null },
  ]);
  assert.deepEqual(
    dir.list().map((entry) => entry.url),
    ["https://flagcdn.com/us.svg", "https://flagcdn.com/gb.svg"],
  );
});

test("directory persists across instances", () => {
  const storage = makeStorage();
  const first = new FlagDirectory({ storage });
  first.add("https://flagcdn.com/us.svg");

  const second = new FlagDirectory({ storage });
  assert.deepEqual(
    second.list().map((entry) => entry.url),
    ["https://flagcdn.com/us.svg"],
  );
});

test("subscribe fires when a new URL is registered", () => {
  const dir = new FlagDirectory({ storage: makeStorage() });
  let calls = 0;
  const unsubscribe = dir.subscribe(() => (calls += 1));
  dir.add("https://flagcdn.com/us.svg");
  dir.add("https://flagcdn.com/us.svg"); // duplicate — no callback
  dir.add("https://flagcdn.com/gb.svg");
  unsubscribe();
  dir.add("https://flagcdn.com/de.svg"); // after unsubscribe — no callback
  assert.equal(calls, 2);
});
