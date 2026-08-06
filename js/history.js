// Rolling 60-minute per-player stat window kept in localStorage. Tracks MMR
// for ranked playlists and wins for the wins playlist — same shape either
// way. The cap keeps the store bounded across long-lived browser sessions.

const WINDOW_MS = 60 * 60_000;
const STORAGE_KEY = "rgPlayerLb:statHistory:v2";
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

const blank = () => ({ version: 2, playlists: {} });

function statFrom(playlist, row) {
  if (playlist === "wins") {
    return typeof row?.wins === "number" && Number.isFinite(row.wins) ? row.wins : null;
  }
  return typeof row?.mmr === "number" && Number.isFinite(row.mmr) ? row.mmr : null;
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
      if (parsed?.version === 2 && parsed.playlists && typeof parsed.playlists === "object") {
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
      const value = statFrom(playlist, row);
      if (value === null) continue;

      const series = store.players[row.id] ?? [];
      const last = series[series.length - 1];
      // Skip near-duplicates so a burst of unchanged snapshots doesn't fill the series.
      if (last && last.value === value && ts - last.ts < 30_000) continue;
      series.push({ value, ts });

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
