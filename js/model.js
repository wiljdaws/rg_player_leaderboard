import { isPlaylist } from "./config.js";
import { canonicalFlagUrl } from "./flag-directory.js";

const MAX_NAME_LENGTH = 80;
const MAX_URL_LENGTH = 2_048;
// Larger cap so a base64-encoded flag PNG (~5-30 KB) is accepted. Legacy
// entries in the leaderboard were saved inline as data URIs; without this
// they were silently stripped and no flag rendered for those players.
const MAX_IMAGE_URL_LENGTH = 200_000;
// Raster-only. SVG data URIs are excluded because they can embed executable
// JavaScript inside <script> or event handlers → XSS if we render them.
const SAFE_DATA_URI = /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/;

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boundedNumber(value, fallback, minimum, maximum) {
  const number = finiteNumber(value);
  return number === null
    ? fallback
    : Math.min(maximum, Math.max(minimum, number));
}

function optionalText(value, maximum = 120) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maximum);
}

export function sanitizeHttpUrl(value) {
  if (typeof value !== "string") return "";
  const candidate = value.trim();
  if (!candidate) return "";
  // Preserve inline raster data URIs (base64 PNG/JPEG/GIF/WebP). The legacy
  // leaderboard saved country flags this way, and stripping them means those
  // players lose their flag on the new site. Length cap is generous but bounded.
  if (SAFE_DATA_URI.test(candidate) && candidate.length <= MAX_IMAGE_URL_LENGTH) {
    return candidate;
  }
  if (candidate.length > MAX_URL_LENGTH) return "";
  try {
    const parsed = new URL(candidate);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    if (parsed.username || parsed.password) return "";
    return parsed.href;
  } catch {
    return "";
  }
}

// Discord / GitHub / jsDelivr file links were used as flags and icons.
// The public board only shows inline country flags and a couple of
// known country-flag hosts. Everything else is dropped.
const PUBLIC_IMAGE_HOSTS = new Set([
  "i.imgur.com",
  "imgur.com",
  "upload.wikimedia.org",
]);

function isBlockedImageHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (!host) return true;
  if (host.endsWith(".discordapp.com") || host.endsWith(".discordapp.net")) return true;
  if (host.endsWith(".githubusercontent.com") || host === "github.com" || host === "www.github.com") return true;
  if (host.endsWith(".jsdelivr.net")) return true;
  return false;
}

export function sanitizePublicImageUrl(value) {
  const safe = sanitizeHttpUrl(canonicalFlagUrl(typeof value === "string" ? value : ""));
  if (!safe) return "";
  if (safe.startsWith("data:")) return safe;
  try {
    const parsed = new URL(safe);
    if (isBlockedImageHost(parsed.hostname)) return "";
    if (!PUBLIC_IMAGE_HOSTS.has(parsed.hostname.toLowerCase())) return "";
    return safe;
  } catch {
    return "";
  }
}

function iconCandidates(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item ?? "").trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function normalizeIcons(value) {
  return iconCandidates(value).slice(0, 12).map(sanitizePublicImageUrl).filter(Boolean);
}

function normalizeUpdatedAt(value) {
  try {
    if (value && typeof value.toDate === "function") {
      const date = value.toDate();
      return Number.isNaN(date.getTime()) ? null : date;
    }
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    if (typeof value === "string" || typeof value === "number") {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? null : date;
    }
  } catch {
    return null;
  }
  return null;
}

