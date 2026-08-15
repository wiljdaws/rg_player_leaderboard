import { test } from "node:test";
import assert from "node:assert/strict";

import { createReadStatsQuery, clampRangeToWindowDays, READ_STATS_WINDOW_DAYS } from "../js/read-stats-query.js";
import { createTokenBucket } from "../js/read-stats-rate-limit.js";

// ------ helpers ------

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    _map: map,
  };
}

function makeClock(startAt = 1_000_000) {
  let ms = startAt;
  return {
    now: () => ms,
    advance(by) { ms += by; },
    set(to) { ms = to; },
  };
}

function silentLogger() {
  const calls = { warn: [], error: [], info: [], log: [] };
  return {
    logger: {
      warn: (...args) => calls.warn.push(args),
      error: (...args) => calls.error.push(args),
      info: (...args) => calls.info.push(args),
      log: (...args) => calls.log.push(args),
    },
    calls,
  };
}

// A mock gateway that records call counts so we can assert cache behavior.
function makeGateway({ siteDocs = [], hudDocs = [] } = {}) {
  const calls = { site: 0, hud: 0, ranges: [] };
  return {
    calls,
    fetchAdminReadStats: async (from, to) => {
      calls.site += 1;
      calls.ranges.push({ kind: "site", from, to });
      return siteDocs;
    },
    fetchHudReadStats: async (from, to) => {
      calls.hud += 1;
      calls.ranges.push({ kind: "hud", from, to });
      return hudDocs;
    },
  };
}

// ------ tests ------

test("fetchRange returns the range and empty aggregate for a zero-doc result", async () => {
  const gateway = makeGateway({ siteDocs: [], hudDocs: [] });
  const { logger } = silentLogger();
  const clock = makeClock();
  const q = createReadStatsQuery({
    gateway,
    storage: makeStorage(),
    now: clock.now,
    logger,
  });

  const result = await q.fetchRange({ from: "2026-08-01", to: "2026-08-07" });
  assert.deepEqual(result.range, { from: "2026-08-01", to: "2026-08-07" });
  assert.deepEqual(result.site, []);
  assert.deepEqual(result.hud, []);
  assert.equal(result.aggregate.totalReads, 0);
  assert.equal(result.aggregate.totalWrites, 0);
  assert.deepEqual(result.aggregate.byDate, {});
  assert.deepEqual(result.aggregate.bySource, { site: 0, clanSite: 0, clanVisitor: 0, hud: 0, other: 0, unknown: 0 });
  assert.deepEqual(result.aggregate.byHudVersion, {});
  assert.deepEqual(result.aggregate.byLabel, { site: [], hud: [] });
  assert.deepEqual(result.aggregate.byHudUser, []);
  assert.deepEqual(result.aggregate.bySiteSession, []);
});

test("hudDenyEvents + hudDenyRulesByBucket carry rule / subject context", async () => {
  const hudDocs = [
    {
      date: "2026-08-11",
      sourceUserId: "u1",
      readTotal: 5,
      writeTotal: 0,
      perLabelDenies: { "leaderboard": 3 },
      deniesRecent: [
        { at: "2026-08-11T10:00:00.000Z", bucket: "leaderboard", path: "leaderboard/u1_1v1",
          op: "write", code: "permission-denied", msg: "Missing or insufficient permissions.",
          subject: "playlist=1v1", rule: "version-gate" },
        { at: "2026-08-11T10:01:00.000Z", bucket: "leaderboard", path: "leaderboard/u1_2v2",
          op: "write", code: "permission-denied", msg: "blacklist",
          subject: "playlist=2v2", rule: "blacklisted" },
      ],
    },
    {
      date: "2026-08-11",
      sourceUserId: "u2",
      readTotal: 2,
      writeTotal: 0,
      perLabelDenies: { "leaderboard": 1 },
      deniesRecent: [
        { at: "2026-08-11T11:00:00.000Z", bucket: "leaderboard", path: "leaderboard/u2_1v1",
          op: "write", code: "permission-denied", msg: "version too old",
          subject: "playlist=1v1", rule: "version-gate" },
      ],
    },
  ];
  const gateway = makeGateway({ siteDocs: [], hudDocs });
  const { logger } = silentLogger();
  const q = createReadStatsQuery({
    gateway,
    storage: makeStorage(),
    now: () => 1_000_000,
    logger,
  });
  const result = await q.fetchRange({ from: "2026-08-11", to: "2026-08-11" });
  assert.equal(result.aggregate.hudDenyEvents.length, 3);
  // Newest first.
  assert.equal(result.aggregate.hudDenyEvents[0].at, "2026-08-11T11:00:00.000Z");
  assert.equal(result.aggregate.hudDenyEvents[0].uid, "u2");
  assert.equal(result.aggregate.hudDenyEvents[0].rule, "version-gate");
  const rules = result.aggregate.hudDenyRulesByBucket.leaderboard;
  assert.deepEqual(
    rules.map((r) => `${r.count}× ${r.rule}`),
    ["2× version-gate", "1× blacklisted"],
  );
});

