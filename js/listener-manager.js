// Keeps one live listener open — the tab currently on screen — so a hidden
// page never burns Firestore quota, and switching tabs cleanly swaps queries.

import { isPlaylist } from "./config.js";

export class PlaylistListenerManager {
  constructor({ subscribe, onRows, onStatus }) {
    this.subscribe = subscribe;
    this.onRows = onRows;
    this.onStatus = onStatus;
    this.cache = new Map();
    this.activePlaylist = null;
    this.visible = true;
    this.unsubscribe = null;
    this.generation = 0;
  }

  activate(playlist) {
    if (!isPlaylist(playlist)) throw new Error("Unknown playlist.");
    if (playlist === this.activePlaylist && this.unsubscribe) return;

    this.disconnect();
    this.activePlaylist = playlist;

    if (this.cache.has(playlist)) {
      this.onRows(this.cache.get(playlist), { cached: true, playlist });
      this.onStatus({ kind: "loading", message: `Refreshing ${playlist} rankings…` });
    } else {
      this.onRows([], { cached: false, playlist });
      this.onStatus({ kind: "loading", message: `Loading ${playlist} rankings…` });
    }

    if (this.visible) this.connect();
  }

  setVisible(visible) {
    const next = Boolean(visible);
    if (next === this.visible) return;
    this.visible = next;

    if (!next) {
      this.disconnect();
      this.onStatus({ kind: "degraded", message: "Live updates paused while this page is hidden." });
      return;
    }

    if (this.activePlaylist) {
      const playlist = this.activePlaylist;
      if (this.cache.has(playlist)) {
        this.onRows(this.cache.get(playlist), { cached: true, playlist });
      }
      this.onStatus({ kind: "loading", message: `Refreshing ${playlist} rankings…` });
      this.connect();
    }
  }

  connect() {
    const playlist = this.activePlaylist;
    if (!playlist || !this.visible || this.unsubscribe) return;

    const generation = ++this.generation;

    try {
      const unsubscribe = this.subscribe(playlist, {
        next: ({ rows, fromCache = false, degradedReason = "" }) => {
          if (generation !== this.generation || playlist !== this.activePlaylist) return;
          const safe = Array.isArray(rows) ? rows : [];
          this.cache.set(playlist, safe);
          this.onRows(safe, { cached: fromCache, playlist });
          this.onStatus({
            kind: fromCache || degradedReason ? "degraded" : "live",
            message:
              degradedReason ||
              (fromCache
                ? `Showing cached ${playlist} rankings while reconnecting.`
                : `Live ${playlist} rankings · ${safe.length} players`),
          });
        },
        error: (error) => {
          if (generation !== this.generation || playlist !== this.activePlaylist) return;
          const hasCache = this.cache.has(playlist);
          this.onStatus({
            kind: hasCache ? "degraded" : "error",
            message: hasCache
              ? `Live updates are unavailable. Showing saved ${playlist} rankings.`
              : error?.userMessage || "Rankings could not be loaded.",
            error,
          });
        },
      });

      if (generation === this.generation) {
        this.unsubscribe = typeof unsubscribe === "function" ? unsubscribe : () => {};
      } else if (typeof unsubscribe === "function") {
        unsubscribe();
      }
    } catch (error) {
      this.onStatus({
        kind: this.cache.has(playlist) ? "degraded" : "error",
        message:
          error?.userMessage ||
          (this.cache.has(playlist)
            ? "Live updates are unavailable. Showing saved rankings."
            : "Rankings could not be loaded."),
        error,
      });
    }
  }

  disconnect() {
    this.generation += 1;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  destroy() {
    this.disconnect();
    this.activePlaylist = null;
    this.cache.clear();
  }
}
