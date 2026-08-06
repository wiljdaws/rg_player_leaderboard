// Every flag URL we've ever seen on a player row, kept in localStorage so the
// admin picker keeps growing across sessions. Watchers re-render when the
// set changes so an open form updates the moment a new flag arrives.
// Each entry can also carry a hand-picked country label (admin-supplied) so
// the picker shows "Brazil" instead of the imgur file code "saBa4s8".

const STORAGE_KEY_V1 = "rgPlayerLb:flagDirectory:v1";
const STORAGE_KEY_V2 = "rgPlayerLb:flagDirectory:v2";
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

// ISO 3166 sovereign states. Used as the validation list when an admin adds a
// new flag URL — they must pick a real country so the picker stays useful.
export const COUNTRIES = Object.freeze([
  "Afghanistan","Albania","Algeria","Andorra","Angola","Antigua and Barbuda","Argentina",
  "Armenia","Australia","Austria","Azerbaijan","Bahamas","Bahrain","Bangladesh","Barbados",
  "Belarus","Belgium","Belize","Benin","Bhutan","Bolivia","Bosnia and Herzegovina","Botswana",
  "Brazil","Brunei","Bulgaria","Burkina Faso","Burundi","Cabo Verde","Cambodia","Cameroon",
  "Canada","Central African Republic","Chad","Chile","China","Colombia","Comoros","Congo",
  "Costa Rica","Croatia","Cuba","Cyprus","Czech Republic","Denmark","Djibouti","Dominica",
  "Dominican Republic","Ecuador","Egypt","El Salvador","Equatorial Guinea","Eritrea","Estonia",
  "Eswatini","Ethiopia","Fiji","Finland","France","Gabon","Gambia","Georgia","Germany",
  "Ghana","Greece","Grenada","Guatemala","Guinea","Guinea-Bissau","Guyana","Haiti","Honduras",
  "Hungary","Iceland","India","Indonesia","Iran","Iraq","Ireland","Israel","Italy",
  "Ivory Coast","Jamaica","Japan","Jordan","Kazakhstan","Kenya","Kiribati","Kuwait",
  "Kyrgyzstan","Laos","Latvia","Lebanon","Lesotho","Liberia","Libya","Liechtenstein",
  "Lithuania","Luxembourg","Madagascar","Malawi","Malaysia","Maldives","Mali","Malta",
  "Marshall Islands","Mauritania","Mauritius","Mexico","Micronesia","Moldova","Monaco",
  "Mongolia","Montenegro","Morocco","Mozambique","Myanmar","Namibia","Nauru","Nepal",
  "Netherlands","New Zealand","Nicaragua","Niger","Nigeria","North Korea","North Macedonia",
  "Norway","Oman","Pakistan","Palau","Palestine","Panama","Papua New Guinea","Paraguay",
  "Peru","Philippines","Poland","Portugal","Qatar","Romania","Russia","Rwanda",
  "Saint Kitts and Nevis","Saint Lucia","Saint Vincent and the Grenadines","Samoa",
  "San Marino","Sao Tome and Principe","Saudi Arabia","Senegal","Serbia","Seychelles",
  "Sierra Leone","Singapore","Slovakia","Slovenia","Solomon Islands","Somalia","South Africa",
  "South Korea","South Sudan","Spain","Sri Lanka","Sudan","Suriname","Sweden","Switzerland",
  "Syria","Taiwan","Tajikistan","Tanzania","Thailand","Timor-Leste","Togo","Tonga",
  "Trinidad and Tobago","Tunisia","Turkey","Turkmenistan","Tuvalu","Uganda","Ukraine",
  "United Arab Emirates","United Kingdom","United States","Uruguay","Uzbekistan","Vanuatu",
  "Vatican City","Venezuela","Vietnam","Yemen","Zambia","Zimbabwe",
]);

const COUNTRIES_LOWER = new Set(COUNTRIES.map((c) => c.toLowerCase()));
export function isRealCountry(name) {
  if (typeof name !== "string") return false;
  return COUNTRIES_LOWER.has(name.trim().toLowerCase());
}

