import {
  AdminWriteService,
  readFormValues,
  setFormValue,
  togglePlaylistFields,
} from "./admin.js";
import { PLAYLIST_LABELS, isAdminUser, isPlaylist } from "./config.js";
import { createFirebaseGateway } from "./firebase.js";
import { FlagDirectory } from "./flag-directory.js";
import { MmrHistoryStore } from "./history.js";
import { PlaylistListenerManager } from "./listener-manager.js";
import { readAdminRosterCache, writeAdminRosterCache, clearAdminRosterCache } from "./local-cache.js";
import { createReadTelemetryUploader } from "./read-telemetry.js";
import { createReadsView } from "./reads-view.js";
import { createPublishView } from "./publish-pipeline.js";
import {
  buildIconPayload,
  buildPlayerPayload,
  normalizeIconKeyRows,
  normalizePlaylistRows,
} from "./model.js";
import {
  handleTabKeydown,
  hydrateFlagPicker,
  renderBoard,
  renderIconKey,
  renderPlayerDialog,
  renderVersionBreakdown,
  setActiveTab,
  setDataStatus,
  setSubLine,
  setWriteStatus,
} from "./render.js";
import { buildShareUrl, parseUrlState, writeUrlState } from "./url-state.js";

const $ = (id) => document.getElementById(id);

const historyStore = new MmrHistoryStore();
const flagDirectory = new FlagDirectory();
const flagPickers = { add: null, edit: null };

function mountFlagPickers() {
  const addMount = document.querySelector('[data-flag-picker="add"]');
  const editMount = document.querySelector('[data-flag-picker="edit"]');
  if (addMount) {
    flagPickers.add = hydrateFlagPicker(addMount, {
      currentValue: "",
      directory: flagDirectory,
      onNewFlag: (url) => flagDirectory.add(url),
    });
  }
  if (editMount) {
    flagPickers.edit = hydrateFlagPicker(editMount, {
      currentValue: "",
      directory: flagDirectory,
      onNewFlag: (url) => flagDirectory.add(url),
    });
  }
}

// ---------- Read-budget admin widget ----------
//
// Compact chip in the admin panel showing Reads/hr with a per-label expand.
// Green (<250), yellow (>= soft or softTripped), red (hard-tripped). Polls
// gateway.readBudget every 3s. Also renders whenever ?readBudget=debug is
// present so it's easy to smoke-test the counter without admin access.
const READ_BUDGET_POLL_MS = 3_000;
const READ_BUDGET_DEBUG = (() => {
  try { return new URL(window.location.href).searchParams.get("readBudget") === "debug"; }
  catch { return false; }
})();
let readBudgetPollHandle = null;
let readBudgetLastTripAt = 0;

function ensureReadBudgetWidget() {
  const host = document.getElementById("adminBox");
  if (!host) return null;
  let widget = document.getElementById("readBudgetWidget");
  if (widget) return widget;
  widget = document.createElement("section");
  widget.id = "readBudgetWidget";
  widget.className = "read-budget-widget";
  widget.setAttribute("aria-label", "Firestore read budget");
  widget.innerHTML = `
    <button type="button" class="read-budget-chip" data-state="ok" aria-expanded="false">
      <span class="read-budget-dot"></span>
      <span class="read-budget-label">Reads/hr:</span>
      <span class="read-budget-value">0</span>
    </button>
    <div class="read-budget-detail" hidden></div>
  `;
  const chip = widget.querySelector(".read-budget-chip");
  chip.addEventListener("click", () => {
    const detail = widget.querySelector(".read-budget-detail");
    const expanded = chip.getAttribute("aria-expanded") === "true";
    chip.setAttribute("aria-expanded", String(!expanded));
    detail.hidden = expanded;
  });
  // Insert just after the panel head so it sits at the top of the panel.
  const head = host.querySelector(".admin-panel-head");
  if (head?.nextSibling) host.insertBefore(widget, head.nextSibling);
  else host.appendChild(widget);
  return widget;
}

