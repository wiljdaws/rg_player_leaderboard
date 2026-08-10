// Rolling 60-minute per-player stat window kept in localStorage. Tracks MMR
// for ranked playlists; on the wins playlist each sample also carries the
// matches count so we can reconstruct win streaks the same way ATLAS does.

const WINDOW_MS = 60 * 60_000;
const STORAGE_KEY = "rgPlayerLb:statHistory:v3";
const MAX_SNAPSHOTS_PER_PLAYER = 240;
const MAX_PLAYERS_PER_PLAYLIST = 300;

function fallbackStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

const blank = () => ({ version: 3, playlists: {} });

function entryFrom(playlist, row, ts) {
  if (playlist === "wins") {
    if (typeof row?.wins !== "number" || !Number.isFinite(row.wins)) return null;
    if (typeof row?.matches !== "number" || !Number.isFinite(row.matches)) return null;
    return { value: row.wins, matches: row.matches, ts };
  }
  if (playlist === "tournament") {
    if (typeof row?.score !== "number" || !Number.isFinite(row.score)) return null;
    if (typeof row?.matches !== "number" || !Number.isFinite(row.matches)) return null;
    return { value: row.score, matches: row.matches, ts };
  }
  if (typeof row?.mmr !== "number" || !Number.isFinite(row.mmr)) return null;
  return { value: row.mmr, ts };
}

function entriesEqual(a, b, playlist) {
  if (!a || !b) return false;
  if (a.value !== b.value) return false;
  if ((playlist === "wins" || playlist === "tournament") && a.matches !== b.matches) return false;
  return true;
}

