import { test } from "node:test";
import assert from "node:assert/strict";

import {
  COUNTRIES,
  FlagDirectory,
  canonicalCountry,
  canonicalFlagUrl,
  isRealCountry,
  labelForFlagUrl,
} from "../js/flag-directory.js";

const US_FLAG = "https://upload.wikimedia.org/wikipedia/commons/a/a4/Flag_of_the_United_States.svg";
const US_DATA = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFwAAAAxCAMAAABgWz7uAAAAnFBMVEX///+xIzOwHS6w<truncated payload>";

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
  assert.equal(labelForFlagUrl(US_DATA), "United States");
});

test("canonicalFlagUrl rewrites the leftover US data URI to Wikimedia", () => {
  assert.equal(canonicalFlagUrl(US_DATA), US_FLAG);
  assert.equal(canonicalFlagUrl(US_FLAG), US_FLAG);
  assert.equal(canonicalFlagUrl(""), "");
});

test("picker always offers United States as an https flag", () => {
  const dir = new FlagDirectory({ storage: makeStorage() });
  const us = dir.list().find((entry) => entry.label === "United States");
  assert.ok(us);
  assert.equal(us.url, US_FLAG);
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
  const urls = dir.list().map((entry) => entry.url);
  assert.ok(urls.includes("https://flagcdn.com/us.svg"));
  assert.ok(urls.includes("https://flagcdn.com/gb.svg"));
  assert.ok(urls.includes(US_FLAG));
});

test("directory persists across instances", () => {
  const storage = makeStorage();
  const first = new FlagDirectory({ storage });
  first.add("https://flagcdn.com/us.svg");

  const second = new FlagDirectory({ storage });
  const urls = second.list().map((entry) => entry.url);
  assert.ok(urls.includes("https://flagcdn.com/us.svg"));
  assert.ok(urls.includes(US_FLAG));
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

test("COUNTRIES list validates real names case-insensitively", () => {
  assert.ok(COUNTRIES.length > 150);
  assert.ok(isRealCountry("Brazil"));
  assert.ok(isRealCountry("brazil"));
  assert.ok(isRealCountry("United States"));
  assert.ok(!isRealCountry("Atlantis"));
  assert.equal(canonicalCountry("brazil"), "Brazil");
  assert.equal(canonicalCountry("UNITED STATES"), "United States");
  assert.equal(canonicalCountry("wut"), "");
});

test("addWithCountry stores a custom label and prevents duplicate countries", () => {
  const dir = new FlagDirectory({ storage: makeStorage() });
  const first = dir.addWithCountry("https://example.com/br1.png", "Brazil");
  // Brazil is already claimed by the static known-flag map (imgur/saBa4s8),
  // so any addWithCountry("Brazil") on a *different* URL should reject.
  assert.equal(first.ok, false);
  assert.match(first.error, /Brazil/);

  const second = dir.addWithCountry("https://example.com/pl.png", "Poland");
  assert.equal(second.ok, true);
  assert.equal(dir.labelFor("https://example.com/pl.png"), "Poland");
  assert.ok(dir.hasCountry("Poland"));

  const third = dir.addWithCountry("https://example.com/other.png", "Poland");
  assert.equal(third.ok, false);
});

test("addWithCountry rejects made-up country names", () => {
  const dir = new FlagDirectory({ storage: makeStorage() });
  const result = dir.addWithCountry("https://example.com/x.png", "Atlantis");
  assert.equal(result.ok, false);
  assert.match(result.error, /real country/i);
});

test("remove drops the entry from the picker", () => {
  const dir = new FlagDirectory({ storage: makeStorage() });
  dir.addWithCountry("https://example.com/pl.png", "Poland");
  assert.ok(dir.list().some((entry) => entry.url === "https://example.com/pl.png"));
  assert.equal(dir.remove("https://example.com/pl.png"), true);
  assert.ok(!dir.list().some((entry) => entry.url === "https://example.com/pl.png"));
  assert.ok(!dir.hasCountry("Poland"));
});

test("v1 URL array migrates into v2 entries on load", () => {
  const storage = makeStorage();
  storage.setItem(
    "rgPlayerLb:flagDirectory:v1",
    JSON.stringify(["https://flagcdn.com/br.svg", "https://flagcdn.com/jp.svg"]),
  );
  const dir = new FlagDirectory({ storage });
  const urls = dir.list().map((e) => e.url);
  assert.ok(urls.includes("https://flagcdn.com/br.svg"));
  assert.ok(urls.includes("https://flagcdn.com/jp.svg"));
  assert.ok(urls.includes(US_FLAG));
  // v1 key is removed after migration.
  assert.equal(storage.getItem("rgPlayerLb:flagDirectory:v1"), null);
});