function paintReadBudgetWidget(snap) {
  const widget = ensureReadBudgetWidget();
  if (!widget) return;
  const chip = widget.querySelector(".read-budget-chip");
  const valueEl = widget.querySelector(".read-budget-value");
  const detail = widget.querySelector(".read-budget-detail");

  valueEl.textContent = String(snap.total);
  let stateAttr = "ok";
  if (snap.tripped) stateAttr = "tripped";
  else if (snap.softTripped || snap.total >= (snap.soft ?? 500)) stateAttr = "warn";
  else if (snap.total >= 250) stateAttr = "warn";
  chip.dataset.state = stateAttr;

  const perLabelEntries = Object.entries(snap.perLabel || {})
    .sort((a, b) => b[1] - a[1]);
  if (!perLabelEntries.length) {
    detail.textContent = "No reads recorded yet.";
  } else {
    detail.innerHTML = "";
    const list = document.createElement("ul");
    list.className = "read-budget-list";
    for (const [label, count] of perLabelEntries) {
      const li = document.createElement("li");
      li.innerHTML = `<span class="rb-label"></span><span class="rb-count"></span>`;
      li.querySelector(".rb-label").textContent = label;
      li.querySelector(".rb-count").textContent = String(count);
      list.appendChild(li);
    }
    detail.appendChild(list);
    if (snap.tripped) {
      const p = document.createElement("p");
      p.className = "read-budget-note";
      const untilMs = Number(snap.trippedUntil) || 0;
      const remainMs = Math.max(0, untilMs - Date.now());
      const remainMin = Math.ceil(remainMs / 60_000);
      p.textContent = `Hard cap tripped. Live updates paused for ~${remainMin} more min.`;
      detail.appendChild(p);
    }
  }

  // console.info on every hard trip transition — helps spot repeat trips in
  // devtools without hunting for the warn.
  const trippedUntil = Number(snap.trippedUntil) || 0;
  if (snap.tripped && trippedUntil !== readBudgetLastTripAt) {
    readBudgetLastTripAt = trippedUntil;
    console.info("[rgLB] read budget hard cap tripped", snap);
  }
}

function shouldShowReadBudget() {
  return Boolean(READ_BUDGET_DEBUG || state.admin);
}

function stopReadBudgetPoll() {
  if (readBudgetPollHandle != null) {
    clearInterval(readBudgetPollHandle);
    readBudgetPollHandle = null;
  }
  const widget = document.getElementById("readBudgetWidget");
  if (widget) widget.remove();
}

function startReadBudgetPoll() {
  const budget = gateway?.readBudget;
  if (!budget) return;
  if (readBudgetPollHandle != null) return;
  paintReadBudgetWidget(budget.snapshot());
  readBudgetPollHandle = setInterval(() => {
    paintReadBudgetWidget(budget.snapshot());
  }, READ_BUDGET_POLL_MS);
}

function syncReadBudgetWidget() {
  if (shouldShowReadBudget()) startReadBudgetPoll();
  else stopReadBudgetPoll();
}

// If we booted straight into a cool-off, `firebase.js` fires this event so
// the widget can paint red the moment it's mounted.
document.addEventListener("rgLB:read-budget-tripped", (event) => {
  if (!shouldShowReadBudget()) return;
  paintReadBudgetWidget(event.detail || {});
});

const ROSTER_STATE_URL = "https://raw.githubusercontent.com/wiljdaws/rg_player_leaderboard/data/state/wins.json";

// Unwrap the CDC snapshot format so it looks like a plain Firestore doc
// to normalizePlayerDocument.
function hydrateStateRow(row) {
  const out = { ...row };
  for (const key of Object.keys(out)) {
    const v = out[key];
    if (v && typeof v === "object" && v.__firestoreType === "timestamp") {
      out[key] = v.value;
    }
  }
  if (!out.id && out._docId) out.id = out._docId;
  return out;
}

async function loadVersionBreakdown({ force = false } = {}) {
  const host = $("versionBreakdown");
  if (!host) return;
  if (!force) {
    const cached = readAdminRosterCache();
    if (cached?.rows?.length) {
      const normalized = normalizePlaylistRows(cached.rows, "wins");
      renderVersionBreakdown(host, normalized.rows);
      return;
    }
  }
  host.replaceChildren(document.createTextNode("Loading roster…"));
  try {
    const response = await fetch(ROSTER_STATE_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`state fetch ${response.status}`);
    const state = await response.json();
    const raw = (state?.snapshot || []).map(hydrateStateRow);
    writeAdminRosterCache(raw);
    const normalized = normalizePlaylistRows(raw, "wins");
    renderVersionBreakdown(host, normalized.rows);
  } catch (error) {
    host.replaceChildren();
    host.append(Object.assign(document.createElement("p"), {
      className: "version-empty",
      textContent: `Could not load roster: ${error?.message || "unknown error"}`,
    }));
  }
}

