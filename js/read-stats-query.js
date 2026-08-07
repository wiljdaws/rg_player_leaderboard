// Query layer for the "Reads" admin dashboard.
//
// Fetches admin_read_stats (one doc per browser session per day) and
// hud_read_stats (one doc per HUD per day) for a date range and rolls them
// up into the aggregate the dashboard renders. Both collections are read-
// gated by isAdmin() at the rules layer, so callers must be authed as an
// admin before invoking any of these methods.
//
// Caching: results are stashed in localStorage under a versioned key with
// a 5-min TTL. The cache is keyed by `${from}:${to}` so switching ranges
// doesn't cross-contaminate. Cache misses always refetch; cache hits skip
// the network entirely and reuse the pre-aggregated payload.
//
// Cost model (typical 7-day range):
//   - 12 HUDs/day × 7 days = ~84 hud docs
//   - 3 admin sessions/day × 7 days = ~21 admin docs
//   - Total: ~105 reads per fetch, cached for 5 min
//
// Every fetch logs an `[rgLB] read-stats fetched` line to console.info so
// the actual cost can be audited in DevTools. Turn off with the browser
// devtools log filter if it gets noisy.

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_STORAGE_KEY = "rgLB:readStatsCache:v1";

// Source attribution for admin_read_stats docs. Every writer now stamps an
// explicit `source` field ("player" from the leaderboard site, "clan" from
// the clan site). We prefer that field; the userAgent regex is only a
// fallback for pre-migration docs that pre-date the field. Once every
// dashboard write predates the migration cutover, the regex path can be
// deleted along with CLAN_SITE_UA_PATTERN.
const CLAN_SITE_UA_PATTERN = /clan/i;

function bucketForDoc(doc) {
  // Explicit `source` field wins when present. "clan" is the clan site;
  // "player" (new) and "site" (legacy alias) both land in the site bucket.
  // Anything else lands in "unknown" so data drift is visible in the
  // dashboard instead of quietly rolling up into the wrong bucket.
  const src = typeof doc?.source === "string" ? doc.source : "";
  if (src) {
    if (src === "clan") return "clanSite";
    if (src === "player" || src === "site") return "site";
    return "unknown";
  }
  // Fallback for pre-migration docs (no `source` field): sniff the
  // userAgent for the clan-site marker. This path can be dropped once
  // enough time has passed for all cached docs to age out.
  const ua = typeof doc?.userAgent === "string" ? doc.userAgent : "";
  return CLAN_SITE_UA_PATTERN.test(ua) ? "clanSite" : "site";
}

function safeStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function shortUserAgent(userAgent) {
  if (typeof userAgent !== "string") return "";
  return userAgent.length > 80 ? `${userAgent.slice(0, 77)}...` : userAgent;
}

// Sums a `{ label: count }` map into an accumulator. Missing / non-object
// inputs are tolerated silently so a rolled-back schema doesn't blow up
// the aggregate.
function accumulateLabels(target, source) {
  if (!source || typeof source !== "object") return;
  for (const [label, value] of Object.entries(source)) {
    const num = Number(value);
    if (!Number.isFinite(num)) continue;
    target[label] = (target[label] || 0) + num;
  }
}

function sortedLabelList(labels) {
  return Object.entries(labels)
    .map(([label, total]) => ({ label, total }))
    .sort((a, b) => b.total - a.total);
}

function safeNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function aggregate({ siteDocs, hudDocs }) {
  const byDate = {};
  const bySource = { site: 0, clanSite: 0, hud: 0, other: 0, unknown: 0 };
  const byHudVersion = {};
  const siteLabels = {};
  const hudLabels = {};
  const hudUsersById = new Map();
  const sessionRows = [];

  let totalReads = 0;
  let totalWrites = 0;

  for (const doc of Array.isArray(siteDocs) ? siteDocs : []) {
    if (!doc || typeof doc !== "object") continue;
    const date = typeof doc.date === "string" ? doc.date : "unknown";
    const reads = safeNumber(doc.total);
    const bucket = bucketForDoc(doc);

    totalReads += reads;
    bySource[bucket] += reads;

    const dayBucket = byDate[date] || (byDate[date] = { site: 0, hud: 0 });
    dayBucket.site += reads;

    accumulateLabels(siteLabels, doc.perLabel);

    sessionRows.push({
      sessionId: typeof doc.sessionId === "string" ? doc.sessionId : (doc.id || ""),
      total: reads,
      updatedAt: typeof doc.updatedAt === "string" ? doc.updatedAt : "",
      userAgentShort: shortUserAgent(doc.userAgent),
    });
  }

  for (const doc of Array.isArray(hudDocs) ? hudDocs : []) {
    if (!doc || typeof doc !== "object") continue;
    const date = typeof doc.date === "string" ? doc.date : "unknown";
    const reads = safeNumber(doc.readTotal);
    const writes = safeNumber(doc.writeTotal);

    totalReads += reads;
    totalWrites += writes;
    bySource.hud += reads;

    const dayBucket = byDate[date] || (byDate[date] = { site: 0, hud: 0 });
    dayBucket.hud += reads;

    accumulateLabels(hudLabels, doc.perLabelReads);

    const versionKey = doc.scriptVersion != null
      ? String(doc.scriptVersion)
      : (doc.versionNum != null ? String(doc.versionNum) : "unknown");
    byHudVersion[versionKey] = (byHudVersion[versionKey] || 0) + reads;

    // Multiple docs share the same sourceUserId across days. Combine into
    // one row per user by summing reads/writes; keep the newest version /
    // updatedAt so the dashboard can flag stale HUDs.
    const userId = typeof doc.sourceUserId === "string" ? doc.sourceUserId : (doc.id || "");
    const prev = hudUsersById.get(userId) || {
      sourceUserId: userId,
      reads: 0,
      writes: 0,
      versionNum: null,
      lastUpdatedAt: "",
    };
    prev.reads += reads;
    prev.writes += writes;
    const versionNum = Number(doc.versionNum);
    if (Number.isFinite(versionNum) && (prev.versionNum == null || versionNum > prev.versionNum)) {
      prev.versionNum = versionNum;
    }
    const updatedAt = typeof doc.updatedAt === "string" ? doc.updatedAt : "";
    if (updatedAt && updatedAt > prev.lastUpdatedAt) prev.lastUpdatedAt = updatedAt;
    hudUsersById.set(userId, prev);
  }

  return {
    totalReads,
    totalWrites,
    byDate,
    bySource,
    byHudVersion,
    byLabel: {
      site: sortedLabelList(siteLabels),
      hud: sortedLabelList(hudLabels),
    },
    byHudUser: Array.from(hudUsersById.values()).sort((a, b) => b.reads - a.reads),
    bySiteSession: sessionRows.sort((a, b) => b.total - a.total),
  };
}

