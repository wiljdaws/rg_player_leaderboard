import { test } from "node:test";
import assert from "node:assert/strict";

import {
  exportReadStatsAsJson,
  exportReadStatsAsCsv,
  bundleForInvestigation,
} from "../js/read-stats-export.js";

// ------ fixtures ------

function fixture() {
  return {
    range: { from: "2026-08-01", to: "2026-08-07" },
    site: [
      { docId: "site-a", date: "2026-08-01", total: 10, byLabel: { staticJson: 10 } },
    ],
    hud: [
      { docId: "hud-a", date: "2026-08-01", readTotal: 42, writeTotal: 3 },
    ],
    aggregate: {
      totalReads: 100,
      totalWrites: 5,
      byDate: {
        "2026-08-01": { site: 10, hud: 20 },
        "2026-08-02": { site: 25, hud: 45 }, // peak day (site+hud=70)
      },
      bySource: { site: 35, clanSite: 0, hud: 65, other: 0 },
      byHudVersion: { "17.4": 65 },
      byLabel: {
        site: [
          { label: "staticJson", total: 20 },
          // Include a nasty label to prove CSV escaping works.
          { label: 'weird, "quoted" label', total: 15 },
        ],
        hud: [
          { label: "roster", total: 40 },
        ],
      },
      byHudUser: [
        {
          sourceUserId: "user-1",
          reads: 60,
          writes: 2,
          versionNum: "17.4",
          lastUpdatedAt: "2026-08-02T12:34:56Z",
        },
        {
          sourceUserId: "user-2",
          reads: 5,
          writes: 1,
          versionNum: "17.3",
          lastUpdatedAt: "2026-08-01T10:00:00Z",
        },
      ],
      bySiteSession: [
        { sessionId: "s1", total: 35, updatedAt: "2026-08-02T12:00:00Z", userAgentShort: "Chrome/..." },
      ],
    },
    fetchedAt: 1_734_000_000_000,
  };
}

// ------ JSON export ------

test("exportReadStatsAsJson returns JSON blob with range-based filename", async () => {
  const data = fixture();
  const { filename, blob } = exportReadStatsAsJson(data);
  assert.equal(filename, "rg-read-stats-2026-08-01-2026-08-07.json");
  assert.equal(blob.type, "application/json");

  const text = await blob.text();
  const parsed = JSON.parse(text);
  assert.deepEqual(parsed.range, data.range);
  assert.equal(parsed.aggregate.totalReads, 100);
  // Pretty printing => newlines present
  assert.ok(text.includes("\n"), "pretty output should contain newlines");
});

test("exportReadStatsAsJson honors pretty:false", async () => {
  const data = fixture();
  const { blob } = exportReadStatsAsJson(data, { pretty: false });
  const text = await blob.text();
  assert.ok(!text.includes("\n  "), "non-pretty output should not have indented newlines");
});

test("exportReadStatsAsJson tolerates undefined range", () => {
  const { filename, blob } = exportReadStatsAsJson({});
  assert.equal(filename, "rg-read-stats-unknown-unknown.json");
  assert.ok(blob);
});

// ------ CSV export ------

test("exportReadStatsAsCsv builds all 4 sections in order", async () => {
  const data = fixture();
  const { filename, blob } = exportReadStatsAsCsv(data);
  assert.equal(filename, "rg-read-stats-2026-08-01-2026-08-07.csv");
  assert.equal(blob.type, "text/csv");

  const text = await blob.text();

  // Section headers, in the required order.
  const dailyIdx = text.indexOf("# daily");
  const hudUserIdx = text.indexOf("# by-hud-user");
  const hudLabelIdx = text.indexOf("# by-hud-label");
  const siteLabelIdx = text.indexOf("# by-site-label");
  assert.ok(dailyIdx >= 0, "should contain # daily header");
  assert.ok(hudUserIdx > dailyIdx, "# by-hud-user should follow daily");
  assert.ok(hudLabelIdx > hudUserIdx, "# by-hud-label should follow by-hud-user");
  assert.ok(siteLabelIdx > hudLabelIdx, "# by-site-label should follow by-hud-label");

  // Daily section rows
  assert.match(text, /date,site_reads,hud_reads,total/);
  assert.match(text, /2026-08-01,10,20,30/);
  assert.match(text, /2026-08-02,25,45,70/);

  // HUD user rows
  assert.match(text, /sourceUserId,versionNum,reads,writes,lastUpdatedAt/);
  assert.match(text, /user-1,17\.4,60,2,2026-08-02T12:34:56Z/);
});

test("exportReadStatsAsCsv escapes comma + quote per RFC 4180", async () => {
  const data = fixture();
  const { blob } = exportReadStatsAsCsv(data);
  const text = await blob.text();
  // The site label 'weird, "quoted" label' must be wrapped in quotes and its
  // internal quotes doubled.
  assert.match(text, /"weird, ""quoted"" label",15/);
});

