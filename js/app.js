import {
  AdminWriteService,
  readFormValues,
  setFormValue,
  togglePlaylistFields,
} from "./admin.js";
import { PLAYLIST_LABELS, STATIC_JSON_URL_TEMPLATE, isAdminUser, isPlaylist } from "./config.js";
import { createFirebaseGateway } from "./firebase.js";
import { FlagDirectory } from "./flag-directory.js";
import { MmrHistoryStore } from "./history.js";
import { PlaylistListenerManager } from "./listener-manager.js";
import { readAdminRosterCache, writeAdminRosterCache, clearAdminRosterCache, clearPlaylistCache } from "./local-cache.js";
import { log } from "./log.js";
import { createReadTelemetryUploader } from "./read-telemetry.js";
import { createReadsView } from "./reads-view.js";
import { createPublishView } from "./publish-pipeline.js";
import {
  buildIconPayload,
  buildPlayerPayload,
  normalizeIconKeyRows,
  normalizePlaylistRows,
  sortPlaylistRows,
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
    console.info("[RG SITE] read budget hard cap tripped", snap);
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
  const count = state.quarantined.length;
  // Show the top reasons so it's obvious why a row vanished.
  const reasonCounts = new Map();
  for (const q of state.quarantined) {
    for (const reason of q?.reasons ?? []) {
      reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
    }
  }
  const topReasons = [...reasonCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason, n]) => (n > 1 ? `${n}× ${reason}` : reason))
    .join(", ");
  const noun = count === 1 ? "row was" : "rows were";
  const suffix = topReasons ? ` (${topReasons})` : "";
  return {
    kind: "degraded",
    message: `${state.status.message} · ${count} invalid ${noun} hidden${suffix}.`,
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
  renderPlayerDialog(dialog, state.rows[index], index + 1, {
    otherPlaylistLookup: lookupPlayerInPlaylist,
  });
}

// Session-cached lookup of a player's rank + MMR in another playlist.
// Reads the same CDN JSON blob the site is already publishing, so no
// Firestore reads. First call for a playlist fetches once (~100-300 KB
// gzipped), then all subsequent lookups are in-memory.
const _playlistRowCache = new Map(); // playlist -> Map<sourceUserId, { rank, mmr }>
const _playlistRowPromises = new Map();

async function lookupPlayerInPlaylist(sourceUserId, playlist) {
  if (!sourceUserId || !playlist) return null;
  const index = await ensurePlaylistIndex(playlist);
  return index?.get(sourceUserId) || null;
}

