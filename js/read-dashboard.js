// Read-insights admin dashboard renderer.
//
// Pure DOM + hand-rolled SVG — no chart libraries, no framework. Consumes the
// aggregate shape produced by createReadStatsQuery.fetchRange() and paints a
// series of panels (big-number chips, line chart, source donut, HUD version
// bars, top-labels dual list, HUD user table, site session table).
//
// The renderer is callback-driven: refresh / range-change / export are
// surfaced through the options object so the caller wires them however it
// likes (e.g. app.js glue).

const SVG_NS = "http://www.w3.org/2000/svg";

// "Current release" is derived from the live userscript header on GitHub
// so bumping @version in rg_hud.user.js is the single source of truth —
// no manual step here on release. Cached in sessionStorage with a 24h
// TTL so a normal dashboard visit hits GitHub zero times. First open
// of a fresh tab does one CDN-cached fetch, and the value updates in
// place when it lands.
let CURRENT_HUD_VERSION = "19.4";
const HUD_RAW_URL = "https://raw.githubusercontent.com/wiljdaws/Tampermonkeys/main/rg_hud.user.js";
const HUD_VERSION_CACHE_KEY = "rgAtlas.currentHudVersion.v1";
const HUD_VERSION_TTL_MS = 24 * 60 * 60 * 1000;

function readCachedHudVersion() {
  try {
    const raw = sessionStorage.getItem(HUD_VERSION_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.ver || !parsed.at) return null;
    if (Date.now() - Number(parsed.at) > HUD_VERSION_TTL_MS) return null;
    return String(parsed.ver);
  } catch {
    return null;
  }
}

function writeCachedHudVersion(ver) {
  try {
    sessionStorage.setItem(HUD_VERSION_CACHE_KEY, JSON.stringify({ ver, at: Date.now() }));
  } catch {
    // storage full / disabled — the fetch just re-runs next load
  }
}

async function refreshCurrentHudVersion() {
  const cached = readCachedHudVersion();
  if (cached) {
    if (cached !== CURRENT_HUD_VERSION) {
      CURRENT_HUD_VERSION = cached;
      repaintCurrentReleaseLabels();
    }
    return;
  }
  try {
    const res = await fetch(HUD_RAW_URL, { cache: "no-cache" });
    if (!res.ok) return;
    const text = await res.text();
    const m = text.match(/^\/\/\s*@version\s+([^\s]+)/m);
    if (!m) return;
    const next = m[1].trim();
    if (!next) return;
    writeCachedHudVersion(next);
    if (next !== CURRENT_HUD_VERSION) {
      CURRENT_HUD_VERSION = next;
      repaintCurrentReleaseLabels();
    }
  } catch {
    // fall back to the compile-time default; not worth surfacing
  }
}

function repaintCurrentReleaseLabels() {
  const doc = getDoc();
  if (!doc) return;
  const nodes = doc.querySelectorAll("[data-current-release-label]");
  nodes.forEach((n) => { n.textContent = `Current release: ${CURRENT_HUD_VERSION}`; });
  const rows = doc.querySelectorAll("[data-verbar-ver]");
  rows.forEach((row) => {
    const ver = row.getAttribute("data-verbar-ver");
    if (ver === CURRENT_HUD_VERSION) row.setAttribute("data-current", "true");
    else row.removeAttribute("data-current");
  });
}

// Kick off the fetch as soon as this module loads; it'll patch the DOM
// in place once the version resolves.
refreshCurrentHudVersion();

// ------------------------------------------------------------
// DOM helpers
// ------------------------------------------------------------

function el(tag, options = {}, children = []) {
  const doc = getDoc();
  const element = doc.createElement(tag);
  if (options.className) element.className = options.className;
  if (options.text !== undefined && options.text !== null) {
    element.textContent = String(options.text);
  }
  if (options.html !== undefined) element.innerHTML = options.html;
  if (options.attrs) {
    for (const [key, value] of Object.entries(options.attrs)) {
      if (value === false || value === null || value === undefined) continue;
      if (value === true) element.setAttribute(key, "");
      else element.setAttribute(key, String(value));
    }
  }
  if (options.dataset) {
    for (const [key, value] of Object.entries(options.dataset)) {
      element.dataset[key] = String(value);
    }
  }
  if (options.style) {
    for (const [key, value] of Object.entries(options.style)) {
      element.style.setProperty(key, value);
    }
  }
  if (options.on) {
    for (const [event, handler] of Object.entries(options.on)) {
      element.addEventListener(event, handler);
    }
  }
  for (const child of children) {
    if (child == null || child === false) continue;
    if (typeof child === "string") element.appendChild(doc.createTextNode(child));
    else element.appendChild(child);
  }
  return element;
}

function svg(tag, attrs = {}, children = []) {
  const doc = getDoc();
  const element = doc.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    element.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child == null || child === false) continue;
    element.appendChild(child);
  }
  return element;
}

function getDoc() {
  if (typeof document !== "undefined") return document;
  throw new Error("read-dashboard: no document available");
}

// ------------------------------------------------------------
// Formatting helpers
// ------------------------------------------------------------

function fmtNum(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "0";
  return v.toLocaleString("en-US");
}

