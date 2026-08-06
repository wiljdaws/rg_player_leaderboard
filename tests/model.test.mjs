import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildPlayerPayload,
  filterPlayers,
  normalizePlayerDocument,
  normalizePlaylistRows,
  sanitizeHttpUrl,
  winRate,
} from "../js/model.js";

test("normalizePlayerDocument accepts a valid MMR doc", () => {
  const result = normalizePlayerDocument(
    { id: "abc", playlist: "1v1", name: "Player", mmr: 1234 },
    "1v1",
  );
  assert.equal(result.ok, true);
  assert.equal(result.player.mmr, 1234);
  assert.equal(result.player.provenance.kind, "Manual admin entry");
});

test("normalizePlayerDocument passes through session fields on ranked docs", () => {
  const result = normalizePlayerDocument(
    {
      id: "abc",
      playlist: "1v1",
      name: "Player",
      mmr: 1234,
      sessionMmrDelta: 42,
      sessionStartedAt: 1_700_000_000_000,
      sessionLastSeen: 1_700_000_000_500,
    },
    "1v1",
  );
  assert.equal(result.player.sessionMmrDelta, 42);
  assert.equal(result.player.sessionStartedAt, 1_700_000_000_000);
  assert.equal(result.player.sessionLastSeen, 1_700_000_000_500);
});

test("normalizePlayerDocument surfaces HUD's lastWriteAt as provenance.updatedAt", () => {
  const stamp = new Date("2026-08-06T09:15:00Z");
  const fromHud = normalizePlayerDocument(
    { id: "abc", playlist: "1v1", name: "Player", mmr: 1234, lastWriteAt: stamp },
    "1v1",
  );
  assert.equal(fromHud.player.provenance.updatedAt?.toISOString(), stamp.toISOString());

  const legacy = normalizePlayerDocument(
    { id: "abc", playlist: "1v1", name: "Player", mmr: 1234, updatedAt: stamp.toISOString() },
    "1v1",
  );
  assert.equal(legacy.player.provenance.updatedAt?.toISOString(), stamp.toISOString());
});

test("normalizePlayerDocument leaves session fields null when missing", () => {
  const result = normalizePlayerDocument(
    { id: "abc", playlist: "1v1", name: "Player", mmr: 1234 },
    "1v1",
  );
  assert.equal(result.player.sessionMmrDelta, null);
  assert.equal(result.player.sessionStartedAt, null);
  assert.equal(result.player.sessionLastSeen, null);
});

test("normalizePlayerDocument passes through session fields on wins docs", () => {
  const result = normalizePlayerDocument(
    {
      id: "x",
      playlist: "wins",
      name: "A",
      wins: 10,
      matches: 20,
      currentStreak: 5,
      sessionStartedAt: 1_700_000_000_000,
      sessionLastSeen: 1_700_000_000_500,
    },
    "wins",
  );
  assert.equal(result.player.sessionStartedAt, 1_700_000_000_000);
  assert.equal(result.player.sessionLastSeen, 1_700_000_000_500);
});

test("normalizePlayerDocument passes through currentStreak on wins docs", () => {
  const result = normalizePlayerDocument(
    { id: "x", playlist: "wins", name: "A", wins: 10, matches: 20, currentStreak: 5 },
    "wins",
  );
  assert.equal(result.ok, true);
  assert.equal(result.player.currentStreak, 5);
});

test("normalizePlayerDocument clamps runaway currentStreak values", () => {
  const result = normalizePlayerDocument(
    { id: "x", playlist: "wins", name: "A", wins: 10, matches: 20, currentStreak: 9999 },
    "wins",
  );
  assert.equal(result.player.currentStreak, 999);
});

test("normalizePlayerDocument leaves currentStreak null when missing", () => {
  const result = normalizePlayerDocument(
    { id: "x", playlist: "wins", name: "A", wins: 10, matches: 20 },
    "wins",
  );
  assert.equal(result.player.currentStreak, null);
});

test("normalizePlayerDocument quarantines wins > matches", () => {
  const result = normalizePlayerDocument(
    { id: "x", playlist: "wins", name: "A", wins: 10, matches: 5 },
    "wins",
  );
  assert.equal(result.ok, false);
  assert.ok(result.quarantine.reasons.includes("wins exceed matches"));
});

test("normalizePlaylistRows sorts descending by score and quarantines duplicates", () => {
  const { rows, quarantined } = normalizePlaylistRows(
    [
      { id: "a", playlist: "1v1", name: "A", mmr: 1000 },
      { id: "b", playlist: "1v1", name: "B", mmr: 1500 },
      { id: "b", playlist: "1v1", name: "B", mmr: 1500 }, // dup
      { id: "c", playlist: "1v1", name: "C", mmr: -1 }, // invalid
    ],
    "1v1",
  );
  assert.deepEqual(rows.map((r) => r.id), ["b", "a"]);
  assert.equal(quarantined.length, 2);
});

test("filterPlayers matches case-insensitively", () => {
  const rows = [
    { id: "1", name: "Vistvy" },
    { id: "2", name: "Pal" },
  ];
  assert.equal(filterPlayers(rows, "vist").length, 1);
  assert.equal(filterPlayers(rows, "").length, 2);
});

test("winRate reports one-decimal percent", () => {
  assert.equal(winRate({ wins: 3, matches: 10 }), "30.0");
  assert.equal(winRate({ wins: 0, matches: 0 }), "0.0");
});

test("buildPlayerPayload rejects invalid flag URL", () => {
  assert.throws(
    () =>
      buildPlayerPayload({
        playlist: "1v1",
        name: "A",
        mmr: 1000,
        flag: "javascript:alert(1)",
      }),
    /Flag URL/,
  );
});

test("sanitizeHttpUrl accepts base64 raster data URIs (legacy flags)", () => {
  const png = "data:image/png;base64,iVBORw0KGgoAAAA";
  assert.equal(sanitizeHttpUrl(png), png);
  const jpg = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
  assert.equal(sanitizeHttpUrl(jpg), jpg);
});

test("sanitizeHttpUrl rejects SVG data URIs (XSS vector)", () => {
  const svg = "data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Pg==";
  assert.equal(sanitizeHttpUrl(svg), "");
});

test("sanitizeHttpUrl still rejects arbitrary schemes", () => {
  assert.equal(sanitizeHttpUrl("javascript:alert(1)"), "");
  assert.equal(sanitizeHttpUrl("file:///etc/passwd"), "");
});