function ensurePlaylistIndex(playlist) {
  if (_playlistRowCache.has(playlist)) return Promise.resolve(_playlistRowCache.get(playlist));
  if (_playlistRowPromises.has(playlist)) return _playlistRowPromises.get(playlist);
  const url = STATIC_JSON_URL_TEMPLATE.replace("{playlist}", playlist);
  const promise = fetch(url, { cache: "default" })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      const rows = Array.isArray(data?.rows) ? data.rows
        : Array.isArray(data) ? data : [];
      const map = new Map();
      for (const row of rows) {
        const uid = typeof row?.sourceUserId === "string" ? row.sourceUserId : null;
        if (!uid) continue;
        const rank = Number.isFinite(row?.rank) ? Math.trunc(row.rank) : null;
        const mmr = Number.isFinite(row?.mmr) ? Number(row.mmr) : null;
        map.set(uid, { rank, mmr });
      }
      _playlistRowCache.set(playlist, map);
      _playlistRowPromises.delete(playlist);
      return map;
    })
    .catch(() => {
      _playlistRowPromises.delete(playlist);
      return null;
    });
  _playlistRowPromises.set(playlist, promise);
  return promise;
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
      onDelete: async (player) => {
        // Tournament rows are hand-typed, so require confirmation.
        // Ranked rows offer a "purge all playlists" checkbox for
        // duplicate-account cleanup.
        let purgeAllPlaylists = false;
        if (player.playlist === "tournament") {
          const ok = await showConfirm({
            title: "Remove player?",
            message: `Remove ${player.name} from the tournament? This can't be undone.`,
            confirmLabel: "Remove",
            variant: "danger",
          });
          if (!ok) return;
        } else if (player.sourceUserId) {
          const result = await showConfirm({
            title: "Remove player?",
            message: `Remove ${player.name} from ${player.playlist}?`,
            confirmLabel: "Remove",
            variant: "danger",
            checkbox: {
              label: "Also remove this account from every other playlist",
              default: false,
            },
          });
          if (!result?.ok) return;
          purgeAllPlaylists = result.checked;
        }
        clearAdminRosterCache();
        if (player.playlist === "tournament") {
          log.info("tournament", "delete requested", { id: player.id, name: player.name });
        } else {
          // Row disappears from view instantly, then the CDN catches up.
          log.info("write", "delete requested", { id: player.id, playlist: player.playlist, purgeAllPlaylists });
          if (purgeAllPlaylists) {
            for (const pl of ["1v1", "2v2", "3v3", "wins"]) {
              stashRankedTombstone(pl, `${player.sourceUserId}_${pl}`);
              clearPlaylistCache(pl);
            }
          } else {
            stashRankedTombstone(player.playlist, player.id);
            clearPlaylistCache(player.playlist);
          }
          state.rows = applyRankedTombstones(state.rows, player.playlist);
          render();
        }
        const result = purgeAllPlaylists
          ? await writes?.deletePlayerAllPlaylists(player.sourceUserId)
          : await writes?.deletePlayer(player.id, player.playlist);
        if (result === false) {
          log.error("write", "delete failed", new Error(`delete returned falsy for ${player.id}`));
        } else {
          log.info("write", "delete completed", { id: player.id, playlist: player.playlist, purgeAllPlaylists });
        }
        return result;
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
  setFormValue(form, "sourceUserId", player.sourceUserId ?? "");
  setFormValue(form, "mmr", player.mmr ?? 0);
  setFormValue(form, "wins", player.wins ?? 0);
  setFormValue(form, "matches", player.matches ?? 0);
  setFormValue(form, "score", player.score ?? 0);
  // Icons can be array (normalized rows) or string (optimistic pending
   // rows before the CDN catches up). Handle both.
  const iconsStr = Array.isArray(player.icons)
    ? player.icons.join(",")
    : String(player.icons || "");
  setFormValue(form, "icons", iconsStr);
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
    log.info("playlist", "switching", { from: prev, to: playlist });
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

// Map of lowercase name to the freshest cosmetic snapshot (flag + icons)
// we've seen. Populated the first time the Tournament tab activates as
// admin; used to auto-fill flag/icons when a known name is chosen from
// the autocomplete list.
const tournamentRoster = new Map();
let tournamentRosterLoaded = false;

function primeTournamentRoster() {
  if (tournamentRosterLoaded) return;
  const cached = readAdminRosterCache();
  if (cached?.rows?.length) applyRoster(cached.rows);
  fetch(ROSTER_STATE_URL, { cache: "no-store" })
    .then(r => r.ok ? r.json() : null)
    .then(json => {
      if (!json?.snapshot) return;
      const raw = json.snapshot.map(hydrateStateRow);
      writeAdminRosterCache(raw);
      applyRoster(raw);
    })
    .catch(() => {});
  tournamentRosterLoaded = true;
}

function applyRoster(rows) {
  for (const row of rows) {
    const name = typeof row?.name === "string" ? row.name.trim() : "";
    if (!name) continue;
    const key = name.toLowerCase();
    // Prefer entries that have a flag over ones that don't.
    const existing = tournamentRoster.get(key);
    if (existing?.flag && !row?.flag) continue;
    tournamentRoster.set(key, {
      name,
      flag: typeof row?.flag === "string" ? row.flag : "",
      icons: Array.isArray(row?.icons) ? row.icons.join(",")
        : typeof row?.icons === "string" ? row.icons : "",
    });
  }
}

function lookupRosterCosmetic(rawName) {
  const key = String(rawName || "").trim().toLowerCase();
  if (!key) return null;
  return tournamentRoster.get(key) || null;
}

// Tombstones for ranked (1v1/2v2/3v3/wins) rows. Rows drop out of
// state.rows immediately on delete; the tombstone clears once the CDN
// publishes without the row or after PENDING_TTL_MS. Tournament tab
// doesn't need this since it reads Firestore directly and onSnapshot
// reflects writes in real time.
const rankedTombstones = new Map();
const PENDING_TTL_MS = 90_000;

function stashRankedTombstone(playlist, id) {
  if (!playlist || !id) return;
  const key = `${playlist}:${id}`;
  rankedTombstones.set(key, { playlist, id, ts: Date.now() });
}

function applyRankedTombstones(rows, playlist) {
  if (!rankedTombstones.size) return rows;
  const now = Date.now();
  const drop = new Set();
  for (const [key, entry] of rankedTombstones) {
    if (entry.playlist !== playlist) continue;
    if (now - entry.ts > PENDING_TTL_MS) {
      rankedTombstones.delete(key);
      continue;
    }
    if (!rows.some(r => r.id === entry.id)) {
      // Feed no longer has this row; the delete propagated.
      rankedTombstones.delete(key);
      continue;
    }
    drop.add(entry.id);
  }
  return drop.size ? rows.filter(r => !drop.has(r.id)) : rows;
}

// Find a tournament row by name so quick-add can upsert into it instead
// of making a duplicate doc. Firestore realtime keeps state.rows fresh
// so we can match against it directly without any pending overlay.
function findTournamentRowByName(name) {
  const needle = String(name || "").trim().toLowerCase();
  if (!needle) return null;
  for (const row of state.rows) {
    if (String(row.name || "").trim().toLowerCase() === needle) return row;
  }
  return null;
}

// Styled confirm dialog. Native window.confirm() looks foreign on the
// dark-themed site, this one uses the same modal chrome as the edit and
// bulk-add dialogs.
function showConfirm({ title = "Are you sure?", message = "", confirmLabel = "Confirm", variant = "primary", checkbox = null } = {}) {
  return new Promise((resolve) => {
    const dialog = document.getElementById("confirmDialog");
    if (!dialog) return resolve(window.confirm(message));
    const titleEl = document.getElementById("confirmDialogTitle");
    const msgEl = document.getElementById("confirmDialogMessage");
    const okBtn = dialog.querySelector("[data-confirm-ok]");
    const cancelBtn = dialog.querySelector("[data-confirm-cancel]");
    const form = dialog.querySelector("[data-confirm-form]");
    if (titleEl) titleEl.textContent = title;
    if (msgEl) msgEl.textContent = message;
    if (okBtn) {
      okBtn.textContent = confirmLabel;
      okBtn.className = variant === "danger" ? "admin-danger" : "admin-primary";
    }
    // Optional checkbox rendered above the buttons. When present the
    // promise resolves to { ok: bool, checked: bool } instead of a raw
    // bool so callers can branch on it.
    let checkboxEl = null;
    if (checkbox && msgEl) {
      const wrap = document.createElement("label");
      wrap.className = "confirm-checkbox";
      wrap.dataset.confirmExtra = "1";
      wrap.style.cssText = "display:flex;align-items:center;gap:8px;margin-top:12px;font-size:14px;cursor:pointer;";
      checkboxEl = document.createElement("input");
      checkboxEl.type = "checkbox";
      checkboxEl.checked = Boolean(checkbox.default);
      wrap.append(checkboxEl, document.createTextNode(" " + checkbox.label));
      // Remove any leftover from a previous open.
      msgEl.parentElement?.querySelector("[data-confirm-extra]")?.remove();
      msgEl.after(wrap);
    } else {
      dialog.querySelector("[data-confirm-extra]")?.remove();
    }
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (dialog.open) dialog.close();
      const checked = Boolean(checkboxEl?.checked);
      resolve(checkbox ? { ok, checked } : ok);
    };
    const onSubmit = (e) => { e.preventDefault(); finish(true); };
    const onCancel = () => finish(false);
    const onDialogClose = () => finish(false);
    const cleanup = () => {
      form?.removeEventListener("submit", onSubmit);
      cancelBtn?.removeEventListener("click", onCancel);
      dialog.removeEventListener("close", onDialogClose);
    };
    form?.addEventListener("submit", onSubmit);
    cancelBtn?.addEventListener("click", onCancel);
    dialog.addEventListener("close", onDialogClose);
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    // Focus the primary action so Enter confirms and Escape cancels.
    okBtn?.focus();
  });
}