test("hudDenyEvents carry the client-side reasons array (HUD 19.5+)", async () => {
  const hudDocs = [
    {
      date: "2026-08-14",
      sourceUserId: "u1",
      readTotal: 5,
      writeTotal: 0,
      perLabelDenies: { "match_snapshots": 1 },
      deniesRecent: [
        { at: "2026-08-14T10:00:00.000Z", bucket: "match_snapshots",
          path: "match_snapshots/u1_abc", op: "write", code: "permission-denied",
          msg: "Missing or insufficient permissions.", subject: "matchId=abc",
          rule: "unknown",
          reasons: [
            "mode must be one of [Competitive3v3, ...] (got \"1v1\")",
            "outcome must be one of [W, L, T] (got null)",
          ] },
      ],
    },
    {
      date: "2026-08-14",
      sourceUserId: "u2",
      readTotal: 2,
      writeTotal: 0,
      perLabelDenies: {},
      // old HUD, no reasons — should degrade to []
      deniesRecent: [
        { at: "2026-08-14T11:00:00.000Z", bucket: "script_submissions",
          op: "write", code: "permission-denied", msg: "denied", rule: "unknown" },
      ],
    },
  ];
  const gateway = makeGateway({ siteDocs: [], hudDocs });
  const { logger } = silentLogger();
  const q = createReadStatsQuery({
    gateway,
    storage: makeStorage(),
    now: () => 1_000_000,
    logger,
  });
  const result = await q.fetchRange({ from: "2026-08-14", to: "2026-08-14" });
  const events = result.aggregate.hudDenyEvents;
  assert.equal(events.length, 2);
  // Newest first — u2 event is newer.
  assert.deepEqual(events[0].reasons, []);
  assert.equal(events[1].reasons.length, 2);
  assert.match(events[1].reasons[0], /^mode must be/);
});

test("aggregate tolerates hud docs without deniesRecent (old schema)", async () => {
  const hudDocs = [
    {
      date: "2026-08-01",
      sourceUserId: "u1",
      readTotal: 1,
      writeTotal: 0,
      perLabelDenies: { "leaderboard": 1 },
      // no deniesRecent — pre-18.6 schema
    },
  ];
  const gateway = makeGateway({ siteDocs: [], hudDocs });
  const { logger } = silentLogger();
  const q = createReadStatsQuery({
    gateway,
    storage: makeStorage(),
    now: () => 1_000_000,
    logger,
  });
  const result = await q.fetchRange({ from: "2026-08-01", to: "2026-08-01" });
  assert.deepEqual(result.aggregate.hudDenyEvents, []);
  assert.deepEqual(result.aggregate.hudDenyRulesByBucket, {});
});

test("aggregate sums reads/writes across site + hud and sorts byLabel desc", async () => {
  const siteDocs = [
    {
      date: "2026-08-01",
      sessionId: "s1",
      updatedAt: "2026-08-01T12:00:00.000Z",
      total: 40,
      perLabel: { leaderboardSub: 30, iconKey: 10 },
      userAgent: "Mozilla/5.0 (Macintosh)",
    },
    {
      date: "2026-08-02",
      sessionId: "s2",
      updatedAt: "2026-08-02T12:00:00.000Z",
      total: 60,
      perLabel: { leaderboardSub: 50, adminRoster: 10 },
      userAgent: "Mozilla/5.0 (rgClan)",
    },
  ];
  const hudDocs = [
    {
      date: "2026-08-01",
      sourceUserId: "u1",
      readTotal: 20,
      writeTotal: 3,
      scriptVersion: "17.4",
      versionNum: 17.4,
      updatedAt: "2026-08-01T10:00:00.000Z",
      perLabelReads: { leaderboard: 15, clans: 5 },
      perLabelWrites: { leaderboard: 2, clans: 1 },
    },
    {
      date: "2026-08-02",
      sourceUserId: "u1",
      readTotal: 10,
      writeTotal: 2,
      scriptVersion: "17.4",
      versionNum: 17.4,
      updatedAt: "2026-08-02T10:00:00.000Z",
      perLabelReads: { leaderboard: 5, clans: 5 },
    },
    {
      date: "2026-08-02",
      sourceUserId: "u2",
      readTotal: 5,
      writeTotal: 1,
      scriptVersion: "17.3",
      versionNum: 17.3,
      updatedAt: "2026-08-02T09:00:00.000Z",
      perLabelReads: { leaderboard: 5 },
    },
  ];
  const gateway = makeGateway({ siteDocs, hudDocs });
  const { logger } = silentLogger();
  const q = createReadStatsQuery({
    gateway,
    storage: makeStorage(),
    now: () => 1_000_000,
    logger,
  });

  const result = await q.fetchRange({ from: "2026-08-01", to: "2026-08-02" });
  assert.equal(result.aggregate.totalReads, 40 + 60 + 20 + 10 + 5);
  assert.equal(result.aggregate.totalWrites, 3 + 2 + 1);
  assert.deepEqual(result.aggregate.byDate, {
    "2026-08-01": { site: 40, hud: 20, versions: { "17.4": 20 } },
    "2026-08-02": { site: 60, hud: 15, versions: { "17.4": 10, "17.3": 5 } },
  });
  // s2's userAgent matches /clan/i so it lands in clanSite; s1 stays site.
  assert.equal(result.aggregate.bySource.site, 40);
  assert.equal(result.aggregate.bySource.clanSite, 60);
  assert.equal(result.aggregate.bySource.hud, 35);
  assert.deepEqual(result.aggregate.byHudVersion, { "17.4": 30, "17.3": 5 });

  // byLabel is sorted desc.
  assert.deepEqual(result.aggregate.byLabel.site, [
    { label: "leaderboardSub", total: 80 },
    { label: "iconKey", total: 10 },
    { label: "adminRoster", total: 10 },
  ]);
  assert.deepEqual(result.aggregate.byLabel.hud, [
    { label: "leaderboard", total: 25 },
    { label: "clans", total: 10 },
  ]);

  // byHudUser combines the two u1 docs.
  assert.equal(result.aggregate.byHudUser.length, 2);
  const u1 = result.aggregate.byHudUser.find((row) => row.sourceUserId === "u1");
  assert.equal(u1.reads, 30);
  assert.equal(u1.writes, 5);
  assert.equal(u1.versionNum, 17.4);
  assert.equal(u1.lastUpdatedAt, "2026-08-02T10:00:00.000Z");

  // bySiteSession sorted desc by total.
  assert.equal(result.aggregate.bySiteSession[0].sessionId, "s2");
  assert.equal(result.aggregate.bySiteSession[0].total, 60);
  assert.equal(result.aggregate.bySiteSession[1].sessionId, "s1");
});

