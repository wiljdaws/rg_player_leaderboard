// Admin-only "Reads" tab. Composes:
//   - createReadStatsQuery (fetch + aggregate admin_read_stats + hud_read_stats)
//   - renderReadDashboard   (SVG dashboard with 8 panels)
//   - exportReadStatsAs*    (JSON / CSV / investigation bundle download)
//
// The tab is hidden until an admin signs in, so anonymous visitors never
// see it and the query — which requires isAdmin() at the rules layer —
// never fires for them.
//
// Show / hide is handled by activatePlaylist("reads") in app.js swapping
// the #boardSection ↔ #readsView containers. That keeps the tabs list a
// single source of truth (no separate route table).

import { createReadStatsQuery, clampRangeToWindowDays, READ_STATS_WINDOW_DAYS } from "./read-stats-query.js";
import { renderReadDashboard } from "./read-dashboard.js";
import {
  exportReadStatsAsJson,
  exportReadStatsAsCsv,
  bundleForInvestigation,
  triggerDownload,
} from "./read-stats-export.js";

const $ = (id) => document.getElementById(id);

function isoDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export function createReadsView({ gateway }) {
  const query = createReadStatsQuery({ gateway });
  const container = $("readsView");
  if (!container) return { activate() {}, deactivate() {} };

  // Persist the selected range across activations so refresh doesn't reset it.
  let range = { from: isoDaysAgo(READ_STATS_WINDOW_DAYS - 1), to: todayIso() };
  let latestData = null;
  let latestFetchAt = 0;
  let activeFetchToken = 0;
  // uid -> displayName lookup so the HUD users table can show names
  // instead of opaque auth uids. Built lazily from the wins roster.
  let nameByUid = new Map();
  let nameMapLoaded = false;

  async function loadNameMap() {
    if (nameMapLoaded) return nameByUid;
    nameMapLoaded = true;
    try {
      const url = "https://raw.githubusercontent.com/wiljdaws/rg_player_leaderboard/data/leaderboard/wins.json";
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) return nameByUid;
      const json = await response.json();
      for (const row of Array.isArray(json?.rows) ? json.rows : []) {
        if (row?.uid && row?.name) nameByUid.set(row.uid, row.name);
      }
    } catch {
      // Non-fatal. Table falls back to truncated uids.
    }
    return nameByUid;
  }

  function paintLoading() {
    renderReadDashboard(container, null, { loading: true });
  }

  function paintData(data) {
    renderReadDashboard(container, data, {
      nameByUid,
      onRefresh,
      onRangeChange: (from, to) => {
        if (typeof from !== "string" || typeof to !== "string") return;
        range = clampRangeToWindowDays(from, to);
        fetchAndRender();
      },
      onExport,
    });
  }

  async function fetchAndRender({ force = false } = {}) {
    const token = ++activeFetchToken;
    paintLoading();
    if (force) query.invalidateCache();
    // Fire the name lookup alongside the stats query. If it wins the
    // race great; if not, the next refresh will pick it up.
    loadNameMap();
    try {
      const data = await query.fetchRange({ ...range, force });
      if (token !== activeFetchToken) return; // superseded by a newer call
      latestData = data;
      latestFetchAt = Date.now();
      paintData(data);
    } catch (err) {
      if (token !== activeFetchToken) return;
      console.error("[RG SITE] read-stats fetch failed:", err);
      // Still render the dashboard with whatever we last had so the
      // header + refresh + export buttons stay usable. If nothing has
      // ever loaded, render an empty shape.
      paintData(latestData || {
        range,
        site: [],
        hud: [],
        aggregate: {
          totalReads: 0,
          totalWrites: 0,
          byDate: {},
          bySource: { site: 0, clanSite: 0, hud: 0, other: 0 },
          byHudVersion: {},
          byLabel: { site: [], hud: [] },
          byDenyLabel: { site: [], hud: [], totalSite: 0, totalHud: 0 },
          byHudUser: [],
          bySiteSession: [],
        },
        fetchedAt: latestFetchAt,
        error: err?.message || String(err),
      });
    }
  }

  function onRefresh() {
    fetchAndRender({ force: true });
  }

  function onExport(format) {
    if (!latestData) return;
    let out = null;
    if (format === "json") out = exportReadStatsAsJson(latestData);
    else if (format === "csv") out = exportReadStatsAsCsv(latestData);
    else if (format === "bundle") out = bundleForInvestigation(latestData);
    if (out) triggerDownload(out);
  }

  return {
    activate() {
      container.hidden = false;
      fetchAndRender();
    },
    deactivate() {
      container.hidden = true;
      activeFetchToken++; // cancels any in-flight render callbacks
    },
  };
}
