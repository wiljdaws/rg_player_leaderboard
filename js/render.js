import { PLAYLIST_LABELS, PLAYLISTS, isRankedPlaylist } from "./config.js";
import { labelForFlagUrl } from "./flag-directory.js";
import { playerGlow, winRate } from "./model.js";
import { formatWindow, momentumChip } from "./momentum.js";

const $ = (id) => document.getElementById(id);

function node(tag, options = {}) {
  const element = document.createElement(tag);
  if (options.className) element.className = options.className;
  if (options.text !== undefined) element.textContent = String(options.text);
  if (options.type) element.type = options.type;
  return element;
}

function safeImage(url, className, alt = "", onFail) {
  const image = node("img", { className });
  image.src = url;
  image.alt = alt;
  image.loading = "lazy";
  image.referrerPolicy = "no-referrer";
  image.addEventListener(
    "error",
    () => {
      image.remove();
      onFail?.();
    },
    { once: true },
  );
  return image;
}

// Skip a clan-tag prefix like "[XYZ] " so a broken flag falls back to the
// player's real initial, not a bracket. "[XYZ] Bob" → "B", "★ Sky" → "S".
export function initials(name) {
  const raw = String(name || "").trim();
  if (!raw) return "?";
  const stripped = raw
    .replace(/^\s*[\[\(\{|][^\]\)\}|]{0,20}[\]\)\}|]\s*/, "")
    .replace(/^[^\p{L}\p{N}]+/u, "");
  const source = stripped || raw;
  const first = source.match(/[\p{L}\p{N}]/u);
  return first ? first[0].toUpperCase() : "?";
}

// When a flag URL 404s the container swaps to the player's initial so the
// space stays the same size instead of collapsing to an empty box.
function flagCell(player, className = "p-flag") {
  const wrap = node("div", { className });
  const fallback = () => {
    wrap.textContent = initials(player?.name);
    wrap.classList.add("no-flag");
  };
  if (player?.flag) {
    wrap.append(safeImage(player.flag, "", "", fallback));
  } else {
    fallback();
  }
  return wrap;
}

function rankClass(index) {
  if (index === 0) return "r1";
  if (index === 1) return "r2";
  if (index === 2) return "r3";
  return "";
}

export function setDataStatus(status) {
  const chip = $("statusChip");
  const label = $("statusChipText");
  if (!chip || !label) return;
  const kind = ["loading", "live", "degraded", "error"].includes(status?.kind) ? status.kind : "loading";
  chip.dataset.state = kind;
  label.textContent = status?.message || "Loading rankings…";
}

export function setSubLine(text) {
  const sub = $("subLine");
  if (sub) sub.textContent = text;
}

export function setActiveTab(playlist) {
  const tabs = $("playlistTabs");
  if (!tabs) return;
  for (const tab of tabs.querySelectorAll('[role="tab"]')) {
    const active = tab.dataset.playlist === playlist;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  }
}

export function handleTabKeydown(event, onActivate) {
  const current = event.target;
  if (!current?.matches?.('[role="tab"]')) return;
  const index = PLAYLISTS.indexOf(current.dataset.playlist);
  let nextIndex = null;
  if (event.key === "ArrowRight") nextIndex = (index + 1) % PLAYLISTS.length;
  if (event.key === "ArrowLeft") nextIndex = (index - 1 + PLAYLISTS.length) % PLAYLISTS.length;
  if (event.key === "Home") nextIndex = 0;
  if (event.key === "End") nextIndex = PLAYLISTS.length - 1;
  if (nextIndex === null) return;
  event.preventDefault();
  const next = current.closest('[role="tablist"]').querySelector(`[data-playlist="${PLAYLISTS[nextIndex]}"]`);
  next?.focus();
  onActivate(PLAYLISTS[nextIndex]);
}

