// Admin-only Access tab: allow list + ban list on one screen.
// Show / hide is handled by activatePlaylist("access") in app.js.

import { PLAYLISTS, STATIC_JSON_URL_TEMPLATE, isRejectableAccessUid } from "./config.js";

const $ = (id) => document.getElementById(id);

export function normalizeAccessUid(value) {
  return String(value ?? "").trim();
}

export const ZERO_DEVICE_ID = "00000000-0000-0000-0000-000000000000";

export function normalizeAccessDeviceId(value) {
  return String(value ?? "").trim();
}

export function isBindableDeviceId(value) {
  const id = normalizeAccessDeviceId(value);
  return id.length >= 8 && id !== ZERO_DEVICE_ID;
}

export function parseAllowCredentials(uidValue, deviceValue) {
  const uid = normalizeAccessUid(uidValue);
  const deviceId = normalizeAccessDeviceId(deviceValue);
  if (!uid) return { error: "Paste their Firebase id." };
  if (isRejectableAccessUid(uid)) {
    return { error: "That id is a test/spam uid. It stays banned." };
  }
  if (!deviceId) return { error: "Paste their Device id too. Writes fail without it." };
  if (deviceId === ZERO_DEVICE_ID) return { error: "That Device id is the all-zero UUID. Don't use it." };
  if (deviceId.length < 8) return { error: "That Device id looks too short." };
  return { uid, deviceId };
}

export function readAllowedDevicePins(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [uid, device] of Object.entries(raw)) {
    const id = normalizeAccessUid(uid);
    const pin = normalizeAccessDeviceId(device);
    if (id && isBindableDeviceId(pin)) out[id] = pin;
  }
  return out;
}

export function unpinnedAccessCount(rows) {
  return (Array.isArray(rows) ? rows : []).filter((row) => !row?.pinned).length;
}

export function shortUid(uid) {
  const id = normalizeAccessUid(uid);
  if (id.length <= 16) return id;
  return `${id.slice(0, 8)}…${id.slice(-6)}`;
}

export function filterAccessEntries(entries, query) {
  const q = String(query ?? "").trim().toLowerCase();
  const rows = Array.isArray(entries) ? entries : [];
  if (!q) return rows;
  return rows.filter((row) => {
    const uid = String(row?.uid || "").toLowerCase();
    const name = String(row?.name || "").toLowerCase();
    const deviceId = String(row?.deviceId || "").toLowerCase();
    return uid.includes(q) || name.includes(q) || deviceId.includes(q);
  });
}

export function nameFromSubmission(data) {
  if (!data || typeof data !== "object") return "";
  const display = String(data.displayName || "").trim();
  if (display) return display.slice(0, 80);
  const raw = String(data.nickname || data.Nickname || "").trim();
  if (!raw) return "";
  return raw.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
}

const NAME_CACHE_KEY = "rgLB:accessNames:v1";
// Firestore gets are how Access burns quota. JSON + local cache first;
// only brand-new allow/ban uids may hit script_submissions, and only a handful.
export const MISSING_NAME_LOOKUP_CAP = 4;

export function newAccessUids(current, previous) {
  if (previous == null) return [];
  const seen = new Set(uniqueAccessUids(previous));
  return uniqueAccessUids(current).filter((uid) => !seen.has(uid));
}

export function pickAccessNameLookups({
  uids = [],
  names = new Map(),
  skip = new Set(),
  limit = MISSING_NAME_LOOKUP_CAP,
} = {}) {
  return uniqueAccessUids(uids)
    .filter((uid) => !names.get(uid) && !skip.has(uid))
    .slice(0, Math.max(0, Number(limit) || 0));
}

export function readCachedAccessNames(storage = globalThis.localStorage) {
  try {
    const raw = JSON.parse(storage?.getItem?.(NAME_CACHE_KEY) || "{}");
    if (!raw || typeof raw !== "object") return new Map();
    return new Map(Object.entries(raw).filter(([uid, name]) => uid && name));
  } catch {
    return new Map();
  }
}

export function writeCachedAccessNames(names, storage = globalThis.localStorage) {
  try {
    const obj = {};
    for (const [uid, name] of names || []) {
      if (uid && name) obj[uid] = name;
    }
    storage?.setItem?.(NAME_CACHE_KEY, JSON.stringify(obj));
  } catch {
    // Private mode / quota — names still live in memory for this session.
  }
}