const initial = parseUrlState(window.location.href);
const state = {
  playlist: initial.playlist,
  playerId: initial.playerId,
  rows: [],
  quarantined: [],
  status: { kind: "loading", message: `Loading ${initial.playlist} rankings…` },
  admin: false,
  user: null,
  icons: [],
  iconLoading: true,
  iconError: "",
  editingPlayer: null,
};

let gateway = null;
let listenerManager = null;
let writes = null;

function urlState(push = false) {
  return writeUrlState(
    window,
    { playlist: state.playlist, search: "", playerId: state.playerId },
    push,
  );
}

function effectiveStatus() {
  if (!state.quarantined.length) return state.status;
  return {
    kind: "degraded",
    message:
      `${state.status.message} · ${state.quarantined.length} invalid ` +
      `${state.quarantined.length === 1 ? "row was" : "rows were"} hidden.`,
  };
}

function emptyMessage() {
  if (state.status.kind === "loading") return "Loading rankings…";
  if (state.status.kind === "error") {
    return (
      "Live data is briefly unavailable — usually a Firestore free-tier " +
      "hiccup that clears within an hour. Rankings will reappear on the " +
      "next refresh once the hourly cache rebuilds."
    );
  }
  return `No ${state.playlist} rankings have been added yet.`;
}

function syncPlayerDialog() {
  const dialog = $("playerDialog");
  if (!state.playerId || !dialog) return;
  const index = state.rows.findIndex((player) => player.id === state.playerId);
  if (index < 0) return;
  if (dialog.dataset.playerId === state.playerId) return;
  dialog.dataset.playerId = state.playerId;
  renderPlayerDialog(dialog, state.rows[index], index + 1);
}

function render() {
  setActiveTab(state.playlist);
  setDataStatus(effectiveStatus());
  const isAdminView = state.playlist === "reads" || state.playlist === "publish";
  // Admin tabs don't have a per-playlist row count — swap the subline for
  // something contextual so the header doesn't try to pluralize a
  // playlist that isn't a real one.
  if (state.playlist === "reads") {
    setSubLine("Admin read insights.");
  } else if (state.playlist === "publish") {
    setSubLine("Firestore → CDN sync health.");
  } else {
    setSubLine(
      state.rows.length
        ? `${PLAYLIST_LABELS[state.playlist]} · ${state.rows.length} ${state.rows.length === 1 ? "player" : "players"}`
        : `Live 1v1, 2v2, 3v3, and wins standings.`,
    );
  }

  // Skip leaderboard + icon-key paints while an admin view is active —
  // their containers are hidden and renderBoard doesn't know these
  // pseudo-playlists.
  if (!isAdminView) {
    renderBoard({
      playlist: state.playlist,
      rows: state.rows,
      historyStore,
      admin: state.admin,
      emptyMessage: emptyMessage(),
      onInspect: openPlayerDetails,
      onEdit: openEdit,
      onDelete: (player) => {
        // Tournament rows are hand-typed and short-lived — a stray click can
        // erase real work. Everything else is HUD-synced and reappears on
        // next write, so no prompt needed.
        if (player.playlist === "tournament"
            && !confirm(`Remove ${player.name} from the tournament?`)) {
          return;
        }
        clearAdminRosterCache();
        return writes?.deletePlayer(player.id, player.playlist);
      },
    });
    renderIconKey({
      rows: state.icons,
      admin: state.admin,
      loading: state.iconLoading,
      error: state.iconError,
      onDelete: (item) => writes?.deleteIcon(item.id),
    });
  }
  syncPlayerDialog();
  // renderIconKey unhides the icon-key section based on data; re-apply the
  // tournament-only overrides so a late icons load doesn't reveal it.
  syncTournamentAdmin();
}

function openPlayerDetails(player) {
  state.playerId = player.id;
  urlState(false);
  const dialog = $("playerDialog");
  if (dialog) dialog.dataset.playerId = "";
  syncPlayerDialog();
}