// Case-insensitive lookup that returns the canonical spelling.
export function canonicalCountry(name) {
  if (typeof name !== "string") return "";
  const target = name.trim().toLowerCase();
  for (const c of COUNTRIES) if (c.toLowerCase() === target) return c;
  return "";
}

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
    // Preserves insertion order so recent additions stay at the top of the picker.
    this.entries = new Map(); // url -> { label: string | null, custom: boolean }
    this.watchers = new Set();
    this.load();
  }

  load() {
    // Read v2 first; fall back to v1 (bare URL array) and migrate.
    try {
      const v2 = JSON.parse(this.storage.getItem(STORAGE_KEY_V2) || "null");
      if (v2 && Array.isArray(v2.entries)) {
        for (const raw of v2.entries) {
          if (typeof raw?.url !== "string" || !raw.url) continue;
          this.entries.set(raw.url, {
            label: typeof raw.label === "string" ? raw.label : null,
            custom: Boolean(raw.custom),
          });
        }
        return;
      }
    } catch {}
    try {
      const v1 = JSON.parse(this.storage.getItem(STORAGE_KEY_V1) || "null");
      if (Array.isArray(v1)) {
        for (const url of v1) {
          if (typeof url === "string" && url) {
            this.entries.set(url, { label: null, custom: false });
          }
        }
        this.persist();
        try { this.storage.removeItem(STORAGE_KEY_V1); } catch {}
      }
    } catch {}
  }

  persist() {
    try {
      const payload = {
        entries: [...this.entries.entries()].map(([url, meta]) => ({ url, ...meta })),
      };
      this.storage.setItem(STORAGE_KEY_V2, JSON.stringify(payload));
    } catch {
      // Storage full or blocked — the in-memory state still works this session.
    }
  }

  // Look up the effective label for a URL: an admin-set custom label wins,
  // then any static known-flag mapping, else the heuristic.
  labelFor(url) {
    const meta = this.entries.get(url);
    if (meta?.label) return meta.label;
    return labelForFlagUrl(url);
  }

  // Check whether a country name is already represented by any flag — either
  // in the static known map or via a user-added label. Used to prevent
  // duplicate country entries when an admin adds a new flag.
  hasCountry(country) {
    if (typeof country !== "string" || !country) return false;
    const target = country.trim().toLowerCase();
    for (const label of KNOWN_FLAG_URLS.values()) {
      if (label.toLowerCase() === target) return true;
    }
    for (const [, label] of KNOWN_FLAG_DATA_PREFIXES) {
      if (label.toLowerCase() === target) return true;
    }
    for (const meta of this.entries.values()) {
      if (meta.label && meta.label.toLowerCase() === target) return true;
    }
    return false;
  }

  // Auto-registration path (from ATLAS-synced rows). No label supplied — the
  // heuristic or static map will label it. Never overwrites an existing custom
  // label.
  add(url) {
    if (typeof url !== "string" || !url) return false;
    const clean = url.trim();
    if (!clean || this.entries.has(clean)) return false;
    this.trimIfFull();
    this.entries.set(clean, { label: null, custom: false });
    this.persist();
    this.emit();
    return true;
  }

  // Admin-add path: attaches a hand-picked country label. Rejects if the
  // country isn't real or is already represented elsewhere.
  addWithCountry(url, country) {
    const clean = typeof url === "string" ? url.trim() : "";
    const canonical = canonicalCountry(country);
    if (!clean) return { ok: false, error: "Enter a flag URL." };
    if (!canonical) return { ok: false, error: "Pick a real country." };
    if (this.hasCountry(canonical) && this.labelFor(clean) !== canonical) {
      return { ok: false, error: `Already have a flag for ${canonical}.` };
    }
    this.trimIfFull();
    this.entries.set(clean, { label: canonical, custom: true });
    this.persist();
    this.emit();
    return { ok: true };
  }

  remove(url) {
    if (!this.entries.delete(url)) return false;
    this.persist();
    this.emit();
    return true;
  }

  trimIfFull() {
    if (this.entries.size < MAX_ENTRIES) return;
    // Drop the oldest non-custom entry first; only fall back to a custom entry
    // if there's nothing else to evict.
    for (const [url, meta] of this.entries) {
      if (!meta.custom) {
        this.entries.delete(url);
        return;
      }
    }
    const first = this.entries.keys().next().value;
    if (first) this.entries.delete(first);
  }

  registerRows(rows) {
    let touched = false;
    for (const row of rows ?? []) {
      const url = typeof row?.flag === "string" ? row.flag.trim() : "";
      if (!url || this.entries.has(url)) continue;
      this.trimIfFull();
      this.entries.set(url, { label: null, custom: false });
      touched = true;
    }
    if (touched) {
      this.persist();
      this.emit();
    }
    return touched;
  }

  list() {
    return [...this.entries].map(([url, meta]) => ({
      url,
      label: meta.label || labelForFlagUrl(url),
      custom: meta.custom,
    }));
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