// Custom autocomplete for the tournament Name input. Native <datalist>
// dumped every roster name on focus which looked bad, so this one only
// opens after 1+ characters and filters as you type.
const SUGGEST_MAX = 8;
function wireNameSuggest(input) {
  if (!input) return;
  const list = document.getElementById("tqNameSuggest");
  if (!list) return;
  let activeIndex = -1;
  let matches = [];

  const close = () => {
    list.hidden = true;
    list.replaceChildren();
    activeIndex = -1;
    input.setAttribute("aria-expanded", "false");
  };

  const highlight = (name, needle) => {
    const idx = name.toLowerCase().indexOf(needle);
    if (idx < 0) return name;
    return `${name.slice(0, idx)}<mark>${name.slice(idx, idx + needle.length)}</mark>${name.slice(idx + needle.length)}`;
  };

  const render = () => {
    if (!matches.length) return close();
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    const needle = input.value.trim().toLowerCase();
    list.replaceChildren();
    matches.forEach((entry, i) => {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.dataset.name = entry.name;
      li.innerHTML = highlight(entry.name, needle);
      if (i === activeIndex) li.setAttribute("aria-selected", "true");
      // mousedown fires before input's blur so the click lands.
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        input.value = entry.name;
        close();
      });
      list.append(li);
    });
  };

  input.addEventListener("input", () => {
    const needle = input.value.trim().toLowerCase();
    if (!needle) return close();
    matches = [...tournamentRoster.values()]
      .filter(entry => entry.name.toLowerCase().includes(needle))
      .sort((a, b) => {
        // Prefer entries where the needle is at the start of the name.
        const aStarts = a.name.toLowerCase().startsWith(needle) ? 0 : 1;
        const bStarts = b.name.toLowerCase().startsWith(needle) ? 0 : 1;
        if (aStarts !== bStarts) return aStarts - bStarts;
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      })
      .slice(0, SUGGEST_MAX);
    activeIndex = matches.length ? 0 : -1;
    render();
  });

  input.addEventListener("keydown", (e) => {
    if (list.hidden || !matches.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIndex = (activeIndex + 1) % matches.length;
      render();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIndex = (activeIndex - 1 + matches.length) % matches.length;
      render();
    } else if (e.key === "Enter" && activeIndex >= 0) {
      e.preventDefault();
      input.value = matches[activeIndex].name;
      close();
    } else if (e.key === "Escape") {
      close();
    }
  });

  input.addEventListener("blur", () => {
    // Small delay so a mousedown on a suggestion still commits.
    setTimeout(close, 120);
  });
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
    if (state.admin) primeTournamentRoster();
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