export function renderPodium(playlist, players, historyStore) {
  const host = $("podium");
  if (!host) return;
  if (players.length < 3) {
    host.style.display = "none";
    host.replaceChildren();
    return;
  }
  const [first, second, third] = players;
  // Visual order: silver on the left, gold in the center, bronze on the right.
  const order = [
    { player: second, place: "2nd", cls: "p2" },
    { player: first, place: "Champion", cls: "p1" },
    { player: third, place: "3rd", cls: "p3" },
  ];

  host.style.display = "grid";
  host.replaceChildren();
  for (const { player, place, cls } of order) {
    const step = node("div", { className: `step ${cls}` });
    step.append(node("div", { className: "place", text: place }));
    step.append(flagCell(player, "flag"));

    const name = node("div", { className: "pname", text: player.name });
    const glow = playerGlow(player);
    if (glow) name.style.textShadow = glow;
    step.append(name);

    const meta =
      playlist === "wins"
        ? `${player.wins} W · ${player.matches} M · ${winRate(player)}%`
        : PLAYLIST_LABELS[playlist];
    step.append(node("div", { className: "pmeta", text: meta }));

    const scoreValue = playlist === "wins" ? player.wins.toLocaleString() : player.mmr.toLocaleString();
    const scoreLabel = playlist === "wins" ? "Wins" : "MMR";
    const scoreEl = node("div", { className: "pscore" });
    scoreEl.textContent = scoreValue;
    scoreEl.append(node("small", { text: scoreLabel }));
    step.append(scoreEl);

    if (isRankedPlaylist(playlist) && historyStore) {
      const { gained, spanMs, samples } = historyStore.gainFor(playlist, player.id);
      if (samples >= 2 && gained != null) {
        const cls =
          gained > 0 ? "" : gained < 0 ? " neg" : " flat";
        const rounded = Math.round(gained);
        const magnitude = Math.abs(rounded).toLocaleString();
        const label =
          rounded === 0
            ? `— flat ${formatWindow(spanMs)}`
            : `${rounded > 0 ? "+" : "-"}${magnitude} ${formatWindow(spanMs)}`;
        step.append(node("div", { className: `plast${cls}`, text: label }));
      }
    }
    host.append(step);
  }
}

export function renderRecentGains(playlist, players, historyStore) {
  const host = $("recentGains");
  const strip = $("gainsStrip");
  const windowLabel = $("gainsWindow");
  const heading = $("gainsHeading");
  if (!host || !strip) return;

  const isRanked = isRankedPlaylist(playlist);
  const statLabel = isRanked ? "MMR" : "wins";
  const statValueOf = (player) => (isRanked ? player.mmr : player.wins);

  host.hidden = false;
  host.setAttribute("aria-label", `Recent ${statLabel} changes`);
  if (heading) heading.textContent = `Recent ${statLabel} changes`;

  const movers = historyStore?.topMovers(playlist, players) ?? [];

  strip.replaceChildren();
  if (!movers.length) {
    strip.append(node("div", { className: "gains-empty", text: `Watching for ${statLabel} movement — check back after the next sync.` }));
    if (windowLabel) windowLabel.textContent = "last hour";
    return;
  }

  if (windowLabel) {
    const spans = movers.map((g) => g.spanMs).filter((s) => s > 0);
    windowLabel.textContent = spans.length ? formatWindow(Math.max(...spans)) : "last hour";
  }

  const metaLabel = isRanked ? "MMR" : "Wins";
  for (const { player, gained } of movers) {
    const card = node("div", { className: gained < 0 ? "gain-card neg" : "gain-card" });
    card.append(flagCell(player, "flag"));
    const body = node("div", { className: "body" });
    body.append(node("div", { className: "n", text: player.name }));
    const value = statValueOf(player);
    if (typeof value === "number") {
      body.append(node("div", { className: "r", text: `${value.toLocaleString()} ${metaLabel}` }));
    }
    card.append(body);
    const sign = gained > 0 ? "+" : gained < 0 ? "-" : "";
    card.append(node("div", { className: "d", text: `${sign}${Math.abs(Math.round(gained)).toLocaleString()}` }));
    strip.append(card);
  }
}