test("exportReadStatsAsCsv sorts daily rows chronologically", async () => {
  const data = fixture();
  data.aggregate.byDate = {
    "2026-08-03": { site: 1, hud: 2 },
    "2026-08-01": { site: 3, hud: 4 },
    "2026-08-02": { site: 5, hud: 6 },
  };
  const { blob } = exportReadStatsAsCsv(data);
  const text = await blob.text();
  const dailyBlock = text.split("\n\n")[0];
  const rows = dailyBlock.split("\n").slice(2); // skip header + column row
  assert.equal(rows[0].split(",")[0], "2026-08-01");
  assert.equal(rows[1].split(",")[0], "2026-08-02");
  assert.equal(rows[2].split(",")[0], "2026-08-03");
});

test("exportReadStatsAsCsv handles empty aggregate without crashing", async () => {
  const data = { range: { from: "2026-08-01", to: "2026-08-01" }, aggregate: {} };
  const { blob } = exportReadStatsAsCsv(data);
  const text = await blob.text();
  // Each section should still have its header + column row.
  assert.match(text, /# daily\ndate,site_reads,hud_reads,total/);
  assert.match(text, /# by-hud-user\nsourceUserId,versionNum,reads,writes,lastUpdatedAt/);
  assert.match(text, /# by-hud-label\nlabel,total/);
  assert.match(text, /# by-site-label\nlabel,total/);
});

test("exportReadStatsAsCsv handles completely empty input", async () => {
  const { filename, blob } = exportReadStatsAsCsv({});
  assert.equal(filename, "rg-read-stats-unknown-unknown.csv");
  const text = await blob.text();
  assert.ok(text.includes("# daily"));
  assert.ok(text.includes("# by-site-label"));
});

// ------ Investigation bundle ------

test("bundleForInvestigation includes required envelope keys", async () => {
  const data = fixture();
  const { filename, blob } = bundleForInvestigation(data);
  assert.match(filename, /^rg-read-investigation-2026-08-01-2026-08-07-\d+\.json$/);
  assert.equal(blob.type, "application/json");

  const text = await blob.text();
  const parsed = JSON.parse(text);

  assert.ok(parsed.envelope, "must have envelope");
  assert.equal(parsed.envelope.generatedBy, "rg-player-leaderboard");
  assert.equal(parsed.envelope.firestoreProjectId, "rgleaderboard");
  assert.ok(parsed.envelope.generatedAt, "must have generatedAt timestamp");
  assert.match(parsed.envelope.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  // Env-derived keys can be null in Node (no DOM), but must be present.
  assert.ok("href" in parsed.envelope);
  assert.ok("userAgent" in parsed.envelope);
  assert.ok("assetVersion" in parsed.envelope);
  assert.ok("readBudgetSnapshot" in parsed.envelope);

  assert.ok(typeof parsed.narrative === "string" && parsed.narrative.length > 0);
  assert.match(parsed.narrative, /# Read-stats investigation bundle/);
  assert.match(parsed.narrative, /Range: 2026-08-01 → 2026-08-07/);
  assert.match(parsed.narrative, /Total reads: 100/);

  // The data payload must be included verbatim.
  assert.deepEqual(parsed.data.range, data.range);
  assert.equal(parsed.data.aggregate.totalReads, 100);
});

test("bundleForInvestigation narrative surfaces top HUD, peak day, and top site label", async () => {
  const data = fixture();
  const { blob } = bundleForInvestigation(data);
  const parsed = JSON.parse(await blob.text());
  // Top HUD by reads should list user-1 (60) before user-2 (5).
  assert.match(parsed.narrative, /user-1 \(60\).*user-2 \(5\)/);
  // Peak day: 2026-08-02 at 70 reads.
  assert.match(parsed.narrative, /Peak day: 2026-08-02 at 70 reads/);
  // Top site call-site: staticJson at 20.
  assert.match(parsed.narrative, /Top site call-site: staticJson at 20/);
});

test("bundleForInvestigation reads globalThis.__rgReadBudget if present", async () => {
  const stubSnap = { total: 42, perLabel: { x: 42 }, tripped: false };
  const previous = globalThis.__rgReadBudget;
  globalThis.__rgReadBudget = { snapshot: () => stubSnap };
  try {
    const { blob } = bundleForInvestigation(fixture());
    const parsed = JSON.parse(await blob.text());
    assert.deepEqual(parsed.envelope.readBudgetSnapshot, stubSnap);
  } finally {
    if (previous === undefined) delete globalThis.__rgReadBudget;
    else globalThis.__rgReadBudget = previous;
  }
});

test("bundleForInvestigation handles empty input without crashing", async () => {
  const { filename, blob } = bundleForInvestigation({});
  assert.match(filename, /^rg-read-investigation-unknown-unknown-\d+\.json$/);
  const parsed = JSON.parse(await blob.text());
  assert.ok(parsed.envelope);
  assert.match(parsed.narrative, /Total reads: 0/);
  assert.match(parsed.narrative, /Top HUD contributors: none/);
  assert.match(parsed.narrative, /Peak day: n\/a/);
  assert.match(parsed.narrative, /Top site call-site: n\/a/);
});
