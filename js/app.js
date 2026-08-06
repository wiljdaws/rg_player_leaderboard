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

// Live-updating readout next to each range slider — helps admins pick a
// glow value without eyeballing pixels.
function bindGlowSlider(form) {
  const slider = form.querySelector("[data-glow-slider]");
  const output = form.querySelector("[data-glow-value]");
  if (!slider || !output) return;
  const paint = () => {
    output.textContent = `${slider.value}px`;
  };
  slider.addEventListener("input", paint);
  paint();
}

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
  if (state.status.kind === "error") return "Rankings are unavailable right now. Please try again shortly.";
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
  setSubLine(
    state.rows.length
      ? `${PLAYLIST_LABELS[state.playlist]} · ${state.rows.length} ${state.rows.length === 1 ? "player" : "players"}`
      : `Live 1v1, 2v2, 3v3, and wins standings.`,
  );

  renderBoard({
    playlist: state.playlist,
    rows: state.rows,
    historyStore,
    admin: state.admin,
    emptyMessage: emptyMessage(),
    onInspect: openPlayerDetails,
    onEdit: openEdit,
    onDelete: (player) => writes?.deletePlayer(player.id),
  });
  renderIconKey({
    rows: state.icons,
    admin: state.admin,
    loading: state.iconLoading,
    error: state.iconError,
    onDelete: (item) => writes?.deleteIcon(item.id),
  });
  syncPlayerDialog();
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
  setFormValue(form, "icons", player.icons.join(","));
  setFormValue(form, "iconSize", player.iconSize);
  setFormValue(form, "glowColor", player.glowColor);
  setFormValue(form, "glowStrength", player.glowStrength);
  if (player.flag) flagDirectory.add(player.flag);
  flagPickers.edit?.setValue(player.flag || "");
  togglePlaylistFields(form, player.playlist);
  const glowValue = form.querySelector("[data-glow-value]");
  if (glowValue) glowValue.textContent = `${player.glowStrength ?? 0}px`;
  const dialog = $("editDialog");
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function activatePlaylist(playlist, { push = true, updateUrl = true } = {}) {
  if (!isPlaylist(playlist)) return;
  if (playlist === state.playlist) return;
  state.playlist = playlist;
  // Drop the previous playlist's rows so the intermediate render doesn't
  // paint wins-shaped data into an MMR-shaped board (or vice versa) while
  // the new listener is spinning up.
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
  if (updateUrl) urlState(push);
  render();
  listenerManager?.activate(playlist);
}

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
  bindGlowSlider($("adminForm"));
  bindGlowSlider($("editForm"));

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
        $("adminForm").reset();
        flagPickers.add?.setValue("");
        const glowValue = $("adminForm").querySelector("[data-glow-value]");
        if (glowValue) glowValue.textContent = "0px";
        togglePlaylistFields($("adminForm"), $("playlist").value);
      }
    } catch (error) {
      handleValidationError(error);
    }
  });

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

  $("editForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.editingPlayer) return;
    try {
      const payload = buildPlayerPayload(readFormValues($("editForm")), false);
      if (payload.flag) flagDirectory.add(payload.flag);
      const player = state.editingPlayer;
      const saved = await writes?.updatePlayer(player.id, payload);
      if (saved) {
        // For HUD-synced players (deterministic ID = sourceUserId_playlist),
        // propagate the cosmetic fields to the other playlist docs so a flag
        // or glow edit made in 1v1 is reflected in 2v2/3v3/wins too. Score
        // fields (mmr / wins / matches) stay per-playlist.
        if (player.sourceUserId) {
          const cosmetic = {
            name: payload.name,
            flag: payload.flag,
            icons: payload.icons,
            iconSize: payload.iconSize,
            glowColor: payload.glowColor,
            glowStrength: payload.glowStrength,
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

  writes = new AdminWriteService({
    gateway,
    isAdmin: () => state.admin,
    refreshIcons,
  });

  gateway.observeAuth((user) => {
    state.user = user;
    state.admin = isAdminUser(user);
    if (!state.admin) {
      state.editingPlayer = null;
      const dialog = $("editDialog");
      if (dialog?.open) dialog.close();
    }
    $("adminBox").hidden = !state.admin;
    $("loginButton").hidden = Boolean(user);
    $("logoutButton").hidden = !user;
    $("authStatus").textContent = state.admin
      ? "Admin mode"
      : user
        ? "Signed in without admin access"
        : "";
    render();
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
}

boot();
