// The SDK is loaded from gstatic on demand so the site stays build-free.

import {
  FIREBASE_CONFIG,
  MAX_PLAYLIST_ROWS,
  SDK,
  STATIC_JSON_MAX_CONSECUTIVE_FAILURES,
  STATIC_JSON_POLL_MS,
  STATIC_JSON_URL_TEMPLATE,
  isPlaylist,
  resolveReadSource,
} from "./config.js";
import {
  readIconKeyCache,
  readPlaylistCache,
  writeIconKeyCache,
  writePlaylistCache,
} from "./local-cache.js";

const APP_URL = `https://www.gstatic.com/firebasejs/${SDK}/firebase-app.js`;
const FIRESTORE_URL = `https://www.gstatic.com/firebasejs/${SDK}/firebase-firestore.js`;
const AUTH_URL = `https://www.gstatic.com/firebasejs/${SDK}/firebase-auth.js`;

function playlistQuerySpec(playlist) {
  if (!isPlaylist(playlist)) throw new Error("Unknown playlist.");
  return {
    playlist,
    orderField: playlist === "wins" ? "wins" : "mmr",
    direction: "desc",
    limit: MAX_PLAYLIST_ROWS,
  };
}

function describeError(error) {
  const code = String(error?.code ?? "");
  if (code.includes("permission-denied")) {
    return "Firebase denied this request. Sign in with an approved admin account.";
  }
  if (code.includes("failed-precondition")) {
    return "This leaderboard index is not ready yet. Showing a one-time fallback when available.";
  }
  if (code.includes("unavailable")) {
    return "Firebase is temporarily unavailable. Cached rankings will stay visible.";
  }
  return error?.message || "Firebase request failed.";
}

function rawDocuments(snapshot) {
  return snapshot.docs.map((entry) => ({ ...entry.data(), id: entry.id }));
}

// Cap for the changes list so a runaway diff can't flood the render layer.
// A full-roster churn on top-100 could produce 200 events (100 left + 100
// entered); the render layer only needs enough to sparkle, not audit.
export const MAX_CHANGES_PER_POLL = 50;

function numericOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Diffs the incoming rows against the previous poll and returns the
// row-level change events the render layer can animate against. Pure and
// stateless — the caller owns "previous rows" storage.
//
// previousRows may be null (first poll) — in which case we return [] because
// there's no baseline. Identity is by `id` (the Firestore doc id shape the
// render layer keys on), not sourceUserId.
//
// Change kinds emitted:
//   - mmr-up / mmr-down: mmr moved
//   - streak-up: currentStreak increased
//   - streak-broken: currentStreak dropped to <=0 or below previous
//   - entered-top100: id present now, absent previously
//   - left-top100: id present previously, absent now (event carries the
//                  outgoing row's id so the render layer can flash-and-clear)
export function computeRowChanges(previousRows, nextRows, options = {}) {
  const { maxChanges = MAX_CHANGES_PER_POLL } = options;

  if (!Array.isArray(previousRows)) return [];
  if (!Array.isArray(nextRows)) return [];

  const previousById = new Map();
  for (const row of previousRows) {
    if (row && typeof row.id === "string") previousById.set(row.id, row);
  }

  const nextIds = new Set();
  const changes = [];

  const push = (change) => {
    if (changes.length < maxChanges) changes.push(change);
  };

  for (const row of nextRows) {
    if (!row || typeof row.id !== "string") continue;
    nextIds.add(row.id);
    const prev = previousById.get(row.id);

    if (!prev) {
      push({ id: row.id, kind: "entered-top100" });
      continue;
    }

    const prevMmr = numericOrNull(prev.mmr);
    const nextMmr = numericOrNull(row.mmr);
    if (prevMmr != null && nextMmr != null && nextMmr !== prevMmr) {
      push({
        id: row.id,
        kind: nextMmr > prevMmr ? "mmr-up" : "mmr-down",
        from: prevMmr,
        to: nextMmr,
      });
    }

    const prevStreak = numericOrNull(prev.currentStreak);
    const nextStreak = numericOrNull(row.currentStreak);
    if (prevStreak != null && nextStreak != null && nextStreak !== prevStreak) {
      // "Broken" means the streak collapsed — dropped to zero/negative or
      // decreased from a positive value. Anything else that goes up we call
      // streak-up (extending a win streak or climbing out of a loss streak).
      if (nextStreak <= 0 && prevStreak > 0) {
        push({ id: row.id, kind: "streak-broken", from: prevStreak, to: nextStreak });
      } else if (nextStreak < prevStreak && prevStreak > 0) {
        push({ id: row.id, kind: "streak-broken", from: prevStreak, to: nextStreak });
      } else if (nextStreak > prevStreak) {
        push({ id: row.id, kind: "streak-up", from: prevStreak, to: nextStreak });
      }
    }
  }

  for (const [id] of previousById) {
    if (!nextIds.has(id)) push({ id, kind: "left-top100" });
  }

  return changes;
}

