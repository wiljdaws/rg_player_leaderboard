import { test } from "node:test";
import assert from "node:assert/strict";

// ----------------------------------------------------------------------------
// Minimal fake DOM. Just enough surface for read-dashboard.js to build its
// tree — no layout, no rendering. Confirms structure and callback wiring.
// ----------------------------------------------------------------------------

class FakeClassList {
  constructor() { this._set = new Set(); }
  add(...names) { for (const n of names) this._set.add(n); }
  remove(...names) { for (const n of names) this._set.delete(n); }
  contains(name) { return this._set.has(name); }
  toString() { return Array.from(this._set).join(" "); }
}

class FakeNode {
  constructor(nodeType) {
    this.nodeType = nodeType;
    this.childNodes = [];
    this.parentNode = null;
    this.textContent = "";
  }
  appendChild(child) {
    if (child == null) return child;
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  removeChild(child) {
    const idx = this.childNodes.indexOf(child);
    if (idx >= 0) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }
  insertBefore(newChild, ref) {
    if (!ref) return this.appendChild(newChild);
    const idx = this.childNodes.indexOf(ref);
    if (idx < 0) return this.appendChild(newChild);
    if (newChild.parentNode) newChild.parentNode.removeChild(newChild);
    newChild.parentNode = this;
    this.childNodes.splice(idx, 0, newChild);
    return newChild;
  }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const idx = this.parentNode.childNodes.indexOf(this);
    return this.parentNode.childNodes[idx + 1] || null;
  }
}

class FakeTextNode extends FakeNode {
  constructor(text) {
    super(3);
    this.textContent = String(text);
  }
  get innerText() { return this.textContent; }
}

