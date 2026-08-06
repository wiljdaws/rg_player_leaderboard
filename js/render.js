import { PLAYLIST_LABELS, PLAYLISTS, isRankedPlaylist } from "./config.js";
import { COUNTRIES, canonicalCountry, labelForFlagUrl } from "./flag-directory.js";
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

// Auto-scroll long names when they overflow their container. Only kicks in
// when text actually exceeds the visible width, so short names stay static.
const MARQUEE_TARGETS = ".p-name, .pname, .gain-card .n";
const MARQUEE_SLACK_PX = 4;

function detachMarquee(el) {
  if (el.dataset.marquee !== "on") return;
  const inner = el.querySelector(":scope > .marquee-inner");
  if (inner) {
    while (inner.firstChild) el.insertBefore(inner.firstChild, inner);
    inner.remove();
  }
  el.classList.remove("marquee");
  el.style.removeProperty("--marquee-distance");
  el.style.removeProperty("--marquee-duration");
  delete el.dataset.marquee;
}

function attachMarquee(el) {
  // Re-measure from scratch on every pass: on resize the container may have
  // grown or shrunk, so a previously-marqueed name might now fit or vice versa.
  detachMarquee(el);

  // Wrap + apply .marquee (which forces display:block) BEFORE measuring.
  // Without the block override, flex-item blockification makes the inner
  // report parent width instead of intrinsic content width and no overflow
  // would be visible.
  const inner = document.createElement("span");
  inner.className = "marquee-inner";
  while (el.firstChild) inner.appendChild(el.firstChild);
  el.appendChild(inner);
  el.classList.add("marquee");

  const overshoot = inner.offsetWidth - el.clientWidth;
  if (overshoot <= MARQUEE_SLACK_PX) {
    // Fits — unwrap and revert so the container keeps normal ellipsis behavior.
    el.classList.remove("marquee");
    while (inner.firstChild) el.insertBefore(inner.firstChild, inner);
    inner.remove();
    return;
  }

  // ~40 px/sec traversal feels legible; add 3s of pause at each end.
  const traverseMs = Math.max(1500, (overshoot / 40) * 1000);
  el.style.setProperty("--marquee-distance", `${-(overshoot + 8)}px`);
  el.style.setProperty("--marquee-duration", `${((traverseMs * 2 + 3000) / 1000).toFixed(1)}s`);
  el.dataset.marquee = "on";
}

// Auto-scroll the mover / streak strip when the cards don't fit in one row.
// Cards flex-grow to fill when there's room; when they overflow we duplicate
// the whole set inside the track and the CSS animation slides 0 → -50%, so
// the second copy takes over seamlessly as the first scrolls off.
const GAINS_SCROLL_SLACK = 4;
const GAINS_SCROLL_PX_PER_SEC = 70;

function refreshGainsCarousel(strip) {
  const track = strip?.querySelector(".gains-track");
  if (!track) {
    strip?.classList.remove("overflowing");
    return;
  }
  // Reset from any prior overflowing state so the measurement is clean.
  strip.classList.remove("overflowing");
  track.style.removeProperty("--gains-duration");
  track.style.removeProperty("--gains-distance");
  track
    .querySelectorAll(":scope > [data-dup='1']")
    .forEach((clone) => clone.remove());

  const overshoot = track.scrollWidth - strip.clientWidth;
  if (overshoot <= GAINS_SCROLL_SLACK) return;

  const originals = [...track.children];
  for (const card of originals) {
    const clone = card.cloneNode(true);
    clone.setAttribute("data-dup", "1");
    clone.setAttribute("aria-hidden", "true");
    track.appendChild(clone);
  }
  strip.classList.add("overflowing");
  const halfContent = track.scrollWidth / 2;
  const seconds = Math.max(10, Math.round(halfContent / GAINS_SCROLL_PX_PER_SEC));
  track.style.setProperty("--gains-duration", `${seconds}s`);
  // Explicit pixel distance so the animation shifts by exactly one full set
  // of original cards; the duplicated set slides into their place seamlessly.
  track.style.setProperty("--gains-distance", `-${halfContent}px`);
}

export function applyGainsCarousels(root = document) {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      // querySelectorAll searches descendants only, so a strip passed as
      // root would be skipped — include it explicitly when it matches.
      const strips = new Set(root.querySelectorAll?.(".gains-strip") ?? []);
      if (root.classList?.contains?.("gains-strip")) strips.add(root);
      strips.forEach(refreshGainsCarousel);
    });
  });
}