function staticJsonUrl(playlist, template = STATIC_JSON_URL_TEMPLATE) {
  return template.replace("{playlist}", encodeURIComponent(playlist));
}

// Public read path that polls the static JSON blob on the CDN. Uses
// If-None-Match so 304s don't re-parse, seeds first paint from the same
// local cache the Firestore path uses, and — after
// STATIC_JSON_MAX_CONSECUTIVE_FAILURES consecutive errors — hands off to the
// provided firestoreFallback so a bad CDN deploy can't take the site down.
//
// Exported for testability. The gateway wires firestoreFallback to the real
// subscribePlaylist closure.
export function subscribePlaylistJson(playlist, handlers, options = {}) {
  if (!isPlaylist(playlist)) throw new Error("Unknown playlist.");

  const {
    fetch: fetchImpl = globalThis.fetch?.bind(globalThis),
    setInterval: setIntervalImpl = globalThis.setInterval.bind(globalThis),
    clearInterval: clearIntervalImpl = globalThis.clearInterval.bind(globalThis),
    urlTemplate = STATIC_JSON_URL_TEMPLATE,
    pollMs = STATIC_JSON_POLL_MS,
    maxFailures = STATIC_JSON_MAX_CONSECUTIVE_FAILURES,
    firestoreFallback = null,
    logger = console,
  } = options;

  if (typeof fetchImpl !== "function") {
    throw new Error("subscribePlaylistJson requires a fetch implementation.");
  }

  let active = true;
  let etag = null;
  let consecutiveFailures = 0;
  let fallbackUnsubscribe = null;
  let intervalHandle = null;
  // Baseline for per-poll delta detection. Stays null until the FIRST live
  // (non-cache) payload lands — first poll emits changes:[] because there's
  // nothing valid to compare against. The cache paint uses fromCache:true and
  // is not used as a baseline (cached rows may be stale/out-of-order).
  let previousRows = null;

  const url = staticJsonUrl(playlist, urlTemplate);

  // Paint from localStorage cache first so the site has a "last known"
  // snapshot before the first fetch resolves. Matches the Firestore path.
  const localCached = readPlaylistCache(playlist);
  if (localCached?.rows?.length) {
    handlers.next({ rows: localCached.rows, fromCache: true, changes: [] });
  }

  async function poll() {
    if (!active || fallbackUnsubscribe) return;

    const headers = {};
    if (etag) headers["If-None-Match"] = etag;

    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers,
        cache: "no-store",
      });

      if (!active || fallbackUnsubscribe) return;

      if (response.status === 304) {
        consecutiveFailures = 0;
        return;
      }

      if (!response.ok) {
        throw new Error(`Static JSON fetch failed with HTTP ${response.status}.`);
      }

      const nextEtag = response.headers?.get?.("ETag") || null;
      const payload = await response.json();
      const rows = Array.isArray(payload?.rows) ? payload.rows : [];

      if (!active || fallbackUnsubscribe) return;

      etag = nextEtag;
      consecutiveFailures = 0;
      writePlaylistCache(playlist, rows);
      handlers.next({ rows, fromCache: false });
    } catch (error) {
      if (!active || fallbackUnsubscribe) return;
      consecutiveFailures += 1;

      if (consecutiveFailures >= maxFailures) {
        const wrapped = new Error(
          `Static JSON path failed ${consecutiveFailures} times; ` +
          `falling back to Firestore. Last error: ${error?.message || error}`,
        );
        wrapped.cause = error;
        wrapped.userMessage = "Live updates temporarily unavailable. Reconnecting…";

        try { handlers.error?.(wrapped); } catch {}

        if (typeof firestoreFallback === "function") {
          logger?.info?.("[rgLB] static JSON path failing; switching to Firestore fallback");
          if (intervalHandle) {
            clearIntervalImpl(intervalHandle);
            intervalHandle = null;
          }
          try {
            fallbackUnsubscribe = firestoreFallback(playlist, handlers) || null;
          } catch (fallbackError) {
            logger?.error?.("[rgLB] Firestore fallback failed to start", fallbackError);
          }
        }
      }
    }
  }

  // Kick off the first poll immediately; setInterval only handles subsequent
  // ticks so users don't wait a full pollMs for their first live paint.
  poll();
  intervalHandle = setIntervalImpl(poll, pollMs);

  return () => {
    active = false;
    if (intervalHandle) {
      clearIntervalImpl(intervalHandle);
      intervalHandle = null;
    }
    if (typeof fallbackUnsubscribe === "function") {
      try { fallbackUnsubscribe(); } catch {}
      fallbackUnsubscribe = null;
    }
  };
}