function openEdit(player) {
  state.editingPlayer = player;
  const form = $("editForm");
  setFormValue(form, "playlist", player.playlist);
  setFormValue(form, "name", player.name);
  setFormValue(form, "mmr", player.mmr ?? 0);
  setFormValue(form, "wins", player.wins ?? 0);
  setFormValue(form, "matches", player.matches ?? 0);
  setFormValue(form, "score", player.score ?? 0);
  setFormValue(form, "icons", player.icons.join(","));
  if (player.flag) flagDirectory.add(player.flag);
  flagPickers.edit?.setValue(player.flag || "");
  togglePlaylistFields(form, player.playlist);
  const dialog = $("editDialog");
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

// "reads" is an admin-only pseudo-playlist that swaps the board for the
// read-insights dashboard. Skip the usual listener + rows plumbing so
// activating it doesn't spin up a Firestore subscription.
function activatePlaylist(playlist, { push = true, updateUrl = true } = {}) {
  if (playlist === "reads" || playlist === "publish") {
    if (!state.admin) return;               // never accept without admin
    if (state.playlist === playlist) return;
    listenerManager?.disconnect();          // stop burning reads on the previous playlist
    const prev = state.playlist;
    // Swap between the two admin views if we're moving reads <-> publish.
    if (prev === "reads") readsView?.deactivate();
    if (prev === "publish") publishView?.deactivate();
    state.playlist = playlist;
    state.rows = [];
    state.quarantined = [];
    state.playerId = "";
    setActiveTab(playlist);
    // Admin views are focused — hide leaderboard chrome so the dashboard
    // has the page to itself.
    $("boardSection").hidden = true;
    const iconKeyHost = $("iconKey");
    if (iconKeyHost) iconKeyHost.hidden = true;
    const adminBoxHost = $("adminBox");
    if (adminBoxHost) adminBoxHost.hidden = true;
    if (playlist === "reads") readsView?.activate();
    if (playlist === "publish") publishView?.activate();
    if (updateUrl) urlState(push);
    // Preserve the last real playlist so switching back defaults there.
    lastRealPlaylist = isPlaylist(prev) ? prev : lastRealPlaylist;
    return;
  }
  if (!isPlaylist(playlist)) return;
  const leavingAdminView = state.playlist === "reads" || state.playlist === "publish";
  if (playlist === state.playlist) return;
  state.playlist = playlist;
  state.rows = [];
  state.quarantined = [];
  state.playerId = "";
  state.status = { kind: "loading", message: `Loading ${playlist} rankings…` };
  const dialog = $("playerDialog");
  if (dialog) {
    dialog.dataset.playerId = "";
    if (dialog.open) dialog.close();
  }
  const adminPlaylist = $("playlist");
  if (adminPlaylist) adminPlaylist.value = playlist;
  togglePlaylistFields($("adminForm"), playlist);
  if (leavingAdminView) {
    readsView?.deactivate();
    publishView?.deactivate();
    $("boardSection").hidden = false;
    // Admin panel returns for admins; the icon-key legend re-shows on the
    // next renderIconKey() (fired below via render()).
    if (state.admin || READ_BUDGET_DEBUG) {
      const adminBoxHost = $("adminBox");
      if (adminBoxHost) adminBoxHost.hidden = false;
    }
  }
  if (updateUrl) urlState(push);
  render();
  syncTournamentAdmin();
  listenerManager?.activate(playlist);
}

// Show the quick-add strip only on the Tournament tab for admins.
// Also hides the icon key + full admin panel while on Tournament since
// those aren't relevant to the manual entry flow.
function syncTournamentAdmin() {
  const host = document.getElementById("tournamentAdmin");
  const iconKey = document.getElementById("iconKey");
  const adminBox = document.getElementById("adminBox");
  const onTournament = state.playlist === "tournament";
  if (host) host.hidden = !(state.admin && onTournament);
  if (onTournament) {
    if (iconKey) iconKey.hidden = true;
    if (adminBox) adminBox.hidden = true;
  } else {
    // Restore admin panel visibility per the same rule the auth observer uses.
    if (adminBox) adminBox.hidden = !state.admin && !READ_BUDGET_DEBUG;
    // Icon key visibility is driven by renderIconKey() on the next render,
    // so leaving hidden=true here is safe — the next render restores it.
  }
}

function setTqStatus(message, kind = "") {
  const el = document.getElementById("tqStatus");
  if (!el) return;
  el.textContent = message || "";
  if (kind) el.dataset.kind = kind;
  else delete el.dataset.kind;
}

function setTqBulkStatus(message, kind = "") {
  const el = document.getElementById("tqBulkStatus");
  if (!el) return;
  el.textContent = message || "";
  if (kind) el.dataset.kind = kind;
  else delete el.dataset.kind;
}

function parseBulkTournamentText(text) {
  const results = [];
  const errors = [];
  const lines = String(text || "").split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    // Split on tabs first (paste-from-spreadsheet), otherwise commas.
    const parts = (line.includes("\t") ? line.split("\t") : line.split(",")).map(p => p.trim());
    if (parts.length < 3) {
      errors.push(`Line ${i + 1}: expected Name, Score, Matches`);
      return;
    }
    const [name, scoreStr, matchesStr] = parts;
    const score = Number(scoreStr);
    const matches = Number(matchesStr);
    if (!name) return errors.push(`Line ${i + 1}: missing name`);
    if (!Number.isFinite(score) || score < 0) return errors.push(`Line ${i + 1}: bad score "${scoreStr}"`);
    if (!Number.isFinite(matches) || matches < 0) return errors.push(`Line ${i + 1}: bad matches "${matchesStr}"`);
    results.push({ name, score, matches });
  });
  return { rows: results, errors };
}