export function applyMarquees(root = document) {
  // Double-rAF: iOS Safari occasionally runs the first rAF before layout is
  // fully painted. The second guarantees measurement against final geometry.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      for (const el of root.querySelectorAll(MARQUEE_TARGETS)) {
        // Skip elements the browser hasn't laid out yet (offsetParent null,
        // width 0). They'll get another pass on the next render or resize.
        if (el.clientWidth === 0) continue;
        attachMarquee(el);
      }
    });
  });
}

if (typeof window !== "undefined") {
  let scheduled = false;
  window.addEventListener("resize", () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      applyMarquees();
      applyGainsCarousels();
    });
  });

  // Chakra Petch loads from Google Fonts async. Text measured before the swap
  // uses fallback metrics, so a name that "just fits" in the fallback can be
  // wider after the display font arrives — re-run once fonts settle.
  if (typeof document !== "undefined" && document.fonts?.ready) {
    document.fonts.ready
      .then(() => {
        applyMarquees();
        applyGainsCarousels();
      })
      .catch(() => {});
  }
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

export function renderRecentGains(playlist, players, historyStore) {
  const host = $("recentGains");
  const strip = $("gainsStrip");
  const windowLabel = $("gainsWindow");
  const heading = $("gainsHeading");
  if (!host || !strip) return;

  // Wins tab: no top strip. Streak badges live inline on each row now
  // (see the row-streak-chip in playerRow), so a separate top carousel
  // would just duplicate the same info.
  if (playlist === "wins") {
    host.hidden = true;
    strip.replaceChildren();
    return;
  }

  host.hidden = false;
  if (isRankedPlaylist(playlist)) {
    renderMoverStrip({ playlist, players, historyStore, host, strip, windowLabel, heading });
  }
}

// Build a chip label for the standings row. A "published" delta comes from
// ATLAS's session baseline (always trustworthy, no minimum span check), while
// an "observed" delta reuses the existing momentum-chip logic that requires
// a 10-min minimum window to avoid noisy short readings.
function chipFromDelta(delta, historyStore, playlist, playerId) {
  if (delta.source === "observed") {
    return momentumChip(historyStore.gainFor(playlist, playerId));
  }
  if (delta.source !== "published" || delta.gained == null) {
    return { className: "momentum warming", label: "warming up", title: "Building a session baseline" };
  }
  const rounded = Math.round(delta.gained);
  const magnitude = Math.abs(rounded).toLocaleString();
  if (rounded > 0) {
    return {
      className: "momentum hot",
      label: `🔥 +${magnitude} session`,
      title: `Gained ${magnitude} MMR this session`,
    };
  }
  if (rounded < 0) {
    return {
      className: "momentum cold",
      label: `❄ -${magnitude} session`,
      title: `Lost ${magnitude} MMR this session`,
    };
  }
  return { className: "momentum flat", label: "— flat session", title: "No change this session" };
}

// Match ATLAS's own idle threshold (rg_hud.user.js `SESSION_IDLE_MS`) so the
// site and HUD agree on when a play session is over.
const STALE_SESSION_MS = 2 * 60 * 60_000;

// Pre-16.7 docs don't publish sessionLastSeen; without it we can't tell if the
// session is stale, so treat unknown as fresh and preserve backwards compat.
function sessionIsStale(player, now) {
  const lastSeen = Number.isFinite(player?.sessionLastSeen) ? player.sessionLastSeen : null;
  if (lastSeen == null) return false;
  return now - lastSeen > STALE_SESSION_MS;
}

