// Export helpers for the Reads admin dashboard.
//
// Given the aggregated payload produced by read-stats-query.js, this module
// turns it into browser-downloadable blobs in three flavors:
//
//   1. exportReadStatsAsJson       — raw data as-is, pretty printed.
//   2. exportReadStatsAsCsv        — 4-section multi-table CSV (daily, HUD user,
//                                    HUD label, site label).
//   3. bundleForInvestigation      — JSON envelope with the raw data plus an
//                                    environment fingerprint and a short
//                                    markdown narrative. Designed to hand off
//                                    to a chat model or a colleague when a
//                                    reads spike needs root-causing.
//
// All three return `{ filename, blob }`; the dashboard calls `triggerDownload`
// to actually kick off the browser download. Keeping the blob generation pure
// makes it trivial to unit-test — the DOM click path lives in one tiny helper.
//
// PII posture: HUD user agents can be identifying, so the CSV truncates them
// to 200 chars. The JSON / investigation bundle keeps them verbatim because
// those files land on the admin's own disk. `sourceUserId` values are the game
// user IDs we already share everywhere, so no redaction there.

const FIRESTORE_PROJECT_ID = "rgleaderboard";
const GENERATED_BY = "rg-player-leaderboard";

// ---------- shared helpers ----------------------------------------------------

function rangeSuffix(data) {
  const from = data?.range?.from || "unknown";
  const to = data?.range?.to || "unknown";
  return `${from}-${to}`;
}

function makeBlob(text, mime) {
  return new Blob([text], { type: mime });
}