export async function fillMissingAccessNames({
  uids = [],
  names = new Map(),
  lookup,
  skip = new Set(),
  limit = MISSING_NAME_LOOKUP_CAP,
} = {}) {
  const next = new Map(names);
  if (typeof lookup !== "function") return next;
  const missing = pickAccessNameLookups({ uids, names: next, skip, limit });
  await Promise.all(missing.map(async (uid) => {
    try {
      const name = nameFromSubmission(await lookup(uid));
      if (name) next.set(uid, name);
      else skip.add(uid);
    } catch {
      // Quota or a missing submission — do not retry this uid this session.
      skip.add(uid);
    }
  }));
  return next;
}

// One Firebase uid covers every playlist. The first seed listed the same
// person once per board they appeared on; collapse that here.
export function nameForAccessUid(rows, uid) {
  const id = normalizeAccessUid(uid);
  if (!id) return "";
  const row = (Array.isArray(rows) ? rows : []).find((entry) => entry?.uid === id);
  return String(row?.name || "").trim();
}

export function uniqueAccessUids(ids) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(ids) ? ids : []) {
    const uid = normalizeAccessUid(raw);
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    out.push(uid);
  }
  return out;
}

export function decorateAccessLists({ allowed = [], banned = [], names = new Map(), pins = {} } = {}) {
  const nameOf = (uid) => names.get(uid) || "";
  const pinOf = (uid) => (isBindableDeviceId(pins[uid]) ? pins[uid] : "");
  const decorate = (uid, list) => ({
    uid,
    name: nameOf(uid),
    list,
    deviceId: pinOf(uid),
    pinned: Boolean(pinOf(uid)),
  });
  const byName = (a, b) => (nameOf(a) || a).localeCompare(nameOf(b) || b, undefined, { sensitivity: "base" });
  return {
    allowedRows: uniqueAccessUids(allowed)
      .sort((a, b) => {
        const pinGap = Number(Boolean(pinOf(a))) - Number(Boolean(pinOf(b)));
        return pinGap || byName(a, b);
      })
      .map((uid) => decorate(uid, "allow")),
    bannedRows: uniqueAccessUids(banned)
      .sort(byName)
      .map((uid) => decorate(uid, "ban")),
  };
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "className") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "attrs") {
      for (const [attr, attrValue] of Object.entries(value)) {
        if (attrValue != null) node.setAttribute(attr, String(attrValue));
      }
    } else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value != null) {
      node[key] = value;
    }
  }
  for (const child of children) {
    if (child) node.append(child);
  }
  return node;
}

async function loadNameMap() {
  const names = new Map();
  const playlists = PLAYLISTS.filter((playlist) => playlist !== "tournament");
  await Promise.all(playlists.map(async (playlist) => {
    try {
      const url = STATIC_JSON_URL_TEMPLATE.replace("{playlist}", playlist);
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) return;
      const json = await response.json();
      for (const row of Array.isArray(json?.rows) ? json.rows : []) {
        const uid = normalizeAccessUid(row?.uid || row?.sourceUserId);
        const name = String(row?.name || "").trim();
        if (uid && name) names.set(uid, name);
      }
    } catch {
      // Non-fatal. Rows fall back to the raw uid.
    }
  }));
  return names;
}