function wireTournamentQuickAdd(writes) {
  const form = document.getElementById("tournamentQuickAdd");
  if (!form) return;
  const nameEl = document.getElementById("tqName");
  const scoreEl = document.getElementById("tqScore");
  const matchesEl = document.getElementById("tqMatches");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setTqStatus("");
    try {
      const payload = buildPlayerPayload({
        playlist: "tournament",
        name: nameEl.value,
        score: scoreEl.value,
        matches: matchesEl.value,
        icons: "",
        flag: "",
      });
      const saved = await writes?.addPlayer(payload);
      if (saved) {
        clearAdminRosterCache();
        setTqStatus(`Added ${payload.name}.`, "success");
        form.reset();
        nameEl.focus();
      }
    } catch (err) {
      setTqStatus(err?.message || "Add failed.", "error");
    }
  });

  document.getElementById("tqClearBtn")?.addEventListener("click", async () => {
    if (!confirm("Wipe every player from the Tournament leaderboard? This can't be undone.")) return;
    setTqStatus("Clearing…");
    const ok = await writes?.clearTournament();
    if (ok) {
      clearAdminRosterCache();
      setTqStatus("Tournament cleared.", "success");
    } else {
      setTqStatus("Clear failed.", "error");
    }
  });

  const bulkDialog = document.getElementById("tqBulkDialog");
  const bulkText = document.getElementById("tqBulkText");
  const bulkForm = document.getElementById("tqBulkForm");
  document.getElementById("tqBulkBtn")?.addEventListener("click", () => {
    setTqBulkStatus("");
    bulkText.value = "";
    if (typeof bulkDialog.showModal === "function") bulkDialog.showModal();
    else bulkDialog.setAttribute("open", "");
  });
  bulkDialog?.querySelector("[data-tq-bulk-cancel]")?.addEventListener("click", () => bulkDialog.close());
  bulkForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const { rows, errors } = parseBulkTournamentText(bulkText.value);
    if (errors.length) {
      setTqBulkStatus(errors.slice(0, 3).join(" · "), "error");
      return;
    }
    if (!rows.length) {
      setTqBulkStatus("No rows to add.", "error");
      return;
    }
    setTqBulkStatus(`Adding ${rows.length}…`);
    let added = 0;
    for (const row of rows) {
      try {
        const payload = buildPlayerPayload({
          playlist: "tournament",
          name: row.name,
          score: row.score,
          matches: row.matches,
          icons: "",
          flag: "",
        });
        const ok = await writes?.addPlayer(payload);
        if (ok) added += 1;
      } catch (err) {
        errors.push(`${row.name}: ${err?.message || "add failed"}`);
      }
    }
    clearAdminRosterCache();
    if (errors.length) {
      setTqBulkStatus(`Added ${added} of ${rows.length}. Errors: ${errors.slice(0, 2).join(" · ")}`, "error");
    } else {
      setTqBulkStatus(`Added ${added}.`, "success");
      bulkText.value = "";
      setTimeout(() => bulkDialog.close(), 600);
    }
  });
}

let readsView = null;
let publishView = null;
let lastRealPlaylist = "1v1";

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand?.("copy");
  textarea.remove();
  if (!copied) throw new Error("Copy is not available in this browser.");
}

function handleValidationError(error) {
  setWriteStatus({ kind: "error", message: error?.message || "Check the form and try again." });
}