// RFC 4180 quoting: wrap fields containing comma/quote/newline in double
// quotes, escape inner quotes by doubling them.
function csvEscape(value) {
  if (value == null) return "";
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function csvRow(fields) {
  return fields.map(csvEscape).join(",");
}

function truncateUA(ua, max = 200) {
  if (!ua) return "";
  const str = String(ua);
  return str.length > max ? str.slice(0, max) : str;
}

// ---------- JSON export -------------------------------------------------------

export function exportReadStatsAsJson(data, { pretty = true } = {}) {
  const text = JSON.stringify(data ?? {}, null, pretty ? 2 : 0);
  const filename = `rg-read-stats-${rangeSuffix(data)}.json`;
  return { filename, blob: makeBlob(text, "application/json") };
}

// ---------- CSV export --------------------------------------------------------

function buildDailySection(aggregate) {
  const byDate = aggregate?.byDate || {};
  const dates = Object.keys(byDate).sort();
  const lines = ["# daily", csvRow(["date", "site_reads", "hud_reads", "total"])];
  for (const date of dates) {
    const entry = byDate[date] || {};
    const site = Number(entry.site) || 0;
    const hud = Number(entry.hud) || 0;
    lines.push(csvRow([date, site, hud, site + hud]));
  }
  return lines.join("\n");
}

function buildHudUserSection(aggregate) {
  const rows = Array.isArray(aggregate?.byHudUser) ? aggregate.byHudUser : [];
  const lines = [
    "# by-hud-user",
    csvRow(["sourceUserId", "versionNum", "reads", "writes", "lastUpdatedAt"]),
  ];
  for (const row of rows) {
    lines.push(csvRow([
      row?.sourceUserId ?? "",
      row?.versionNum ?? "",
      Number(row?.reads) || 0,
      Number(row?.writes) || 0,
      row?.lastUpdatedAt ?? "",
    ]));
  }
  return lines.join("\n");
}

function buildLabelSection(sectionName, rows) {
  const lines = [`# ${sectionName}`, csvRow(["label", "total"])];
  const source = Array.isArray(rows) ? rows : [];
  for (const row of source) {
    lines.push(csvRow([row?.label ?? "", Number(row?.total) || 0]));
  }
  return lines.join("\n");
}

export function exportReadStatsAsCsv(data) {
  const aggregate = data?.aggregate || {};
  const byLabel = aggregate.byLabel || {};

  const sections = [
    buildDailySection(aggregate),
    buildHudUserSection(aggregate),
    buildLabelSection("by-hud-label", byLabel.hud),
    buildLabelSection("by-site-label", byLabel.site),
  ];

  // If any site session rows include user agents, they get truncated in the
  // relevant section — currently only surfaced when a caller extends the CSV,
  // but keep the helper referenced via the shared truncateUA so treeshaking
  // doesn't drop it. (No-op if no rows.)
  void truncateUA;

  const text = sections.join("\n\n") + "\n";
  const filename = `rg-read-stats-${rangeSuffix(data)}.csv`;
  return { filename, blob: makeBlob(text, "text/csv") };
}

// ---------- Investigation bundle ---------------------------------------------

function readAssetVersion() {
  if (typeof document === "undefined") return null;
  const tagged = document.querySelector("[data-asset-version]");
  if (tagged?.dataset?.assetVersion) return tagged.dataset.assetVersion;
  // Fall back to the `?v=` query on the first stylesheet — that's how the
  // static site cache-busts CSS between deploys.
  const link = document.querySelector('link[rel="stylesheet"]');
  if (link?.href) {
    try {
      const url = new URL(link.href, document.baseURI || undefined);
      const v = url.searchParams.get("v");
      if (v) return v;
    } catch {
      // ignore malformed href
    }
  }
  return null;
}

function readBudgetSnapshot() {
  try {
    const snap = globalThis.__rgReadBudget?.snapshot?.();
    return snap ?? null;
  } catch {
    return null;
  }
}

function environmentSnapshot() {
  const doc = typeof document !== "undefined" ? document : null;
  const nav = typeof navigator !== "undefined" ? navigator : null;
  const loc = typeof location !== "undefined" ? location : null;
  return {
    href: loc?.href ?? null,
    userAgent: nav?.userAgent ?? null,
    assetVersion: readAssetVersion(),
    firestoreProjectId: FIRESTORE_PROJECT_ID,
    readBudgetSnapshot: readBudgetSnapshot(),
    generatedAtIso: new Date().toISOString(),
    // Include timezone offset separately since ISO8601 above is always UTC (Z).
    // Callers eyeballing "peak day" want to know if the admin was on the west
    // coast when they pulled the bundle.
    tzOffsetMinutes: new Date().getTimezoneOffset(),
    // Any tag like `America/Chicago` when available.
    tzName: (typeof Intl !== "undefined" && Intl.DateTimeFormat)
      ? (Intl.DateTimeFormat().resolvedOptions().timeZone || null)
      : null,
    _docPresent: !!doc,
  };
}

function pickTopHudContributors(aggregate, limit = 3) {
  const rows = Array.isArray(aggregate?.byHudUser) ? aggregate.byHudUser : [];
  return [...rows]
    .sort((a, b) => (Number(b?.reads) || 0) - (Number(a?.reads) || 0))
    .slice(0, limit);
}

function pickPeakDay(aggregate) {
  const byDate = aggregate?.byDate || {};
  let bestDate = null;
  let bestTotal = -Infinity;
  for (const [date, entry] of Object.entries(byDate)) {
    const total = (Number(entry?.site) || 0) + (Number(entry?.hud) || 0);
    if (total > bestTotal) {
      bestTotal = total;
      bestDate = date;
    }
  }
  return bestDate ? { date: bestDate, total: bestTotal } : null;
}

function pickTopSiteLabel(aggregate) {
  const rows = aggregate?.byLabel?.site;
  if (!Array.isArray(rows) || !rows.length) return null;
  return [...rows].sort((a, b) => (Number(b?.total) || 0) - (Number(a?.total) || 0))[0];
}

function buildNarrative(data) {
  const from = data?.range?.from ?? "unknown";
  const to = data?.range?.to ?? "unknown";
  const aggregate = data?.aggregate || {};
  const totalReads = Number(aggregate.totalReads) || 0;

  const topHud = pickTopHudContributors(aggregate, 3);
  const peak = pickPeakDay(aggregate);
  const topSite = pickTopSiteLabel(aggregate);

  const topHudLine = topHud.length
    ? topHud
        .map((row) => `${row.sourceUserId ?? "?"} (${Number(row.reads) || 0})`)
        .join(", ")
    : "none";
  const peakLine = peak ? `${peak.date} at ${peak.total} reads` : "n/a";
  const topSiteLine = topSite
    ? `${topSite.label ?? "?"} at ${Number(topSite.total) || 0}`
    : "n/a";

  return [
    "# Read-stats investigation bundle",
    "",
    `Range: ${from} → ${to}`,
    `- Total reads: ${totalReads}`,
    `- Top HUD contributors: ${topHudLine}`,
    `- Peak day: ${peakLine}`,
    `- Top site call-site: ${topSiteLine}`,
    "",
    "Data below.",
  ].join("\n");
}

export function bundleForInvestigation(data) {
  const env = environmentSnapshot();
  const bundle = {
    envelope: {
      generatedAt: env.generatedAtIso,
      generatedBy: GENERATED_BY,
      firestoreProjectId: FIRESTORE_PROJECT_ID,
      href: env.href,
      userAgent: env.userAgent,
      assetVersion: env.assetVersion,
      tzOffsetMinutes: env.tzOffsetMinutes,
      tzName: env.tzName,
      readBudgetSnapshot: env.readBudgetSnapshot,
    },
    narrative: buildNarrative(data),
    data: data ?? {},
  };
  const text = JSON.stringify(bundle, null, 2);
  const filename = `rg-read-investigation-${rangeSuffix(data)}-${Date.now()}.json`;
  return { filename, blob: makeBlob(text, "application/json") };
}

// ---------- Download trigger --------------------------------------------------

export function triggerDownload({ filename, blob }) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on next tick so mobile Safari has time to actually kick off the
  // download.
  setTimeout(() => URL.revokeObjectURL(url), 500);
}
