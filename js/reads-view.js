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

import { createReadStatsQuery } from "./read-stats-query.js";
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
  let range = { from: isoDaysAgo(6), to: todayIso() };
  let latestData = null;
  let latestFetchAt = 0;
  let activeFetchToken = 0;

  function paintLoading() {
    renderReadDashboard(container, null, { loading: true });
  }

  function paintData(data) {
    renderReadDashboard(container, data, {
      onRefresh,
      onRangeChange: (from, to) => {
        // Basic range sanity — the picker enforces ISO date strings but
        // guard here anyway so a malformed input doesn't wedge the fetch.
        if (typeof from !== "string" || typeof to !== "string") return;
        if (from > to) [from, to] = [to, from];
        range = { from, to };
        fetchAndRender();
      },
      onExport,
    });
  }

  async function fetchAndRender({ force = false } = {}) {
    const token = ++activeFetchToken;
    paintLoading();
    if (force) query.invalidateCache();
    try {
      const data = await query.fetchRange({ ...range, force });
      if (token !== activeFetchToken) return; // superseded by a newer call
      latestData = data;
      latestFetchAt = Date.now();
      paintData(data);
    } catch (err) {
      if (token !== activeFetchToken) return;
      console.error("[rgLB] read-stats fetch failed:", err);
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
