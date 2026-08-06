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

// Hand-curated mapping so the admin picker can show "Brazil" instead of the
// imgur file code "saBa4s8". Add new entries here when a new flag URL shows
// up in the leaderboard — the fallback heuristic below still runs for
// anything not listed.
const KNOWN_FLAG_URLS = new Map([
  ["https://i.imgur.com/B6VOEig.png", "France"],
  ["https://i.imgur.com/l66r6qD.png", "Germany"],
  ["https://i.imgur.com/saBa4s8.png", "Brazil"],
  ["https://upload.wikimedia.org/wikipedia/commons/0/0a/Flag_of_Jamaica.svg", "Jamaica"],
  ["https://i.imgur.com/FiyMewtg.jpg", "Japan"],
  ["https://upload.wikimedia.org/wikipedia/commons/thumb/e/e4/Flag_of_the_Federated_States_of_Micronesia.svg/1280px-Flag_of_the_Federated_States_of_Micronesia.svg.png", "Micronesia"],
  ["https://i.imgur.com/sW4qCQU.png", "Italy"],
  ["https://i.imgur.com/sbXkCut.png", "India"],
  ["https://i.imgur.com/GhWQkxX.png", "Saudi Arabia"],
  ["https://i.imgur.com/TsLtfjT.jpeg", "Mexico"],
  ["https://i.imgur.com/sFwhqF5.png", "South Africa"],
]);

// Base64 flags carried over from the old leaderboard. Match on the first
// ~88 chars of the data URI — that spans the PNG header + IHDR + palette
// start, which is unique per image (different width/height/palette all
// change these bytes). Keeps the constants short instead of embedding
// full 3 KB data URIs.
const KNOWN_FLAG_DATA_PREFIXES = [
  ["data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFwAAAAxCAMAAABgWz7uAAAAnFBMVEX///+xIzOwHS6w", "United States"],
  ["data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFwAAAA9CAMAAAAXmf6VAAAAGFBMVEX///8hRoyuHCeu", "Netherlands"],
  ["data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAT4AAACfCAMAAABX0UX9AAAAkFBMVEXVKx7////TGADr", "Canada"],
  ["data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFwAAAAuCAMAAACS246gAAAAb1BMVEX////PFCsAJH3O", "United Kingdom"],
  ["data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAP0AAACfCAMAAAAF1y+fAAAAb1BMVEUAteJQni/vM0D/", "Azerbaijan"],
];

export function labelForFlagUrl(url) {
  if (typeof url !== "string" || !url) return "flag";
  const known = KNOWN_FLAG_URLS.get(url);
  if (known) return known;
  if (url.startsWith("data:")) {
    for (const [prefix, label] of KNOWN_FLAG_DATA_PREFIXES) {
      if (url.startsWith(prefix)) return label;
    }
    return "flag";
  }
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
