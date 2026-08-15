// Admin-only Access tab: allow list + ban list on one screen.
// Show / hide is handled by activatePlaylist("access") in app.js.

import { PLAYLISTS, STATIC_JSON_URL_TEMPLATE } from "./config.js";

const $ = (id) => document.getElementById(id);

export function normalizeAccessUid(value) {
  return String(value ?? "").trim();
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
    return uid.includes(q) || name.includes(q);
  });
}

export function decorateAccessLists({ allowed = [], banned = [], names = new Map() } = {}) {
  const nameOf = (uid) => names.get(uid) || "";
  return {
    allowedRows: [...allowed].map(normalizeAccessUid).filter(Boolean)
      .sort((a, b) => (nameOf(a) || a).localeCompare(nameOf(b) || b, undefined, { sensitivity: "base" }))
      .map((uid) => ({ uid, name: nameOf(uid), list: "allow" })),
    bannedRows: [...banned].map(normalizeAccessUid).filter(Boolean)
      .sort((a, b) => (nameOf(a) || a).localeCompare(nameOf(b) || b, undefined, { sensitivity: "base" }))
      .map((uid) => ({ uid, name: nameOf(uid), list: "ban" })),
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
  onAllow,
  onBan,
  onRemoveAllow,
  onRemoveBan,
  onBanDevice,
  onRemoveDevice,
  onQuery,
  onRefresh,
}) {
  container.replaceChildren();

  const search = el("input", {
    className: "access-search-input",
    type: "search",
    value: query,
    placeholder: "Search a name or uid…",
    attrs: { "aria-label": "Filter allow and ban lists" },
    onInput: (event) => onQuery(event.target.value),
  });

  const allowInput = el("input", {
    className: "access-uid-input",
    type: "text",
    autocomplete: "off",
    spellcheck: false,
    placeholder: "Paste their Firebase uid",
    attrs: { maxlength: "128", "aria-label": "Uid to allow" },
  });
  const banInput = el("input", {
    className: "access-uid-input",
    type: "text",
    autocomplete: "off",
    spellcheck: false,
    placeholder: "Paste a uid to lock out",
    attrs: { maxlength: "128", "aria-label": "Uid to ban" },
  });
  const deviceInput = el("input", {
    className: "access-uid-input",
    type: "text",
    autocomplete: "off",
    spellcheck: false,
    placeholder: "Device id",
    attrs: { maxlength: "128", "aria-label": "Device id to ban" },
  });

  const submitUid = (input, handler) => (event) => {
    event.preventDefault();
    const uid = normalizeAccessUid(input.value);
    if (!uid) return;
    handler(uid);
    input.value = "";
  };

  container.append(
    el("div", { className: "access-shell" }, [
      el("header", { className: "access-hero" }, [
        el("div", { className: "access-hero-copy" }, [
          el("span", { className: "access-kicker", text: "Checkpoint" }),
          el("h2", { className: "access-title", text: "Who gets through" }),
          el("p", {
            className: "access-lede",
            text: "Allow a uid and they can write the live board. Ban one and ATLAS stops cold. Allowing someone unbans them. Banning someone drops them off the allow list.",
          }),
        ]),
        el("div", { className: "access-meters", attrs: { "aria-label": "List counts" } }, [
          meter("Allowed", allowedRows.length, "allow"),
          meter("Banned", bannedRows.length, "ban"),
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
          hint: "HUD 19.9 → Settings → Copy. Then paste here.",
          input: allowInput,
          actionLabel: "Allow this uid",
          onSubmit: submitUid(allowInput, onAllow),
          rows: filterAccessEntries(allowedRows, query),
          empty: query ? "No allowed uid matches that search." : "Nobody is allowed yet. The live board will not take HUD writes.",
          onMove: onBan,
          moveLabel: "Ban",
          onRemove: onRemoveAllow,
        }),
        gate({
          tone: "ban",
          kicker: "Denied",
          title: "Ban list",
          hint: "Writes die even if they still have the HUD.",
          input: banInput,
          actionLabel: "Ban this uid",
          onSubmit: submitUid(banInput, onBan),
          rows: filterAccessEntries(bannedRows, query),
          empty: query ? "No banned uid matches that search." : "No uid bans. Attack leftovers go here.",
          onMove: onAllow,
          moveLabel: "Allow",
          onRemove: onRemoveBan,
        }),
      ]),
      el("section", { className: "access-devices", attrs: { "aria-label": "Banned devices" } }, [
        el("div", { className: "access-devices-head" }, [
          el("div", {}, [
            el("span", { className: "access-kicker", text: "Hardware" }),
            el("h3", { className: "access-devices-title", text: "Banned devices" }),
          ]),
          el("form", { className: "access-add", onSubmit: submitUid(deviceInput, onBanDevice) }, [
            deviceInput,
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
  input,
  actionLabel,
  onSubmit,
  rows,
  empty,
  onMove,
  moveLabel,
  onRemove,
}) {
  return el("section", { className: `access-gate access-gate-${tone}` }, [
    el("div", { className: "access-gate-head" }, [
      el("span", { className: "access-kicker", text: kicker }),
      el("h3", { className: "access-gate-title", text: title }),
      el("p", { className: "access-gate-hint", text: hint }),
    ]),
    el("form", { className: "access-add", onSubmit }, [
      input,
      el("button", {
        className: tone === "allow" ? "admin-primary" : "admin-danger",
        type: "submit",
        text: actionLabel,
      }),
    ]),
    rows.length
      ? el("ul", { className: "access-list" }, rows.map((row) => accessRow(row, { onMove, moveLabel, onRemove })))
      : el("p", { className: "access-empty", text: empty }),
  ]);
}

function accessRow(row, { onMove, moveLabel, onRemove }) {
  const copy = el("button", {
    className: "access-icon-btn",
    type: "button",
    text: "Copy",
    title: "Copy uid",
    attrs: { "aria-label": `Copy ${row.uid}` },
    onClick: async () => {
      try {
        await navigator.clipboard.writeText(row.uid);
        copy.textContent = "Copied";
        setTimeout(() => { copy.textContent = "Copy"; }, 1200);
      } catch {
        copy.textContent = "Failed";
        setTimeout(() => { copy.textContent = "Copy"; }, 1200);
      }
    },
  });
  return el("li", { className: "access-row" }, [
    el("div", { className: "access-row-id" }, [
      el("strong", { className: "access-row-name", text: row.name || "Unknown player" }),
      el("code", { className: "access-row-uid", text: shortUid(row.uid), title: row.uid }),
    ]),
    el("div", { className: "access-row-actions" }, [
      copy,
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
  let loading = false;
  let error = "";
  let inflight = 0;

  function snapshot() {
    const decorated = decorateAccessLists({ allowed, banned, names });
    return {
      ...decorated,
      devices,
      query,
      loading,
      error,
      onAllow: (uid) => act(() => writes?.addAllowedUserId(uid)),
      onBan: (uid) => act(() => writes?.addBannedUserId(uid)),
      onRemoveAllow: (uid) => act(() => writes?.removeAllowedUserId(uid)),
      onRemoveBan: (uid) => act(() => writes?.removeBannedUserId(uid)),
      onBanDevice: (id) => act(() => writes?.addBannedDeviceId(id)),
      onRemoveDevice: (id) => act(() => writes?.removeBannedDeviceId(id)),
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
      if (force || names.size === 0) names = await loadNameMap();
      const control = await gateway.loadAccessControl();
      if (token !== inflight || !active) return;
      allowed = control.allowedUserIds;
      banned = control.userIds;
      devices = control.deviceIds;
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