async function refreshIcons(force = false) {
  if (!gateway) return state.icons;
  state.iconLoading = true;
  state.iconError = "";
  render();
  try {
    const rawRows = await gateway.loadIconKey(force);
    const normalized = normalizeIconKeyRows(rawRows);
    state.icons = normalized.rows;
    state.iconError = normalized.quarantined.length
      ? `${normalized.quarantined.length} invalid icon key item was hidden.`
      : "";
  } catch (error) {
    state.iconError = error?.message || "Icon key could not be loaded.";
  } finally {
    state.iconLoading = false;
    render();
  }
  return state.icons;
}

function wireEvents() {
  mountFlagPickers();

  const tabs = $("playlistTabs");
  tabs.addEventListener("click", (event) => {
    const tab = event.target.closest('[role="tab"]');
    if (tab) activatePlaylist(tab.dataset.playlist);
  });
  tabs.addEventListener("keydown", (event) =>
    handleTabKeydown(event, (playlist) => activatePlaylist(playlist)),
  );

  $("shareView").addEventListener("click", async () => {
    try {
      const url = buildShareUrl(window.location.href, {
        playlist: state.playlist,
        search: "",
        playerId: state.playerId,
      }).href;
      await copyText(url);
      setWriteStatus({ kind: "success", message: "Share link copied." });
      setTimeout(() => setWriteStatus({ kind: "idle", message: "" }), 2400);
    } catch (error) {
      setWriteStatus({ kind: "error", message: error?.message || "Could not copy the link." });
    }
  });

  document.addEventListener("visibilitychange", () => {
    listenerManager?.setVisible(!document.hidden);
  });

  window.addEventListener("popstate", () => {
    const next = parseUrlState(window.location.href);
    state.playerId = next.playerId;
    activatePlaylist(next.playlist, { push: false, updateUrl: false });
  });

  const adminPlaylist = $("playlist");
  adminPlaylist.addEventListener("change", () =>
    togglePlaylistFields($("adminForm"), adminPlaylist.value),
  );

  $("adminForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const payload = buildPlayerPayload(readFormValues($("adminForm")));
      if (payload.flag) flagDirectory.add(payload.flag);
      const saved = await writes?.addPlayer(payload);
      if (saved) {
        clearAdminRosterCache();
        $("adminForm").reset();
        flagPickers.add?.setValue("");
        togglePlaylistFields($("adminForm"), $("playlist").value);
      }
    } catch (error) {
      handleValidationError(error);
    }
  });

  wireTournamentQuickAdd(writes);

  $("iconForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const payload = buildIconPayload(readFormValues($("iconForm")));
      const saved = await writes?.addIcon(payload);
      if (saved) $("iconForm").reset();
    } catch (error) {
      handleValidationError(error);
    }
  });

  $("refreshVersions")?.addEventListener("click", () => {
    if (!state.admin) return;
    clearAdminRosterCache();
    loadVersionBreakdown({ force: true });
  });

  $("editForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.editingPlayer) return;
    try {
      const payload = buildPlayerPayload(readFormValues($("editForm")), false);
      if (payload.flag) flagDirectory.add(payload.flag);
      const player = state.editingPlayer;
      const saved = await writes?.updatePlayer(player.id, payload);
      if (saved) {
        clearAdminRosterCache();
        // For HUD-synced players (deterministic ID = sourceUserId_playlist),
        // propagate the cosmetic fields to the other playlist docs so a flag
        // or glow edit made in 1v1 is reflected in 2v2/3v3/wins too. Score
        // fields (mmr / wins / matches) stay per-playlist.
        if (player.sourceUserId) {
          const cosmetic = {
            name: payload.name,
            flag: payload.flag,
            icons: payload.icons,
          };
          const siblingIds = ["1v1", "2v2", "3v3", "wins"]
            .filter((p) => p !== player.playlist)
            .map((p) => `${player.sourceUserId}_${p}`);
          // Fire in parallel, ignore individual failures (a sibling doc may
          // simply not exist yet — e.g. the player never played that mode).
          await Promise.allSettled(
            siblingIds.map((id) => gateway.updatePlayer(id, cosmetic)),
          );
        }
        state.editingPlayer = null;
        $("editDialog").close();
      }
    } catch (error) {
      handleValidationError(error);
    }
  });

  $("cancelEdit").addEventListener("click", () => {
    state.editingPlayer = null;
    $("editDialog").close();
  });

  const playerDialog = $("playerDialog");
  playerDialog.addEventListener("close", () => {
    playerDialog.dataset.playerId = "";
    if (!state.playerId) return;
    state.playerId = "";
    urlState(false);
  });

  $("loginButton").addEventListener("click", async () => {
    try {
      await gateway?.signIn();
    } catch (error) {
      setWriteStatus({ kind: "error", message: error?.message || "Admin login failed." });
    }
  });

  $("logoutButton").addEventListener("click", async () => {
    try {
      await gateway?.signOut();
    } catch (error) {
      setWriteStatus({ kind: "error", message: error?.message || "Logout failed." });
    }
  });
}