function readCache(storage, storageKey, cacheKey, ttlMs, now) {
  if (!storage) return null;
  let raw;
  try {
    raw = storage.getItem(storageKey);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const entry = parsed[cacheKey];
  if (!entry || typeof entry !== "object") return null;
  const fetchedAt = Number(entry.fetchedAt) || 0;
  if (!fetchedAt || now() - fetchedAt > ttlMs) return null;
  return entry;
}

function writeCache(storage, storageKey, cacheKey, entry) {
  if (!storage) return;
  let parsed = {};
  try {
    const raw = storage.getItem(storageKey);
    if (raw) parsed = JSON.parse(raw) || {};
  } catch {
    parsed = {};
  }
  parsed[cacheKey] = entry;
  try {
    storage.setItem(storageKey, JSON.stringify(parsed));
  } catch {
    // Quota exceeded / private mode / etc. — cache is a nice-to-have, not
    // load-bearing. Silently drop and let the next call refetch.
  }
}

function clearCache(storage, storageKey) {
  if (!storage) return;
  try {
    storage.removeItem(storageKey);
  } catch {}
}

export function createReadStatsQuery({
  gateway,
  cache = { ttlMs: DEFAULT_TTL_MS, storageKey: DEFAULT_STORAGE_KEY },
  storage = safeStorage(),
  now = () => Date.now(),
  logger = typeof console !== "undefined" ? console : null,
} = {}) {
  if (!gateway || typeof gateway.fetchAdminReadStats !== "function" || typeof gateway.fetchHudReadStats !== "function") {
    throw new Error("createReadStatsQuery requires a gateway with fetchAdminReadStats and fetchHudReadStats.");
  }

  const ttlMs = Number.isFinite(cache?.ttlMs) ? cache.ttlMs : DEFAULT_TTL_MS;
  const storageKey = typeof cache?.storageKey === "string" && cache.storageKey
    ? cache.storageKey
    : DEFAULT_STORAGE_KEY;

  async function fetchRange({ from, to } = {}) {
    if (typeof from !== "string" || typeof to !== "string") {
      throw new Error("fetchRange requires from and to as YYYY-MM-DD strings.");
    }
    const cacheKey = `${from}:${to}`;
    const cached = readCache(storage, storageKey, cacheKey, ttlMs, now);
    if (cached) {
      return cached.payload;
    }

    const startedAt = now();
    const [siteDocs, hudDocs] = await Promise.all([
      gateway.fetchAdminReadStats(from, to),
      gateway.fetchHudReadStats(from, to),
    ]);

    const site = Array.isArray(siteDocs) ? siteDocs : [];
    const hud = Array.isArray(hudDocs) ? hudDocs : [];
    const aggregateResult = aggregate({ siteDocs: site, hudDocs: hud });
    const fetchedAt = now();
    const docs = site.length + hud.length;

    const payload = {
      range: { from, to },
      site,
      hud,
      aggregate: aggregateResult,
      fetchedAt,
    };

    writeCache(storage, storageKey, cacheKey, { payload, fetchedAt });

    // Cost breadcrumb — the actual bill is one Firestore read per returned
    // doc plus one indexed-query overhead. Rounded up to `docs` for a safe
    // upper bound so the log matches what shows up in the console.
    try {
      logger?.info?.("[rgLB] read-stats fetched", {
        docs,
        ms: fetchedAt - startedAt,
        cost: docs,
      });
    } catch {}

    return payload;
  }

  function invalidateCache() {
    clearCache(storage, storageKey);
  }

  return { fetchRange, invalidateCache };
}