// Prefer the ATLAS-published session delta (immediate, session-scoped)
// and fall back to the observation-based rolling window when the doc
// predates ATLAS 16.6 or hasn't been re-synced yet. A published delta is
// dropped if the session went stale (HUD hasn't written in >2h), so a
// midnight viewer doesn't see a 6-hour-old +50 as if it were current.
export function effectiveMmrDelta(player, playlist, historyStore, now = Date.now()) {
  const published = Number.isFinite(player?.sessionMmrDelta) ? Math.trunc(player.sessionMmrDelta) : null;
  const startedAt = Number.isFinite(player?.sessionStartedAt) ? player.sessionStartedAt : null;
  const lastSeen = Number.isFinite(player?.sessionLastSeen) ? player.sessionLastSeen : null;
  if (published != null && startedAt && !sessionIsStale(player, now)) {
    // Use actual playtime (baseline → last write) for the label, not wall-clock,
    // so the strip doesn't count seconds while nobody's playing.
    const spanMs = lastSeen != null
      ? Math.max(0, lastSeen - startedAt)
      : Math.max(0, now - startedAt);
    return { gained: published, spanMs, source: "published" };
  }
  const observed = historyStore?.gainFor?.(playlist, player.id);
  if (observed?.samples >= 2 && observed.gained != null) {
    return { gained: observed.gained, spanMs: observed.spanMs, source: "observed" };
  }
  return { gained: null, spanMs: 0, source: "none" };
}

function renderMoverStrip({ playlist, players, historyStore, host, strip, windowLabel, heading }) {
  host.setAttribute("aria-label", "Recent MMR changes");
  if (heading) heading.textContent = "Recent MMR changes";

  const now = Date.now();
  const movers = [];
  for (const player of players ?? []) {
    const { gained, spanMs, source } = effectiveMmrDelta(player, playlist, historyStore, now);
    if (gained == null) continue;
    if (Math.abs(gained) < 1) continue;
    // For observation-based deltas we still require the 10-min minimum so a
    // 1-minute reading doesn't sneak in; published deltas are always trusted.
    if (source === "observed" && spanMs < 10 * 60_000) continue;
    movers.push({ player, gained, spanMs, source });
  }
  movers.sort((a, b) => Math.abs(b.gained) - Math.abs(a.gained));
  const trimmed = movers.slice(0, 8);

  if (windowLabel) {
    if (trimmed.length) {
      // Label follows the widest-span mover's source: a published (session)
      // delta uses session wording, an observed rolling-window delta uses the
      // "last N min / last hour" wording. Mixing sources is fine; the widest
      // span drives what the whole strip is really showing.
      const widest = trimmed.reduce((a, b) => (b.spanMs > a.spanMs ? b : a));
      windowLabel.textContent = widest.source === "published"
        ? "session"
        : formatWindow(widest.spanMs);
    } else {
      windowLabel.textContent = "session";
    }
  }

  strip.replaceChildren();
  if (!trimmed.length) {
    strip.append(
      node("div", {
        className: "gains-empty",
        text: "No MMR movement this session yet. Movers appear as players play.",
      }),
    );
    return;
  }

  const track = node("div", { className: "gains-track" });
  for (const { player, gained } of trimmed) {
    const card = node("div", { className: gained < 0 ? "gain-card neg" : "gain-card" });
    card.append(flagCell(player, "flag"));
    const body = node("div", { className: "body" });
    body.append(node("div", { className: "n", text: player.name }));
    if (typeof player.mmr === "number") {
      body.append(node("div", { className: "r", text: `${player.mmr.toLocaleString()} MMR` }));
    }
    card.append(body);
    const sign = gained > 0 ? "+" : gained < 0 ? "-" : "";
    card.append(node("div", { className: "d", text: `${sign}${Math.abs(Math.round(gained)).toLocaleString()}` }));
    track.append(card);
  }
  strip.append(track);
  applyMarquees(strip);
  applyGainsCarousels(strip);
}