test("cache hit within TTL avoids the second fetch", async () => {
  const gateway = makeGateway({
    siteDocs: [{ date: "2026-08-01", sessionId: "s1", total: 5, perLabel: {} }],
    hudDocs: [],
  });
  const { logger } = silentLogger();
  const clock = makeClock();
  const q = createReadStatsQuery({
    gateway,
    cache: { ttlMs: 5 * 60_000, storageKey: "rgLB:readStatsCache:test" },
    storage: makeStorage(),
    now: clock.now,
    logger,
  });

  await q.fetchRange({ from: "2026-08-01", to: "2026-08-07" });
  assert.equal(gateway.calls.site, 1);
  assert.equal(gateway.calls.hud, 1);

  clock.advance(60_000); // still within 5-min TTL
  const second = await q.fetchRange({ from: "2026-08-01", to: "2026-08-07" });
  assert.equal(gateway.calls.site, 1, "second call should be a cache hit");
  assert.equal(gateway.calls.hud, 1, "second call should be a cache hit");
  assert.equal(second.aggregate.totalReads, 5, "cache hit still returns aggregate");
});

test("cache miss after TTL triggers a refetch", async () => {
  const gateway = makeGateway({
    siteDocs: [{ date: "2026-08-01", sessionId: "s1", total: 7, perLabel: {} }],
    hudDocs: [],
  });
  const { logger } = silentLogger();
  const clock = makeClock();
  const q = createReadStatsQuery({
    gateway,
    cache: { ttlMs: 5 * 60_000, storageKey: "rgLB:readStatsCache:test" },
    storage: makeStorage(),
    now: clock.now,
    logger,
  });

  await q.fetchRange({ from: "2026-08-01", to: "2026-08-07" });
  clock.advance(5 * 60_000 + 1);
  await q.fetchRange({ from: "2026-08-01", to: "2026-08-07" });
  assert.equal(gateway.calls.site, 2, "expired cache should refetch site");
  assert.equal(gateway.calls.hud, 2, "expired cache should refetch hud");
});

test("different ranges use separate cache slots", async () => {
  const gateway = makeGateway({
    siteDocs: [{ date: "2026-08-01", sessionId: "s1", total: 1, perLabel: {} }],
    hudDocs: [],
  });
  const { logger } = silentLogger();
  const clock = makeClock();
  const q = createReadStatsQuery({
    gateway,
    storage: makeStorage(),
    now: clock.now,
    logger,
  });

  await q.fetchRange({ from: "2026-08-01", to: "2026-08-07" });
  await q.fetchRange({ from: "2026-08-08", to: "2026-08-14" });
  assert.equal(gateway.calls.site, 2);
  await q.fetchRange({ from: "2026-08-01", to: "2026-08-07" });
  assert.equal(gateway.calls.site, 2, "reusing the first range should hit cache");
});

test("invalidateCache forces a refetch on the next call", async () => {
  const gateway = makeGateway({
    siteDocs: [{ date: "2026-08-01", sessionId: "s1", total: 3, perLabel: {} }],
    hudDocs: [],
  });
  const { logger } = silentLogger();
  const clock = makeClock();
  const q = createReadStatsQuery({
    gateway,
    storage: makeStorage(),
    now: clock.now,
    logger,
  });

  await q.fetchRange({ from: "2026-08-01", to: "2026-08-07" });
  q.invalidateCache();
  await q.fetchRange({ from: "2026-08-01", to: "2026-08-07" });
  assert.equal(gateway.calls.site, 2, "invalidateCache should force a refetch");
});

test("missing perLabel / perLabelReads fields don't crash aggregation", async () => {
  const gateway = makeGateway({
    siteDocs: [
      { date: "2026-08-01", sessionId: "s1", total: 5 }, // no perLabel
      { date: "2026-08-01", sessionId: "s2", total: 3, perLabel: null }, // null perLabel
      { date: "2026-08-01", sessionId: "s3", total: 2, perLabel: "wat" }, // wrong type
    ],
    hudDocs: [
      { date: "2026-08-01", sourceUserId: "u1", readTotal: 10 }, // no perLabelReads
      { date: "2026-08-01", sourceUserId: "u2", readTotal: 5, perLabelReads: null },
    ],
  });
  const { logger } = silentLogger();
  const q = createReadStatsQuery({
    gateway,
    storage: makeStorage(),
    now: () => 1_000_000,
    logger,
  });

  const result = await q.fetchRange({ from: "2026-08-01", to: "2026-08-01" });
  assert.equal(result.aggregate.totalReads, 5 + 3 + 2 + 10 + 5);
  assert.deepEqual(result.aggregate.byLabel.site, []);
  assert.deepEqual(result.aggregate.byLabel.hud, []);
});

test("fetchRange throws when from/to are missing", async () => {
  const gateway = makeGateway();
  const { logger } = silentLogger();
  const q = createReadStatsQuery({
    gateway,
    storage: makeStorage(),
    now: () => 1_000_000,
    logger,
  });
  await assert.rejects(() => q.fetchRange({}), /YYYY-MM-DD/);
  await assert.rejects(() => q.fetchRange({ from: "2026-08-01" }), /YYYY-MM-DD/);
});