class FakeElement extends FakeNode {
  constructor(tagName, namespace = null) {
    super(1);
    this.tagName = String(tagName).toUpperCase();
    this.localName = String(tagName);
    this.namespaceURI = namespace;
    this.attributes = new Map();
    this.style = new FakeStyle();
    this._classList = new FakeClassList();
    this._listeners = new Map();
    this.value = "";
    this.type = null;
    const self = this;
    this.dataset = new Proxy({}, {
      set(target, key, value) {
        target[key] = value;
        // Mirror to data-* attribute like the real DOM does.
        const attrName = "data-" + String(key).replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
        self.attributes.set(attrName, String(value));
        return true;
      },
      get(target, key) { return target[key]; },
    });
  }
  get className() { return this._classList.toString(); }
  set className(v) {
    this._classList = new FakeClassList();
    if (v) for (const name of String(v).split(/\s+/).filter(Boolean)) this._classList.add(name);
  }
  get classList() { return this._classList; }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "value" && (this.localName === "input" || this.localName === "INPUT")) {
      this.value = String(value);
    }
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }
  addEventListener(evt, handler) {
    if (!this._listeners.has(evt)) this._listeners.set(evt, []);
    this._listeners.get(evt).push(handler);
  }
  removeEventListener(evt, handler) {
    const list = this._listeners.get(evt);
    if (!list) return;
    const idx = list.indexOf(handler);
    if (idx >= 0) list.splice(idx, 1);
  }
  dispatch(evt, payload) {
    const list = this._listeners.get(evt) || [];
    for (const fn of list.slice()) fn(payload || { target: this });
  }
  click() { this.dispatch("click"); }
  set textContent(v) {
    // Clear children then set string content.
    while (this.childNodes.length) this.removeChild(this.childNodes[0]);
    this._text = String(v);
    if (this._text) {
      const node = new FakeTextNode(this._text);
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }
  get textContent() {
    if (Array.isArray(this.childNodes) && this.childNodes.length > 0) {
      return this.childNodes.map((c) => c.textContent || "").join("");
    }
    return this._text || "";
  }
  set innerHTML(v) {
    this._text = "";
    while (this.childNodes.length) this.removeChild(this.childNodes[0]);
    if (v) {
      const node = new FakeTextNode(v);
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }
  get innerHTML() { return this._text || ""; }
  querySelectorAll(sel) {
    const out = [];
    walk(this, (n) => { if (matchesSel(n, sel)) out.push(n); });
    return out;
  }
  querySelector(sel) {
    let hit = null;
    walk(this, (n) => {
      if (hit) return;
      if (matchesSel(n, sel)) hit = n;
    });
    return hit;
  }
}

class FakeStyle {
  constructor() { this._props = new Map(); }
  setProperty(k, v) { this._props.set(k, String(v)); }
  getPropertyValue(k) { return this._props.get(k) || ""; }
  removeProperty(k) { this._props.delete(k); }
}

function walk(node, fn) {
  if (!node) return;
  fn(node);
  for (const child of node.childNodes || []) walk(child, fn);
}

function matchesSel(node, sel) {
  if (!(node instanceof FakeElement)) return false;
  // Support a very small subset: ".class", "tag", "[data-foo]", "[data-foo=bar]".
  if (sel.startsWith(".")) {
    const cls = sel.slice(1);
    if (node._classList.contains(cls)) return true;
    // SVG elements set class via setAttribute("class", ...) — check that too.
    const raw = node.getAttribute("class");
    if (raw && raw.split(/\s+/).includes(cls)) return true;
    return false;
  }
  if (sel.startsWith("[") && sel.endsWith("]")) {
    const inner = sel.slice(1, -1);
    const eq = inner.indexOf("=");
    if (eq === -1) return node.hasAttribute(inner);
    const key = inner.slice(0, eq);
    const val = inner.slice(eq + 1).replace(/^"|"$/g, "");
    return node.getAttribute(key) === val;
  }
  return node.localName === sel;
}

class FakeDocument {
  createElement(tag) { return new FakeElement(tag); }
  createElementNS(ns, tag) { return new FakeElement(tag, ns); }
  createTextNode(text) { return new FakeTextNode(text); }
}

function installFakeDom() {
  const doc = new FakeDocument();
  globalThis.document = doc;
  return doc;
}

function cleanupDom() {
  delete globalThis.document;
}

function makeContainer() {
  return new FakeElement("div");
}

function findByClass(root, className) {
  return root.querySelectorAll(`.${className}`);
}

function findByAttr(root, attr, value) {
  const all = [];
  walk(root, (n) => {
    if (n instanceof FakeElement && n.getAttribute(attr) === value) all.push(n);
  });
  return all;
}

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

function fullData() {
  return {
    range: { from: "2026-08-01", to: "2026-08-07" },
    site: [{ id: "s1" }, { id: "s2" }],
    hud: [{ id: "h1" }],
    aggregate: {
      totalReads: 12345,
      totalWrites: 234,
      byDate: {
        "2026-08-01": { site: 100, hud: 200 },
        "2026-08-02": { site: 150, hud: 180 },
        "2026-08-03": { site: 120, hud: 220 },
        "2026-08-04": { site: 90, hud: 260 },
      },
      bySource: { site: 500, clanSite: 200, hud: 800, other: 10 },
      byHudVersion: { "19.4": 500, "17.6": 100, "17.4": 30 },
      byLabel: {
        site: [
          { label: "leaderboardSub:1v1", total: 100 },
          { label: "iconKey", total: 10 },
        ],
        hud: [
          { label: "leaderboard", total: 25 },
          { label: "clans", total: 3 },
        ],
      },
      byHudUser: [
        { sourceUserId: "abcdef123456", reads: 400, writes: 12, versionNum: "17.4", lastUpdatedAt: Date.now() - 5 * 60 * 1000 },
        { sourceUserId: "ghijkl789012", reads: 200, writes: 8, versionNum: "17.3", lastUpdatedAt: Date.now() - 60 * 60 * 1000 },
      ],
      bySiteSession: [
        { sessionId: "sess-1234567890", total: 300, updatedAt: Date.now() - 10 * 60 * 1000, userAgentShort: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125" },
        { sessionId: "sess-abcdef1234", total: 150, updatedAt: Date.now() - 2 * 60 * 60 * 1000, userAgentShort: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Safari/604.1" },
      ],
    },
    fetchedAt: Date.now(),
  };
}

function emptyData() {
  return {
    range: { from: "2026-08-01", to: "2026-08-07" },
    site: [],
    hud: [],
    aggregate: {
      totalReads: 0,
      totalWrites: 0,
      byDate: {},
      bySource: { site: 0, clanSite: 0, hud: 0, other: 0 },
      byHudVersion: {},
      byLabel: { site: [], hud: [] },
      byHudUser: [],
      bySiteSession: [],
    },
    fetchedAt: Date.now(),
  };
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

test("renderReadDashboard: renders without throwing on valid data", async () => {
  installFakeDom();
  try {
    const { renderReadDashboard } = await import("../js/read-dashboard.js");
    const container = makeContainer();
    renderReadDashboard(container, fullData(), {});
    // Header rendered.
    assert.ok(findByClass(container, "rd-header").length >= 1, "header present");
    // Chips rendered.
    assert.equal(findByClass(container, "rd-chip-tile").length, 4, "4 chip tiles");
    // Time chart svg present.
    assert.ok(findByClass(container, "rd-timechart").length >= 1, "timechart svg");
    // Donut present.
    assert.ok(findByClass(container, "rd-donut").length >= 1, "donut svg");
    // Version breakdown present.
    assert.ok(findByClass(container, "rd-verbar-row").length >= 1, "version rows");
    // Top labels + top denies each render site + hud columns (4 total).
    assert.equal(findByClass(container, "rd-toplabels-col").length, 4, "four label columns");
    // Tables rendered.
    assert.equal(findByAttr(container, "data-table", "hud-users").length, 1, "hud users table");
    assert.equal(findByAttr(container, "data-table", "site-sessions").length, 1, "site sessions table");
  } finally {
    cleanupDom();
  }
});

test("renderReadDashboard: highlights current HUD release in green", async () => {
  installFakeDom();
  try {
    const { renderReadDashboard } = await import("../js/read-dashboard.js");
    const container = makeContainer();
    renderReadDashboard(container, fullData(), {});
    const currents = [];
    walk(container, (n) => {
      if (n instanceof FakeElement && n.getAttribute && n.getAttribute("data-current") === "true") {
        currents.push(n);
      }
    });
    assert.equal(currents.length, 1, "exactly one row marked as current release");
  } finally {
    cleanupDom();
  }
});

test("renderReadDashboard: renders empty state when aggregates are zero", async () => {
  installFakeDom();
  try {
    const { renderReadDashboard } = await import("../js/read-dashboard.js");
    const container = makeContainer();
    renderReadDashboard(container, emptyData(), {});
    // Header still rendered.
    assert.ok(findByClass(container, "rd-header").length >= 1, "header still present");
    // Empty state block rendered.
    assert.ok(findByClass(container, "rd-empty").length >= 1, "empty state present");
    // No chips row.
    assert.equal(findByClass(container, "rd-chip-tile").length, 0, "no chip tiles");
    // No chart.
    assert.equal(findByClass(container, "rd-timechart").length, 0, "no chart");
  } finally {
    cleanupDom();
  }
});

test("renderReadDashboard: skeleton mode renders shimmer rows", async () => {
  installFakeDom();
  try {
    const { renderReadDashboard } = await import("../js/read-dashboard.js");
    const container = makeContainer();
    renderReadDashboard(container, null, { loading: true });
    assert.ok(findByClass(container, "rd-skeleton").length >= 1, "skeleton present");
    // Skeleton mode should NOT render live panels.
    assert.equal(findByClass(container, "rd-chip-tile").length, 0, "no live chips");
    assert.equal(findByClass(container, "rd-timechart").length, 0, "no live chart");
  } finally {
    cleanupDom();
  }
});

test("renderReadDashboard: fires onRefresh when refresh clicked", async () => {
  installFakeDom();
  try {
    const { renderReadDashboard } = await import("../js/read-dashboard.js");
    const container = makeContainer();
    let refreshes = 0;
    renderReadDashboard(container, fullData(), {
      onRefresh: () => { refreshes += 1; },
    });
    const btn = container.querySelector(".rd-btn-primary");
    assert.ok(btn, "refresh button present");
    btn.click();
    assert.equal(refreshes, 1, "onRefresh fired once");
    btn.click();
    assert.equal(refreshes, 2, "onRefresh fired again on second click");
  } finally {
    cleanupDom();
  }
});

test("renderReadDashboard: fires onExport('csv') when CSV button clicked", async () => {
  installFakeDom();
  try {
    const { renderReadDashboard } = await import("../js/read-dashboard.js");
    const container = makeContainer();
    const formats = [];
    renderReadDashboard(container, fullData(), {
      onExport: (fmt) => formats.push(fmt),
    });
    const csvBtn = findByAttr(container, "data-export", "csv")[0];
    assert.ok(csvBtn, "csv button present");
    csvBtn.click();
    assert.deepEqual(formats, ["csv"], "onExport called with 'csv'");
    findByAttr(container, "data-export", "json")[0].click();
    findByAttr(container, "data-export", "bundle")[0].click();
    assert.deepEqual(formats, ["csv", "json", "bundle"], "all three formats fire distinctly");
  } finally {
    cleanupDom();
  }
});

test("renderReadDashboard: onRangeChange fires when date input changes", async () => {
  installFakeDom();
  try {
    const { renderReadDashboard } = await import("../js/read-dashboard.js");
    const container = makeContainer();
    const calls = [];
    renderReadDashboard(container, fullData(), {
      onRangeChange: (from, to) => calls.push([from, to]),
    });
    const inputs = container.querySelectorAll(".rd-date-input");
    assert.equal(inputs.length, 2, "two date inputs");
    const min = inputs[0].getAttribute("min");
    const max = inputs[0].getAttribute("max");
    assert.ok(min, "from input is locked to the 7-day window");
    assert.ok(max, "from input has a max");
    inputs[0].value = "2020-01-01";
    inputs[0].dispatch("change");
    assert.equal(calls.length, 1, "range change fired");
    assert.equal(calls[0][0], min, "a 30-day pick snaps back to the window min");
    assert.ok(calls[0][0] >= min, "forwarded from is not older than min");
    assert.ok(calls[0][1] <= max, "forwarded to is not past max");
  } finally {
    cleanupDom();
  }
});

test("renderReadDashboard: sortable table swaps sort direction on header click", async () => {
  installFakeDom();
  try {
    const { renderReadDashboard } = await import("../js/read-dashboard.js");
    const container = makeContainer();
    renderReadDashboard(container, fullData(), {});
    const table = findByAttr(container, "data-table", "hud-users")[0];
    assert.ok(table, "hud users table present");
    const headers = table.querySelectorAll(".rd-th");
    assert.ok(headers.length >= 3, "table has headers");
    // Default sort is by "reads" desc — third column header.
    const readsHeader = headers[2];
    const before = readsHeader.getAttribute("aria-sort");
    assert.equal(before, "descending", "starts descending");
    readsHeader.click();
    // Re-query because paint() rebuilds the header nodes.
    const headersAfter = table.querySelectorAll(".rd-th");
    const readsHeaderAfter = headersAfter[2];
    const after = readsHeaderAfter.getAttribute("aria-sort");
    assert.equal(after, "ascending", "flipped to ascending after click");
  } finally {
    cleanupDom();
  }
});

test("__private helpers: fmtCompact + niceCeil basic behavior", async () => {
  installFakeDom();
  try {
    const mod = await import("../js/read-dashboard.js");
    const { fmtCompact, niceCeil, truncateId, shortUserAgent } = mod.__private;
    assert.equal(fmtCompact(500), "500");
    assert.equal(fmtCompact(1500), "1.5k");
    assert.equal(fmtCompact(1_200_000), "1.2M");
    assert.equal(niceCeil(97), 100);
    assert.equal(niceCeil(120), 200);
    assert.equal(niceCeil(0), 1);
    assert.equal(truncateId("abcdefghij", 4), "abcd…");
    assert.equal(truncateId("abc", 4), "abc");
    const ua = shortUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/125");
    assert.match(ua, /Chrome/);
    assert.match(ua, /macOS/);
  } finally {
    cleanupDom();
  }
});