// Prefer the streak ATLAS publishes on the wins doc (immediate, authoritative)
// and fall back to whatever we've observed since the tab opened. A published
// streak is ignored when the session is stale so a 3h-old "🔥 x6" doesn't
// keep parading long after the player logged off.
export function effectiveStreak(player, historyStore, now = Date.now()) {
  const published = Number.isFinite(player?.currentStreak) ? Math.trunc(player.currentStreak) : null;
  if (published != null && published !== 0 && !sessionIsStale(player, now)) {
    return { streak: published, source: "published" };
  }
  const observed = historyStore?.streakFor?.(player.id);
  if (observed?.confident && observed.streak !== 0) {
    return { streak: observed.streak, source: "observed" };
  }
  return { streak: 0, source: "none" };
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

    // Empty cell still renders so grid columns line up across every row.
    const streakCell = node("div", { className: "p-streak" });
    const { streak } = effectiveStreak(player, historyStore);
    if (streak >= 3) {
      const chip = node("span", { className: "streak-chip" });
      chip.title = `${streak}-win streak`;
      chip.append(node("span", { className: "streak-flame", text: "🔥" }));
      chip.append(node("span", { className: "streak-count", text: `x${streak}` }));
      streakCell.append(chip);
    }
    row.append(streakCell);

    if (admin) row.append(adminActions(player, onEdit, onDelete));
  } else {
    row.append(node("div", { className: "p-score", text: player.mmr.toLocaleString() }));

    const momentumWrap = node("div", { className: "momentum-cell" });
    const delta = effectiveMmrDelta(player, playlist, historyStore);
    const chip = chipFromDelta(delta, historyStore, playlist, player.id);
    if (chip.className === "momentum hot" || chip.className === "momentum cold") {
      const chipEl = node("span", { className: chip.className, text: chip.label });
      chipEl.title = chip.title;
      momentumWrap.append(chipEl);
    }
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
      node("span", { text: "Streak" }),
    );
    if (admin) head.append(node("span", { text: "Actions" }));
  } else {
    head.append(
      node("span", { text: "Rank" }),
      node("span", { text: "Player" }),
      node("span", { className: "num", text: "MMR" }),
      node("span", { className: "num", text: "Recent" }),
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
  applyMarquees(body);
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
  // Country autocomplete via native <datalist>. Admins must pick a real
  // country so the picker keeps its meaning and can dedupe by country.
  const countryInput = document.createElement("input");
  countryInput.type = "text";
  countryInput.placeholder = "Country (e.g. Brazil)";
  countryInput.autocomplete = "off";
  countryInput.className = "flag-custom-country";
  countryInput.setAttribute("list", "rgFlagCountries");
  if (!document.getElementById("rgFlagCountries")) {
    const dl = document.createElement("datalist");
    dl.id = "rgFlagCountries";
    for (const c of COUNTRIES) {
      const opt = document.createElement("option");
      opt.value = c;
      dl.append(opt);
    }
    document.body.appendChild(dl);
  }
  const customAdd = document.createElement("button");
  customAdd.type = "button";
  customAdd.textContent = "Add";
  customAdd.className = "flag-custom-add";
  const customCancel = document.createElement("button");
  customCancel.type = "button";
  customCancel.textContent = "Cancel";
  customCancel.className = "flag-custom-cancel";
  const customError = document.createElement("div");
  customError.className = "flag-custom-error";
  customError.hidden = true;
  customRow.append(customInput, countryInput, customAdd, customCancel, customError);

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
      // Every actual flag entry gets an inline remove button. The "— No flag —"
      // sentinel (empty url) doesn't. Clicking × removes the URL from the
      // directory without changing whichever player is currently selected —
      // it just stops offering that URL as a picker suggestion.
      if (entry.url) {
        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "flag-option-remove";
        removeBtn.textContent = "×";
        removeBtn.setAttribute("aria-label", `Remove ${entry.label}`);
        removeBtn.title = `Remove ${entry.label} from the picker`;
        removeBtn.addEventListener("click", (event) => {
          event.stopPropagation();
          directory.remove?.(entry.url);
        });
        item.append(removeBtn);
      }
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

  function showCustomError(message) {
    customError.textContent = message;
    customError.hidden = false;
  }

  function clearCustomError() {
    customError.hidden = true;
  }

  function commitCustomUrl() {
    clearCustomError();
    const raw = customInput.value.trim();
    const country = countryInput.value.trim();
    if (!raw) {
      customInput.focus();
      showCustomError("Enter a flag URL.");
      return;
    }
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      showCustomError("Enter a valid URL.");
      return;
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      showCustomError("Flag URL must use http or https.");
      return;
    }
    const canonical = canonicalCountry(country);
    if (!canonical) {
      showCustomError("Pick a real country from the list.");
      countryInput.focus();
      return;
    }
    const url = parsed.href;
    const result = directory.addWithCountry?.(url, canonical)
      ?? { ok: directory.add(url), error: null };
    if (!result.ok) {
      showCustomError(result.error || "Couldn't add that flag.");
      return;
    }
    onNewFlag?.(url);
    customRow.hidden = true;
    customInput.value = "";
    countryInput.value = "";
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
    countryInput.value = "";
    clearCustomError();
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
  countryInput.addEventListener("keydown", (event) => {
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