test("fetch logs a cost breadcrumb via logger.info", async () => {
  const gateway = makeGateway({
    siteDocs: [{ date: "2026-08-01", sessionId: "s1", total: 1, perLabel: {} }],
    hudDocs: [
      { date: "2026-08-01", sourceUserId: "u1", readTotal: 1 },
      { date: "2026-08-01", sourceUserId: "u2", readTotal: 1 },
    ],
  });
  const { logger, calls } = silentLogger();
  const q = createReadStatsQuery({
    gateway,
    storage: makeStorage(),
    now: () => 1_000_000,
    logger,
  });
  await q.fetchRange({ from: "2026-08-01", to: "2026-08-01" });
  assert.equal(calls.info.length, 1);
  const [msg, meta] = calls.info[0];
  assert.equal(msg, "[RG SITE] read-stats fetched");
  assert.equal(meta.docs, 3);
  assert.equal(meta.cost, 3);
});

test("gateway missing required methods throws at construction", () => {
  assert.throws(() => createReadStatsQuery({ gateway: {} }), /fetchAdminReadStats/);
  assert.throws(
    () => createReadStatsQuery({ gateway: { fetchAdminReadStats: async () => [] } }),
    /fetchHudReadStats/,
  );
});

test("cache survives across factory instances (localStorage-backed)", async () => {
  const storage = makeStorage();
  const siteDocs = [{ date: "2026-08-01", sessionId: "s1", total: 9, perLabel: {} }];
  const clock = makeClock();
  const { logger } = silentLogger();

  const gwA = makeGateway({ siteDocs, hudDocs: [] });
  const qA = createReadStatsQuery({ gateway: gwA, storage, now: clock.now, logger });
  await qA.fetchRange({ from: "2026-08-01", to: "2026-08-07" });
  assert.equal(gwA.calls.site, 1);

  // Fresh instance sharing the storage should hit the same cache.
  const gwB = makeGateway({ siteDocs, hudDocs: [] });
  const qB = createReadStatsQuery({ gateway: gwB, storage, now: clock.now, logger });
  const result = await qB.fetchRange({ from: "2026-08-01", to: "2026-08-07" });
  assert.equal(gwB.calls.site, 0, "cross-instance cache should still hit");
  assert.equal(result.aggregate.totalReads, 9);
});

test("invalidateCache with no storage is a no-op (does not throw)", () => {
  const gateway = makeGateway();
  const { logger } = silentLogger();
  const q = createReadStatsQuery({
    gateway,
    storage: null,
    now: () => 0,
    logger,
  });
  q.invalidateCache();
});

test("bySource: source='clan' lands in clanSite regardless of userAgent", async () => {
  const gateway = makeGateway({
    siteDocs: [
      {
        date: "2026-08-01",
        sessionId: "clan-1",
        total: 25,
        perLabel: {},
        // UA doesn't say "clan" — the explicit source field should still win.
        userAgent: "Mozilla/5.0 (Macintosh)",
        source: "clan",
      },
    ],
    hudDocs: [],
  });
  const { logger } = silentLogger();
  const q = createReadStatsQuery({
    gateway,
    storage: makeStorage(),
    now: () => 1_000_000,
    logger,
  });
  const result = await q.fetchRange({ from: "2026-08-01", to: "2026-08-01" });
  assert.equal(result.aggregate.bySource.clanSite, 25);
  assert.equal(result.aggregate.bySource.site, 0);
});

test("bySource: source='player' lands in site", async () => {
  const gateway = makeGateway({
    siteDocs: [
      {
        date: "2026-08-01",
        sessionId: "p-1",
        total: 12,
        perLabel: {},
        // UA mentions "clan" — explicit source should still win and route to site.
        userAgent: "Mozilla/5.0 (rgClan)",
        source: "player",
      },
    ],
    hudDocs: [],
  });
  const { logger } = silentLogger();
  const q = createReadStatsQuery({
    gateway,
    storage: makeStorage(),
    now: () => 1_000_000,
    logger,
  });
  const result = await q.fetchRange({ from: "2026-08-01", to: "2026-08-01" });
  assert.equal(result.aggregate.bySource.site, 12);
  assert.equal(result.aggregate.bySource.clanSite, 0);
});

test("bySource: source='site' (legacy alias) still counts as site", async () => {
  const gateway = makeGateway({
    siteDocs: [
      {
        date: "2026-08-01",
        sessionId: "legacy-1",
        total: 7,
        perLabel: {},
        userAgent: "Mozilla/5.0 (Macintosh)",
        source: "site",
      },
    ],
    hudDocs: [],
  });
  const { logger } = silentLogger();
  const q = createReadStatsQuery({
    gateway,
    storage: makeStorage(),
    now: () => 1_000_000,
    logger,
  });
  const result = await q.fetchRange({ from: "2026-08-01", to: "2026-08-01" });
  assert.equal(result.aggregate.bySource.site, 7);
});

test("bySource: missing source field falls back to userAgent regex", async () => {
  const gateway = makeGateway({
    siteDocs: [
      // No `source` — falls back to UA sniff. Pre-migration doc.
      {
        date: "2026-08-01",
        sessionId: "old-1",
        total: 8,
        perLabel: {},
        userAgent: "Mozilla/5.0 (rgClan)",
      },
      {
        date: "2026-08-01",
        sessionId: "old-2",
        total: 4,
        perLabel: {},
        userAgent: "Mozilla/5.0 (Macintosh)",
      },
    ],
    hudDocs: [],
  });
  const { logger } = silentLogger();
  const q = createReadStatsQuery({
    gateway,
    storage: makeStorage(),
    now: () => 1_000_000,
    logger,
  });
  const result = await q.fetchRange({ from: "2026-08-01", to: "2026-08-01" });
  assert.equal(result.aggregate.bySource.clanSite, 8);
  assert.equal(result.aggregate.bySource.site, 4);
});

