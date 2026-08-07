// Cross-session read-budget telemetry. Every admin session uploads its
// current read counters to admin_read_stats/{yyyymmdd_sessionId} so we can
// see WHICH features drove reads over a day, not just the total from the
// Firebase console. Toggleable — set `?telemetry=off` to skip uploads.
//
// Cost model: 1 write per session per upload interval + a final beforeunload
// flush via sendBeacon. At 12 admin sessions/day × 5 uploads each = 60
// writes/day, well inside free tier. Reads happen only when we query the
// collection to view the stats, which is admin-triggered.
//
// This is *observability infrastructure*. If we don't need it long-term,
// flip TELEMETRY_ENABLED = false in config or turn off the admin.js
// bootstrap. The gateway.setReadStat write path is defensive — it swallows
// errors so a Firestore hiccup doesn't cascade into UI failures.

const HAS_CRYPTO_UUID = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function";
const SESSION_ID = HAS_CRYPTO_UUID
  ? crypto.randomUUID()
  : `s${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
const SESSION_STARTED_AT = new Date().toISOString();

function todayKey(now = new Date()) {
  return now.toISOString().slice(0, 10); // YYYY-MM-DD
}
function docKey(date = todayKey()) {
  // Flat collection so we can query with a simple where("date","==",X).
  // {date}_{sessionId} keeps the doc-id sortable + human-readable.
  return `${date}_${SESSION_ID}`;
}

export function createReadTelemetryUploader({
  gateway,
  budget,
  isAdmin,
  uploadIntervalMs = 60_000,
  logger = typeof console !== "undefined" ? console : null,
  now = () => Date.now(),
} = {}) {
  if (!gateway || typeof gateway.setReadStat !== "function") {
    return { start() {}, stop() {}, upload: async () => {}, sessionId: SESSION_ID };
  }

  let intervalHandle = null;
  let lastPayloadKey = "";
  let running = false;

  async function upload({ final = false } = {}) {
    if (!running || typeof isAdmin !== "function" || !isAdmin()) return;
    const snap = budget?.snapshot?.() || { total: 0, perLabel: {}, tripped: false };
    // Skip identical payloads to avoid burning writes on quiet sessions.
    // A "final" flush always writes so we capture the ending state.
    const payloadKey = `${snap.total}:${JSON.stringify(snap.perLabel || {})}:${snap.tripped ? 1 : 0}`;
    if (!final && payloadKey === lastPayloadKey) return;
    lastPayloadKey = payloadKey;

    const payload = {
      date: todayKey(),
      sessionId: SESSION_ID,
      startedAt: SESSION_STARTED_AT,
      updatedAt: new Date().toISOString(),
      total: Number(snap.total) || 0,
      perLabel: snap.perLabel && typeof snap.perLabel === "object" ? { ...snap.perLabel } : {},
      tripped: Boolean(snap.tripped),
      userAgent: typeof navigator !== "undefined" ? String(navigator.userAgent || "").slice(0, 200) : "",
    };

    try {
      await gateway.setReadStat(docKey(payload.date), payload);
    } catch (err) {
      logger?.warn?.("[rgLB] telemetry upload failed:", err?.message || err);
    }
  }

  function start() {
    if (running) return;
    running = true;
    // Fire immediately so the day's first admin action is captured, then poll.
    upload();
    intervalHandle = setInterval(() => upload(), uploadIntervalMs);
    // beforeunload can't do async — the setDoc RPC may race the tab close.
    // A final synchronous-ish upload via the standard client is the best we
    // can do here; if it drops in flight, the last periodic write is the
    // fallback record.
    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", handleUnload);
      window.addEventListener("pagehide", handleUnload);
    }
  }

  function stop() {
    if (!running) return;
    running = false;
    if (intervalHandle != null) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("beforeunload", handleUnload);
      window.removeEventListener("pagehide", handleUnload);
    }
  }

  function handleUnload() {
    // Fire and forget — we can't await inside a beforeunload handler and get
    // consistent behavior across browsers. The synchronous kick of the write
    // is enough; the client's connection stays open long enough in most
    // cases for the write to complete.
    upload({ final: true });
  }

  return { start, stop, upload, sessionId: SESSION_ID };
}

export const READ_TELEMETRY_SESSION_ID = SESSION_ID;