function fmtCompact(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "0";
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return (v / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (abs >= 1_000) return (v / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(v);
}

function fmtDateShort(iso) {
  // Turn 2026-08-01 into "Aug 1"
  if (!iso) return "";
  const parts = String(iso).split("-");
  if (parts.length !== 3) return String(iso);
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return String(iso);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const month = dt.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  return `${month} ${d}`;
}

function fmtAgo(input) {
  if (!input) return "—";
  const ts = normalizeTimestampMs(input);
  if (ts == null) return "—";
  const now = Date.now();
  const diff = Math.max(0, now - ts);
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.round(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(mo / 12)}y ago`;
}

function normalizeTimestampMs(input) {
  if (input == null) return null;
  if (typeof input === "number" && Number.isFinite(input)) {
    // Assume ms if > 10^12, else seconds.
    return input > 1e12 ? input : input * 1000;
  }
  if (typeof input === "string") {
    const parsed = Date.parse(input);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (typeof input === "object") {
    if (typeof input.toMillis === "function") {
      try {
        return input.toMillis();
      } catch {
        /* fall through */
      }
    }
    if (typeof input.seconds === "number") {
      return input.seconds * 1000 + Math.floor((input.nanoseconds || 0) / 1e6);
    }
  }
  return null;
}

function truncateId(id, len = 8) {
  const s = String(id ?? "");
  if (s.length <= len) return s;
  return s.slice(0, len) + "…";
}

function shortUserAgent(ua) {
  if (!ua || typeof ua !== "string") return "unknown";
  const short = String(ua);
  // Very lightweight browser + OS extraction — good enough for a summary chip.
  let browser = "browser";
  if (/edg\//i.test(short)) browser = "Edge";
  else if (/chrome\//i.test(short) && !/edg\//i.test(short)) browser = "Chrome";
  else if (/firefox\//i.test(short)) browser = "Firefox";
  else if (/safari\//i.test(short) && !/chrome\//i.test(short)) browser = "Safari";
  else if (/opera|opr\//i.test(short)) browser = "Opera";
  let os = "unknown";
  if (/windows/i.test(short)) os = "Windows";
  else if (/mac os x|macintosh/i.test(short)) os = "macOS";
  else if (/iphone|ipad|ipod/i.test(short)) os = "iOS";
  else if (/android/i.test(short)) os = "Android";
  else if (/linux/i.test(short)) os = "Linux";
  return `${browser} · ${os}`;
}

function todayIso() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function isoDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ------------------------------------------------------------
// Public API
// ------------------------------------------------------------

export function renderReadDashboard(container, data, options = {}) {
  if (!container) return;
  const {
    onRefresh,
    onRangeChange,
    onExport,
    loading = false,
    nameByUid = null,
  } = options;

  container.classList.add("read-dashboard");
  // Reset children.
  while (container.firstChild) container.removeChild(container.firstChild);

  if (loading) {
    container.appendChild(renderSkeleton());
    return;
  }

  const safeData = data && typeof data === "object" ? data : {};
  const range = safeData.range || { from: isoDaysAgo(6), to: todayIso() };
  const aggregate = safeData.aggregate || {};

  container.appendChild(renderHeader({
    range,
    onRefresh,
    onRangeChange,
    onExport,
  }));

  // Defense-in-depth: when the Firestore-fallback rate limiter refuses a
  // fetch, the query layer flags the payload with `rateLimited: true` and
  // returns the last cached data. Surface that state as a small chip so
  // the operator knows why numbers might be stale.
  if (safeData?.rateLimited === true) {
    container.appendChild(renderRateLimitPill(safeData.rateLimitMsUntilRefill));
  }

  if (isEmpty(aggregate)) {
    container.appendChild(renderEmpty());
    return;
  }

  container.appendChild(renderBigNumbers(aggregate, safeData));
  container.appendChild(renderTimeChart(aggregate));
  container.appendChild(renderTwoUp(
    renderSourceBreakdown(aggregate),
    renderVersionBreakdown(aggregate),
  ));
  container.appendChild(renderTopLabels(aggregate));
  container.appendChild(renderTopDenies(aggregate));
  const recent = renderRecentDenies(aggregate, nameByUid);
  if (recent) container.appendChild(recent);
  container.appendChild(renderHudUsersTable(aggregate, nameByUid));
  container.appendChild(renderSiteSessionsTable(aggregate));
}

// ------------------------------------------------------------
// Empty + loading
// ------------------------------------------------------------

function isEmpty(agg) {
  const totalReads = Number(agg?.totalReads || 0);
  const totalWrites = Number(agg?.totalWrites || 0);
  const bySource = agg?.bySource || {};
  const bySourceTotal = Object.values(bySource).reduce(
    (sum, v) => sum + (Number(v) || 0),
    0,
  );
  const users = Array.isArray(agg?.byHudUser) ? agg.byHudUser.length : 0;
  const sessions = Array.isArray(agg?.bySiteSession) ? agg.bySiteSession.length : 0;
  return totalReads === 0 && totalWrites === 0 && bySourceTotal === 0 && users === 0 && sessions === 0;
}

function renderEmpty() {
  return el("div", { className: "rd-empty" }, [
    el("div", { className: "rd-empty-title", text: "No reads in this range" }),
    el("div", {
      className: "rd-empty-sub",
      text: "Pick a wider window or wait for HUD + site telemetry to arrive.",
    }),
  ]);
}

function renderRateLimitPill(msUntilRefill) {
  const minutes = Math.max(1, Math.ceil(Number(msUntilRefill || 0) / 60_000));
  return el("div", { className: "rd-rate-limit-pill", attrs: { role: "status" } }, [
    el("span", { className: "rd-rate-limit-dot", attrs: { "aria-hidden": "true" } }),
    el("span", {
      className: "rd-rate-limit-text",
      text: `Rate limited — showing cached data. Refill in ${minutes} min.`,
    }),
  ]);
}

function renderSkeleton() {
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push(el("div", { className: "rd-sk-row" }));
  return el("div", { className: "rd-skeleton" }, [
    el("div", { className: "rd-sk-header" }),
    el("div", { className: "rd-sk-chips" }, [
      el("div", { className: "rd-sk-chip" }),
      el("div", { className: "rd-sk-chip" }),
      el("div", { className: "rd-sk-chip" }),
      el("div", { className: "rd-sk-chip" }),
    ]),
    el("div", { className: "rd-sk-chart" }),
    ...rows,
  ]);
}

// ------------------------------------------------------------
// Header
// ------------------------------------------------------------

function renderHeader({ range, onRefresh, onRangeChange, onExport }) {
  const from = range?.from || isoDaysAgo(6);
  const to = range?.to || todayIso();

  const fromInput = el("input", {
    className: "rd-date-input",
    attrs: {
      type: "date",
      id: "rd-range-from",
      value: from,
      "aria-label": "Range start date",
    },
  });
  const toInput = el("input", {
    className: "rd-date-input",
    attrs: {
      type: "date",
      id: "rd-range-to",
      value: to,
      "aria-label": "Range end date",
    },
  });

  const handleRange = () => {
    if (typeof onRangeChange === "function") {
      onRangeChange(fromInput.value, toInput.value);
    }
  };
  fromInput.addEventListener("change", handleRange);
  toInput.addEventListener("change", handleRange);

  const refreshBtn = el("button", {
    className: "rd-btn rd-btn-primary",
    attrs: { type: "button", "aria-label": "Refresh read stats" },
    text: "Refresh",
    on: {
      click: () => {
        if (typeof onRefresh === "function") onRefresh();
      },
    },
  });

  const exportGroup = renderExportGroup(onExport);

  return el("section", { className: "rd-header" }, [
    el("div", { className: "rd-header-title" }, [
      el("span", { className: "rd-kicker", text: "Admin only" }),
      el("h2", { className: "rd-h2", text: "Read insights" }),
    ]),
    el("div", { className: "rd-header-controls" }, [
      el("label", { className: "rd-date-label" }, [
        el("span", { className: "rd-date-lead", text: "From" }),
        fromInput,
      ]),
      el("label", { className: "rd-date-label" }, [
        el("span", { className: "rd-date-lead", text: "To" }),
        toInput,
      ]),
      refreshBtn,
      exportGroup,
    ]),
  ]);
}

function renderExportGroup(onExport) {
  const handle = (format) => {
    if (typeof onExport === "function") onExport(format);
  };
  return el("div", { className: "rd-export-group", attrs: { role: "group", "aria-label": "Export read stats" } }, [
    el("button", {
      className: "rd-btn rd-btn-ghost",
      attrs: { type: "button", "data-export": "json" },
      text: "JSON",
      on: { click: () => handle("json") },
    }),
    el("button", {
      className: "rd-btn rd-btn-ghost",
      attrs: { type: "button", "data-export": "csv" },
      text: "CSV",
      on: { click: () => handle("csv") },
    }),
    el("button", {
      className: "rd-btn rd-btn-ghost",
      attrs: { type: "button", "data-export": "bundle" },
      text: "Bundle",
      on: { click: () => handle("bundle") },
    }),
  ]);
}

// ------------------------------------------------------------
// Big numbers
// ------------------------------------------------------------

function renderBigNumbers(agg, data) {
  const attributedReads = Number(agg?.totalReads || 0);
  const monitoringAvailable = Boolean(agg?.monitoring?.available);
  const monitoringReads = Number(agg?.monitoring?.totalReads || 0);
  const untrackedReads = Number(agg?.untracked?.totalReads || 0);
  const totalWrites = Number(agg?.totalWrites || 0);
  const activeHuds = Array.isArray(agg?.byHudUser) ? agg.byHudUser.length : 0;
  const siteSessions = Array.isArray(agg?.bySiteSession)
    ? agg.bySiteSession.length
    : Array.isArray(data?.site) ? data.site.length : 0;

  // Layout is different depending on whether Cloud Monitoring totals are
  // available. When they are, the top row shows Firestore-project-wide
  // totals + our attributed slice + the untracked remainder. When they
  // aren't, we show just the attributed slice so the dashboard still
  // works before the Monitoring pipeline is deployed.
  const chips = monitoringAvailable
    ? [
        chipTile("Firestore reads", monitoringReads, "gain",
          "Total from Cloud Monitoring across every source hitting the project."),
        chipTile("Attributed", attributedReads, "grad",
          "Reads we can trace to a specific source via telemetry."),
        chipTile("Untracked", untrackedReads, "gold",
          "Firestore total minus attributed. Likely Pal's site + old HUDs + scrapers."),
        chipTile("Active HUDs", activeHuds, "silver",
          "Distinct HUDs that reported telemetry in the range."),
      ]
    : [
        chipTile("Attributed reads", attributedReads, "gain",
          "Reads we can trace via telemetry. Total from Cloud Monitoring not yet wired."),
        chipTile("Total writes", totalWrites, "gold"),
        chipTile("Active HUDs", activeHuds, "grad"),
        chipTile("Site sessions", siteSessions, "silver"),
      ];

  return el("section", { className: "rd-chips-row", attrs: { "aria-label": "Range totals" } }, chips);
}

function chipTile(label, value, tone, hint) {
  const tile = el("div", {
    className: "rd-chip-tile",
    dataset: { tone: tone || "ink" },
    attrs: hint ? { title: hint } : {},
  }, [
    el("div", { className: "rd-chip-value", text: fmtNum(value) }),
    el("div", { className: "rd-chip-label", text: label }),
  ]);
  return tile;
}

// ------------------------------------------------------------
// Reads-over-time line chart
// ------------------------------------------------------------

// Distinct hues for per-version lines. Current release always paints
// green (--gain) so it pops; palette skips green/purple so lines don't
// collide with the site accent.
const VERSION_LINE_PALETTE = [
  "#f5b64c", // amber
  "#4cd8f5", // cyan
  "#f56b9c", // pink
  "#ff8a5b", // coral
  "#b892ff", // lavender
  "#7be0a4", // mint
  "#e6e6e6", // near-white (last resort)
];
const OLDER_VERSION_COLOR = "#7a7a92";
const MAX_VERSION_LINES = 5;

function renderTimeChart(agg) {
  const byDate = agg?.byDate || {};
  const state = { mode: "source", selectedVersions: null };

  // Collect the set of versions we've ever seen in this range, ranked
  // by total reads so the multi-select puts the highest first.
  const versionTotals = {};
  for (const day of Object.values(byDate)) {
    const vers = day?.versions || {};
    for (const [v, n] of Object.entries(vers)) {
      versionTotals[v] = (versionTotals[v] || 0) + Number(n || 0);
    }
  }
  const rankedVersions = Object.entries(versionTotals)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([v]) => v);

  // Pre-select the top N. If the current release exists in the data,
  // keep it selected too even if it's not top-N.
  const initialSelected = new Set(rankedVersions.slice(0, MAX_VERSION_LINES));
  if (rankedVersions.includes(CURRENT_HUD_VERSION)) initialSelected.add(CURRENT_HUD_VERSION);
  state.selectedVersions = initialSelected;

  const chartHost = el("div", { className: "rd-timechart-wrap" });
  const legendHost = el("div", { className: "rd-chart-legend" });

  function paint() {
    chartHost.innerHTML = "";
    legendHost.innerHTML = "";
    const model = buildChartModel(byDate, state);
    const svgEl = buildChartSvg(model);
    chartHost.appendChild(svgEl);
    const tooltip = createChartTooltip();
    chartHost.appendChild(tooltip);
    installChartHover(chartHost, svgEl, tooltip, model);
    for (const swatch of buildLegend(state)) legendHost.appendChild(swatch);
  }

  const controls = buildChartControls(rankedVersions, versionTotals, state, paint);
  paint();

  return el("section", { className: "rd-panel" }, [
    panelHead("Reads over time", "Daily totals — pick source or version breakdown"),
    controls,
    chartHost,
    legendHost,
  ]);
}

function buildChartControls(rankedVersions, versionTotals, state, paint) {
  const modeSelect = el("select", {
    className: "rd-chart-mode",
    attrs: { "aria-label": "Chart grouping" },
    on: {
      change: (e) => {
        state.mode = e.target.value;
        versionRow.hidden = state.mode !== "version";
        paint();
      },
    },
  }, [
    optionEl("source", "By source (Site vs HUD)", true),
    optionEl("version", "By HUD version"),
  ]);

  // Toggleable chips — one per version, top N pre-selected.
  const chips = rankedVersions.map((ver) => {
    const isOn = state.selectedVersions.has(ver);
    const chip = el("button", {
      className: `rd-verchip${isOn ? " rd-verchip-on" : ""}`,
      attrs: { type: "button", "data-ver": ver, "aria-pressed": isOn ? "true" : "false" },
      text: `${ver} · ${fmtCompact(versionTotals[ver] || 0)}`,
      on: {
        click: () => {
          if (state.selectedVersions.has(ver)) state.selectedVersions.delete(ver);
          else state.selectedVersions.add(ver);
          const on = state.selectedVersions.has(ver);
          chip.className = `rd-verchip${on ? " rd-verchip-on" : ""}`;
          chip.setAttribute("aria-pressed", on ? "true" : "false");
          paint();
        },
      },
    });
    return chip;
  });
  const versionRow = el("div", {
    className: "rd-verchip-row",
    attrs: { "aria-label": "HUD versions to plot" },
  }, chips);
  versionRow.hidden = true;

  return el("div", { className: "rd-chart-controls" }, [
    el("label", { className: "rd-chart-mode-label", text: "Group by:" }),
    modeSelect,
    versionRow,
  ]);
}

function optionEl(value, label, selected = false) {
  const opt = el("option", {
    text: label,
    attrs: { value },
  });
  if (selected) opt.selected = true;
  return opt;
}

function buildChartModel(byDate, state) {
  const keys = Object.keys(byDate).sort();
  const width = 720;
  const height = 260;
  const padX = 44;
  const padTop = 24;
  const padBottom = 34;
  const innerW = width - padX * 2;
  const innerH = height - padTop - padBottom;
  const series = state.mode === "version"
    ? seriesByVersion(byDate, keys, state.selectedVersions)
    : seriesBySource(byDate, keys);
  const allValues = series.flatMap((s) => s.values.filter((v) => Number.isFinite(v)));
  const yMax = niceCeil(Math.max(1, ...allValues));
  const xForIdx = (i) => {
    if (keys.length <= 1) return padX + innerW / 2;
    return padX + (i / (keys.length - 1)) * innerW;
  };
  const yForVal = (v) => padTop + innerH - (v / yMax) * innerH;
  return {
    keys, series, width, height, padX, padTop, padBottom, innerW, innerH, yMax,
    xForIdx, yForVal,
  };
}

function buildChartSvg(model) {
  const { keys, series, width, height, padX, padTop, padBottom, innerH, yMax,
    xForIdx, yForVal } = model;
  const svgChildren = [];

  for (let i = 0; i <= 4; i++) {
    const y = padTop + (innerH * i) / 4;
    const gridVal = yMax * (1 - i / 4);
    svgChildren.push(svg("line", {
      x1: padX, x2: width - padX, y1: y, y2: y,
      stroke: "rgba(168,120,255,0.12)", "stroke-width": 1,
    }));
    svgChildren.push(text(padX - 8, y + 4, fmtCompact(gridVal), {
      "text-anchor": "end", fill: "var(--ink-dim)",
      "font-size": 11, "font-family": "var(--display)",
    }));
  }

  const tickStep = Math.max(1, Math.ceil(keys.length / 6));
  keys.forEach((k, i) => {
    if (i % tickStep !== 0 && i !== keys.length - 1) return;
    svgChildren.push(text(xForIdx(i), height - padBottom + 18, fmtDateShort(k), {
      "text-anchor": "middle", fill: "var(--ink-dim)",
      "font-size": 11, "font-family": "var(--display)",
    }));
  });

  // Vertical crosshair guide, hidden until hover picks a column.
  svgChildren.push(svg("line", {
    class: "rd-tc-guide",
    x1: 0, x2: 0, y1: padTop, y2: padTop + innerH,
    stroke: "rgba(255,255,255,0.28)", "stroke-width": 1,
    "stroke-dasharray": "3 3", "pointer-events": "none",
    style: "opacity:0",
  }));

  for (const s of series) {
    const path = pathFor(s.values, xForIdx, yForVal);
    if (path) {
      svgChildren.push(svg("path", {
        d: path, fill: "none", stroke: s.color, "stroke-width": 2,
        "stroke-linecap": "round", "stroke-linejoin": "round",
      }));
    }
    keys.forEach((k, i) => {
      const v = s.values[i];
      if (!Number.isFinite(v)) return;
      svgChildren.push(svg("circle", {
        class: "rd-tc-dot",
        "data-idx": String(i),
        cx: xForIdx(i), cy: yForVal(v), r: 3.5, fill: s.color,
        "aria-label": `${s.name} ${fmtDateShort(k)}: ${v}`,
      }));
    });
  }

  return svg("svg", {
    class: "rd-timechart",
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: "xMidYMid meet",
    role: "img",
    "aria-label": "Reads over time",
  }, svgChildren);
}

function createChartTooltip() {
  return el("div", { className: "rd-tc-tooltip", attrs: { "aria-hidden": "true" } });
}

// Snap-to-nearest hover: reads mouse position → converts to viewBox coords →
// picks the nearest date index → moves crosshair, enlarges that column's
// dots, and renders a compact tooltip with each series' value.
function installChartHover(host, svgEl, tooltip, model) {
  const { keys, series, xForIdx, width, height, padX, padTop, padBottom, innerH } = model;
  if (!keys.length) return;
  const guide = svgEl.querySelector(".rd-tc-guide");
  const dots = svgEl.querySelectorAll(".rd-tc-dot");

  function pointerXInViewBox(evt) {
    const rect = svgEl.getBoundingClientRect();
    if (!rect.width) return null;
    const xClient = evt.clientX - rect.left;
    return (xClient / rect.width) * width;
  }
  function nearestIndex(vbX) {
    if (vbX == null) return -1;
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < keys.length; i++) {
      const dx = Math.abs(xForIdx(i) - vbX);
      if (dx < bestDist) { bestDist = dx; bestIdx = i; }
    }
    return bestIdx;
  }
  function hide() {
    guide.style.opacity = "0";
    tooltip.classList.remove("rd-tc-tooltip-on");
    tooltip.setAttribute("aria-hidden", "true");
    dots.forEach((d) => d.removeAttribute("data-focus"));
  }
  function show(idx, evt) {
    const gx = xForIdx(idx);
    guide.setAttribute("x1", String(gx));
    guide.setAttribute("x2", String(gx));
    guide.style.opacity = "1";
    dots.forEach((d) => {
      if (d.getAttribute("data-idx") === String(idx)) d.setAttribute("data-focus", "true");
      else d.removeAttribute("data-focus");
    });

    // Build tooltip body: date header + one row per series with a value.
    // Series with no data on that day are dropped so the card stays compact.
    tooltip.innerHTML = "";
    const doc = getDoc();
    const head = doc.createElement("div");
    head.className = "rd-tc-tt-head";
    head.textContent = fmtDateShort(keys[idx]);
    tooltip.appendChild(head);
    const list = doc.createElement("div");
    list.className = "rd-tc-tt-list";
    const rows = series
      .map((s) => ({ name: s.name, color: s.color, value: s.values[idx] }))
      .filter((r) => Number.isFinite(r.value))
      .sort((a, b) => (b.value || 0) - (a.value || 0));
    if (rows.length === 0) {
      const empty = doc.createElement("div");
      empty.className = "rd-tc-tt-empty";
      empty.textContent = "No data";
      list.appendChild(empty);
    } else {
      for (const r of rows) {
        const row = doc.createElement("div");
        row.className = "rd-tc-tt-row";
        const swatch = doc.createElement("span");
        swatch.className = "rd-tc-tt-swatch";
        swatch.style.background = r.color;
        const name = doc.createElement("span");
        name.className = "rd-tc-tt-name";
        name.textContent = r.name;
        const val = doc.createElement("span");
        val.className = "rd-tc-tt-val";
        val.textContent = fmtNum(r.value);
        row.appendChild(swatch);
        row.appendChild(name);
        row.appendChild(val);
        list.appendChild(row);
      }
    }
    tooltip.appendChild(list);

    // Position the tooltip in host-relative coords. Flip left/right of the
    // crosshair so it never covers the mouse. Clamp inside the host.
    const rect = svgEl.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const pxPerVb = rect.width / width;
    const crosshairPx = (rect.left - hostRect.left) + gx * pxPerVb;
    const yPx = evt.clientY - hostRect.top;
    tooltip.classList.add("rd-tc-tooltip-on");
    tooltip.setAttribute("aria-hidden", "false");
    // Measure after content set.
    const ttW = tooltip.offsetWidth || 160;
    const ttH = tooltip.offsetHeight || 60;
    let left = crosshairPx + 14;
    if (left + ttW > hostRect.width - 6) left = crosshairPx - ttW - 14;
    if (left < 4) left = 4;
    let top = yPx - ttH - 12;
    if (top < 4) top = yPx + 16;
    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.top = `${Math.round(top)}px`;
  }

  svgEl.addEventListener("mousemove", (evt) => {
    const idx = nearestIndex(pointerXInViewBox(evt));
    if (idx < 0) { hide(); return; }
    show(idx, evt);
  });
  svgEl.addEventListener("mouseleave", hide);
  svgEl.addEventListener("touchend", hide);
}

function seriesBySource(byDate, keys) {
  return [
    { name: "Site", color: "var(--grad-a)", values: keys.map((k) => Number(byDate[k]?.site || 0)) },
    { name: "HUD",  color: "var(--gain)",   values: keys.map((k) => Number(byDate[k]?.hud  || 0)) },
  ];
}

function seriesByVersion(byDate, keys, selected) {
  const list = [...(selected || new Set())];
  // Stable order: current release first (gets --gain), then by size desc.
  const totals = new Map();
  for (const v of list) {
    let sum = 0;
    for (const k of keys) sum += Number(byDate[k]?.versions?.[v] || 0);
    totals.set(v, sum);
  }
  list.sort((a, b) => {
    if (a === CURRENT_HUD_VERSION) return -1;
    if (b === CURRENT_HUD_VERSION) return 1;
    return (totals.get(b) || 0) - (totals.get(a) || 0);
  });
  let paletteIdx = 0;
  return list.map((v) => {
    const isCurrent = v === CURRENT_HUD_VERSION;
    const color = isCurrent
      ? "var(--gain)"
      : (VERSION_LINE_PALETTE[paletteIdx++ % VERSION_LINE_PALETTE.length]);
    return {
      name: `v${v}`,
      color,
      values: keys.map((k) => Number(byDate[k]?.versions?.[v] || 0)),
    };
  });
}

function buildLegend(state) {
  const items = state.mode === "version"
    ? legendItemsForVersions(state.selectedVersions)
    : [
        { name: "Site", color: "var(--grad-a)" },
        { name: "HUD",  color: "var(--gain)"   },
      ];
  if (state.mode === "version" && items.length === 0) {
    return [el("span", { className: "rd-chart-legend-empty", text: "Pick a version above to plot." })];
  }
  return items.map((it) => legendSwatch(it.name, it.color));
}

function legendItemsForVersions(selected) {
  const list = [...(selected || new Set())];
  list.sort((a, b) => {
    if (a === CURRENT_HUD_VERSION) return -1;
    if (b === CURRENT_HUD_VERSION) return 1;
    return String(b).localeCompare(String(a), undefined, { numeric: true });
  });
  let paletteIdx = 0;
  return list.map((v) => ({
    name: `v${v}${v === CURRENT_HUD_VERSION ? " (current)" : ""}`,
    color: v === CURRENT_HUD_VERSION
      ? "var(--gain)"
      : VERSION_LINE_PALETTE[paletteIdx++ % VERSION_LINE_PALETTE.length],
  }));
}

function pathFor(values, xForIdx, yForVal) {
  const points = [];
  values.forEach((v, i) => {
    if (!Number.isFinite(v)) return;
    points.push(`${i === 0 ? "M" : "L"}${xForIdx(i).toFixed(2)},${yForVal(v).toFixed(2)}`);
  });
  if (points.length === 0) return null;
  return points.join(" ");
}

function niceCeil(v) {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / mag;
  let mult;
  if (norm <= 1) mult = 1;
  else if (norm <= 2) mult = 2;
  else if (norm <= 5) mult = 5;
  else mult = 10;
  return mult * mag;
}

function legendSwatch(label, color) {
  return el("span", { className: "rd-legend-item" }, [
    el("span", {
      className: "rd-legend-swatch",
      style: { "background-color": color },
      attrs: { "aria-hidden": "true" },
    }),
    el("span", { className: "rd-legend-label", text: label }),
  ]);
}

function text(x, y, content, attrs = {}) {
  const t = svg("text", { x, y, ...attrs });
  t.appendChild(textNode(content));
  return t;
}

function textNode(content) {
  return getDoc().createTextNode(String(content));
}

// ------------------------------------------------------------
// Source breakdown (donut)
// ------------------------------------------------------------

function renderSourceBreakdown(agg) {
  const bySource = agg?.bySource || {};
  const raw = [
    { key: "site", label: "Site", value: Number(bySource.site || 0), color: "var(--grad-a)" },
    { key: "clanSite", label: "Clan site (admin)", value: Number(bySource.clanSite || 0), color: "var(--grad-b)" },
    { key: "clanVisitor", label: "Clan visitors", value: Number(bySource.clanVisitor || 0), color: "var(--warn)" },
    { key: "hud", label: "HUD", value: Number(bySource.hud || 0), color: "var(--gain)" },
    { key: "other", label: "Other", value: Number(bySource.other || 0), color: "var(--ink-dim)" },
  ];
  const total = raw.reduce((sum, e) => sum + e.value, 0);

  const size = 180;
  const radius = 70;
  const cx = size / 2;
  const cy = size / 2;
  const strokeW = 22;

  const arcs = [];
  const legend = [];
  if (total > 0) {
    let cursor = 0;
    for (const entry of raw) {
      if (entry.value <= 0) continue;
      const frac = entry.value / total;
      const startAngle = cursor;
      cursor += frac;
      const endAngle = cursor;
      arcs.push(donutArc({
        cx,
        cy,
        radius,
        strokeW,
        startFrac: startAngle,
        endFrac: endAngle,
        color: entry.color,
        title: `${entry.label}: ${fmtNum(entry.value)} (${Math.round(frac * 100)}%)`,
      }));
    }
  } else {
    arcs.push(svg("circle", {
      cx,
      cy,
      r: radius,
      fill: "none",
      stroke: "var(--line)",
      "stroke-width": strokeW,
    }));
  }

  arcs.push(text(cx, cy - 2, fmtCompact(total), {
    "text-anchor": "middle",
    fill: "var(--ink)",
    "font-size": 22,
    "font-weight": 700,
    "font-family": "var(--display)",
  }));
  arcs.push(text(cx, cy + 16, "reads", {
    "text-anchor": "middle",
    fill: "var(--ink-dim)",
    "font-size": 11,
    "letter-spacing": 2,
    "font-family": "var(--display)",
  }));

  for (const entry of raw) {
    const pct = total > 0 ? Math.round((entry.value / total) * 100) : 0;
    legend.push(el("li", { className: "rd-donut-legend-row" }, [
      el("span", {
        className: "rd-donut-swatch",
        style: { "background-color": entry.color },
        attrs: { "aria-hidden": "true" },
      }),
      el("span", { className: "rd-donut-name", text: entry.label }),
      el("span", { className: "rd-donut-value", text: `${fmtNum(entry.value)} · ${pct}%` }),
    ]));
  }

  const chart = svg("svg", {
    class: "rd-donut",
    viewBox: `0 0 ${size} ${size}`,
    width: size,
    height: size,
    role: "img",
    "aria-label": "Reads by source",
  }, arcs);

  return el("section", { className: "rd-panel rd-panel-half" }, [
    panelHead("Source breakdown", "Where reads originated"),
    el("div", { className: "rd-donut-wrap" }, [
      chart,
      el("ul", { className: "rd-donut-legend", attrs: { "aria-label": "Source legend" } }, legend),
    ]),
  ]);
}

function donutArc({ cx, cy, radius, strokeW, startFrac, endFrac, color, title }) {
  const circ = 2 * Math.PI * radius;
  const dashLen = (endFrac - startFrac) * circ;
  const dashGap = circ - dashLen;
  const offset = -startFrac * circ;
  const circle = svg("circle", {
    cx,
    cy,
    r: radius,
    fill: "none",
    stroke: color,
    "stroke-width": strokeW,
    "stroke-dasharray": `${dashLen} ${dashGap}`,
    "stroke-dashoffset": offset,
    transform: `rotate(-90 ${cx} ${cy})`,
  });
  if (title) circle.appendChild(svg("title", {}, [textNode(title)]));
  return circle;
}

// ------------------------------------------------------------
// HUD version breakdown
// ------------------------------------------------------------

function renderVersionBreakdown(agg) {
  const byVer = agg?.byHudVersion || {};
  const entries = Object.entries(byVer)
    .map(([ver, count]) => ({ ver, count: Number(count) || 0 }))
    .filter((e) => e.count > 0)
    .sort((a, b) => b.count - a.count);

  const max = entries.reduce((m, e) => Math.max(m, e.count), 0);

  const rows = entries.length === 0
    ? [el("div", { className: "rd-inline-empty", text: "No HUD version data in range." })]
    : entries.map((e) => {
      const pct = max > 0 ? (e.count / max) * 100 : 0;
      const isCurrent = String(e.ver) === CURRENT_HUD_VERSION;
      return el("div", {
        className: "rd-verbar-row",
        dataset: { verbarVer: String(e.ver), ...(isCurrent ? { current: "true" } : {}) },
      }, [
        el("span", { className: "rd-verbar-tag", text: e.ver }),
        el("div", { className: "rd-verbar-track" }, [
          el("div", {
            className: "rd-verbar-fill",
            style: { width: `${pct.toFixed(1)}%` },
            attrs: { "aria-hidden": "true" },
          }),
        ]),
        el("span", { className: "rd-verbar-count", text: fmtNum(e.count) }),
      ]);
    });

  return el("section", { className: "rd-panel rd-panel-half" }, [
    panelHead(
      "HUD version breakdown",
      `Current release: ${CURRENT_HUD_VERSION}`,
      { subtitleAttrs: { "data-current-release-label": "true" } },
    ),
    el("div", { className: "rd-verbar-list" }, rows),
  ]);
}

// ------------------------------------------------------------
// Top labels (dual list)
// ------------------------------------------------------------

function renderTopLabels(agg) {
  const site = Array.isArray(agg?.byLabel?.site) ? agg.byLabel.site : [];
  const hud = Array.isArray(agg?.byLabel?.hud) ? agg.byLabel.hud : [];
  return el("section", { className: "rd-panel rd-panel-full" }, [
    panelHead("Top labels", "Highest-volume call-sites by source"),
    el("div", { className: "rd-toplabels-grid" }, [
      labelColumn("Site", site.slice(0, 10), "var(--grad-a)"),
      labelColumn("HUD", hud.slice(0, 10), "var(--gain)"),
    ]),
  ]);
}

// Permission-denied breakdown by call-site, so we can see which rule is
// tripping instead of just the total from Firebase's Rules metrics chart.
function renderTopDenies(agg) {
  const site = Array.isArray(agg?.byDenyLabel?.site) ? agg.byDenyLabel.site : [];
  const hud = Array.isArray(agg?.byDenyLabel?.hud) ? agg.byDenyLabel.hud : [];
  const totalSite = Number(agg?.byDenyLabel?.totalSite) || 0;
  const totalHud = Number(agg?.byDenyLabel?.totalHud) || 0;
  const total = totalSite + totalHud;
  const rulesByBucket = agg?.hudDenyRulesByBucket || {};
  const subtitle = total === 0
    ? "No permission-denied errors in range · rules are clean"
    : `${fmtNum(total)} permission-denied across site + HUD in range`;
  return el("section", { className: "rd-panel rd-panel-full" }, [
    panelHead("Denies by call-site", subtitle),
    el("div", { className: "rd-toplabels-grid" }, [
      labelColumn("Site", site.slice(0, 10), "var(--warn, #f5a742)", {}),
      labelColumn("HUD", hud.slice(0, 10), "var(--warn, #f5a742)", rulesByBucket),
    ]),
  ]);
}

function ruleSummary(rules) {
  if (!Array.isArray(rules) || rules.length === 0) return "";
  return rules
    .slice(0, 3)
    .map(({ rule, count }) => `${count}× ${rule || "unknown"}`)
    .join(" · ");
}

function labelColumn(title, rows, color, rulesByBucket = {}) {
  const max = rows.reduce((m, r) => Math.max(m, Number(r?.total) || 0), 0);
  return el("div", { className: "rd-toplabels-col" }, [
    el("h4", { className: "rd-toplabels-title", text: title }),
    rows.length === 0
      ? el("div", { className: "rd-inline-empty", text: "No labels in range." })
      : el("ul", { className: "rd-toplabels-list" }, rows.map((r) => {
        const total = Number(r?.total) || 0;
        const pct = max > 0 ? (total / max) * 100 : 0;
        const rules = rulesByBucket[r?.label] || [];
        const rulesText = ruleSummary(rules);
        return el("li", { className: "rd-toplabels-row" }, [
          el("div", { className: "rd-toplabels-label-wrap" }, [
            el("span", { className: "rd-toplabels-label", text: r?.label || "—", attrs: { title: r?.label || "" } }),
            rulesText
              ? el("span", { className: "rd-toplabels-sub", text: rulesText, attrs: { title: rulesText } })
              : null,
          ].filter(Boolean)),
          el("div", { className: "rd-toplabels-track" }, [
            el("div", {
              className: "rd-toplabels-fill",
              style: { width: `${pct.toFixed(1)}%`, "background-color": color },
              attrs: { "aria-hidden": "true" },
            }),
          ]),
          el("span", { className: "rd-toplabels-count", text: fmtNum(total) }),
        ]);
      })),
  ]);
}

function truncateMid(value, head = 8, tail = 4) {
  const s = String(value ?? "");
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function relativeTime(iso, nowMs = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const delta = Math.max(0, nowMs - t);
  const s = Math.round(delta / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

// Every rule gets a distinct hue so the operator can eyeball a burst
// of "everyone tripping version-gate at 3pm" without reading the label.
const DENY_RULE_STYLES = {
  "version-gate": { fg: "#f5a742", bg: "rgba(245,167,66,.14)" },
  "blacklisted": { fg: "#f87171", bg: "rgba(248,113,113,.16)" },
  "device-id": { fg: "#38bdf8", bg: "rgba(56,189,248,.14)" },
  "write-stamp": { fg: "#a78bfa", bg: "rgba(167,139,250,.16)" },
  "clan-membership": { fg: "#22d3ee", bg: "rgba(34,211,238,.14)" },
  "name-blocklist": { fg: "#f472b6", bg: "rgba(244,114,182,.16)" },
};
const DENY_RULE_UNKNOWN = { fg: "#94a3b8", bg: "rgba(148,163,184,.14)" };

function renderRuleChip(rule) {
  const label = rule || "unknown";
  const style = DENY_RULE_STYLES[label] || DENY_RULE_UNKNOWN;
  const chip = el("span", { className: "rd-deny-rule-chip", text: label });
  chip.style.color = style.fg;
  chip.style.backgroundColor = style.bg;
  chip.style.borderColor = style.fg;
  return chip;
}

function renderRecentDenies(agg, nameByUid) {
  const events = Array.isArray(agg?.hudDenyEvents) ? agg.hudDenyEvents : [];
  if (events.length === 0) return null;
  const lookupName = (uid) => {
    if (!uid) return "";
    if (nameByUid?.get) return nameByUid.get(uid) || uid;
    if (nameByUid && typeof nameByUid === "object") return nameByUid[uid] || uid;
    return uid;
  };
  const nowMs = Date.now();
  const rows = events.slice(0, 25).map((event) => {
    const displayName = lookupName(event.uid);
    // Show the resolved name when we have one, else a truncated uid so
    // long verify uuids don't dominate the row.
    const userLabel = displayName && displayName !== event.uid
      ? displayName
      : truncateMid(event.uid || "—", 10, 6);
    const bucketCell = el("div", { className: "rd-deny-callsite" }, [
      el("div", { className: "rd-deny-bucket", text: event.bucket || "—" }),
      event.path
        ? el("div", { className: "rd-deny-path", text: event.path, attrs: { title: event.path } })
        : null,
    ].filter(Boolean));
    const messageText = event.msg || event.code || "";
    const codeBadge = event.code
      ? el("span", { className: "rd-deny-code", text: event.code })
      : null;
    const msgCell = el("div", { className: "rd-deny-msg-cell" }, [
      codeBadge,
      el("span", { className: "rd-deny-msg-text", text: messageText, attrs: { title: messageText } }),
    ].filter(Boolean));
    return el("div", { className: "rd-tr rd-deny-row" }, [
      el("div", { className: "rd-td rd-deny-when", text: relativeTime(event.at, nowMs), attrs: { title: event.at || "" } }),
      el("div", { className: "rd-td rd-deny-user", text: userLabel, attrs: { title: event.uid || "" } }),
      el("div", { className: "rd-td rd-deny-rule" }, [renderRuleChip(event.rule)]),
      el("div", { className: "rd-td" }, [bucketCell]),
      el("div", { className: "rd-td rd-deny-op", text: event.op || "—" }),
      el("div", { className: "rd-td rd-deny-subject", text: event.subject || "—", attrs: { title: event.subject || "" } }),
      el("div", { className: "rd-td" }, [msgCell]),
    ]);
  });
  return el("section", { className: "rd-panel rd-panel-full" }, [
    panelHead(
      "Recent HUD denies",
      `Latest ${rows.length} deny event${rows.length === 1 ? "" : "s"} with rule, subject, and Firestore error`,
    ),
    el("div", { className: "rd-table rd-deny-table", attrs: { "data-table": "hud-denies" } }, [
      el("div", { className: "rd-tr rd-thead rd-deny-row" }, [
        el("div", { className: "rd-th", text: "When" }),
        el("div", { className: "rd-th", text: "User" }),
        el("div", { className: "rd-th", text: "Rule" }),
        el("div", { className: "rd-th", text: "Call-site" }),
        el("div", { className: "rd-th", text: "Op" }),
        el("div", { className: "rd-th", text: "Subject" }),
        el("div", { className: "rd-th", text: "Firestore message" }),
      ]),
      ...rows,
    ]),
  ]);
}

// ------------------------------------------------------------
// HUD users table
// ------------------------------------------------------------

const HUD_USER_COLUMNS = [
  { key: "sourceUserId", label: "User", sortable: true, kind: "text" },
  { key: "versionNum", label: "Version", sortable: true, kind: "text" },
  { key: "reads", label: "Reads", sortable: true, kind: "num" },
  { key: "writes", label: "Writes", sortable: true, kind: "num" },
  { key: "lastUpdatedAt", label: "Last active", sortable: true, kind: "time" },
];

function renderHudUsersTable(agg, nameByUid) {
  const rows = Array.isArray(agg?.byHudUser) ? agg.byHudUser.slice(0) : [];
  const lookupName = (uid) => {
    if (!uid) return null;
    if (nameByUid?.get) return nameByUid.get(uid) || null;
    if (nameByUid && typeof nameByUid === "object") return nameByUid[uid] || null;
    return null;
  };
  return sortableTable({
    id: "hud-users",
    title: "HUD users",
    subtitle: "Top 20 by reads",
    columns: HUD_USER_COLUMNS,
    rows,
    defaultSort: { key: "reads", dir: "desc" },
    max: 20,
    renderCell: (col, row) => {
      const v = row?.[col.key];
      if (col.key === "sourceUserId") {
        // Prefer the display name; fall back to the truncated uid for
        // users not yet on the wins leaderboard.
        const name = lookupName(v);
        return name || truncateId(v, 8);
      }
      if (col.key === "versionNum") return v ? String(v) : "—";
      if (col.key === "reads" || col.key === "writes") return fmtNum(Number(v) || 0);
      if (col.key === "lastUpdatedAt") return fmtAgo(v);
      return v == null ? "—" : String(v);
    },
    sortValue: (col, row) => {
      const v = row?.[col.key];
      if (col.kind === "num") return Number(v) || 0;
      if (col.kind === "time") {
        const ms = normalizeTimestampMs(v);
        return ms == null ? 0 : ms;
      }
      return String(v ?? "").toLowerCase();
    },
  });
}

// ------------------------------------------------------------
// Site sessions table
// ------------------------------------------------------------

const SITE_SESSION_COLUMNS = [
  { key: "sessionId", label: "Session", sortable: true, kind: "text" },
  { key: "adminEmail", label: "Signed in as", sortable: true, kind: "text" },
  { key: "source", label: "Source", sortable: true, kind: "text" },
  { key: "total", label: "Reads", sortable: true, kind: "num" },
  { key: "updatedAt", label: "Updated", sortable: true, kind: "time" },
  { key: "userAgentShort", label: "Client", sortable: true, kind: "text" },
];

// Shortens an admin email for readable display in the table. Keeps the
// mailbox and a fingerprint of the domain so Pal vs JesusDied4U reads
// clearly without dumping the full address into a narrow column.
function shortAdminEmail(email) {
  if (typeof email !== "string" || !email.length) return "—";
  const at = email.indexOf("@");
  if (at <= 0) return email.length > 22 ? email.slice(0, 22) + "…" : email;
  const mailbox = email.slice(0, at);
  const domain = email.slice(at + 1);
  const shortDomain = domain.length > 12 ? domain.slice(0, 12) + "…" : domain;
  return `${mailbox}@${shortDomain}`;
}

function renderSiteSessionsTable(agg) {
  const rows = Array.isArray(agg?.bySiteSession) ? agg.bySiteSession.slice(0) : [];
  return sortableTable({
    id: "site-sessions",
    title: "Site sessions",
    subtitle: "Top 20 by reads",
    columns: SITE_SESSION_COLUMNS,
    rows,
    defaultSort: { key: "total", dir: "desc" },
    max: 20,
    renderCell: (col, row) => {
      const v = row?.[col.key];
      if (col.key === "sessionId") return truncateId(v, 10);
      if (col.key === "adminEmail") return shortAdminEmail(v);
      if (col.key === "source") return v ? String(v) : "—";
      if (col.key === "total") return fmtNum(Number(v) || 0);
      if (col.key === "updatedAt") return fmtAgo(v);
      if (col.key === "userAgentShort") return shortUserAgent(v);
      return v == null ? "—" : String(v);
    },
    sortValue: (col, row) => {
      const v = row?.[col.key];
      if (col.kind === "num") return Number(v) || 0;
      if (col.kind === "time") {
        const ms = normalizeTimestampMs(v);
        return ms == null ? 0 : ms;
      }
      if (col.key === "userAgentShort") return shortUserAgent(v).toLowerCase();
      return String(v ?? "").toLowerCase();
    },
  });
}

// ------------------------------------------------------------
// Sortable table primitive
// ------------------------------------------------------------

function sortableTable({
  id,
  title,
  subtitle,
  columns,
  rows,
  defaultSort,
  max,
  renderCell,
  sortValue,
}) {
  const state = {
    key: defaultSort?.key || columns[0].key,
    dir: defaultSort?.dir || "desc",
  };

  const wrap = el("section", {
    className: "rd-panel rd-panel-full",
    attrs: { "data-table": id },
  }, [
    panelHead(title, subtitle),
  ]);

  const tableWrap = el("div", { className: "rd-table-wrap" });
  const table = el("div", {
    className: "rd-table",
    attrs: { role: "table", "aria-label": title },
  });

  const paint = () => {
    while (table.firstChild) table.removeChild(table.firstChild);

    const head = el("div", {
      className: "rd-tr rd-thead",
      attrs: { role: "row" },
    }, columns.map((col) => {
      const isSorted = state.key === col.key;
      const cell = el("button", {
        className: "rd-th",
        attrs: {
          type: "button",
          role: "columnheader",
          "aria-sort": isSorted ? (state.dir === "asc" ? "ascending" : "descending") : "none",
        },
        text: col.label,
        on: {
          click: () => {
            if (!col.sortable) return;
            if (state.key === col.key) {
              state.dir = state.dir === "asc" ? "desc" : "asc";
            } else {
              state.key = col.key;
              state.dir = col.kind === "num" || col.kind === "time" ? "desc" : "asc";
            }
            paint();
          },
        },
      });
      if (isSorted) {
        cell.appendChild(el("span", {
          className: "rd-sort-arrow",
          text: state.dir === "asc" ? " ↑" : " ↓",
          attrs: { "aria-hidden": "true" },
        }));
      }
      return cell;
    }));
    table.appendChild(head);

    const sortedCol = columns.find((c) => c.key === state.key) || columns[0];
    const sorted = rows.slice(0).sort((a, b) => {
      const av = sortValue(sortedCol, a);
      const bv = sortValue(sortedCol, b);
      if (av < bv) return state.dir === "asc" ? -1 : 1;
      if (av > bv) return state.dir === "asc" ? 1 : -1;
      return 0;
    });

    const shown = typeof max === "number" ? sorted.slice(0, max) : sorted;
    if (shown.length === 0) {
      table.appendChild(el("div", {
        className: "rd-empty-row",
        text: "No rows to display.",
      }));
    } else {
      for (const row of shown) {
        const tr = el("div", { className: "rd-tr", attrs: { role: "row" } });
        for (const col of columns) {
          tr.appendChild(el("span", {
            className: "rd-td",
            attrs: { role: "cell" },
            text: renderCell(col, row),
          }));
        }
        table.appendChild(tr);
      }
    }
  };

  paint();
  tableWrap.appendChild(table);
  wrap.appendChild(tableWrap);
  return wrap;
}

// ------------------------------------------------------------
// Shared building blocks
// ------------------------------------------------------------

function panelHead(title, subtitle, opts = {}) {
  const subtitleAttrs = opts.subtitleAttrs || null;
  return el("div", { className: "rd-panel-head" }, [
    el("h3", { className: "rd-panel-title", text: title }),
    subtitle
      ? el("p", {
          className: "rd-panel-sub",
          text: subtitle,
          ...(subtitleAttrs ? { attrs: subtitleAttrs } : {}),
        })
      : null,
  ].filter(Boolean));
}

function renderTwoUp(left, right) {
  return el("div", { className: "rd-twoup" }, [left, right]);
}

// Named exports for testing.
export const __private = {
  fmtNum,
  fmtCompact,
  fmtAgo,
  fmtDateShort,
  truncateId,
  shortUserAgent,
  niceCeil,
  normalizeTimestampMs,
};