// Reads `writes` off the module scope each call, not off the closure at
// wire-time, because wireEvents() runs before AdminWriteService is built.
function wireTournamentQuickAdd() {
  const form = document.getElementById("tournamentQuickAdd");
  if (!form) return;
  const nameEl = document.getElementById("tqName");
  const scoreEl = document.getElementById("tqScore");
  const matchesEl = document.getElementById("tqMatches");
  wireNameSuggest(nameEl);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setTqStatus("Adding…");
    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    try {
      if (!writes) {
        setTqStatus("Not signed in yet. Wait for admin auth to finish.", "error");
        return;
      }
      const cosmetic = lookupRosterCosmetic(nameEl.value) || {};
      const payload = buildPlayerPayload({
        playlist: "tournament",
        name: nameEl.value,
        score: scoreEl.value,
        matches: matchesEl.value,
        icons: cosmetic.icons || "",
        flag: cosmetic.flag || "",
      });
      // Upsert on name so a repeat add updates instead of duplicating.
      const existing = findTournamentRowByName(payload.name);
      log.info("tournament", existing ? "quick-add upsert" : "quick-add insert", {
        name: payload.name,
        score: payload.score,
        matches: payload.matches,
        existingId: existing?.id || null,
      });
      const saved = existing
        ? await writes.updatePlayer(existing.id, payload)
        : await writes.addPlayer(payload);
      if (saved) {
        log.info("tournament", existing ? "quick-add upsert ok" : "quick-add insert ok", {
          name: payload.name, id: existing?.id || saved?.id || null,
        });
        clearAdminRosterCache();
        // Firestore realtime updates state.rows within ~500ms; no local
        // overlay needed on the tournament tab.
        const verb = existing ? "Updated" : "Added";
        setTqStatus(`✓ ${verb} ${payload.name}. Row appears in the board within a second.`, "success");
        form.reset();
        nameEl.focus();
        setTimeout(() => setTqStatus(""), 4000);
      } else {
        // AdminWriteService.run catches the SDK error and paints it into
        // #writeStatus. Mirror that here so the quick-add pill shows the
        // actual reason instead of a generic "check the other pill".
        const reason = document.getElementById("writeStatus")?.textContent?.trim();
        log.error("tournament", "quick-add failed", new Error(reason || "unknown"));
        setTqStatus(reason ? `Add failed: ${reason}` : "Add failed.", "error");
      }
    } catch (err) {
      log.error("tournament", "quick-add threw", err);
      setTqStatus(err?.message || "Add failed.", "error");
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });

  document.getElementById("tqClearBtn")?.addEventListener("click", async () => {
    if (!writes) {
      setTqStatus("Not signed in yet.", "error");
      return;
    }
    const confirmed = await showConfirm({
      title: "Clear the tournament?",
      message: "This removes every player from the Tournament leaderboard and can't be undone.",
      confirmLabel: "Clear all",
      variant: "danger",
    });
    if (!confirmed) return;
    setTqStatus("Clearing…");
    const ok = await writes.clearTournament();
    if (ok) {
      clearAdminRosterCache();
      // Firestore realtime handles the redraw once the soft-delete
      // writes propagate.
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
        const cosmetic = lookupRosterCosmetic(row.name) || {};
        const payload = buildPlayerPayload({
          playlist: "tournament",
          name: row.name,
          score: row.score,
          matches: row.matches,
          icons: cosmetic.icons || "",
          flag: cosmetic.flag || "",
        });
        // Same upsert rule as the quick-add: don't create a duplicate.
        const existing = findTournamentRowByName(payload.name);
        const result = existing
          ? await writes?.updatePlayer(existing.id, payload)
          : await writes?.addPlayer(payload);
        if (result) added += 1;
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

  wireTournamentQuickAdd();

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
      const rawValues = readFormValues($("editForm"));
      const player = state.editingPlayer;
      // Tournament edits hide the Appearance section, and disabled inputs
      // are dropped from FormData. Without this, every edit would blank
      // the row's flag and icons. Re-inject them from the current row.
      if (player.playlist === "tournament") {
        rawValues.flag = player.flag || "";
        rawValues.icons = Array.isArray(player.icons)
          ? player.icons.join(",")
          : String(player.icons || "");
      }
      const payload = buildPlayerPayload(rawValues, false);
      if (payload.flag) flagDirectory.add(payload.flag);
      // Re-attach playlist so the gateway routes to tournament_leaderboard
      // and the rule's hasOnly() check accepts the write.
      log.info("write", "update requested", {
        id: player.id,
        playlist: player.playlist,
        name: payload.name,
        score: payload.score,
        matches: payload.matches,
      });
      const saved = await writes?.updatePlayer(player.id, {
        ...payload,
        playlist: player.playlist,
      });
      if (!saved) log.error("write", "update failed", new Error(`updatePlayer returned falsy for ${player.id}`));
      else log.info("write", "update completed", { id: player.id, playlist: player.playlist });
      if (saved) {
        clearAdminRosterCache();
        // Optimistic overlay: patch the edited row into state.rows and
        // re-sort so the admin sees their change without waiting for the
        // ~15-min publish cycle. The CDN update will replace this shortly
        // and normalizePlaylistRows will re-derive an identical row.
        if (state.playlist === player.playlist && player.playlist !== "tournament") {
          const idx = state.rows.findIndex((r) => r.id === player.id);
          if (idx >= 0) {
            const patch = { ...state.rows[idx], name: payload.name };
            if (typeof payload.flag === "string") patch.flag = payload.flag;
            if (typeof payload.icons === "string") {
              // model stores icons as an array; payload has the comma string.
              patch.icons = payload.icons
                ? payload.icons.split(",").map((s) => s.trim()).filter(Boolean)
                : [];
            }
            if (player.playlist === "wins") {
              if (Number.isFinite(payload.wins)) patch.wins = payload.wins;
              if (Number.isFinite(payload.matches)) patch.matches = payload.matches;
            } else if (Number.isFinite(payload.mmr)) {
              patch.mmr = payload.mmr;
            }
            // A freshly-attached source id should show up immediately —
            // otherwise the ATLAS badge / purge-all-playlists behavior
            // only kicks in after the next publish.
            if (typeof payload.sourceUserId === "string" && payload.sourceUserId) {
              patch.sourceUserId = payload.sourceUserId;
            }
            // Drop the JSON-provided rank so the render falls back to
            // index+1 after re-sort.
            delete patch.rank;
            state.rows[idx] = patch;
            state.rows.forEach((r) => { delete r.rank; });
            sortPlaylistRows(state.rows, player.playlist);
            render();
          }
        }
        // Tournament updates propagate via Firestore realtime; no local
        // overlay needed. Ranked edits stay on the CDN path and rely on
        // the ~1 min publish cadence.
        // Fan the cosmetic fields (name/flag/icons) across sibling
        // playlist docs so a flag edit made in 1v1 shows up in 2v2/3v3/wins
        // too. Score fields stay per-playlist. Tournament rows have no
        // siblings.
        if (player.sourceUserId && player.playlist !== "tournament") {
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
  log.info("boot", "starting", {
    href: globalThis.location?.href,
    userAgent: globalThis.navigator?.userAgent?.slice(0, 60),
  });
  wireEvents();
  render();

  try {
    gateway = await createFirebaseGateway();
    log.info("boot", "firebase gateway ready");
  } catch (error) {
    log.error("boot", "firebase gateway failed to load", error);
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
      state.rows = state.playlist === "tournament"
        ? normalized.rows
        : applyRankedTombstones(normalized.rows, state.playlist);
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