function playerRow(player, index, playlist, historyStore, { admin, onInspect, onEdit, onDelete }) {
  const row = node("div", { className: `player-row${admin ? " admin" : ""}` });
  row.dataset.playlist = playlist;
  row.dataset.playerId = player.id;

  row.append(node("div", { className: `rank ${rankClass(index)}`, text: `#${index + 1}` }));

  const ident = node("div", { className: "p-ident" });
  ident.append(flagCell(player));
  const nameWrap = node("div", { className: "p-name-wrap" });

  const nameBtn = node("button", { className: "p-name", type: "button" });
  nameBtn.textContent = player.name;
  const glow = playerGlow(player);
  if (glow) nameBtn.style.textShadow = glow;
  nameBtn.setAttribute("aria-label", `View details for ${player.name}`);
  nameBtn.addEventListener("click", () => onInspect(player));
  nameWrap.append(nameBtn);

  if (player.icons?.length) {
    const icons = node("div", { className: "p-icons" });
    for (const url of player.icons) {
      const img = safeImage(url, "p-icon", "");
      img.style.setProperty("--icon-size", `${player.iconSize}px`);
      icons.append(img);
    }
    nameWrap.append(icons);
  }
  ident.append(nameWrap);
  row.append(ident);

  if (playlist === "wins") {
    row.append(node("div", { className: "p-score", text: player.wins.toLocaleString() }));
    row.append(node("div", { className: "p-score small", text: player.matches.toLocaleString() }));
    row.append(node("div", { className: "p-winrate", text: `${winRate(player)}%` }));
    if (admin) row.append(adminActions(player, onEdit, onDelete));
    else row.append(node("div"));
  } else {
    row.append(node("div", { className: "p-score", text: player.mmr.toLocaleString() }));

    const momentumWrap = node("div", { className: "momentum-cell" });
    const chip = momentumChip(historyStore.gainFor(playlist, player.id));
    const chipEl = node("span", { className: chip.className, text: chip.label });
    chipEl.title = chip.title;
    momentumWrap.append(chipEl);
    row.append(momentumWrap);

    if (admin) row.append(adminActions(player, onEdit, onDelete));
  }
  return row;
}

function adminActions(player, onEdit, onDelete) {
  const wrap = node("div", { className: "row-actions" });
  const edit = node("button", { className: "edit", text: "Edit", type: "button" });
  edit.addEventListener("click", () => onEdit(player));
  const del = node("button", { className: "delete", text: "Remove", type: "button" });
  del.addEventListener("click", () => onDelete(player));
  wrap.append(edit, del);
  return wrap;
}

export function renderBoard({ playlist, rows, historyStore, admin, emptyMessage, onInspect, onEdit, onDelete }) {
  const body = $("boardBody");
  const head = $("boardHead");
  if (!body || !head) return;

  head.dataset.playlist = playlist;
  head.replaceChildren();
  if (playlist === "wins") {
    head.append(
      node("span", { text: "Rank" }),
      node("span", { text: "Player" }),
      node("span", { className: "num", text: "Wins" }),
      node("span", { className: "num", text: "Matches" }),
      node("span", { className: "num", text: "Win %" }),
      node("span", { text: admin ? "Actions" : "" }),
    );
  } else {
    head.append(
      node("span", { text: "Rank" }),
      node("span", { text: "Player" }),
      node("span", { className: "num", text: "MMR" }),
      node("span", { className: "num", text: "Last hour" }),
    );
    if (admin) head.append(node("span", { text: "Actions" }));
  }

  if (!rows.length) {
    body.replaceChildren(node("div", { className: "empty-state", text: emptyMessage }));
    return;
  }

  const fragment = document.createDocumentFragment();
  rows.forEach((player, index) => {
    fragment.append(playerRow(player, index, playlist, historyStore, { admin, onInspect, onEdit, onDelete }));
  });
  body.replaceChildren(fragment);
}

export function renderIconKey({ rows, admin, loading, error, onDelete }) {
  const host = $("iconKey");
  if (!host) return;

  const shouldShow = admin || rows.length > 0;
  host.hidden = !shouldShow;
  if (!shouldShow) {
    host.replaceChildren();
    return;
  }

  host.replaceChildren();
  host.append(node("h2", { text: "Icon key" }));

  if (loading && !rows.length) {
    host.append(node("p", { text: "Loading icon key…" }));
    return;
  }
  if (error && !rows.length) {
    host.append(node("p", { text: error }));
    return;
  }
  if (!rows.length) {
    host.append(node("p", { text: "No icon labels yet." }));
    return;
  }

  for (const item of rows) {
    const chip = node("div", { className: "icon-key-item" });
    chip.append(safeImage(item.icon, "", ""));
    chip.append(node("span", { text: item.label }));
    if (admin) {
      const remove = node("button", { className: "remove", text: "×", type: "button" });
      remove.setAttribute("aria-label", `Remove ${item.label}`);
      remove.addEventListener("click", () => onDelete(item));
      chip.append(remove);
    }
    host.append(chip);
  }
  if (error) host.append(node("p", { text: error }));
}

function detailRow(term, value) {
  const wrap = node("div", { className: "detail-row" });
  wrap.append(node("dt", { text: term }), node("dd", { text: value }));
  return wrap;
}