test("bySource: unknown source string lands in unknown bucket", async () => {
  const gateway = makeGateway({
    siteDocs: [
      {
        date: "2026-08-01",
        sessionId: "drift-1",
        total: 3,
        perLabel: {},
        userAgent: "Mozilla/5.0",
        source: "hud", // not a valid site-facing value
      },
    ],
    hudDocs: [],
  });
  const { logger } = silentLogger();
  const q = createReadStatsQuery({
    gateway,
    storage: makeStorage(),
    now: () => 1_000_000,
    logger,
  });
  const result = await q.fetchRange({ from: "2026-08-01", to: "2026-08-01" });
  assert.equal(result.aggregate.bySource.unknown, 3);
  assert.equal(result.aggregate.bySource.site, 0);
  assert.equal(result.aggregate.bySource.clanSite, 0);
});

// ------ snapshot fallback tests ------

function makeSnapshotGateway({ snapshot, siteDocs = [], hudDocs = [], failSnapshot = false } = {}) {
  const calls = { snapshot: 0, site: 0, hud: 0 };
  return {
    calls,
    fetchReadStatsSnapshot: async () => {
      calls.snapshot += 1;
      if (failSnapshot) throw new Error("cdn down");
      return snapshot;
    },
    fetchAdminReadStats: async () => { calls.site += 1; return siteDocs; },
    fetchHudReadStats: async () => { calls.hud += 1; return hudDocs; },
  };
}

test("snapshot path: uses CDN blob and skips Firestore when range fits window", async () => {
  const snapshot = {
    windowStart: "2026-07-10",
    windowEnd: "2026-08-09",
    site: [
      { id: "s1", date: "2026-08-05", sessionId: "s1", total: 10, perLabel: {}, source: "player" },
      { id: "s2", date: "2026-08-15", sessionId: "s2", total: 99, perLabel: {}, source: "player" },
    ],
    hud: [
      { id: "h1", date: "2026-08-05", sourceUserId: "u1", readTotal: 5, perLabel: {} },
    ],
  };
  const gateway = makeSnapshotGateway({ snapshot });
  const { logger } = silentLogger();
  const q = createReadStatsQuery({ gateway, storage: makeStorage(), now: () => 1_000_000, logger });
  const result = await q.fetchRange({ from: "2026-08-01", to: "2026-08-09" });
  assert.equal(gateway.calls.snapshot, 1, "snapshot fetched once");
  assert.equal(gateway.calls.site, 0, "no Firestore admin_read_stats call");
  assert.equal(gateway.calls.hud, 0, "no Firestore hud_read_stats call");
  assert.equal(result.source, "snapshot");
  // Out-of-range doc should be filtered out.
  assert.equal(result.site.length, 1);
  assert.equal(result.site[0].id, "s1");
  assert.equal(result.aggregate.totalReads, 10 + 5);
});

test("snapshot path: clips `from` to windowStart instead of scanning Firestore", async () => {
  const snapshot = {
    windowStart: "2026-07-10",
    windowEnd: "2026-08-09",
    site: [{ id: "s1", date: "2026-08-05", sessionId: "s1", total: 10, perLabel: {}, source: "player" }],
    hud: [],
  };
  const gateway = makeSnapshotGateway({
    snapshot,
    siteDocs: [{ id: "old", date: "2026-06-01", sessionId: "old", total: 42, perLabel: {}, source: "player" }],
    hudDocs: [],
  });
  const { logger } = silentLogger();
  const q = createReadStatsQuery({ gateway, storage: makeStorage(), now: () => 1_000_000, logger });
  const result = await q.fetchRange({ from: "2026-06-01", to: "2026-08-09" });
  assert.equal(gateway.calls.snapshot, 1);
  assert.equal(gateway.calls.site, 0, "30-day pick must not hit Firestore");
  assert.equal(gateway.calls.hud, 0);
  assert.equal(result.source, "snapshot");
  assert.equal(result.aggregate.totalReads, 10);
});

test("snapshot path: falls back to Firestore when CDN fetch throws", async () => {
  const gateway = makeSnapshotGateway({
    failSnapshot: true,
    siteDocs: [{ id: "s1", date: "2026-08-05", sessionId: "s1", total: 7, perLabel: {}, source: "player" }],
    hudDocs: [],
  });
  const { logger } = silentLogger();
  const q = createReadStatsQuery({ gateway, storage: makeStorage(), now: () => 1_000_000, logger });
  const result = await q.fetchRange({ from: "2026-08-01", to: "2026-08-09" });
  assert.equal(gateway.calls.snapshot, 1);
  assert.equal(gateway.calls.site, 1);
  assert.equal(result.source, "firestore");
  assert.equal(result.aggregate.totalReads, 7);
});