function paint(container, {
  allowedRows,
  bannedRows,
  devices,
  query,
  loading,
  error,
  formError,
  drafts,
  onAllow,
  onBan,
  onRemoveAllow,
  onRemoveBan,
  onBanDevice,
  onRemoveDevice,
  onRequestAllow,
  onDraft,
  onQuery,
  onRefresh,
}) {
  container.replaceChildren();

  const search = el("input", {
    className: "access-search-input",
    type: "search",
    value: query,
    placeholder: "Search a name, uid, or device…",
    attrs: { "aria-label": "Filter allow and ban lists" },
    onInput: (event) => onQuery(event.target.value),
  });

  const allowUidInput = el("input", {
    className: "access-uid-input",
    type: "text",
    autocomplete: "off",
    spellcheck: false,
    value: drafts?.allowUid || "",
    placeholder: "Firebase id from ATLAS settings",
    attrs: { maxlength: "128", name: "firebaseId", "aria-label": "Firebase id to allow" },
    onInput: (event) => onDraft("allowUid", event.target.value),
  });
  const allowDeviceInput = el("input", {
    className: "access-uid-input",
    type: "text",
    autocomplete: "off",
    spellcheck: false,
    value: drafts?.allowDevice || "",
    placeholder: "Device id from the row below it",
    attrs: { maxlength: "128", name: "deviceId", "aria-label": "Device id to allow" },
    onInput: (event) => onDraft("allowDevice", event.target.value),
  });
  const banInput = el("input", {
    className: "access-uid-input",
    type: "text",
    autocomplete: "off",
    spellcheck: false,
    value: drafts?.banUid || "",
    placeholder: "Paste a uid to lock out",
    attrs: { maxlength: "128", name: "banUid", "aria-label": "Uid to ban" },
    onInput: (event) => onDraft("banUid", event.target.value),
  });
  const bannedDeviceInput = el("input", {
    className: "access-uid-input",
    type: "text",
    autocomplete: "off",
    spellcheck: false,
    value: drafts?.banDevice || "",
    placeholder: "Device id",
    attrs: { maxlength: "128", name: "banDevice", "aria-label": "Device id to ban" },
    onInput: (event) => onDraft("banDevice", event.target.value),
  });

  const submitUid = (fieldName, handler) => (event) => {
    event.preventDefault();
    const uid = normalizeAccessUid(new FormData(event.currentTarget).get(fieldName));
    if (!uid) return;
    handler(uid);
  };

  const submitAllow = (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    onAllow(data.get("firebaseId"), data.get("deviceId"));
  };

  const unpinned = unpinnedAccessCount(allowedRows);
  const draftUid = normalizeAccessUid(drafts?.allowUid);
  const draftName = nameForAccessUid([...allowedRows, ...bannedRows], draftUid);

  container.append(
    el("div", { className: "access-shell" }, [
      el("header", { className: "access-hero" }, [
        el("div", { className: "access-hero-copy" }, [
          el("span", { className: "access-kicker", text: "Checkpoint" }),
          el("h2", { className: "access-title", text: "Who gets through" }),
          el("p", {
            className: "access-lede",
            text: "They DM both ids from ATLAS settings. Paste both here. A uid with no device still cannot write. Allowing someone unbans them. Banning someone drops them off the allow list.",
          }),
        ]),
        el("div", { className: "access-meters", attrs: { "aria-label": "List counts" } }, [
          meter("Allowed IDs", allowedRows.length, "allow"),
          meter("No device", unpinned, "pin"),
          meter("Banned IDs", bannedRows.length, "ban"),
          meter("Banned devices", (devices || []).length, "device"),
        ]),
      ]),
      el("div", { className: "access-toolbar" }, [
        el("label", { className: "access-search" }, [
          el("span", { className: "access-search-label", text: "Find" }),
          search,
        ]),
        el("button", {
          className: "admin-secondary access-refresh",
          type: "button",
          text: loading ? "Loading…" : "Refresh",
          disabled: loading,
          onClick: onRefresh,
        }),
      ]),
      error
        ? el("p", { className: "access-error", text: error, attrs: { role: "alert" } })
        : null,
      el("div", { className: "access-gates" }, [
        gate({
          tone: "allow",
          kicker: "Cleared",
          title: "Allow list",
          hint: "Settings → Firebase id and Device id. Both required.",
          form: el("form", { className: "access-add access-add-allow", onSubmit: submitAllow }, [
            draftUid
              ? el("p", {
                className: "access-draft-who",
                text: draftName
                  ? `Editing ${draftName}`
                  : "Editing an unknown player",
              })
              : null,
            el("label", { className: "access-field" }, [
              el("span", { className: "access-field-label", text: "Firebase id" }),
              allowUidInput,
            ]),
            el("label", { className: "access-field" }, [
              el("span", { className: "access-field-label", text: "Device id" }),
              allowDeviceInput,
            ]),
            formError
              ? el("p", { className: "access-form-error", text: formError, attrs: { role: "alert" } })
              : null,
            el("button", { className: "admin-primary", type: "submit", text: "Allow" }),
          ]),
          rows: filterAccessEntries(allowedRows, query),
          empty: query ? "No allowed uid matches that search." : "Nobody is allowed yet. The live board will not take HUD writes.",
          onMove: onBan,
          moveLabel: "Ban",
          onRemove: onRemoveAllow,
          onPin: onRequestAllow,
        }),
        gate({
          tone: "ban",
          kicker: "Denied",
          title: "Ban list",
          hint: "Writes die even if they still have the HUD.",
          form: el("form", { className: "access-add", onSubmit: submitUid("banUid", onBan) }, [
            banInput,
            el("button", { className: "admin-danger", type: "submit", text: "Ban this uid" }),
          ]),
          rows: filterAccessEntries(bannedRows, query),
          empty: query ? "No banned uid matches that search." : "No uid bans. Attack leftovers go here.",
          onMove: onRequestAllow,
          moveLabel: "Allow",
          onRemove: onRemoveBan,
          onPin: onRequestAllow,
        }),
      ]),
      el("section", { className: "access-devices", attrs: { "aria-label": "Banned devices" } }, [
        el("div", { className: "access-devices-head" }, [
          el("div", {}, [
            el("span", { className: "access-kicker", text: "Hardware" }),
            el("h3", { className: "access-devices-title", text: "Banned devices" }),
          ]),
          el("form", { className: "access-add", onSubmit: submitUid("banDevice", onBanDevice) }, [
            bannedDeviceInput,
            el("button", { className: "admin-danger", type: "submit", text: "Ban device" }),
          ]),
        ]),
        devices.length
          ? el("ul", { className: "access-device-list" }, devices.map((id) =>
            el("li", { className: "access-device-row" }, [
              el("code", { text: id }),
              el("button", {
                className: "admin-secondary",
                type: "button",
                text: "Remove",
                onClick: () => onRemoveDevice(id),
              }),
            ])))
          : el("p", { className: "access-empty", text: "No device bans." }),
      ]),
    ]),
  );
}

