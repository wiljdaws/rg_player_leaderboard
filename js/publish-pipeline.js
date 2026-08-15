// Admin-only "Publish pipeline" tab. Visualizes the CDC state produced by
// Tampermonkeys/firebase/scripts/build-leaderboard-cache.mjs so an operator
// can see at a glance:
//   - When the last publish landed and what mode it ran in (delta / full /
//     full-fallback)
//   - How many docs the delta query pulled per playlist vs how many are in
//     the persistent snapshot
//   - How many reads the CDC path saved compared to a naive full-scan
//   - A sparkline of the last 96 runs so drift / fallback events show up
//
// Data comes exclusively from GitHub raw — no Firestore reads. The workflow
// commits state/status.json, state/history.json, and state/{playlist}.json
// alongside the published leaderboard JSON. Raw revalidates via ETag every
// 5 min; jsDelivr's branch-alias cache held these files for hours.

const CDN_BASE = "https://raw.githubusercontent.com/wiljdaws/rg_player_leaderboard/data/state";
const PLAYLISTS = ["1v1", "2v2", "3v3", "wins"];
const REFRESH_MS = 30_000;

const $ = (id) => document.getElementById(id);

function el(tag, options = {}, children = []) {
  const element = document.createElement(tag);
  if (options.className) element.className = options.className;
  if (options.text !== undefined && options.text !== null) {
    element.textContent = String(options.text);
  }
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
  if (options.on) {
    for (const [event, handler] of Object.entries(options.on)) {
      element.addEventListener(event, handler);
    }
  }
  for (const child of children) {
    if (child == null || child === false) continue;
    element.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return element;
}

function svgNode(tag, attrs = {}, children = []) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
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

function fmtNum(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString("en-US") : "—";
}

function fmtAgo(iso, { now = Date.now() } = {}) {
  if (!iso) return "—";
  const ts = typeof iso === "number" ? iso : Date.parse(iso);
  if (!Number.isFinite(ts)) return "—";
  const diff = Math.max(0, now - ts);
  const sec = Math.round(diff / 1000);
  if (sec < 45) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

function fmtCursorAge(sinceIso, builtIso) {
  if (!sinceIso || !builtIso) return "—";
  const diff = Math.max(0, Date.parse(builtIso) - Date.parse(sinceIso));
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  return `${Math.round(min / 60)}h`;
}

function cursorAgeMs(sinceIso, builtIso) {
  if (!sinceIso || !builtIso) return null;
  return Math.max(0, Date.parse(builtIso) - Date.parse(sinceIso));
}

// Daily full-sync cron is "13 10 * * *" (10:13 UTC). Next occurrence in ms.
function nextFullSyncMs(now = Date.now()) {
  const d = new Date(now);
  d.setUTCHours(10, 13, 0, 0);
  if (d.getTime() <= now) d.setUTCDate(d.getUTCDate() + 1);
  return d.getTime();
}

function fmtCountdown(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "any moment";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h >= 1) return `${h}h ${m}m`;
  return `${m}m`;
}

// "Xd Yh Zm Ws" — leading zero segments dropped so short-lived counters
// don't render "0d 0h 3m 4s".
function fmtTrackedFor(sinceMs, now = Date.now()) {
  if (!Number.isFinite(sinceMs)) return null;
  const total = Math.max(0, Math.floor((now - sinceMs) / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (d || h) parts.push(`${h}h`);
  if (d || h || m) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

const FALLBACK_REASON_LABEL = {
  index_not_ready: "index still building",
};

// Fire only when a playlist's cursor is meaningfully older than the
// freshest playlist. If every playlist is equally stale it's a quiet
// site-wide period, not drift — no banner. Prevents the "1v1 and 2v2
// idle on a quiet Sunday" false positive.
const RELATIVE_LAG_MS = 15 * 60 * 1000;

function modeTone(mode) {
  if (mode === "delta") return "gain";
  if (mode === "full") return "gold";
  if (mode === "full-fallback") return "warn";
  return "grey";
}

function modeLabel(mode) {
  if (mode === "delta") return "DELTA";
  if (mode === "full") return "FULL";
  if (mode === "full-fallback") return "FALLBACK";
  return String(mode || "—").toUpperCase();
}

// Fetch with `cache: "no-store"` so a manual refresh actually hits the CDN
// instead of a stale browser cache. jsDelivr's own edge cache still applies.
async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
  return response.json();
}

async function fetchState() {
  const [status, history, lifetime, ...perPlaylist] = await Promise.all([
    fetchJson(`${CDN_BASE}/status.json`).catch(() => null),
    fetchJson(`${CDN_BASE}/history.json`).catch(() => null),
    fetchJson(`${CDN_BASE}/lifetime.json`).catch(() => null),
    ...PLAYLISTS.map(pl => fetchJson(`${CDN_BASE}/${pl}.json`).catch(() => null)),
  ]);
  const stateFiles = {};
  PLAYLISTS.forEach((pl, i) => { stateFiles[pl] = perPlaylist[i]; });
  return { status, history, lifetime, stateFiles };
}

function renderHeader({ status, onRefresh }) {
  const built = status?.builtAt;
  const overallMode = status?.overallMode || "—";
  return el("div", { className: "rd-header pp-header" }, [
    el("div", { className: "rd-header-title" }, [
      el("div", { className: "rd-kicker", text: "Data sync" }),
      el("div", { className: "rd-h2", text: "Firestore → CDN" }),
      el("div", { className: "pp-header-meta" }, [
        el("span", { className: `pp-mode pp-mode-${modeTone(overallMode)}`, text: modeLabel(overallMode) }),
        el("span", { className: "pp-header-sub", text: built ? `Last sync · ${fmtAgo(built)}` : "No status yet" }),
      ]),
    ]),
    el("div", { className: "rd-header-controls" }, [
      el("button", {
        className: "rd-btn rd-btn-primary",
        text: "Refresh",
        attrs: { type: "button" },
        on: { click: onRefresh },
      }),
    ]),
  ]);
}

function renderTiles(status, history, lifetime) {
  const readsThisRun = status?.readsThisRun ?? 0;
  const readsProjectedFullScan = status?.readsProjectedFullScan ?? 0;
  const snapshotTotal = status?.playlists
    ? Object.values(status.playlists).reduce((sum, p) => sum + (p.snapshotRows || 0), 0)
    : 0;

  // Lifetime counter climbs continuously from the day CDC shipped —
  // survives the 96-entry rolling history window. Falls back to the
  // cumulative-over-history-window number until lifetime.json exists
  // (first run after this deploy).
  const runs = history?.runs || [];
  const historicalActual = runs.reduce((sum, r) => sum + (r.reads || 0), 0);
  const historicalSaved = runs.reduce((sum, r) => sum + (r.readsSaved || 0), 0);
  const lifeSaved = lifetime?.readsSaved;
  const lifeBaseline = lifetime?.readsBaseline;
  const lifeSyncs = lifetime?.syncs;
  const lifeSince = lifetime?.since;

  let savedValue;
  let savedSub;
  let savedPct;
  if (Number.isFinite(lifeSaved) && Number.isFinite(lifeBaseline) && lifeBaseline > 0) {
    savedValue = lifeSaved;
    savedPct = Math.round((lifeSaved / lifeBaseline) * 1000) / 10;
    const trackedFor = lifeSince ? fmtTrackedFor(Date.parse(lifeSince)) : null;
    savedSub = trackedFor
      ? `Tracking for ${trackedFor} · ${fmtNum(lifeSyncs || 0)} syncs · ${fmtNum(lifeBaseline)} full-scan equivalent`
      : `${fmtNum(lifeSyncs || 0)} syncs · ${fmtNum(lifeBaseline)} full-scan equivalent`;
  } else if (runs.length) {
    const cumBaseline = historicalActual + historicalSaved;
    savedValue = historicalSaved;
    savedPct = cumBaseline > 0 ? Math.round((historicalSaved / cumBaseline) * 1000) / 10 : 0;
    savedSub = `${fmtNum(cumBaseline)} full-scan equivalent · last ${runs.length} syncs`;
  } else {
    savedValue = status?.readsSaved ?? 0;
    savedPct = status?.readsSavedPct ?? 0;
    savedSub = `${readsProjectedFullScan} full-scan equivalent · this sync`;
  }

  const deltaLabel = status?.overallMode === "delta"
    ? `${readsThisRun} of ${readsProjectedFullScan} · full-scan equivalent`
    : `${readsThisRun} (full re-sync)`;
  const nextFull = nextFullSyncMs();
  const modeSub = status?.forceFull
    ? `This run was the daily re-sync`
    : `Next daily re-sync in ${fmtCountdown(nextFull - Date.now())}`;
  return el("div", { className: "rd-chips-row pp-chips" }, [
    tile("Reads this sync", fmtNum(readsThisRun), deltaLabel, "gain"),
    tile(`Reads saved · ${savedPct.toFixed(1)}%`, fmtNum(savedValue), savedSub, "gold"),
    tile("Snapshot rows", fmtNum(snapshotTotal), "Persistent working set", "grad"),
    tile("Overall mode", modeLabel(status?.overallMode), modeSub, "silver"),
  ]);
}

function tile(label, value, sub, tone) {
  return el("div", { className: "rd-chip-tile pp-tile", dataset: { tone } }, [
    el("div", { className: "rd-chip-label", text: label }),
    el("div", { className: "rd-chip-value", text: value }),
    el("div", { className: "pp-tile-sub", text: sub }),
  ]);
}

// Flags playlists whose cursor lags the freshest playlist's cursor by
// more than RELATIVE_LAG_MS. Absolute staleness on its own doesn't fire
// — that just means nobody's playing right now.
function renderDriftBanner(status) {
  if (!status?.playlists || !status?.builtAt) return null;
  const ages = [];
  for (const [pl, per] of Object.entries(status.playlists)) {
    const age = cursorAgeMs(per.since, status.builtAt);
    if (age != null) ages.push({ pl, age });
  }
  if (ages.length < 2) return null;

  const minAge = Math.min(...ages.map(a => a.age));
  const laggards = ages
    .filter(a => a.age - minAge > RELATIVE_LAG_MS)
    .sort((a, b) => b.age - a.age);
  if (!laggards.length) return null;

  const summary = laggards.map(d => {
    const ageStr = fmtCursorAge(new Date(Date.parse(status.builtAt) - d.age).toISOString(), status.builtAt);
    return `${d.pl} idle ${ageStr}`;
  }).join(" · ");

  return el("div", {
    className: "pp-drift-banner",
    dataset: { tone: "info" },
    attrs: { role: "status" },
  }, [
    el("span", { className: "pp-drift-icon", text: "•" }),
    el("span", { className: "pp-drift-body" }, [
      el("b", { text: "Low activity · " }),
      el("span", { text: `${laggards.length} playlist${laggards.length === 1 ? "" : "s"} idle while others are active` }),
      el("div", { className: "pp-drift-detail", text: summary }),
    ]),
  ]);
}

function renderPlaylistTable({ status, stateFiles }) {
  const rows = PLAYLISTS.map(pl => {
    const per = status?.playlists?.[pl] || {};
    const state = stateFiles?.[pl];
    return {
      playlist: pl,
      mode: per.mode,
      delta: per.deltaRows,
      snapshot: per.snapshotRows ?? state?.snapshot?.length,
      since: per.since ?? state?.since,
      built: status?.builtAt,
      fallbackReason: per.fallbackReason ?? null,
    };
  });
  const head = el("div", { className: "pp-table-head" }, [
    el("span", { text: "Playlist" }),
    el("span", { text: "Mode" }),
    el("span", { className: "num", text: "Reads" }),
    el("span", { className: "num", text: "Snapshot" }),
    el("span", { className: "num", text: "Behind by" }),
    el("span", { text: "Newest write" }),
  ]);
  const body = rows.map(row => {
    const modeCell = row.fallbackReason
      ? el("span", { className: "pp-mode-cell" }, [
          el("span", { className: `pp-mode pp-mode-${modeTone(row.mode)}`, text: modeLabel(row.mode) }),
          el("span", { className: "pp-fallback-reason", text: FALLBACK_REASON_LABEL[row.fallbackReason] || row.fallbackReason }),
        ])
      : el("span", { className: `pp-mode pp-mode-${modeTone(row.mode)}`, text: modeLabel(row.mode) });
    return el("div", { className: "pp-table-row" }, [
      el("span", { className: "pp-cell-name", text: row.playlist }),
      modeCell,
      el("span", { className: "num pp-num", text: row.delta == null ? "—" : fmtNum(row.delta) }),
      el("span", { className: "num pp-num", text: fmtNum(row.snapshot) }),
      el("span", { className: "num pp-num pp-dim", text: fmtCursorAge(row.since, row.built) }),
      el("span", { className: "pp-mono pp-dim", text: row.since ? row.since.slice(11, 19) + "Z" : "—" }),
    ]);
  });
  return el("div", { className: "rd-panel pp-panel" }, [
    el("div", { className: "rd-panel-head" }, [
      el("div", { className: "rd-panel-title", text: "Per-playlist state" }),
      el("div", { className: "rd-panel-sub", text: "Reads = docs the delta query pulled this run. Behind by = time between the newest write we captured and this publish (small = writes are landing right up to publish time)." }),
    ]),
    el("div", { className: "pp-table" }, [head, ...body]),
  ]);
}

function renderHistory({ history }) {
  const runs = history?.runs?.slice(-48) || [];
  // Mode distribution across the window — quick "is fallback climbing?" signal.
  let modeSub = `Last ${runs.length} syncs · reads consumed, mode per run`;
  if (runs.length) {
    const counts = { delta: 0, full: 0, "full-fallback": 0 };
    for (const r of runs) {
      const m = r.overallMode || "delta";
      counts[m] = (counts[m] || 0) + 1;
    }
    const pct = k => Math.round((counts[k] / runs.length) * 100);
    const parts = [];
    if (counts.delta) parts.push(`Delta ${pct("delta")}%`);
    if (counts.full) parts.push(`Full ${pct("full")}%`);
    if (counts["full-fallback"]) parts.push(`Fallback ${pct("full-fallback")}%`);
    modeSub = `Last ${runs.length} syncs · ${parts.join(" · ")}`;
  }
  const panel = el("div", { className: "rd-panel pp-panel" }, [
    el("div", { className: "rd-panel-head" }, [
      el("div", { className: "rd-panel-title", text: "Recent syncs" }),
      el("div", { className: "rd-panel-sub", text: modeSub }),
    ]),
  ]);
  if (!runs.length) {
    panel.appendChild(el("div", { className: "pp-empty", text: "No history yet. First sync after this deploy will populate it." }));
    return panel;
  }

  const width = 720;
  const height = 120;
  const pad = { top: 12, right: 12, bottom: 22, left: 34 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const maxReads = Math.max(1, ...runs.map(r => r.reads || 0));
  const barW = Math.max(2, Math.floor(innerW / runs.length) - 2);
  const step = innerW / runs.length;

  const bars = runs.map((run, i) => {
    const x = pad.left + i * step + (step - barW) / 2;
    const h = Math.max(1, ((run.reads || 0) / maxReads) * innerH);
    const y = pad.top + innerH - h;
    const tone = modeTone(run.overallMode);
    return svgNode("rect", {
      x, y, width: barW, height: h,
      rx: 2,
      class: `pp-bar pp-bar-${tone}`,
      "data-tooltip": `${run.builtAt} · ${run.reads} reads (${modeLabel(run.overallMode)})`,
    });
  });

  // Baseline + top gridlines
  const gridLines = [
    svgNode("line", {
      x1: pad.left, x2: pad.left + innerW,
      y1: pad.top + innerH + 0.5, y2: pad.top + innerH + 0.5,
      class: "pp-axis",
    }),
    svgNode("line", {
      x1: pad.left, x2: pad.left + innerW,
      y1: pad.top + 0.5, y2: pad.top + 0.5,
      class: "pp-axis pp-axis-dim",
    }),
  ];

  // Y-axis labels: 0 and max
  const labels = [
    svgNode("text", {
      x: pad.left - 6, y: pad.top + innerH + 4,
      class: "pp-axis-text", "text-anchor": "end",
    }, [document.createTextNode("0")]),
    svgNode("text", {
      x: pad.left - 6, y: pad.top + 4,
      class: "pp-axis-text", "text-anchor": "end",
    }, [document.createTextNode(String(maxReads))]),
  ];

  const svg = svgNode("svg", {
    viewBox: `0 0 ${width} ${height}`,
    class: "pp-history-chart",
    preserveAspectRatio: "none",
    role: "img",
    "aria-label": "Reads per recent publish run",
  }, [...gridLines, ...labels, ...bars]);

  panel.appendChild(el("div", { className: "pp-chart-wrap" }, [svg]));

  // Legend
  const legend = el("div", { className: "pp-legend" }, [
    el("span", { className: "pp-legend-item" }, [
      el("span", { className: "pp-legend-swatch pp-bar-gain" }),
      el("span", { text: "delta" }),
    ]),
    el("span", { className: "pp-legend-item" }, [
      el("span", { className: "pp-legend-swatch pp-bar-gold" }),
      el("span", { text: "full re-sync" }),
    ]),
    el("span", { className: "pp-legend-item" }, [
      el("span", { className: "pp-legend-swatch pp-bar-warn" }),
      el("span", { text: "fallback (index issue)" }),
    ]),
  ]);
  panel.appendChild(legend);

  // Latest run summary
  const latest = runs[runs.length - 1];
  if (latest) {
    panel.appendChild(el("div", { className: "pp-latest" }, [
      el("span", { className: "pp-dim", text: "Latest:" }),
      el("span", { text: `${fmtAgo(latest.builtAt)} · ${latest.reads} reads · ${modeLabel(latest.overallMode)}` }),
    ]));
  }

  return panel;
}

function renderLoading(container) {
  container.innerHTML = "";
  container.appendChild(el("div", { className: "read-dashboard pp-loading" }, [
    el("div", { className: "rd-panel" }, [
      el("div", { className: "rd-panel-title", text: "Loading sync state…" }),
      el("div", { className: "rd-panel-sub", text: "Fetching status + snapshots from CDN" }),
    ]),
  ]));
}

function renderError(container, error) {
  container.innerHTML = "";
  container.appendChild(el("div", { className: "read-dashboard" }, [
    el("div", { className: "rd-panel pp-error" }, [
      el("div", { className: "rd-panel-title", text: "Data sync · error" }),
      el("div", { className: "rd-panel-sub", text: String(error?.message || error) }),
    ]),
  ]));
}

function paint(container, data, { onRefresh }) {
  container.innerHTML = "";
  const drift = renderDriftBanner(data.status);
  const shell = el("div", { className: "read-dashboard pp-view" }, [
    renderHeader({ status: data.status, onRefresh }),
    drift,
    renderTiles(data.status, data.history, data.lifetime),
    renderPlaylistTable(data),
    renderHistory(data),
  ]);
  container.appendChild(shell);
}

export function createPublishView() {
  const container = $("publishView");
  if (!container) return { activate() {}, deactivate() {} };
  let active = false;
  let pollTimer = null;
  let inflight = 0;

  async function refresh() {
    const token = ++inflight;
    try {
      const data = await fetchState();
      if (token !== inflight || !active) return;
      paint(container, data, { onRefresh: refresh });
    } catch (error) {
      if (token !== inflight || !active) return;
      renderError(container, error);
    }
  }

  return {
    activate() {
      container.hidden = false;
      active = true;
      renderLoading(container);
      refresh();
      pollTimer = window.setInterval(refresh, REFRESH_MS);
    },
    deactivate() {
      active = false;
      container.hidden = true;
      inflight++;
      if (pollTimer != null) {
        window.clearInterval(pollTimer);
        pollTimer = null;
      }
    },
  };
}