test("snapshot path: force=true still hits CDN when snapshot covers range", async () => {
  // Pins the fix for the "Refresh button burned 17k Firestore reads/day"
  // regression: force means "invalidate the local cache", not "punish us
  // with a Firestore fetch when a free CDN blob already answers".
  const snapshot = {
    windowStart: "2026-07-10",
    windowEnd: "2026-08-09",
    site: [{ id: "s1", date: "2026-08-05", sessionId: "s1", total: 10, perLabel: {}, source: "player" }],
    hud: [],
  };
  const gateway = makeSnapshotGateway({
    snapshot,
    siteDocs: [{ id: "live", date: "2026-08-08", sessionId: "live", total: 99, perLabel: {}, source: "player" }],
    hudDocs: [],
  });
  const { logger } = silentLogger();
  const q = createReadStatsQuery({ gateway, storage: makeStorage(), now: () => 1_000_000, logger });
  const result = await q.fetchRange({ from: "2026-08-01", to: "2026-08-09", force: true });
  assert.equal(gateway.calls.snapshot, 1, "snapshot is still consulted on force");
  assert.equal(gateway.calls.site, 0, "no Firestore fallback when snapshot serves");
  assert.equal(result.source, "snapshot");
  assert.equal(result.aggregate.totalReads, 10);
});

test("snapshot path: force=true still stays on snapshot when range predates window", async () => {
  const snapshot = {
    windowStart: "2026-07-10",
    windowEnd: "2026-08-09",
    site: [{ id: "s1", date: "2026-08-05", sessionId: "s1", total: 10, perLabel: {}, source: "player" }],
    hud: [],
  };
  const gateway = makeSnapshotGateway({
    snapshot,
    siteDocs: [{ id: "live", date: "2026-06-01", sessionId: "live", total: 42, perLabel: {}, source: "player" }],
    hudDocs: [],
  });
  const { logger } = silentLogger();
  const q = createReadStatsQuery({ gateway, storage: makeStorage(), now: () => 1_000_000, logger });
  const result = await q.fetchRange({ from: "2026-06-01", to: "2026-08-09", force: true });
  assert.equal(gateway.calls.snapshot, 1);
  assert.equal(gateway.calls.site, 0, "Refresh must not unlock a Firestore scan");
  assert.equal(result.source, "snapshot");
  assert.equal(result.aggregate.totalReads, 10);
});

test("snapshot path: force=true still clears the local cache", async () => {
  // Cache should not survive a manual Refresh — otherwise stale data
  // lingers even after the admin explicitly asked for fresh.
  const snapshot = {
    windowStart: "2026-07-10",
    windowEnd: "2026-08-09",
    site: [{ id: "s1", date: "2026-08-05", sessionId: "s1", total: 10, perLabel: {}, source: "player" }],
    hud: [],
  };
  const gateway = makeSnapshotGateway({ snapshot });
  const { logger } = silentLogger();
  const clock = makeClock();
  const q = createReadStatsQuery({ gateway, storage: makeStorage(), now: clock.now, logger });
  await q.fetchRange({ from: "2026-08-01", to: "2026-08-09" });
  assert.equal(gateway.calls.snapshot, 1);
  // Second call inside TTL — served from cache, no snapshot re-fetch.
  await q.fetchRange({ from: "2026-08-01", to: "2026-08-09" });
  assert.equal(gateway.calls.snapshot, 1);
  // force clears cache and re-hits the snapshot.
  await q.fetchRange({ from: "2026-08-01", to: "2026-08-09", force: true });
  assert.equal(gateway.calls.snapshot, 2);
});

test("snapshot path: clips `to` to windowEnd when caller asks past it (default range vs 15-min stale snapshot)", async () => {
  // Pins the fix for the "default range → all 4 collections hit Firestore
  // live" regression. Dashboard default is `isoDaysAgo(6) → todayIso()`,
  // but the snapshot is rebuilt every :15 min so `to` (today) almost
  // always exceeds `windowEnd` by a few hours. Old guard rejected the
  // snapshot wholesale; new guard clips `to` and serves the snapshot,
  // tagging `dataAsOf` so the UI knows.
  const snapshot = {
    windowStart: "2026-07-10",
    windowEnd: "2026-08-12", // yesterday
    site: [
      { id: "s1", date: "2026-08-05", sessionId: "s1", total: 10, perLabel: {}, source: "player" },
      { id: "s2", date: "2026-08-12", sessionId: "s2", total: 20, perLabel: {}, source: "player" },
    ],
    hud: [
      { id: "h1", date: "2026-08-12", sourceUserId: "u1", readTotal: 5, perLabel: {} },
    ],
  };
  const gateway = makeSnapshotGateway({ snapshot });
  const { logger } = silentLogger();
  const q = createReadStatsQuery({ gateway, storage: makeStorage(), now: () => 1_000_000, logger });
  // Ask for "today" (2026-08-13) — one day past windowEnd.
  const result = await q.fetchRange({ from: "2026-08-07", to: "2026-08-13" });
  assert.equal(gateway.calls.snapshot, 1);
  assert.equal(gateway.calls.site, 0, "no Firestore admin_read_stats fallback");
  assert.equal(gateway.calls.hud, 0, "no Firestore hud_read_stats fallback");
  assert.equal(result.source, "snapshot");
  assert.equal(result.dataAsOf, "2026-08-12", "dataAsOf carries the clipped windowEnd");
  // Both site docs (2026-08-05 + 2026-08-12) fall inside effective range 2026-08-07..2026-08-12.
  // Actually only 2026-08-12 does — 2026-08-05 is before `from`.
  assert.equal(result.site.length, 1);
  assert.equal(result.site[0].id, "s2");
  assert.equal(result.aggregate.totalReads, 20 + 5);
});

test("snapshot path: dataAsOf is null when range fits fully inside window", async () => {
  const snapshot = {
    windowStart: "2026-07-10",
    windowEnd: "2026-08-09",
    site: [{ id: "s1", date: "2026-08-05", sessionId: "s1", total: 10, perLabel: {}, source: "player" }],
    hud: [],
  };
  const gateway = makeSnapshotGateway({ snapshot });
  const { logger } = silentLogger();
  const q = createReadStatsQuery({ gateway, storage: makeStorage(), now: () => 1_000_000, logger });
  const result = await q.fetchRange({ from: "2026-08-01", to: "2026-08-08" });
  assert.equal(result.source, "snapshot");
  assert.equal(result.dataAsOf, null, "no clipping needed → dataAsOf is null");
});

