// Every flag URL we've ever seen on a player row, kept in localStorage so the
// admin picker keeps growing across sessions. Watchers re-render when the
// set changes so an open form updates the moment a new flag arrives.

const STORAGE_KEY = "rgPlayerLb:flagDirectory:v1";
const MAX_ENTRIES = 500;

function fallbackStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

export function labelForFlagUrl(url) {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split("/").filter(Boolean).pop() || "";
    const base = last.replace(/\.[^.]+$/, "");
    if (/^[a-z]{2,3}$/i.test(base)) return base.toUpperCase();
    if (base.length && base.length <= 16) return base;
    return parsed.hostname;
  } catch {
    return "flag";
  }
}

export class FlagDirectory {
  constructor({
    storage = typeof localStorage === "undefined" ? fallbackStorage() : localStorage,
  } = {}) {
    this.storage = storage;
    this.urls = new Set(this.load());
    this.watchers = new Set();
  }

  load() {
    try {
      const parsed = JSON.parse(this.storage.getItem(STORAGE_KEY) || "null");
      return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : [];
    } catch {
      return [];
    }
  }

  persist() {
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify([...this.urls]));
    } catch {
      // Storage full or blocked — the in-memory set still works this session.
    }
  }

  add(url) {
    if (typeof url !== "string" || !url) return false;
    const clean = url.trim();
    if (!clean || this.urls.has(clean)) return false;
    // Cap growth so a runaway ATLAS write can't blow past a reasonable size.
    if (this.urls.size >= MAX_ENTRIES) {
      const first = this.urls.values().next().value;
      this.urls.delete(first);
    }
    this.urls.add(clean);
    this.persist();
    this.emit();
    return true;
  }

  registerRows(rows) {
    let touched = false;
    for (const row of rows ?? []) {
      const url = typeof row?.flag === "string" ? row.flag.trim() : "";
      if (!url || this.urls.has(url)) continue;
      if (this.urls.size >= MAX_ENTRIES) {
        const first = this.urls.values().next().value;
        this.urls.delete(first);
      }
      this.urls.add(url);
      touched = true;
    }
    if (touched) {
      this.persist();
      this.emit();
    }
    return touched;
  }

  list() {
    return [...this.urls].map((url) => ({ url, label: labelForFlagUrl(url) }));
  }

  subscribe(watcher) {
    this.watchers.add(watcher);
    return () => this.watchers.delete(watcher);
  }

  emit() {
    for (const watcher of this.watchers) {
      try {
        watcher();
      } catch {
        // A broken watcher shouldn't take down the directory.
      }
    }
  }
}