export class MmrHistoryStore {
  constructor({
    storage = typeof localStorage === "undefined" ? fallbackStorage() : localStorage,
    now = () => Date.now(),
    windowMs = WINDOW_MS,
  } = {}) {
    this.storage = storage;
    this.now = now;
    this.windowMs = windowMs;
    this.error = null;
    this.data = this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(this.storage.getItem(STORAGE_KEY) || "null");
      if (parsed?.version === 3 && parsed.playlists && typeof parsed.playlists === "object") {
        return parsed;
      }
    } catch {
      this.error = "History could not be read.";
    }
    return blank();
  }

  persist() {
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(this.data));
      this.error = null;
    } catch {
      this.error = "History could not be saved.";
    }
  }

  record(playlist, rows, ts = this.now()) {
    if (!playlist || !Array.isArray(rows) || !rows.length) return false;
    const store = this.data.playlists[playlist] ?? { players: {} };
    let touched = false;
    const cutoff = ts - this.windowMs;

    for (const row of rows) {
      if (!row?.id) continue;
      const entry = entryFrom(playlist, row, ts);
      if (!entry) continue;

      const series = store.players[row.id] ?? [];
      const last = series[series.length - 1];
      // Skip near-duplicates so a burst of unchanged snapshots doesn't fill the series.
      if (last && entriesEqual(last, entry, playlist) && ts - last.ts < 30_000) continue;
      series.push(entry);

      // Keep at least the newest sample even when the whole window is stale,
      // so a chip can render as soon as the next reading lands.
      let firstInWindow = 0;
      while (firstInWindow < series.length - 1 && series[firstInWindow].ts < cutoff) {
        firstInWindow += 1;
      }
      const trimmed = series.slice(firstInWindow, firstInWindow + MAX_SNAPSHOTS_PER_PLAYER);
      store.players[row.id] = trimmed;
      touched = true;
    }

    // Once we're tracking too many players, drop anyone missing from the
    // latest snapshot — they've fallen off the visible board anyway.
    const ids = Object.keys(store.players);
    if (ids.length > MAX_PLAYERS_PER_PLAYLIST) {
      const seen = new Set(rows.map((row) => row.id));
      for (const id of ids) if (!seen.has(id)) delete store.players[id];
    }

    this.data.playlists[playlist] = store;
    if (touched) this.persist();
    return touched;
  }

  // Returns null when we haven't seen two samples yet — callers should treat
  // that as "no data" instead of assuming zero change.
  gainFor(playlist, playerId, ts = this.now()) {
    const series = this.data.playlists[playlist]?.players?.[playerId] ?? [];
    if (series.length < 2) return { gained: null, spanMs: 0, samples: series.length };
    const cutoff = ts - this.windowMs;
    const anchor = series.find((entry) => entry.ts >= cutoff) ?? series[0];
    const latest = series[series.length - 1];
    return {
      gained: latest.value - anchor.value,
      spanMs: Math.max(0, latest.ts - anchor.ts),
      samples: series.length,
    };
  }

  // Every player whose tracked stat shifted inside the rolling window, ranked
  // by absolute magnitude. Requires a minimum span so the strip only reports
  // real last-hour comparisons instead of fresh-load 1-minute snapshots.
  topMovers(
    playlist,
    players,
    { max = 8, minChange = 1, minSpanMs = 10 * 60_000, ts = this.now() } = {},
  ) {
    const rows = [];
    for (const player of players ?? []) {
      const { gained, spanMs, samples } = this.gainFor(playlist, player.id, ts);
      if (gained == null || samples < 2) continue;
      if (spanMs < minSpanMs) continue;
      if (Math.abs(gained) < minChange) continue;
      rows.push({ player, gained, spanMs });
    }
    rows.sort((a, b) => Math.abs(b.gained) - Math.abs(a.gained));
    return rows.slice(0, max);
  }

  // Session win/loss streak reconstructed from wins/matches deltas. Mirrors
  // the ATLAS HUD's advanceOpponentStreak: a clean run of wins extends the
  // streak, a clean run of losses flips it negative, and any mixed block
  // collapses to +/- 1 because we can't know the game order.
  //
  // Returns { streak, confident, samples }. streak is positive for wins,
  // negative for losses, zero when we haven't seen a decisive block yet.
  streakFor(playerId, ts = this.now()) {
    const series = this.data.playlists.wins?.players?.[playerId] ?? [];
    if (series.length < 2) return { streak: 0, confident: false, samples: series.length };

    let streak = 0;
    let confident = false;
    for (let i = 1; i < series.length; i += 1) {
      const prev = series[i - 1];
      const curr = series[i];
      if (typeof prev.matches !== "number" || typeof curr.matches !== "number") continue;
      const matchDiff = curr.matches - prev.matches;
      const winDiff = curr.value - prev.value;
      if (matchDiff <= 0) continue;
      const losses = matchDiff - winDiff;
      if (winDiff > 0 && losses === 0) {
        streak = streak > 0 ? streak + winDiff : winDiff;
      } else if (losses > 0 && winDiff === 0) {
        streak = streak < 0 ? streak - losses : -losses;
      } else {
        streak = winDiff >= losses ? 1 : -1;
      }
      confident = true;
    }
    return { streak, confident, samples: series.length, ts };
  }

  // Everyone on a positive streak of at least minStreak, ordered longest
  // first. Loss streaks are intentionally excluded — the site is for
  // celebrating heaters, not for airing anyone's rough night.
  topStreaks(players, { minStreak = 3, max = 8, ts = this.now() } = {}) {
    const rows = [];
    for (const player of players ?? []) {
      const { streak, confident } = this.streakFor(player.id, ts);
      if (!confident) continue;
      if (streak < minStreak) continue;
      rows.push({ player, streak });
    }
    rows.sort((a, b) => b.streak - a.streak);
    return rows.slice(0, max);
  }

  // How much of the 60-minute window we've filled for the playlist — used to
  // show progress during the initial warmup so the empty state feels alive.
  warmupProgress(playlist, ts = this.now()) {
    const players = this.data.playlists[playlist]?.players ?? {};
    let bestSpanMs = 0;
    for (const series of Object.values(players)) {
      if (series.length < 2) continue;
      const cutoff = ts - this.windowMs;
      const anchor = series.find((entry) => entry.ts >= cutoff) ?? series[0];
      const latest = series[series.length - 1];
      const span = Math.max(0, latest.ts - anchor.ts);
      if (span > bestSpanMs) bestSpanMs = span;
    }
    return { spanMs: bestSpanMs, ratio: Math.min(1, bestSpanMs / this.windowMs) };
  }

  clear() {
    this.data = blank();
    this.persist();
  }
}
