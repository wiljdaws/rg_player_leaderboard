import { PLAYLIST_LABELS, PLAYLISTS } from "./config.js";
import { COUNTRIES, canonicalCountry, labelForFlagUrl } from "./flag-directory.js";
import { playerGlow, sanitizePublicImageUrl, winRate } from "./model.js";
import { momentumChip } from "./momentum.js";

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
const MARQUEE_TARGETS = ".p-name";
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
    });
  });

  // Chakra Petch loads from Google Fonts async. Text measured before the swap
  // uses fallback metrics, so a name that "just fits" in the fallback can be
  // wider after the display font arrives — re-run once fonts settle.
  if (typeof document !== "undefined" && document.fonts?.ready) {
    document.fonts.ready.then(() => applyMarquees()).catch(() => {});
  }
}

function safeImage(url, className, alt = "", onFail) {
  const safe = sanitizePublicImageUrl(url);
  if (!safe) {
    onFail?.();
    return node("span", { className });
  }
  const image = node("img", { className });
  image.src = safe;
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

// Build a highlighted suggestion label as an array of Text + <mark> DOM
// nodes so player-supplied names — which may contain `<`, `>`, quotes, or
// full HTML fragments — can never reach the DOM as parsed HTML. Callers
// append the returned nodes to their <li> instead of assigning innerHTML.
//
// Regression this guards against: names like `a<img src=x onerror=1>`
// used to flow into innerHTML through the tournament quick-add autocomplete
// so the browser parsed the `<img>` tag and fired onerror → stored XSS
// against every admin viewing the suggestion list.
export function highlightSuggestion(name, needle) {
  const nodes = [];
  const safeName = String(name || "");
  const rawNeedle = String(needle || "");
  if (!rawNeedle) {
    nodes.push(document.createTextNode(safeName));
    return nodes;
  }
  const idx = safeName.toLowerCase().indexOf(rawNeedle.toLowerCase());
  if (idx < 0) {
    nodes.push(document.createTextNode(safeName));
    return nodes;
  }
  if (idx > 0) nodes.push(document.createTextNode(safeName.slice(0, idx)));
  const mark = document.createElement("mark");
  mark.textContent = safeName.slice(idx, idx + rawNeedle.length);
  nodes.push(mark);
  const tailStart = idx + rawNeedle.length;
  if (tailStart < safeName.length) {
    nodes.push(document.createTextNode(safeName.slice(tailStart)));
  }
  return nodes;
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

// When a flag URL is missing or 404s the container shows a "?" so the space
// stays the same size instead of collapsing. Reads cleaner than the
// player's initial (which was easy to mistake for a real avatar letter).
function flagCell(player, className = "p-flag", { hideMissing = false } = {}) {
  const wrap = node("div", { className });
  const fallback = () => {
    // Tournament rows opt out of the "?" placeholder since a lot of manual
    // entries won't have a flag and the ? just adds visual noise.
    if (hideMissing) {
      wrap.classList.add("no-flag", "flag-empty-slot");
      return;
    }
    wrap.textContent = "?";
    wrap.classList.add("no-flag");
  };
  if (player?.flag) {
    wrap.append(safeImage(player.flag, "", "", fallback));
  } else {
    fallback();
  }
  return wrap;
}

function rankClass(rank) {
  if (rank === 1) return "r1";
  if (rank === 2) return "r2";
  if (rank === 3) return "r3";
  if (rank >= 4 && rank <= 10) return "r-top10";
  return "r-tail";
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
  // Prefer the JSON's rank field (which reflects the true worldwide position
  // including filtered rows) over the array position, so the site matches
  // what the HUD's Firestore count query returns.
  const rank = Number.isFinite(player?.rank) ? player.rank : index + 1;
  row.dataset.rank = rank;
  if (rank >= 4 && rank <= 10) row.classList.add("top10");

  row.append(node("div", { className: `rank ${rankClass(rank)}`, text: `#${rank}` }));

  const ident = node("div", { className: "p-ident" });
  // Flag carries the activity dot and "Last played" hover tooltip, but only
  // for HUD-synced tabs. Tournament rows are hand-entered, no session data,
  // so the dot and tooltip would just be noise.
  const flag = flagCell(player, "p-flag", { hideMissing: playlist === "tournament" });
  if (playlist !== "tournament") {
    flag.classList.add(activityStatus(player));
    attachTooltip(flag, formatLastPlayed(player));
  } else {
    // Hides the .p-flag::after grey dot (the default state before any
    // status-* class kicks in).
    flag.classList.add("status-none");
  }
  ident.append(flag);
  const nameWrap = node("div", { className: "p-name-wrap" });

  // Non-admin viewers see the name as a plain label — clicks belong to
  // admins so they can open the full details modal (version, source,
  // last updated). Everyone else sees just the styled name.
  const glow = playerGlow(rank);
  let nameEl;
  if (admin) {
    nameEl = node("button", { className: "p-name", type: "button" });
    nameEl.setAttribute("aria-label", `View details for ${player.name}`);
    nameEl.addEventListener("click", () => onInspect(player));
  } else {
    nameEl = node("span", { className: "p-name p-name-static" });
  }
  nameEl.textContent = player.name;
  if (glow) nameEl.style.textShadow = glow;
  nameWrap.append(nameEl);

  if (player.icons?.length) {
    const icons = node("div", { className: "p-icons" });
    for (const url of player.icons) {
      icons.append(safeImage(url, "p-icon", ""));
    }
    nameWrap.append(icons);
  }

  ident.append(nameWrap);
  row.append(ident);

  // Spacer cell occupies the 1fr slack column in .player-row's grid,
  // keeping the numeric columns pinned near the right edge instead of
  // drifting rightward on wide screens. Header row appends a matching
  // .col-spacer span so column indexes line up.
  row.append(node("div", { className: "col-spacer" }));

  if (playlist === "tournament") {
    row.append(node("div", { className: "p-score", text: player.score.toLocaleString() }));
    row.append(node("div", { className: "p-score small", text: player.matches.toLocaleString() }));
    if (admin) row.append(adminActions(player, onEdit, onDelete));
  } else if (playlist === "wins") {
    row.append(node("div", { className: "p-score", text: player.wins.toLocaleString() }));
    row.append(node("div", { className: "p-score small", text: player.matches.toLocaleString() }));
    row.append(node("div", { className: "p-winrate", text: `${winRate(player)}%` }));
    row.append(streakCell(player, historyStore));
    if (admin) row.append(adminActions(player, onEdit, onDelete));
  } else {
    row.append(node("div", { className: "p-score", text: player.mmr.toLocaleString() }));
    row.append(streakCell(player, historyStore));

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

// Empty cell still renders so grid columns line up across every row.
function streakCell(player, historyStore) {
  const cell = node("div", { className: "p-streak" });
  const { streak } = effectiveStreak(player, historyStore);
  if (streak >= 3) {
    const chip = node("span", { className: "streak-chip" });
    chip.title = `${streak}-win streak`;
    chip.append(node("span", { className: "streak-flame", text: "🔥" }));
    chip.append(node("span", { className: "streak-count", text: `x${streak}` }));
    cell.append(chip);
  }
  return cell;
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
  head.classList.toggle("admin", !!admin);
  head.replaceChildren();
  // Empty span between Player and the numeric columns is a spacer that
  // occupies the 1fr slack column in the grid.
  if (playlist === "tournament") {
    head.append(
      node("span", { text: "Rank" }),
      node("span", { text: "Player" }),
      node("span", { className: "col-spacer" }),
      node("span", { className: "num", text: "Score" }),
      node("span", { className: "num", text: "Matches" }),
    );
    if (admin) head.append(node("span", { text: "Actions" }));
  } else if (playlist === "wins") {
    head.append(
      node("span", { text: "Rank" }),
      node("span", { text: "Player" }),
      node("span", { className: "col-spacer" }),
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
      node("span", { className: "col-spacer" }),
      node("span", { className: "num", text: "MMR" }),
      node("span", { text: "Streak" }),
      node("span", { text: "Recent" }),
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
  host.append(node("h2", { text: "Trophies" }));

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
    chip.append(safeImage(item.icon, "", item.label));
    chip.append(node("span", { className: "label", text: item.label }));
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

// Format in the viewer's local zone with an explicit zone tag so people
// reading from different regions know what "3:34 AM" is anchored to.
// dateStyle+timeZoneName together throws on older engines, so spell out fields.
const UPDATED_AT_FORMAT = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});
function formatUpdatedAt(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "Not recorded";
  return UPDATED_AT_FORMAT.format(date);
}

// Human-friendly "X ago" — used for the hover tooltip on player names.
// Prefers sessionLastSeen (HUD activity) because it reflects when the player
// last actually did something in-game; falls back to lastWriteAt for docs
// that predate session tracking.
export function lastActivityMs(player) {
  const lastSeen = Number.isFinite(player?.sessionLastSeen) ? player.sessionLastSeen : null;
  const updated = player?.provenance?.updatedAt instanceof Date
    ? player.provenance.updatedAt.getTime()
    : null;
  if (lastSeen != null && updated != null) return Math.max(lastSeen, updated);
  return lastSeen ?? updated;
}
export function formatAgo(timestamp, now = Date.now()) {
  if (!Number.isFinite(timestamp)) return null;
  const diff = Math.max(0, now - timestamp);
  const seconds = Math.round(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.round(months / 12);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}
function formatLastPlayed(player) {
  const ts = lastActivityMs(player);
  const ago = formatAgo(ts);
  return ago ? `Last played: ${ago}` : "Last played: unknown";
}

// Activity dot on the flag corner. Bucket by how recently the HUD wrote —
// green pulsing = still playing, gold = last hour, orange = today, grey
// = older/offline, none = never seen. Same idea as the clan site's .ava
// freshness dot so the visual language stays consistent.
const STATUS_HOT_MS = 10 * 60_000;
const STATUS_WARM_MS = 60 * 60_000;
const STATUS_RECENT_MS = 24 * 60 * 60_000;
function activityStatus(player, now = Date.now()) {
  const ts = lastActivityMs(player);
  if (!Number.isFinite(ts)) return "status-none";
  const age = now - ts;
  if (age < 0) return "status-hot";
  if (age < STATUS_HOT_MS) return "status-hot";
  if (age < STATUS_WARM_MS) return "status-warm";
  if (age < STATUS_RECENT_MS) return "status-recent";
  return "status-cold";
}

// Single shared floating tooltip so multiple .p-name hovers don't spawn
// duplicate DOM. Portaled to <body> so the row's overflow:hidden clip
// (which contains the shimmer background) can't chop off the tooltip.
let sharedTooltip = null;
function ensureTooltip() {
  if (sharedTooltip) return sharedTooltip;
  sharedTooltip = document.createElement("div");
  sharedTooltip.className = "rg-tooltip";
  sharedTooltip.setAttribute("role", "tooltip");
  document.body.appendChild(sharedTooltip);
  return sharedTooltip;
}
function positionTooltip(target) {
  const el = ensureTooltip();
  const targetRect = target.getBoundingClientRect();
  // Measure after we've made it visible-but-transparent so getBoundingClientRect
  // reads the correct pill width. .visible flips opacity; layout is stable.
  el.classList.add("measuring");
  const tipRect = el.getBoundingClientRect();
  el.classList.remove("measuring");
  const scrollY = window.scrollY || document.documentElement.scrollTop;
  const scrollX = window.scrollX || document.documentElement.scrollLeft;
  const above = targetRect.top - tipRect.height - 10;
  const useAbove = above > 8;
  el.dataset.pos = useAbove ? "above" : "below";
  const top = useAbove
    ? targetRect.top + scrollY - tipRect.height - 10
    : targetRect.bottom + scrollY + 10;
  const rawLeft = targetRect.left + scrollX + Math.min(24, targetRect.width / 2);
  const maxLeft = document.documentElement.clientWidth - tipRect.width - 8 + scrollX;
  const left = Math.max(8 + scrollX, Math.min(rawLeft, maxLeft));
  el.style.top = `${top}px`;
  el.style.left = `${left}px`;
}
function attachTooltip(el, text) {
  const label = String(text || "").trim();
  if (!label) return;
  el.addEventListener("mouseenter", () => {
    const tip = ensureTooltip();
    tip.textContent = label;
    tip.classList.add("visible");
    positionTooltip(el);
  });
  el.addEventListener("mouseleave", () => {
    sharedTooltip?.classList.remove("visible");
  });
}

// Admin diagnostic: group everyone by HUD @version so the admin can eyeball
// who's stuck on old builds and needs a ping. Rows come from the wins
// collection because every HUD-synced player writes a wins doc, so it's the
// canonical "seen at least once" roster. Unknown/legacy rows (no versionNum
// stamped) surface first so they can't hide at the bottom.
export function renderVersionBreakdown(host, rows) {
  if (!host) return;
  host.replaceChildren();
  const active = (rows || []).filter((p) => p?.name);
  if (!active.length) {
    host.append(node("p", { className: "version-empty", text: "No players in the roster yet." }));
    return;
  }

  const groups = new Map();
  for (const player of active) {
    const raw = player.provenance?.version;
    const num = Number.parseFloat(raw);
    const key = Number.isFinite(num) ? num : "unknown";
    if (!groups.has(key)) groups.set(key, { label: Number.isFinite(num) ? `v${raw}` : "Unknown / legacy", players: [] });
    groups.get(key).players.push(player);
  }

  const sortedKeys = [...groups.keys()].sort((a, b) => {
    if (a === "unknown") return -1;
    if (b === "unknown") return 1;
    return a - b;
  });

  for (const key of sortedKeys) {
    const group = groups.get(key);
    const wrap = node("div", { className: "version-group" });
    const header = node("div", { className: "version-header" });
    header.append(
      node("span", { className: "version-tag", text: group.label }),
      node("span", { className: "version-count", text: `${group.players.length} ${group.players.length === 1 ? "player" : "players"}` }),
    );
    wrap.append(header);
    group.players.sort((a, b) => (lastActivityMs(b) ?? 0) - (lastActivityMs(a) ?? 0));
    const list = node("ul", { className: "version-list" });
    for (const player of group.players) {
      const item = node("li", { className: "version-row" });
      item.append(node("span", { className: "v-name", text: player.name }));
      const ago = formatAgo(lastActivityMs(player)) || "never";
      item.append(node("span", { className: "v-last", text: ago }));
      list.append(item);
    }
    wrap.append(list);
    host.append(wrap);
  }
}

const RANKED_PLAYLISTS_FOR_CARD = ["1v1", "2v2", "3v3"];

export function renderPlayerDialog(dialog, player, rank, options = {}) {
  const panel = node("div", { className: "dialog-panel" });
  const heading = node("h2", { className: "dialog-title", text: player.name });
  heading.id = "playerDialogTitle";
  dialog.setAttribute("aria-labelledby", heading.id);

  const isRanked = RANKED_PLAYLISTS_FOR_CARD.includes(player.playlist);
  if (!isRanked) {
    renderLegacyPlayerDialog(dialog, panel, heading, player, rank);
    return;
  }

  const summary = node("p", { className: "dialog-summary" });
  summary.append(
    document.createTextNode("Currently viewing · "),
    node("span", { className: "dialog-summary-current",
      text: `${PLAYLIST_LABELS[player.playlist]} · Rank #${rank}` }),
  );

  const chipGrid = node("div", { className: "pc-chips" });
  const chipByPlaylist = new Map();
  for (const pl of RANKED_PLAYLISTS_FOR_CARD) {
    const chip = buildRankedChip(pl, pl === player.playlist);
    if (pl === player.playlist) {
      setChipData(chip, { rank, mmr: player.mmr });
    }
    chipByPlaylist.set(pl, chip);
    chipGrid.append(chip);
  }

  const total = node("div", { className: "pc-total" });
  const totalLabel = node("span", { className: "pc-total-label", text: "Total MMR" });
  const totalValue = node("span", { className: "pc-total-value", text: "—" });
  total.append(totalLabel, totalValue);

  const source = node("div", { className: "pc-source" });
  source.append(
    node("span", { className: "pc-source-dot" }),
    node("span", { className: "pc-source-label", text: "Source" }),
    node("span", { className: "pc-source-value", text: player.provenance.kind }),
  );

  const close = node("button", { className: "admin-primary", text: "Close", type: "button" });
  close.addEventListener("click", () => dialog.close());

  const actions = node("div", { className: "pc-actions" });
  actions.append(close);

  panel.append(heading, summary, chipGrid, total, source, actions);
  dialog.replaceChildren(panel);
  if (!dialog.open) {
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }
  close.focus();

  updateTotal(totalValue, chipByPlaylist, player.mmr, player.playlist);

  const lookup = typeof options.otherPlaylistLookup === "function" ? options.otherPlaylistLookup : null;
  const uid = player.sourceUserId;
  if (lookup && uid) {
    for (const pl of RANKED_PLAYLISTS_FOR_CARD) {
      if (pl === player.playlist) continue;
      const chip = chipByPlaylist.get(pl);
      Promise.resolve(lookup(uid, pl)).then((row) => {
        if (dialog.dataset.playerId !== player.id) return;
        if (row && Number.isFinite(row.mmr)) {
          setChipData(chip, { rank: row.rank, mmr: row.mmr });
        } else {
          setChipData(chip, { rank: null, mmr: null });
        }
        updateTotal(totalValue, chipByPlaylist, player.mmr, player.playlist);
      }).catch(() => {
        if (dialog.dataset.playerId !== player.id) return;
        setChipData(chip, { rank: null, mmr: null });
        updateTotal(totalValue, chipByPlaylist, player.mmr, player.playlist);
      });
    }
  } else {
    for (const pl of RANKED_PLAYLISTS_FOR_CARD) {
      if (pl === player.playlist) continue;
      setChipData(chipByPlaylist.get(pl), { rank: null, mmr: null });
    }
  }
}

// Wins + tournament rows keep the old detail-list layout — those aren't
// ranked-MMR playlists so the chip grid doesn't apply.
function renderLegacyPlayerDialog(dialog, panel, heading, player, rank) {
  const summary = node("p", {
    className: "dialog-summary",
    text: `${PLAYLIST_LABELS[player.playlist]} · Rank #${rank}`,
  });
  const details = node("dl", { className: "detail-list" });
  const scoreLabel = player.playlist === "wins" ? "Record"
    : player.playlist === "tournament" ? "Score"
    : "MMR";
  const scoreValue = player.playlist === "wins"
    ? `${player.wins} wins in ${player.matches} matches`
    : player.playlist === "tournament"
      ? `${player.score} in ${player.matches} matches`
      : String(player.mmr);
  details.append(
    detailRow(scoreLabel, scoreValue),
    detailRow("Source", player.provenance.kind),
    detailRow("ATLAS version", player.provenance.version || "Not recorded"),
    detailRow("Last updated", formatUpdatedAt(player.provenance.updatedAt)),
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

function buildRankedChip(playlist, isCurrent) {
  const chip = node("div", { className: `pc-chip${isCurrent ? " pc-chip-current" : ""}` });
  chip.dataset.playlist = playlist;
  const mode = node("div", { className: "pc-chip-mode", text: playlist });
  const rank = node("div", { className: "pc-chip-rank", text: "—" });
  const mmr = node("div", { className: "pc-chip-mmr", text: "—" });
  chip.append(mode, rank, mmr);
  return chip;
}

function setChipData(chip, { rank, mmr }) {
  const rankEl = chip.querySelector(".pc-chip-rank");
  const mmrEl = chip.querySelector(".pc-chip-mmr");
  if (Number.isFinite(rank) && rank > 0) {
    rankEl.textContent = `#${rank}`;
    chip.dataset.rank = rank <= 3 ? "podium" : rank <= 10 ? "top10" : "ranked";
  } else {
    rankEl.textContent = "—";
    chip.dataset.rank = "none";
  }
  mmrEl.textContent = Number.isFinite(mmr)
    ? Number(mmr).toLocaleString("en-US")
    : "—";
  if (Number.isFinite(mmr)) chip.dataset.mmr = String(mmr);
}

function updateTotal(totalValueEl, chipByPlaylist, ownMmr, ownPlaylist) {
  let sum = 0;
  let hasAll = true;
  for (const [pl, chip] of chipByPlaylist) {
    if (pl === ownPlaylist) {
      sum += Number(ownMmr) || 0;
      continue;
    }
    const raw = chip.dataset.mmr;
    if (raw == null || raw === "") { hasAll = false; continue; }
    const n = Number(raw);
    if (Number.isFinite(n)) sum += n;
  }
  totalValueEl.textContent = sum.toLocaleString("en-US") + (hasAll ? "" : " …");
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
  // Hidden url inputs still fail native form submit. Keep this disabled
  // until the admin actually opens "+ Add new flag URL…".
  customInput.autocomplete = "off";
  customInput.className = "flag-custom-input";
  customInput.disabled = true;
  // Country autocomplete via native <datalist>. Admins must pick a real
  // country so the picker keeps its meaning and can dedupe by country.
  const countryInput = document.createElement("input");
  countryInput.type = "text";
  countryInput.placeholder = "Country (e.g. Brazil)";
  countryInput.autocomplete = "off";
  countryInput.className = "flag-custom-country";
  countryInput.disabled = true;
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
    const safe = sanitizePublicImageUrl(url);
    if (!safe) {
      wrap.classList.add("empty");
      wrap.textContent = "—";
      return wrap;
    }
    const img = document.createElement("img");
    img.src = safe;
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
      // Keep the URL off data-* attributes. A leftover country PNG is a
      // multi-KB data URI; stuffing that into dataset can truncate, and
      // Enter-to-select would then save a broken flag.
      item._flagUrl = entry.url;
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

  function setCustomRowOpen(open) {
    customRow.hidden = !open;
    customInput.disabled = !open;
    countryInput.disabled = !open;
    if (!open) {
      customInput.value = "";
      countryInput.value = "";
    }
  }

  function openMenu() {
    menu.hidden = false;
    setCustomRowOpen(false);
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
    setCustomRowOpen(false);
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
      if (focused) choose(focused._flagUrl ?? "");
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeMenu();
      trigger.focus();
    }
  });

  addBtn.addEventListener("click", () => {
    menu.hidden = true;
    setCustomRowOpen(true);
    clearCustomError();
    customInput.focus();
  });

  customAdd.addEventListener("click", commitCustomUrl);
  customCancel.addEventListener("click", () => {
    setCustomRowOpen(false);
    openMenu();
  });
  customInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitCustomUrl();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setCustomRowOpen(false);
    }
  });
  countryInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitCustomUrl();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setCustomRowOpen(false);
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
  const kind = status?.kind || "idle";
  if (el) {
    el.dataset.state = kind;
    el.hidden = !status?.message;
    el.replaceChildren();
    if (status?.message) {
      el.append(node("span", { className: "write-status-msg", text: status.message }));
      if (status.hint) {
        el.append(node("span", { className: "write-status-hint", text: status.hint }));
      }
    }
  }
  // Native <dialog> sits on the top layer, so the page toast is hidden
  // while Edit player is open. Mirror errors into the form itself.
  const editError = $("editFormError");
  const editDialog = $("editDialog");
  if (editError && editDialog?.open) {
    const show = kind === "error" && Boolean(status?.message);
    editError.hidden = !show;
    editError.textContent = show ? status.message : "";
  }
}
