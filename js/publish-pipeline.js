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
// Data comes exclusively from jsDelivr — no Firestore reads. The workflow
// commits state/status.json, state/history.json, and state/{playlist}.json
// alongside the published leaderboard JSON.

const CDN_BASE = "https://cdn.jsdelivr.net/gh/wiljdaws/rg_player_leaderboard@data/state";
const PLAYLISTS = ["1v1", "2v2", "3v3", "wins"];
const REFRESH_MS = 30_000;

const $ = (id) => document.getElementById(id);

function el(tag, options = {}, children = []) {
  const element = document.createElement(tag);
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
  const [status, history, ...perPlaylist] = await Promise.all([
    fetchJson(`${CDN_BASE}/status.json`).catch(() => null),
    fetchJson(`${CDN_BASE}/history.json`).catch(() => null),
    ...PLAYLISTS.map(pl => fetchJson(`${CDN_BASE}/${pl}.json`).catch(() => null)),
  ]);
  const stateFiles = {};
  PLAYLISTS.forEach((pl, i) => { stateFiles[pl] = perPlaylist[i]; });
  return { status, history, stateFiles };
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

function renderTiles(status, history) {
  const readsThisRun = status?.readsThisRun ?? 0;
  const readsProjectedFullScan = status?.readsProjectedFullScan ?? 0;
  const snapshotTotal = status?.playlists
    ? Object.values(status.playlists).reduce((sum, p) => sum + (p.snapshotRows || 0), 0)
    : 0;

  // Cumulative comparison over the last N syncs — the honest apples-to-
  // apples "what did CDC actually save vs. full-scans on the same cadence"
  // number. Each history entry has actual reads + readsSaved; baseline
  // for that run is reads + readsSaved.
  const runs = history?.runs || [];
  const cumActual = runs.reduce((sum, r) => sum + (r.reads || 0), 0);
  const cumSaved = runs.reduce((sum, r) => sum + (r.readsSaved || 0), 0);
  const cumBaseline = cumActual + cumSaved;
  const cumPct = cumBaseline > 0 ? Math.round((cumSaved / cumBaseline) * 1000) / 10 : 0;

  const savedSub = runs.length
    ? `${fmtNum(cumBaseline)} full-scan equivalent · last ${runs.length} syncs`
    : `${readsProjectedFullScan} full-scan equivalent · this sync`;
  const savedValue = runs.length ? cumSaved : (status?.readsSaved ?? 0);
  const savedPct = runs.length ? cumPct : (status?.readsSavedPct ?? 0);

  const deltaLabel = status?.overallMode === "delta"
    ? `${readsThisRun} of ${readsProjectedFullScan} · full-scan equivalent`
    : `${readsThisRun} (full re-sync)`;
  return el("div", { className: "rd-chips-row pp-chips" }, [
    tile("Reads this sync", fmtNum(readsThisRun), deltaLabel, "gain"),
    tile(`Reads saved · ${savedPct.toFixed(1)}%`, fmtNum(savedValue), savedSub, "gold"),
    tile("Snapshot rows", fmtNum(snapshotTotal), "Persistent working set", "grad"),
    tile("Overall mode", modeLabel(status?.overallMode), status?.forceFull ? "Daily re-sync" : "Automatic cadence", "silver"),
  ]);
}

function tile(label, value, sub, tone) {
  return el("div", { className: "rd-chip-tile pp-tile", dataset: { tone } }, [
    el("div", { className: "rd-chip-label", text: label }),
    el("div", { className: "rd-chip-value", text: value }),
    el("div", { className: "pp-tile-sub", text: sub }),
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
  const body = rows.map(row => el("div", { className: "pp-table-row" }, [
    el("span", { className: "pp-cell-name", text: row.playlist }),
    el("span", { className: `pp-mode pp-mode-${modeTone(row.mode)}`, text: modeLabel(row.mode) }),
    el("span", { className: "num pp-num", text: row.delta == null ? "—" : fmtNum(row.delta) }),
    el("span", { className: "num pp-num", text: fmtNum(row.snapshot) }),
    el("span", { className: "num pp-num pp-dim", text: fmtCursorAge(row.since, row.built) }),
    el("span", { className: "pp-mono pp-dim", text: row.since ? row.since.slice(11, 19) + "Z" : "—" }),
  ]));
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
  const panel = el("div", { className: "rd-panel pp-panel" }, [
    el("div", { className: "rd-panel-head" }, [
      el("div", { className: "rd-panel-title", text: "Recent syncs" }),
      el("div", { className: "rd-panel-sub", text: `Last ${runs.length} syncs · reads consumed, mode per run` }),
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
  const shell = el("div", { className: "read-dashboard pp-view" }, [
    renderHeader({ status: data.status, onRefresh }),
    renderTiles(data.status, data.history),
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
