import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildPlayerPayload,
  filterPlayers,
  normalizePlayerDocument,
  normalizePlaylistRows,
  sanitizeHttpUrl,
  sanitizePublicImageUrl,
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

test("normalizePlayerDocument passes through currentStreak on ranked docs too", () => {
  // HUD 17.2+ mirrors the streak on ranked docs so the chip renders on
  // 1v1/2v2/3v3 tabs. Regression: the ranked branch was dropping the field.
  const result = normalizePlayerDocument(
    { id: "x", playlist: "1v1", name: "A", mmr: 1234, currentStreak: 7 },
    "1v1",
  );
  assert.equal(result.ok, true);
  assert.equal(result.player.currentStreak, 7);
});

test("normalizePlayerDocument quarantines wins > matches", () => {
  const result = normalizePlayerDocument(
    { id: "x", playlist: "wins", name: "A", wins: 10, matches: 5 },
    "wins",
  );
  assert.equal(result.ok, false);
  assert.ok(result.quarantine.reasons.includes("wins exceed matches"));
});

test("normalizePlaylistRows wins ties break on fewer matches then name", () => {
  const { rows } = normalizePlaylistRows(
    [
      { id: "hamzaeg_wins", playlist: "wins", name: "HAMZAEG", wins: 7, matches: 12 },
      { id: "og_wins", playlist: "wins", name: "[OG] ....", wins: 7, matches: 10 },
      { id: "future_wins", playlist: "wins", name: "FutureDemon.5FP", wins: 0, matches: 1 },
      { id: "jajaa_wins", playlist: "wins", name: "Jajaa", wins: 0, matches: 1 },
    ],
    "wins",
  );
  assert.deepEqual(
    rows.map((r) => r.id),
    ["og_wins", "hamzaeg_wins", "future_wins", "jajaa_wins"],
  );
});

test("normalizePlaylistRows is stable across shuffled inputs", () => {
  const inputs = [
    { id: "a1", playlist: "1v1", name: "Same", mmr: 1500 },
    { id: "a2", playlist: "1v1", name: "Same", mmr: 1500 },
    { id: "b", playlist: "1v1", name: "Other", mmr: 1500 },
  ];
  const first = normalizePlaylistRows(inputs, "1v1").rows.map((r) => r.id);
  const shuffled = [inputs[2], inputs[0], inputs[1]];
  const second = normalizePlaylistRows(shuffled, "1v1").rows.map((r) => r.id);
  assert.deepEqual(second, first);
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

test("sanitizePublicImageUrl drops Discord and GitHub CDNs", () => {
  assert.equal(
    sanitizePublicImageUrl("https://cdn.discordapp.com/attachments/1/2/flag.png"),
    "",
  );
  assert.equal(
    sanitizePublicImageUrl("https://raw.githubusercontent.com/foo/bar/flag.png"),
    "",
  );
  assert.equal(
    sanitizePublicImageUrl("https://cdn.jsdelivr.net/gh/foo/bar/flag.png"),
    "",
  );
});

test("normalizePlayerDocument drops Discord flag URLs", () => {
  const result = normalizePlayerDocument(
    {
      id: "abc",
      playlist: "1v1",
      name: "Player",
      mmr: 1234,
      flag: "https://cdn.discordapp.com/attachments/1/2/flag.png",
    },
    "1v1",
  );
  assert.equal(result.ok, true);
  assert.equal(result.player.flag, "");
});

test("sanitizePublicImageUrl keeps country-flag hosts and data URIs", () => {
  const imgur = "https://i.imgur.com/saBa4s8.png";
  const wiki = "https://upload.wikimedia.org/wikipedia/commons/0/0a/Flag_of_Jamaica.svg";
  const png = "data:image/png;base64,iVBORw0KGgoAAAA";
  assert.equal(sanitizePublicImageUrl(imgur), imgur);
  assert.equal(sanitizePublicImageUrl(wiki), wiki);
  assert.equal(sanitizePublicImageUrl(png), png);
});