export function normalizePlayerDocument(raw, expectedPlaylist) {
  const reasons = [];
  const id = typeof raw?.id === "string" ? raw.id.trim() : "";
  const playlist = raw?.playlist;
  const name = typeof raw?.name === "string" ? raw.name.trim() : "";
  const sourceUserId = typeof raw?.sourceUserId === "string" ? raw.sourceUserId.trim() : "";

  // Soft-deleted rows are hidden from the board. Quarantine (not filter)
  // so the count still shows in the admin's diagnostics, but don't render.
  if (raw?.deleted === true) {
    return { ok: false, quarantine: { id: id || "unknown", reasons: ["soft-deleted"] } };
  }
  if (!id) reasons.push("missing document id");
  if (!isPlaylist(playlist) || playlist !== expectedPlaylist) reasons.push("invalid playlist");
  const maximumNameLength = sourceUserId ? 22 : MAX_NAME_LENGTH;
  if (!name || name.length > maximumNameLength) reasons.push("invalid player name");
  if (sourceUserId && id !== `${sourceUserId}_${expectedPlaylist}`) {
    reasons.push("invalid sourced document id");
  }

  let score = null;
  if (expectedPlaylist === "tournament") {
    const tScore = finiteNumber(raw?.score);
    const matches = finiteNumber(raw?.matches);
    if (tScore === null || tScore < 0) reasons.push("invalid score");
    if (matches === null || matches < 0) reasons.push("invalid matches");
    if (matches !== null && matches > 100_000) reasons.push("matches exceed limit");
    score = { score: tScore, matches };
  } else if (expectedPlaylist === "wins") {
    const wins = finiteNumber(raw?.wins);
    const matches = finiteNumber(raw?.matches);
    if (wins === null || wins < 0) reasons.push("invalid wins");
    if (matches === null || matches < 0) reasons.push("invalid matches");
    if (wins !== null && matches !== null && wins > matches) reasons.push("wins exceed matches");
    if (matches !== null && matches > 100_000) reasons.push("matches exceed limit");
    const streak = finiteNumber(raw?.currentStreak);
    const startedAt = finiteNumber(raw?.sessionStartedAt);
    const lastSeen = finiteNumber(raw?.sessionLastSeen);
    score = {
      wins,
      matches,
      currentStreak: streak == null ? null : Math.max(-999, Math.min(999, Math.trunc(streak))),
      sessionStartedAt: startedAt == null ? null : Math.trunc(startedAt),
      sessionLastSeen: lastSeen == null ? null : Math.trunc(lastSeen),
    };
  } else {
    const mmr = finiteNumber(raw?.mmr);
    if (mmr === null || mmr < 0 || mmr > 35_000) reasons.push("invalid MMR");
    const delta = finiteNumber(raw?.sessionMmrDelta);
    const startedAt = finiteNumber(raw?.sessionStartedAt);
    const lastSeen = finiteNumber(raw?.sessionLastSeen);
    // HUD 17.2+ mirrors the total-streak value on ranked docs too so the
    // streak chip can render on 1v1/2v2/3v3 tabs. Pre-17.2 docs won't have
    // this field; the chip just stays hidden for those rows.
    const streak = finiteNumber(raw?.currentStreak);
    score = {
      mmr,
      sessionMmrDelta: delta == null ? null : Math.trunc(delta),
      sessionStartedAt: startedAt == null ? null : Math.trunc(startedAt),
      sessionLastSeen: lastSeen == null ? null : Math.trunc(lastSeen),
      currentStreak: streak == null ? null : Math.max(-999, Math.min(999, Math.trunc(streak))),
    };
  }

  if (reasons.length) {
    return { ok: false, quarantine: { id: id || "unknown", reasons } };
  }

  const version = optionalText(String(raw.versionNum ?? raw.version ?? ""), 24);

  // Published JSON rows carry an authoritative rank that reflects the true
  // worldwide position (including filtered/blacklisted rows). Preserve it so
  // the render layer can show the same rank the HUD's count query returns.
  const rank = Number.isFinite(raw?.rank) ? Math.trunc(raw.rank) : null;

  return {
    ok: true,
    player: {
      id,
      playlist,
      name,
      // sourceUserId identifies HUD-synced players. Callers use it to fan out
      // cosmetic edits (flag, icons, glow) across a player's sibling playlist
      // docs — an edit made in 1v1 propagates to 2v2/3v3/wins.
      sourceUserId: sourceUserId || null,
      rank,
      ...score,
      flag: sanitizePublicImageUrl(raw.flag),
      icons: normalizeIcons(raw.icons),
      provenance: {
        kind: sourceUserId ? "ATLAS synced" : "Manual admin entry",
        version,
        // HUD writes the timestamp as `lastWriteAt`; legacy admin rows used
        // `updatedAt`. Fall back to either so the "Last updated" readout
        // populates whichever field the writer stamped.
        updatedAt: normalizeUpdatedAt(raw.lastWriteAt) || normalizeUpdatedAt(raw.updatedAt),
      },
    },
  };
}