function meter(label, count, tone) {
  return el("div", { className: `access-meter access-meter-${tone}` }, [
    el("span", { className: "access-meter-count", text: String(count) }),
    el("span", { className: "access-meter-label", text: label }),
  ]);
}

function gate({
  tone,
  kicker,
  title,
  hint,
  form,
  rows,
  empty,
  onMove,
  moveLabel,
  onRemove,
  onPin,
}) {
  return el("section", { className: `access-gate access-gate-${tone}` }, [
    el("div", { className: "access-gate-head" }, [
      el("span", { className: "access-kicker", text: kicker }),
      el("h3", { className: "access-gate-title", text: title }),
      el("p", { className: "access-gate-hint", text: hint }),
    ]),
    form,
    rows.length
      ? el("ul", { className: "access-list" }, rows.map((row) => accessRow(row, { onMove, moveLabel, onRemove, onPin })))
      : el("p", { className: "access-empty", text: empty }),
  ]);
}

function copyButton(label, value, ariaLabel) {
  const copy = el("button", {
    className: "access-icon-btn",
    type: "button",
    text: label,
    title: ariaLabel,
    attrs: { "aria-label": ariaLabel },
    onClick: async () => {
      try {
        await navigator.clipboard.writeText(value);
        copy.textContent = "Copied";
        setTimeout(() => { copy.textContent = label; }, 1200);
      } catch {
        copy.textContent = "Failed";
        setTimeout(() => { copy.textContent = label; }, 1200);
      }
    },
  });
  return copy;
}

function accessRow(row, { onMove, moveLabel, onRemove, onPin }) {
  const pinMissing = row.list === "allow" && !row.pinned;
  return el("li", { className: `access-row${pinMissing ? " access-row-unpinned" : ""}` }, [
    el("div", { className: "access-row-id" }, [
      el("button", {
        className: "access-row-name",
        type: "button",
        text: row.name || "Unknown player",
        title: "Edit this player in the form above",
        onClick: () => onPin?.(row.uid),
      }),
      el("code", { className: "access-row-uid", text: shortUid(row.uid), title: row.uid }),
      row.list === "allow"
        ? el("span", {
          className: `access-pin ${row.pinned ? "access-pin-ok" : "access-pin-missing"}`,
          text: row.pinned ? `Device ${shortUid(row.deviceId)}` : "No device",
          title: row.deviceId || "No device on file",
        })
        : null,
    ]),
    el("div", { className: "access-row-actions" }, [
      copyButton("Copy", row.uid, `Copy ${row.uid}`),
      row.pinned ? copyButton("Device", row.deviceId, `Copy device ${row.deviceId}`) : null,
      pinMissing
        ? el("button", {
          className: "access-icon-btn access-pin-btn",
          type: "button",
          text: "Set device",
          onClick: () => onPin(row.uid),
        })
        : null,
      el("button", {
        className: "admin-secondary",
        type: "button",
        text: moveLabel,
        onClick: () => onMove(row.uid),
      }),
      el("button", {
        className: "access-icon-btn access-icon-btn-danger",
        type: "button",
        text: "Remove",
        onClick: () => onRemove(row.uid),
      }),
    ]),
  ]);
}