export function renderPlayerDialog(dialog, player, rank) {
  const panel = node("div", { className: "dialog-panel" });
  const heading = node("h2", { className: "dialog-title", text: player.name });
  heading.id = "playerDialogTitle";
  dialog.setAttribute("aria-labelledby", heading.id);

  const summary = node("p", {
    className: "dialog-summary",
    text: `${PLAYLIST_LABELS[player.playlist]} · Rank #${rank}`,
  });

  const details = node("dl", { className: "detail-list" });
  details.append(
    detailRow(
      player.playlist === "wins" ? "Record" : "MMR",
      player.playlist === "wins"
        ? `${player.wins} wins in ${player.matches} matches`
        : String(player.mmr),
    ),
    detailRow("Source", player.provenance.kind),
    detailRow("ATLAS version", player.provenance.version || "Not recorded"),
    detailRow(
      "Last updated",
      player.provenance.updatedAt ? player.provenance.updatedAt.toLocaleString() : "Not recorded",
    ),
  );

  const close = node("button", { className: "admin-primary", text: "Close", type: "button" });
  close.addEventListener("click", () => dialog.close());
  panel.append(heading, summary, details, close);
  dialog.replaceChildren(panel);
  if (!dialog.open) {
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }
  close.focus();
}

// A visual flag combobox: native <select> can't render thumbnails, so this
// hand-rolls a listbox out of a trigger button + a popover menu. Each option
// carries a flag image next to its label, and the actual form value is held
// in a hidden <input name="flag"> so FormData serializes it unchanged.
export function hydrateFlagPicker(root, { currentValue = "", directory, onNewFlag }) {
  if (!root) return null;
  root.innerHTML = "";
  root.classList.add("flag-picker");

  const hidden = document.createElement("input");
  hidden.type = "hidden";
  hidden.name = "flag";
  hidden.value = currentValue || "";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "flag-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");

  const menu = document.createElement("div");
  menu.className = "flag-menu";
  menu.setAttribute("role", "listbox");
  menu.hidden = true;

  const searchWrap = document.createElement("div");
  searchWrap.className = "flag-search";
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "Search flags…";
  search.autocomplete = "off";
  search.setAttribute("aria-label", "Search flags");
  searchWrap.append(search);

  const list = document.createElement("div");
  list.className = "flag-list";
  list.setAttribute("role", "presentation");

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "flag-add";
  addBtn.textContent = "+ Add new flag URL…";

  const customRow = document.createElement("div");
  customRow.className = "flag-custom";
  customRow.hidden = true;
  const customInput = document.createElement("input");
  customInput.type = "url";
  customInput.placeholder = "https://…/flag.svg";
  customInput.autocomplete = "off";
  customInput.className = "flag-custom-input";
  const customAdd = document.createElement("button");
  customAdd.type = "button";
  customAdd.textContent = "Add";
  customAdd.className = "flag-custom-add";
  const customCancel = document.createElement("button");
  customCancel.type = "button";
  customCancel.textContent = "Cancel";
  customCancel.className = "flag-custom-cancel";
  customRow.append(customInput, customAdd, customCancel);

  menu.append(searchWrap, list, addBtn);
  root.append(hidden, trigger, menu, customRow);

  function makeThumb(url, className = "flag-thumb") {
    const wrap = document.createElement("span");
    wrap.className = className;
    if (!url) {
      wrap.classList.add("empty");
      wrap.textContent = "—";
      return wrap;
    }
    const img = document.createElement("img");
    img.src = url;
    img.alt = "";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.addEventListener(
      "error",
      () => {
        wrap.classList.add("empty");
        wrap.replaceChildren(document.createTextNode("?"));
      },
      { once: true },
    );
    wrap.append(img);
    return wrap;
  }

  function drawTrigger() {
    trigger.innerHTML = "";
    const value = hidden.value;
    trigger.append(makeThumb(value, "flag-thumb trigger"));
    const label = document.createElement("span");
    label.className = "flag-trigger-label";
    label.textContent = value ? labelForFlagUrl(value) : "— No flag —";
    trigger.append(label);
    const chev = document.createElement("span");
    chev.className = "flag-chev";
    chev.textContent = "▾";
    chev.setAttribute("aria-hidden", "true");
    trigger.append(chev);
  }

  function drawOptions() {
    const query = search.value.trim().toLowerCase();
    const entries = directory.list();
    const desired = hidden.value;
    if (desired && !entries.some((e) => e.url === desired)) {
      entries.unshift({ url: desired, label: labelForFlagUrl(desired) });
    }

    list.innerHTML = "";
    const options = [{ url: "", label: "— No flag —" }, ...entries];
    let active = 0;
    let renderedActive = false;
    options.forEach((entry, index) => {
      if (query && entry.url && !entry.label.toLowerCase().includes(query)) return;
      const item = document.createElement("div");
      item.className = "flag-option";
      item.setAttribute("role", "option");
      item.dataset.value = entry.url;
      const selected = entry.url === desired;
      item.setAttribute("aria-selected", String(selected));
      if (selected) {
        item.classList.add("selected");
        active = index;
        renderedActive = true;
      }
      item.append(makeThumb(entry.url, "flag-thumb option"));
      const label = document.createElement("span");
      label.className = "flag-option-label";
      label.textContent = entry.label;
      item.append(label);
      item.addEventListener("click", () => choose(entry.url));
      list.append(item);
    });

    if (!list.children.length) {
      const empty = document.createElement("div");
      empty.className = "flag-empty";
      empty.textContent = query ? `No flags matching "${query}"` : "No saved flags yet.";
      list.append(empty);
    } else if (!renderedActive) {
      list.firstElementChild?.classList.add("kb-focus");
    } else {
      const activeEl = list.querySelector(".selected");
      activeEl?.scrollIntoView({ block: "nearest" });
    }
  }

  function refresh() {
    drawTrigger();
    if (!menu.hidden) drawOptions();
  }

  function openMenu() {
    menu.hidden = false;
    customRow.hidden = true;
    trigger.setAttribute("aria-expanded", "true");
    root.classList.add("open");
    drawOptions();
    // Defer focus so the popover has a frame to layout first.
    requestAnimationFrame(() => search.focus());
  }

  function closeMenu() {
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    root.classList.remove("open");
    search.value = "";
  }

  function choose(value) {
    hidden.value = value || "";
    currentValue = hidden.value;
    drawTrigger();
    closeMenu();
    hidden.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function moveFocus(delta) {
    const items = [...list.querySelectorAll(".flag-option")];
    if (!items.length) return;
    const current = list.querySelector(".kb-focus, .selected") ?? items[0];
    const currentIndex = items.indexOf(current);
    const nextIndex = Math.max(0, Math.min(items.length - 1, currentIndex + delta));
    items.forEach((item) => item.classList.remove("kb-focus"));
    items[nextIndex].classList.add("kb-focus");
    items[nextIndex].scrollIntoView({ block: "nearest" });
  }

  function commitCustomUrl() {
    const raw = customInput.value.trim();
    if (!raw) {
      customInput.focus();
      return;
    }
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      customInput.setCustomValidity("Enter a valid URL.");
      customInput.reportValidity();
      return;
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      customInput.setCustomValidity("Flag URL must use http or https.");
      customInput.reportValidity();
      return;
    }
    customInput.setCustomValidity("");
    const url = parsed.href;
    directory.add(url);
    onNewFlag?.(url);
    customRow.hidden = true;
    choose(url);
  }

  trigger.addEventListener("click", () => {
    if (menu.hidden) openMenu();
    else closeMenu();
  });

  trigger.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openMenu();
    }
  });

  search.addEventListener("input", drawOptions);
  search.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveFocus(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveFocus(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const focused = list.querySelector(".kb-focus, .selected");
      if (focused) choose(focused.dataset.value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeMenu();
      trigger.focus();
    }
  });

  addBtn.addEventListener("click", () => {
    menu.hidden = true;
    customRow.hidden = false;
    customInput.value = "";
    customInput.focus();
  });

  customAdd.addEventListener("click", commitCustomUrl);
  customCancel.addEventListener("click", () => {
    customRow.hidden = true;
    openMenu();
  });
  customInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitCustomUrl();
    } else if (event.key === "Escape") {
      event.preventDefault();
      customRow.hidden = true;
    }
  });

  // Close on outside click. `mousedown` beats `click` so we don't miss the
  // event when the click lands on something that removes itself.
  const outsideHandler = (event) => {
    if (!root.contains(event.target)) closeMenu();
  };
  document.addEventListener("mousedown", outsideHandler);

  const unsubscribe = directory.subscribe(refresh);
  drawTrigger();

  return {
    setValue(value) {
      hidden.value = value || "";
      currentValue = hidden.value;
      drawTrigger();
    },
    getValue() {
      return hidden.value;
    },
    destroy() {
      unsubscribe();
      document.removeEventListener("mousedown", outsideHandler);
    },
  };
}

export function setWriteStatus(status) {
  const el = $("writeStatus");
  if (!el) return;
  const kind = status?.kind || "idle";
  el.dataset.state = kind;
  el.textContent = status?.message || "";
  el.hidden = !status?.message;
}