export async function createFirebaseGateway() {
  const [{ initializeApp }, firestoreMod, authMod] = await Promise.all([
    import(APP_URL),
    import(FIRESTORE_URL),
    import(AUTH_URL),
  ]);

  const {
    addDoc,
    collection,
    deleteDoc,
    doc,
    getDocs,
    getFirestore,
    limit,
    onSnapshot,
    orderBy,
    query,
    serverTimestamp,
    updateDoc,
    where,
  } = firestoreMod;

  const {
    getAuth,
    GoogleAuthProvider,
    onAuthStateChanged,
    signInWithPopup,
    signOut,
  } = authMod;

  const app = initializeApp(FIREBASE_CONFIG);
  const db = getFirestore(app);
  const auth = getAuth(app);
  const provider = new GoogleAuthProvider();
  const leaderboard = collection(db, "leaderboard");
  const iconKey = collection(db, "iconKey");
  let iconKeyCache = null;

  function subscribePlaylist(playlist, handlers) {
    const spec = playlistQuerySpec(playlist);
    const liveQuery = query(
      leaderboard,
      where("playlist", "==", spec.playlist),
      orderBy(spec.orderField, spec.direction),
      limit(spec.limit),
    );
    let active = true;

    const local = readPlaylistCache(playlist);
    if (local?.rows?.length) {
      handlers.next({ rows: local.rows, fromCache: true });
    }

    const unsubscribe = onSnapshot(
      liveQuery,
      { includeMetadataChanges: true },
      (snapshot) => {
        if (!active) return;
        const rows = rawDocuments(snapshot);
        if (!snapshot.metadata.fromCache) writePlaylistCache(playlist, rows);
        handlers.next({ rows, fromCache: snapshot.metadata.fromCache });
      },
      async (error) => {
        if (!active) return;
        if (String(error?.code).includes("failed-precondition")) {
          try {
            const fallbackQuery = query(
              leaderboard,
              where("playlist", "==", spec.playlist),
              limit(spec.limit),
            );
            const snapshot = await getDocs(fallbackQuery);
            if (!active) return;
            const rows = rawDocuments(snapshot);
            writePlaylistCache(playlist, rows);
            handlers.next({
              rows,
              fromCache: true,
              degradedReason:
                `${spec.playlist} is using a one-time fallback until the ` +
                `playlist + ${spec.orderField} descending index is ready.`,
            });
            return;
          } catch (fallbackError) {
            error = fallbackError;
          }
        }
        const wrapped = new Error(describeError(error));
        wrapped.code = error?.code;
        wrapped.userMessage = wrapped.message;
        handlers.error(wrapped);
      },
    );

    return () => {
      active = false;
      unsubscribe();
    };
  }

  // Dispatcher: picks the read path per-subscription so a mid-session
  // localStorage or URL flip takes effect the next time a playlist activates.
  // Anything unrecognized is treated as "firestore" so a corrupt config can't
  // strand the site on a broken path.
  function subscribePlaylistDispatch(playlist, handlers) {
    const source = resolveReadSource();
    if (source === "static") {
      return subscribePlaylistJson(playlist, handlers, {
        firestoreFallback: subscribePlaylist,
      });
    }
    return subscribePlaylist(playlist, handlers);
  }

  // Announce the initial mode so it's obvious in DevTools which path a
  // client is running. Individual subscriptions re-resolve, but this is the
  // single "why is this tab acting weird" breadcrumb during rollout.
  console.info("[rgLB] read source:", resolveReadSource());

  async function loadIconKey(force = false) {
    if (!force && iconKeyCache) return iconKeyCache;
    if (!force) {
      const local = readIconKeyCache();
      if (local?.rows?.length) {
        iconKeyCache = local.rows;
        return iconKeyCache;
      }
    }
    const snapshot = await getDocs(iconKey);
    iconKeyCache = rawDocuments(snapshot);
    writeIconKeyCache(iconKeyCache);
    return iconKeyCache;
  }

  return {
    // Dispatched at call-time based on resolveReadSource(). The historical
    // Firestore path is preserved as the fallback and rollback route.
    subscribePlaylist: subscribePlaylistDispatch,
    observeAuth: (callback) => onAuthStateChanged(auth, callback),
    signIn: () => signInWithPopup(auth, provider),
    signOut: () => signOut(auth),
    loadIconKey,
    addPlayer: (payload) => addDoc(leaderboard, { ...payload, lastWriteAt: serverTimestamp() }),
    updatePlayer: (id, payload) => updateDoc(doc(db, "leaderboard", id), { ...payload, lastWriteAt: serverTimestamp() }),
    // One-shot: read every player from the wins collection so admins can see
    // who's running which HUD version. Wins is the canonical "seen once ever"
    // collection since every HUD-synced player gets a wins doc.
    loadPlayerRoster: async () => {
      const snapshot = await getDocs(query(leaderboard, where("playlist", "==", "wins"), limit(MAX_PLAYLIST_ROWS)));
      return rawDocuments(snapshot);
    },
    deletePlayer: (id) => deleteDoc(doc(db, "leaderboard", id)),
    addIcon: (payload) => addDoc(iconKey, payload),
    deleteIcon: (id) => deleteDoc(doc(db, "iconKey", id)),
  };
}