function bareLeaderboardName(name) {
  return String(name || "")
    .trim()
    .replace(/^\[[^\]]+\]\s*/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function playerWriteAt(player) {
  const date = player?.provenance?.updatedAt;
  if (date instanceof Date && !Number.isNaN(date.getTime())) return date.getTime();
  return 0;
}

function preferPlaylistTwin(current, candidate, playlist) {
  const currentAt = playerWriteAt(current);
  const candidateAt = playerWriteAt(candidate);
  if (candidateAt !== currentAt) return candidateAt > currentAt;
  const field = playlist === "wins" ? "wins" : playlist === "tournament" ? "score" : "mmr";
  return Number(candidate[field]) > Number(current[field]);
}

function absorbPlaylistTwin(winner, loser) {
  const out = { ...winner };
  if (!out.flag && loser.flag) out.flag = loser.flag;
  if ((!out.icons || !out.icons.length) && loser.icons?.length) out.icons = loser.icons;
  const winnerTagged = /^\[[^\]]+\]\s*/.test(String(winner.name || "").trim());
  const loserTagged = /^\[[^\]]+\]\s*/.test(String(loser.name || "").trim());
  if (!winnerTagged && loserTagged
      && bareLeaderboardName(winner.name) === bareLeaderboardName(loser.name)) {
    out.name = loser.name;
  }
  return out;
}

function collapsePlaylistTwins(rows, playlist) {
  const kept = new Map();
  const leftovers = [];
  for (const row of rows) {
    const key = bareLeaderboardName(row.name);
    if (!key) {
      leftovers.push(row);
      continue;
    }
    const existing = kept.get(key);
    if (!existing) {
      kept.set(key, row);
      continue;
    }
    if (preferPlaylistTwin(existing, row, playlist)) {
      kept.set(key, absorbPlaylistTwin(row, existing));
    } else {
      kept.set(key, absorbPlaylistTwin(existing, row));
    }
  }
  return [...kept.values(), ...leftovers];
}

export function normalizePlaylistRows(rawRows, playlist) {
  const rows = [];
  const quarantined = [];
  const seen = new Set();

  for (const raw of Array.isArray(rawRows) ? rawRows : []) {
    const result = normalizePlayerDocument(raw, playlist);
    if (!result.ok) {
      quarantined.push(result.quarantine);
      continue;
    }
    if (seen.has(result.player.id)) {
      quarantined.push({ id: result.player.id, reasons: ["duplicate document id"] });
      continue;
    }
    seen.add(result.player.id);
    rows.push(result.player);
  }

  const collapsed = collapsePlaylistTwins(rows, playlist);
  sortPlaylistRows(collapsed, playlist);
  return { rows: collapsed, quarantined };
}

// Mirror the publisher's sort so live and static ranks agree. Exported
// so the admin path can re-sort locally after an optimistic edit.
export function sortPlaylistRows(rows, playlist) {
  if (!Array.isArray(rows)) return rows;
  const scoreField = playlist === "wins" ? "wins"
    : playlist === "tournament" ? "score"
    : "mmr";
  rows.sort((left, right) => {
    const scoreDelta = right[scoreField] - left[scoreField];
    if (scoreDelta !== 0) return scoreDelta;
    if (playlist === "wins" || playlist === "tournament") {
      const leftMatches = Number(left.matches);
      const rightMatches = Number(right.matches);
      if (Number.isFinite(leftMatches) && Number.isFinite(rightMatches)
          && leftMatches !== rightMatches) {
        return leftMatches - rightMatches;
      }
    }
    const nameCompare = left.name.localeCompare(right.name, undefined, {
      sensitivity: "base",
    });
    if (nameCompare !== 0) return nameCompare;
    return String(left.id).localeCompare(String(right.id));
  });
  return rows;
}