test("snapshot path: totals + visitors from snapshot are aggregated without Firestore", async () => {
  // Pins the fix for the "read_stats_total + visitor_read_stats always
  // fall through to Firestore" leak. When the snapshot carries them we
  // must aggregate them locally and skip Firestore entirely.
  const snapshot = {
    windowStart: "2026-07-10",
    windowEnd: "2026-08-12",
    site: [{ id: "s1", date: "2026-08-06", sessionId: "s1", total: 10, perLabel: {}, source: "player" }],
    hud: [],
    total: [
      { id: "2026-08-06", date: "2026-08-06", reads: 100, writes: 20, deletes: 3 },
      { id: "2026-08-07", date: "2026-08-07", reads: 200, writes: 30, deletes: 0 },
      { id: "2026-06-01", date: "2026-06-01", reads: 9999, writes: 0, deletes: 0 }, // out of range
    ],
    visitors: [
      { id: "v1", date: "2026-08-06", sessionId: "v1", total: 7, perLabel: {} },
    ],
  };
  const gateway = makeSnapshotGateway({ snapshot });
  const { logger } = silentLogger();
  const q = createReadStatsQuery({ gateway, storage: makeStorage(), now: () => 1_000_000, logger });
  const result = await q.fetchRange({ from: "2026-08-06", to: "2026-08-12" });
  assert.equal(gateway.calls.site, 0, "no Firestore admin_read_stats fallback");
  assert.equal(gateway.calls.hud, 0, "no Firestore hud_read_stats fallback");
  assert.equal(result.source, "snapshot");
  assert.equal(result.totals.length, 2, "monitoring totals scoped to range");
  assert.equal(result.visitors.length, 1, "visitor docs available on payload");
  assert.equal(result.aggregate.monitoring.available, true);
  assert.equal(result.aggregate.monitoring.totalReads, 100 + 200);
  // Visitor doc gets tagged with source="visitor" → clanVisitor bucket.
  assert.equal(result.aggregate.bySource.clanVisitor, 7);
  assert.equal(result.aggregate.bySource.site, 10);
  assert.equal(result.aggregate.totalReads, 10 + 7);
});

test("snapshot path: a 30-day pick stays on the snapshot even when `from` predates it", async () => {
  const snapshot = {
    windowStart: "2026-07-10",
    windowEnd: "2026-08-12",
    site: [{ id: "s1", date: "2026-08-10", sessionId: "s1", total: 10, perLabel: {}, source: "player" }],
    hud: [],
  };
  const gateway = makeSnapshotGateway({
    snapshot,
    siteDocs: [{ id: "old", date: "2026-06-01", sessionId: "old", total: 42, perLabel: {}, source: "player" }],
    hudDocs: [],
  });
  const { logger } = silentLogger();
  const q = createReadStatsQuery({ gateway, storage: makeStorage(), now: () => 1_000_000, logger });
  const result = await q.fetchRange({ from: "2026-06-01", to: "2026-08-13" });
  assert.equal(gateway.calls.site, 0, "Firestore fallback must not fire");
  assert.equal(result.source, "snapshot");
  assert.equal(result.aggregate.totalReads, 10);
});

test("clampRangeToWindowDays: a 30-day span collapses to 7 days ending at `to`", () => {
  assert.equal(READ_STATS_WINDOW_DAYS, 7);
  const clamped = clampRangeToWindowDays("2026-06-01", "2026-08-09");
  assert.equal(clamped.from, "2026-08-03");
  assert.equal(clamped.to, "2026-08-09");
});

test("bySource: mixed docs aggregate correctly across all buckets", async () => {
  const gateway = makeGateway({
    siteDocs: [
      { date: "2026-08-01", sessionId: "p-1", total: 10, perLabel: {}, source: "player" },
      { date: "2026-08-01", sessionId: "c-1", total: 20, perLabel: {}, source: "clan" },
      { date: "2026-08-01", sessionId: "s-1", total: 5, perLabel: {}, source: "site" },
      // Pre-migration doc with clan UA — falls back to clanSite.
      { date: "2026-08-01", sessionId: "old-c", total: 4, perLabel: {}, userAgent: "clan" },
      // Pre-migration doc with plain UA — falls back to site.
      { date: "2026-08-01", sessionId: "old-s", total: 3, perLabel: {}, userAgent: "Mozilla" },
      // Drift value.
      { date: "2026-08-01", sessionId: "drift", total: 2, perLabel: {}, source: "weird" },
    ],
    hudDocs: [],
  });
  const { logger } = silentLogger();
  const q = createReadStatsQuery({
    gateway,
    storage: makeStorage(),
    now: () => 1_000_000,
    logger,
  });
  const result = await q.fetchRange({ from: "2026-08-01", to: "2026-08-01" });
  assert.equal(result.aggregate.bySource.site, 10 + 5 + 3);
  assert.equal(result.aggregate.bySource.clanSite, 20 + 4);
  assert.equal(result.aggregate.bySource.unknown, 2);
  assert.equal(result.aggregate.totalReads, 10 + 20 + 5 + 4 + 3 + 2);
});

// ------ rate-limit tests (defense-in-depth on Firestore fallback) ------