export function createAccessView({ gateway, writes } = {}) {
  const container = $("accessView");
  if (!container) return { activate() {}, deactivate() {}, refresh() {} };

  let active = false;
  let query = "";
  let names = new Map();
  let allowed = [];
  let banned = [];
  let devices = [];
  let pins = {};
  let knownUids = null;
  let nameMisses = new Set();
  let loading = false;
  let error = "";
  let formError = "";
  let drafts = { allowUid: "", allowDevice: "", banUid: "", banDevice: "" };
  let inflight = 0;
  let focusDevice = false;

  function snapshot() {
    const decorated = decorateAccessLists({ allowed, banned, names, pins });
    return {
      ...decorated,
      devices,
      query,
      loading,
      error,
      formError,
      drafts,
      onAllow: (uid, deviceId) => {
        const parsed = parseAllowCredentials(uid, deviceId);
        if (parsed.error) {
          formError = parsed.error;
          render();
          return;
        }
        formError = "";
        act(async () => {
          const ok = await writes?.addAllowedUserId(parsed.uid, parsed.deviceId);
          if (ok) {
            drafts = { ...drafts, allowUid: "", allowDevice: "" };
          }
          return ok;
        });
      },
      onBan: (uid) => {
        drafts = { ...drafts, banUid: "" };
        act(() => writes?.addBannedUserId(uid));
      },
      onRemoveAllow: (uid) => act(() => writes?.removeAllowedUserId(uid)),
      onRemoveBan: (uid) => act(() => writes?.removeBannedUserId(uid)),
      onBanDevice: (id) => {
        drafts = { ...drafts, banDevice: "" };
        act(() => writes?.addBannedDeviceId(id));
      },
      onRemoveDevice: (id) => act(() => writes?.removeBannedDeviceId(id)),
      onRequestAllow: (uid) => {
        drafts = { ...drafts, allowUid: uid, allowDevice: pins[uid] || "" };
        formError = "";
        focusDevice = true;
        render();
      },
      onDraft: (field, value) => {
        drafts = { ...drafts, [field]: value };
        if (field === "allowUid" || field === "allowDevice") formError = "";
      },
      onQuery: (value) => {
        query = value;
        render();
      },
      onRefresh: () => refresh({ force: true }),
    };
  }

  function render() {
    if (!active) return;
    const focused = container.querySelector(":focus");
    const restore = focused
      ? {
        label: focused.getAttribute("aria-label"),
        className: focused.className,
        start: focused.selectionStart,
        end: focused.selectionEnd,
      }
      : null;
    paint(container, snapshot());
    if (focusDevice) {
      focusDevice = false;
      const deviceField = container.querySelector('[aria-label="Device id to allow"]');
      deviceField?.focus();
      return;
    }
    if (!restore) return;
    const next = restore.label
      ? container.querySelector(`[aria-label="${restore.label}"]`)
      : container.querySelector(`.${restore.className.split(" ").join(".")}`);
    if (!next) return;
    next.focus();
    if (typeof restore.start === "number") {
      try { next.setSelectionRange(restore.start, restore.end); } catch { /* not a text field */ }
    }
  }

  async function act(operation) {
    const ok = await operation?.();
    if (ok) await refresh({ force: true });
  }

  async function refresh({ force = false } = {}) {
    if (!gateway?.loadAccessControl) return;
    const token = ++inflight;
    loading = true;
    error = "";
    render();
    try {
      if (force || names.size === 0) {
        const published = await loadNameMap();
        const cached = readCachedAccessNames();
        names = new Map([...cached, ...published]);
      }
      const control = await gateway.loadAccessControl();
      if (token !== inflight || !active) return;
      allowed = control.allowedUserIds;
      banned = control.userIds;
      devices = control.deviceIds;
      pins = readAllowedDevicePins(control.allowedDevices);
      const current = uniqueAccessUids([...allowed, ...banned]);
      const newcomers = newAccessUids(current, knownUids);
      knownUids = current;
      if (newcomers.length && typeof gateway.loadScriptSubmission === "function") {
        names = await fillMissingAccessNames({
          uids: newcomers,
          names,
          skip: nameMisses,
          lookup: (uid) => gateway.loadScriptSubmission(uid),
        });
        writeCachedAccessNames(names);
      }
      loading = false;
      render();
    } catch (err) {
      if (token !== inflight || !active) return;
      loading = false;
      error = err?.message || "Could not load the allow and ban lists.";
      render();
    }
  }

  return {
    activate() {
      container.hidden = false;
      active = true;
      refresh();
    },
    deactivate() {
      active = false;
      container.hidden = true;
      inflight += 1;
    },
    refresh() {
      if (active) return refresh({ force: true });
    },
  };
}