export function normalizeIconKeyRows(rawRows) {
  const rows = [];
  const quarantined = [];
  for (const raw of Array.isArray(rawRows) ? rawRows : []) {
    const id = typeof raw?.id === "string" ? raw.id.trim() : "";
    const label = typeof raw?.label === "string" ? raw.label.trim() : "";
    const icon = sanitizePublicImageUrl(raw?.icon);
    if (!id || !label || label.length > 100 || !icon) {
      quarantined.push(id || "unknown");
      continue;
    }
    rows.push({ id, label, icon });
  }
  return { rows, quarantined };
}

export function filterPlayers(rows, query) {
  const needle = String(query ?? "").trim().toLocaleLowerCase();
  if (!needle) return rows;
  return rows.filter((player) => player.name.toLocaleLowerCase().includes(needle));
}

export function winRate(player) {
  if (!player.matches) return "0.0";
  return ((player.wins / player.matches) * 100).toFixed(1);
}

// Fixed glow on the podium tiers, nothing on the rest.
const TIER_GLOWS = {
  1: "0 0 14px rgba(255,210,74,.55)",   // gold
  2: "0 0 14px rgba(168,85,247,.55)",   // grad-a purple
  3: "0 0 14px rgba(224,154,92,.5)",    // bronze
};
export function playerGlow(rank) {
  return TIER_GLOWS[rank] || "";
}

export function buildPlayerPayload(input, includePlaylist = true) {
  const playlist = input?.playlist;
  const name = typeof input?.name === "string" ? input.name.trim() : "";
  if (!isPlaylist(playlist)) throw new Error("Choose a valid playlist.");
  if (!name || name.length > MAX_NAME_LENGTH) throw new Error("Enter a player name up to 80 characters.");

  const typedIcons = iconCandidates(input.icons).slice(0, 12);
  const iconsList = typedIcons.map(sanitizePublicImageUrl).filter(Boolean);
  if (typedIcons.length && iconsList.length < typedIcons.length) {
    throw new Error("Icon URLs must be https links from i.imgur.com, imgur.com, or upload.wikimedia.org.");
  }
  const icons = iconsList.join(",");
  const rawFlag = typeof input.flag === "string" ? input.flag.trim() : "";
  const flag = sanitizeHttpUrl(canonicalFlagUrl(rawFlag));
  if (rawFlag && !flag) throw new Error("Flag URL must use http or https.");

  // Optional — links a manual row back to a HUD account so future ATLAS
  // writes upsert instead of creating a duplicate, and so admin's
  // "purge all playlists" sweep can reach it.
  const sourceUserId = typeof input?.sourceUserId === "string" ? input.sourceUserId.trim() : "";
  if (sourceUserId && sourceUserId.length > 120) throw new Error("RG user id is too long.");

  const payload = {
    name,
    flag,
    icons,
  };
  if (includePlaylist) payload.playlist = playlist;
  if (sourceUserId) payload.sourceUserId = sourceUserId;

  if (playlist === "tournament") {
    const score = Number(input.score);
    const matches = Number(input.matches);
    if (!Number.isFinite(score) || score < 0) throw new Error("Score must be zero or higher.");
    if (!Number.isFinite(matches) || matches < 0) throw new Error("Matches must be zero or higher.");
    payload.score = score;
    payload.matches = matches;
  } else if (playlist === "wins") {
    const wins = Number(input.wins);
    const matches = Number(input.matches);
    if (!Number.isFinite(wins) || wins < 0) throw new Error("Wins must be zero or higher.");
    if (!Number.isFinite(matches) || matches < 0) throw new Error("Matches must be zero or higher.");
    payload.wins = wins;
    payload.matches = matches;
  } else {
    const mmr = Number(input.mmr);
    if (!Number.isFinite(mmr)) throw new Error("Enter a valid MMR.");
    payload.mmr = mmr;
  }

  return payload;
}

export function buildIconPayload(input) {
  const label = typeof input?.label === "string" ? input.label.trim() : "";
  const icon = sanitizeHttpUrl(input?.icon);
  if (!label || label.length > 100) throw new Error("Enter an icon label up to 100 characters.");
  if (!icon) throw new Error("Icon URL must use http or https.");
  return { icon, label };
}