test("rate limit: token bucket refuses Firestore fallback when empty; returns rateLimited: true", async () => {
  // No snapshot gateway → every call hits the Firestore branch. With a
  // pre-drained bucket, the first call should be refused.
  const gateway = makeGateway({
    siteDocs: [{ date: "2026-08-01", sessionId: "s1", total: 5, perLabel: {} }],
    hudDocs: [],
  });
  const storage = makeStorage();
  const clock = makeClock();
  const bucket = createTokenBucket({
    capacity: 2,
    refillMs: 60 * 60_000,
    storage,
    now: clock.now,
    storageKey: "rgLB:rl:test",
  });
  // Drain the bucket manually.
  bucket.tryConsume();
  bucket.tryConsume();
  const { logger, calls } = silentLogger();
  const q = createReadStatsQuery({
    gateway,
    storage,
    now: clock.now,
    logger,
    rateLimiter: bucket,
  });
  const result = await q.fetchRange({ from: "2026-08-01", to: "2026-08-01" });
  assert.equal(gateway.calls.site, 0, "Firestore fallback must NOT fire when bucket is empty");
  assert.equal(gateway.calls.hud, 0);
  assert.equal(result.rateLimited, true);
  assert.equal(result.source, "rate-limited");
  assert.ok(result.rateLimitMsUntilRefill > 0, "rateLimitMsUntilRefill exposed for UI countdown");
  // Empty aggregate — no last-cached payload available.
  assert.equal(result.aggregate.totalReads, 0);
  assert.ok(calls.warn.some(([msg]) => String(msg).includes("rate-limited")), "warning is logged");
});

test("rate limit: refuses Firestore fallback but returns LAST cached payload when available", async () => {
  // Prime the cache with a successful fetch, then drain the bucket, then
  // ask for the same range and confirm we get the cached payload back.
  const gateway = makeGateway({
    siteDocs: [{ date: "2026-08-01", sessionId: "cached", total: 42, perLabel: {} }],
    hudDocs: [],
  });
  const storage = makeStorage();
  const clock = makeClock();
  const bucket = createTokenBucket({
    capacity: 5,
    refillMs: 60 * 60_000,
    storage,
    now: clock.now,
    storageKey: "rgLB:rl:cached",
  });
  const { logger } = silentLogger();
  const q = createReadStatsQuery({
    gateway,
    cache: { ttlMs: 5 * 60_000, storageKey: "rgLB:readStatsCache:rl-cached" },
    storage,
    now: clock.now,
    logger,
    rateLimiter: bucket,
  });
  // First call: consumes 1 token, populates cache.
  await q.fetchRange({ from: "2026-08-01", to: "2026-08-01" });
  assert.equal(gateway.calls.site, 1);
  // Drain remaining tokens.
  bucket.tryConsume(); bucket.tryConsume(); bucket.tryConsume(); bucket.tryConsume();
  // Expire TTL so the normal cache path is skipped.
  clock.advance(10 * 60_000);
  const result = await q.fetchRange({ from: "2026-08-01", to: "2026-08-01" });
  assert.equal(gateway.calls.site, 1, "no new Firestore fetch — bucket is empty");
  assert.equal(result.rateLimited, true);
  assert.equal(result.aggregate.totalReads, 42, "last-cached payload is returned intact");
});

test("rate limit: token bucket refills after refillMs elapses", async () => {
  const storage = makeStorage();
  const clock = makeClock();
  const bucket = createTokenBucket({
    capacity: 2,
    refillMs: 60 * 60_000,
    storage,
    now: clock.now,
    storageKey: "rgLB:rl:refill",
  });
  // Drain.
  assert.equal(bucket.tryConsume().ok, true);
  assert.equal(bucket.tryConsume().ok, true);
  const empty = bucket.tryConsume();
  assert.equal(empty.ok, false);
  assert.ok(empty.msUntilRefill > 0);
  // Advance time past refillMs — the whole bucket should reset.
  clock.advance(60 * 60_000 + 1);
  assert.equal(bucket.peek().tokens, 2, "bucket is full after refillMs");
  assert.equal(bucket.tryConsume().ok, true);
  assert.equal(bucket.tryConsume().ok, true);
  assert.equal(bucket.tryConsume().ok, false, "and re-empties after 2 more consumes");
});

test("rate limit: snapshot-served requests do NOT consume tokens (regression guard)", async () => {
  // The whole point of the rate limiter is to protect the Firestore
  // fallback — the snapshot path is CDN-served and essentially free, so
  // it must never touch the bucket.
  const snapshot = {
    windowStart: "2026-07-10",
    windowEnd: "2026-08-12",
    site: [{ id: "s1", date: "2026-08-05", sessionId: "s1", total: 10, perLabel: {}, source: "player" }],
    hud: [],
  };
  const gateway = makeSnapshotGateway({ snapshot });
  const storage = makeStorage();
  const clock = makeClock();
  const bucket = createTokenBucket({
    capacity: 3,
    refillMs: 60 * 60_000,
    storage,
    now: clock.now,
    storageKey: "rgLB:rl:snap",
  });
  const { logger } = silentLogger();
  const q = createReadStatsQuery({
    gateway,
    storage,
    now: clock.now,
    logger,
    rateLimiter: bucket,
  });
  // 10 snapshot-served fetches (bypass local cache with distinct ranges) —
  // bucket should remain full because no Firestore fallback occurred.
  for (let i = 1; i <= 10; i++) {
    const to = `2026-08-${String(i).padStart(2, "0")}`;
    await q.fetchRange({ from: "2026-08-01", to });
  }
  assert.equal(gateway.calls.site, 0, "snapshot path never hits Firestore");
  assert.equal(bucket.peek().tokens, 3, "bucket is untouched by snapshot-served fetches");
});

