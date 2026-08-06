import { isPlaylist } from "./config.js";

const HEX_COLOR = /^#(?:[\da-f]{3}|[\da-f]{6})$/i;
const MAX_NAME_LENGTH = 80;
const MAX_URL_LENGTH = 2_048;

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
  if (!candidate || candidate.length > MAX_URL_LENGTH) return "";
  try {
    const parsed = new URL(candidate);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    if (parsed.username || parsed.password) return "";
    return parsed.href;
  } catch {
    return "";
  }
}

function normalizeIcons(value) {
  const candidates = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return candidates.slice(0, 12).map(sanitizeHttpUrl).filter(Boolean);
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

  if (!id) reasons.push("missing document id");
  if (!isPlaylist(playlist) || playlist !== expectedPlaylist) reasons.push("invalid playlist");
  const maximumNameLength = sourceUserId ? 22 : MAX_NAME_LENGTH;
  if (!name || name.length > maximumNameLength) reasons.push("invalid player name");
  if (sourceUserId && id !== `${sourceUserId}_${expectedPlaylist}`) {
    reasons.push("invalid sourced document id");
  }

  let score = null;
  if (expectedPlaylist === "wins") {
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
    score = {
      mmr,
      sessionMmrDelta: delta == null ? null : Math.trunc(delta),
      sessionStartedAt: startedAt == null ? null : Math.trunc(startedAt),
      sessionLastSeen: lastSeen == null ? null : Math.trunc(lastSeen),
    };
  }

  if (reasons.length) {
    return { ok: false, quarantine: { id: id || "unknown", reasons } };
  }

  const version = optionalText(String(raw.versionNum ?? raw.version ?? ""), 24);

  return {
    ok: true,
    player: {
      id,
      playlist,
      name,
      ...score,
      flag: sanitizeHttpUrl(raw.flag),
      icons: normalizeIcons(raw.icons),
      iconSize: boundedNumber(raw.iconSize, 18, 12, 50),
      glowColor: HEX_COLOR.test(raw.glowColor ?? "") ? raw.glowColor : "#ffffff",
      glowStrength: boundedNumber(raw.glowStrength, 0, 0, 50),
      provenance: {
        kind: sourceUserId ? "ATLAS synced" : "Manual admin entry",
        version,
        updatedAt: normalizeUpdatedAt(raw.updatedAt),
      },
    },
  };
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

  const score = playlist === "wins" ? "wins" : "mmr";
  rows.sort(
    (left, right) =>
      right[score] - left[score] ||
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
  );

  return { rows, quarantined };
}

export function normalizeIconKeyRows(rawRows) {
  const rows = [];
  const quarantined = [];
  for (const raw of Array.isArray(rawRows) ? rawRows : []) {
    const id = typeof raw?.id === "string" ? raw.id.trim() : "";
    const label = typeof raw?.label === "string" ? raw.label.trim() : "";
    const icon = sanitizeHttpUrl(raw?.icon);
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

export function playerGlow(player) {
  const strength = boundedNumber(player?.glowStrength, 0, 0, 50);
  const color = HEX_COLOR.test(player?.glowColor ?? "") ? player.glowColor : "#ffffff";
  return strength > 0 ? `0 0 ${strength}px ${color}` : "";
}

export function buildPlayerPayload(input, includePlaylist = true) {
  const playlist = input?.playlist;
  const name = typeof input?.name === "string" ? input.name.trim() : "";
  if (!isPlaylist(playlist)) throw new Error("Choose a valid playlist.");
  if (!name || name.length > MAX_NAME_LENGTH) throw new Error("Enter a player name up to 80 characters.");

  const icons = normalizeIcons(input.icons).join(",");
  const rawFlag = typeof input.flag === "string" ? input.flag.trim() : "";
  const flag = sanitizeHttpUrl(rawFlag);
  if (rawFlag && !flag) throw new Error("Flag URL must use http or https.");

  const payload = {
    name,
    flag,
    icons,
    iconSize: boundedNumber(Number(input.iconSize), 18, 12, 50),
    glowColor: HEX_COLOR.test(input.glowColor ?? "") ? input.glowColor : "#ffffff",
    glowStrength: boundedNumber(Number(input.glowStrength), 0, 0, 50),
  };
  if (includePlaylist) payload.playlist = playlist;

  if (playlist === "wins") {
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