async function boot() {
  wireEvents();
  render();

  try {
    gateway = await createFirebaseGateway();
  } catch (error) {
    state.status = {
      kind: "error",
      message: error?.message || "Firebase could not be loaded. Cached rankings will stay visible if available.",
    };
    render();
    return;
  }

  readsView = createReadsView({ gateway });
  publishView = createPublishView();

  writes = new AdminWriteService({
    gateway,
    isAdmin: () => state.admin,
    refreshIcons,
  });

  // Cross-session telemetry: every admin session pushes its read-budget
  // snapshot to admin_read_stats/. Disabled with ?telemetry=off. Only starts
  // once the auth-observer flips state.admin to true.
  const telemetryDisabled = (() => {
    try { return new URL(window.location.href).searchParams.get("telemetry") === "off"; }
    catch { return false; }
  })();
  const readTelemetry = telemetryDisabled
    ? { start() {}, stop() {}, upload: async () => {} }
    : createReadTelemetryUploader({
        gateway,
        budget: gateway.readBudget,
        isAdmin: () => state.admin,
        // Captures which admin is signed in so the dashboard's Site
        // Sessions table can distinguish Pal from JesusDied4U on the
        // same site deployment. Only sent when we actually have a
        // signed-in admin.
        getAdminEmail: () => (state.admin && state.user?.email) || null,
      });

  gateway.observeAuth((user) => {
    state.user = user;
    state.admin = isAdminUser(user);
    if (!state.admin) {
      state.editingPlayer = null;
      const dialog = $("editDialog");
      if (dialog?.open) dialog.close();
    }
    // In debug mode we force the admin panel visible so the widget renders
    // for any user. Otherwise the panel follows real admin state.
    $("adminBox").hidden = !state.admin && !READ_BUDGET_DEBUG;
    syncTournamentAdmin();
    $("loginButton").hidden = Boolean(user);
    $("logoutButton").hidden = !user;
    $("authStatus").textContent = state.admin
      ? "Admin mode"
      : user
        ? "Signed in without admin access"
        : "";
    // Reveal the admin-only Reads + Publish tabs; hide + kick the user
    // back to a real playlist if they were viewing one while their admin
    // session ended.
    const readsTabEl = $("readsTab");
    if (readsTabEl) readsTabEl.hidden = !state.admin;
    const publishTabEl = $("publishTab");
    if (publishTabEl) publishTabEl.hidden = !state.admin;
    if (!state.admin && (state.playlist === "reads" || state.playlist === "publish")) {
      activatePlaylist(lastRealPlaylist || "1v1", { push: false });
    }
    render();
    if (state.admin) {
      loadVersionBreakdown();
      readTelemetry.start();
    } else {
      readTelemetry.stop();
    }
    syncReadBudgetWidget();
  });

  listenerManager = new PlaylistListenerManager({
    subscribe: gateway.subscribePlaylist,
    onRows(raw, metadata) {
      if (metadata.playlist !== state.playlist) return;
      const normalized = normalizePlaylistRows(raw, state.playlist);
      state.rows = normalized.rows;
      state.quarantined = normalized.quarantined;
      historyStore.record(state.playlist, state.rows);
      flagDirectory.registerRows(state.rows);
      render();
    },
    onStatus(status) {
      state.status = status;
      render();
    },
  });

  refreshIcons();
  listenerManager.setVisible(!document.hidden);
  listenerManager.activate(state.playlist);

  // Debug/ops override — makes the widget visible for any user (still needs
  // adminBox visible for its parent to layout, which the auth block above
  // handles). Idempotent — the sync helper no-ops when already polling.
  if (READ_BUDGET_DEBUG) syncReadBudgetWidget();
}

boot();
