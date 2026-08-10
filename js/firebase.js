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
import { createReadBudget } from "./read-budget.js";

const APP_URL = `https://www.gstatic.com/firebasejs/${SDK}/firebase-app.js`;
const APP_CHECK_URL = `https://www.gstatic.com/firebasejs/${SDK}/firebase-app-check.js`;
const FIRESTORE_URL = `https://www.gstatic.com/firebasejs/${SDK}/firebase-firestore.js`;
const AUTH_URL = `https://www.gstatic.com/firebasejs/${SDK}/firebase-auth.js`;

// Public reCAPTCHA v3 site key. Domain-restricted to wiljdaws.github.io
// in the reCAPTCHA admin. Locks Firestore reads to our own sites once
// App Check enforcement is turned on in the Firebase console.
const RECAPTCHA_SITE_KEY = "6LetM38tAAAAADvHq4SYd05r_DGK2AWJo8M3ZmJK";

// Published by the Tampermonkeys publish workflow every 15 min.
const READ_STATS_SNAPSHOT_URL = "https://raw.githubusercontent.com/wiljdaws/rg_player_leaderboard/data/state/read-stats.json";

function playlistQuerySpec(playlist) {
  if (!isPlaylist(playlist)) throw new Error("Unknown playlist.");
  return {
    playlist,
    orderField: playlist === "wins" ? "wins" : playlist === "tournament" ? "score" : "mmr",
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

// Pure helper: given whether this is the first snapshot for a subscription,
// the snapshot's total doc count, and how many doc-level changes it carries,
// return how many reads to charge the budget.
//
//   - First fire  → snapshot.size (full initial paint). Falls back to 1 when
//     size is 0/missing so an empty first result still counts as one query.
//   - Later fires → docChanges.length AS-IS (no min-1 clamp). A metadata-only
//     fire has 0 doc-changes and MUST cost 0 reads — clamping it to 1 is
//     what produced the 721-reads-in-6-seconds telemetry spike on 1v1.
//
// Exported for unit tests. Callers pass raw numbers; snapshot inspection
// stays in the onSnapshot wrapper.
export function computeSnapshotCharge({ isFirstFire, size = 0, changeCount = 0 } = {}) {
  if (isFirstFire) return Math.max(1, Number(size) || 1);
  const changes = Number(changeCount) || 0;
  return changes > 0 ? changes : 0;
}

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

// JSON rows drop the playlist and (for HUD-sourced rows) sourceUserId to save
// bytes; put them back so the validator accepts the row. Tournament JSON keeps
// the doc id directly and has no uid — treat it separately.
function expandCompactRow(row, playlist) {
  if (!row || typeof row !== "object") return row;
  if (playlist === "tournament") {
    return { ...row, playlist };
  }
  if (row.id) return row;
  const uid = typeof row.uid === "string" ? row.uid : "";
  return {
    ...row,
    id: uid ? `${uid}_${playlist}` : "",
    playlist,
    sourceUserId: uid,
  };
}

function expandCompactRows(rows, playlist) {
  return Array.isArray(rows) ? rows.map(row => expandCompactRow(row, playlist)) : [];
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
    handlers.next({ rows: expandCompactRows(localCached.rows, playlist), fromCache: true, changes: [] });
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
        // Re-emit so the row re-renders and "X ago" tooltips tick forward.
        // Also refresh localStorage's fetchedAt so its TTL doesn't lie.
        if (previousRows?.length) {
          writePlaylistCache(playlist, previousRows);
          handlers.next({ rows: previousRows, fromCache: false, changes: [] });
        }
        return;
      }

      if (response.status === 404) {
        // Blob doesn't exist yet (new playlist, first deploy, etc). Trip
        // the fallback right away instead of pretending it's a flaky
        // network and making the user wait 3 poll cycles.
        consecutiveFailures = maxFailures;
        throw new Error(`Static JSON not found (404) for playlist "${playlist}".`);
      }
      if (!response.ok) {
        throw new Error(`Static JSON fetch failed with HTTP ${response.status}.`);
      }

      const nextEtag = response.headers?.get?.("ETag") || null;
      const payload = await response.json();
      const rows = expandCompactRows(payload?.rows, playlist);

      if (!active || fallbackUnsubscribe) return;

      etag = nextEtag;
      consecutiveFailures = 0;
      writePlaylistCache(playlist, rows);
      // First live poll has no baseline → changes:[]. Every subsequent poll
      // diffs against the last poll's rows so the render layer can animate
      // MMR/streak deltas and top-100 entries/exits.
      const changes = computeRowChanges(previousRows, rows);
      previousRows = rows;
      handlers.next({ rows, fromCache: false, changes });
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
  const [{ initializeApp }, appCheckMod, firestoreMod, authMod] = await Promise.all([
    import(APP_URL),
    import(APP_CHECK_URL),
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
    setDoc,
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

  // App Check attaches a reCAPTCHA v3 attestation to every Firestore
  // request. Once enforcement is on in the Firebase console, only our
  // whitelisted domains can read/write. Init errors are non-fatal so
  // preview builds without console setup still boot.
  try {
    const { initializeAppCheck, ReCaptchaV3Provider } = appCheckMod;
    initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(RECAPTCHA_SITE_KEY),
      isTokenAutoRefreshEnabled: true,
    });
  } catch (error) {
    console.warn("[firebase] App Check init failed", error);
  }

  const db = getFirestore(app);
  const auth = getAuth(app);
  const provider = new GoogleAuthProvider();
  const leaderboard = collection(db, "leaderboard");
  const tournamentBoard = collection(db, "tournament_leaderboard");
  const iconKey = collection(db, "iconKey");
  const boardFor = (pl) => (pl === "tournament" ? tournamentBoard : leaderboard);
  const collectionNameFor = (pl) => (pl === "tournament" ? "tournament_leaderboard" : "leaderboard");
  const adminReadStats = collection(db, "admin_read_stats");
  const hudReadStats = collection(db, "hud_read_stats");
  const readStatsTotal = collection(db, "read_stats_total");
  let iconKeyCache = null;

  // --- Read budget ---------------------------------------------------------
  //
  // Guards runtime Firestore reads. Soft cap warns, hard cap tears down
  // every live listener and flips a 15-min cool-off flag to localStorage so
  // a cache-bust storm can't blast the quota. Query-string overrides:
  //   ?readBudget=off   → count but don't enforce
  //   ?readBudget=debug → makes the admin widget visible for any user (used
  //                       in app.js, not here — kept as a doc breadcrumb)
  const readBudgetParam = (() => {
    try { return new URL(window.location.href).searchParams.get("readBudget"); }
    catch { return null; }
  })();
  const enforcementDisabled = readBudgetParam === "off";
  const budget = createReadBudget({});
  // Expose for DevTools. Nothing in the app reads this — it's an ops handle.
  try { globalThis.__rgReadBudget = budget; } catch {}

  // All live listener teardowns. On trip we drain the set and refuse to
  // spin up new listeners until the cool-off elapses.
  const activeUnsubscribes = new Set();
  let blocked = budget.isTripped() && !enforcementDisabled;

  function announceTrip(snap) {
    try {
      document.dispatchEvent(
        new CustomEvent("rgLB:read-budget-tripped", { detail: snap }),
      );
    } catch {}
  }

  budget.onTrip((snap) => {
    if (enforcementDisabled) return;
    blocked = true;
    for (const off of Array.from(activeUnsubscribes)) {
      activeUnsubscribes.delete(off);
      try { off(); } catch {}
    }
    announceTrip(snap);
  });

  // If we boot straight into a cool-off (persisted from a previous session),
  // announce it once so the admin widget can paint the red chip immediately.
  if (blocked) announceTrip(budget.snapshot());

  async function chargedGetDocs(target, label) {
    try {
      const snapshot = await getDocs(target);
      budget.charge(label, Math.max(1, snapshot.size || 1));
      return snapshot;
    } catch (err) {
      if (String(err?.code ?? "").includes("permission-denied")) {
        budget.chargeDeny(label);
      }
      throw err;
    }
  }

  // Wraps a write so a permission-denied bumps the deny counter.
  async function chargedWrite(label, fn) {
    try {
      return await fn();
    } catch (err) {
      if (String(err?.code ?? "").includes("permission-denied")) {
        budget.chargeDeny(label);
      }
      throw err;
    }
  }

  // Wraps onSnapshot with the read budget.
  //
  // Charging model:
  //   - First data snapshot: snapshot.size (initial paint = full set)
  //   - Subsequent snapshots: snapshot.docChanges().length (deltas only,
  //     no min-1 clamp — a metadata-only fire is 0 real doc reads and should
  //     stay 0 in the counter).
  //
  // We intentionally do NOT pass { includeMetadataChanges: true } here.
  // With it on, Firestore fires the callback again every time it flips
  // metadata.fromCache from true→false (and back again on network hiccups).
  // Those fires carry zero real doc changes but were previously charged
  // Math.max(1, 0) = 1 read each, and each unsubscribe/resubscribe
  // (tab-focus, visibility change) re-armed the "first snapshot" branch and
  // charged another snapshot.size worth of reads. Telemetry caught a session
  // charging 721 reads for one playlist in ~6s — that's this bug.
  //
  // snapshot.metadata.fromCache is still populated on data snapshots without
  // the flag, so downstream callers (listener-manager status pills) keep
  // working. What we lose is the standalone "server caught up, no data
  // changed" fire — the site does not need it.
  function chargedOnSnapshot(target, label, next, error) {
    let firstDelivered = false;
    const unsub = onSnapshot(
      target,
      (snap) => {
        const isFirstFire = !firstDelivered;
        if (isFirstFire) firstDelivered = true;
        const cost = computeSnapshotCharge({
          isFirstFire,
          size: snap.size,
          changeCount: snap.docChanges().length,
        });
        if (cost > 0) budget.charge(label, cost);
        try { next?.(snap); } catch (err) { console.error("[rgLB] onSnapshot handler threw", err); }
      },
      (err) => {
        if (String(err?.code ?? "").includes("permission-denied")) {
          budget.chargeDeny(label);
        }
        try { error?.(err); } catch {}
      },
    );

    const wrapped = () => {
      activeUnsubscribes.delete(wrapped);
      try { unsub(); } catch {}
    };
    activeUnsubscribes.add(wrapped);
    return wrapped;
  }

  function subscribePlaylist(playlist, handlers) {
    // Cool-off: refuse to spin up a live listener while the hard cap is
    // still tripped. Static JSON path is orthogonal and remains available.
    if (blocked) {
      const wrapped = new Error("Read cap tripped — updates paused for 15 min.");
      wrapped.userMessage = "Read cap tripped — updates paused for 15 min.";
      try { handlers.error?.(wrapped); } catch {}
      return () => {};
    }

    const spec = playlistQuerySpec(playlist);
    const boardCollection = boardFor(spec.playlist);
    // Tournament lives in its own collection so the playlist filter is
    // redundant — dropping it means we don't need a composite index just to
    // sort by score.
    const liveQuery = spec.playlist === "tournament"
      ? query(boardCollection, orderBy(spec.orderField, spec.direction), limit(spec.limit))
      : query(
          boardCollection,
          where("playlist", "==", spec.playlist),
          orderBy(spec.orderField, spec.direction),
          limit(spec.limit),
        );
    let active = true;
    // Same "no baseline until first live payload" rule as the JSON path so
    // both read sources produce identical event shapes for the render layer.
    let previousRows = null;

    const local = readPlaylistCache(playlist);
    if (local?.rows?.length) {
      handlers.next({ rows: local.rows, fromCache: true, changes: [] });
    }

    const unsubscribe = chargedOnSnapshot(
      liveQuery,
      `playlist:${spec.playlist}`,
      (snapshot) => {
        if (!active) return;
        const rows = rawDocuments(snapshot);
        if (!snapshot.metadata.fromCache) writePlaylistCache(playlist, rows);
        // Only diff live (non-cache) snapshots — cache metadata snapshots are
        // just Firestore telling us it painted from local; they don't carry
        // fresh field values worth animating on.
        let changes = [];
        if (!snapshot.metadata.fromCache) {
          changes = computeRowChanges(previousRows, rows);
          previousRows = rows;
        }
        handlers.next({ rows, fromCache: snapshot.metadata.fromCache, changes });
      },
      async (error) => {
        if (!active) return;
        if (String(error?.code).includes("failed-precondition")) {
          try {
            const fallbackQuery = spec.playlist === "tournament"
              ? query(boardCollection, limit(spec.limit))
              : query(
                  boardCollection,
                  where("playlist", "==", spec.playlist),
                  limit(spec.limit),
                );
            const snapshot = await chargedGetDocs(fallbackQuery, "leaderboardFallback");
            if (!active) return;
            const rows = rawDocuments(snapshot);
            writePlaylistCache(playlist, rows);
            // One-shot getDocs fallback — no baseline, no animation.
            handlers.next({
              rows,
              fromCache: true,
              changes: [],
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
    const snapshot = await chargedGetDocs(iconKey, "iconKey");
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
    addPlayer: (payload) => chargedWrite("addPlayer", () =>
      addDoc(boardFor(payload?.playlist), { ...payload, lastWriteAt: serverTimestamp() })),
    updatePlayer: (id, payload) => chargedWrite("updatePlayer", () =>
      updateDoc(doc(db, collectionNameFor(payload?.playlist), id), { ...payload, lastWriteAt: serverTimestamp() })),
    deletePlayer: (id, playlist) => chargedWrite("deletePlayer", () =>
      deleteDoc(doc(db, collectionNameFor(playlist), id))),
    // Wipes every row from the tournament collection — used by the admin
    // "Clear all" button between tournaments.
    clearTournament: async () => {
      const snap = await chargedGetDocs(tournamentBoard, "tournamentClear");
      await Promise.all(snap.docs.map((d) =>
        chargedWrite("deleteTournamentPlayer", () => deleteDoc(d.ref))));
      return snap.size;
    },
    addIcon: (payload) => chargedWrite("addIcon", () => addDoc(iconKey, payload)),
    deleteIcon: (id) => chargedWrite("deleteIcon", () => deleteDoc(doc(db, "iconKey", id))),
    // Read budget handle — admin widget reads snapshots off this on a poll.
    readBudget: budget,
    // Cross-session telemetry: uploads the current read-budget snapshot to
    // admin_read_stats/{docKey} so we can attribute daily read totals to
    // specific features. Merge-write so periodic polls keep updating the
    // same doc without re-creating it. Rules restrict this collection to
    // admin writers.
    setReadStat: (docKey, payload) => chargedWrite("setReadStat", () =>
      setDoc(doc(db, "admin_read_stats", docKey), payload, { merge: true })),
    // Query the admin_read_stats collection for a date range. Both `from`
    // and `to` are inclusive `YYYY-MM-DD` strings; the field they compare
    // against is a string, and `YYYY-MM-DD` sorts lexicographically the
    // same way it sorts chronologically, so `>=` / `<=` are safe. This is
    // the read half of the "Reads" admin dashboard — the write half is
    // setReadStat above. Charged reads use the "readStatsQuery" label so
    // opening the dashboard shows up cleanly in the read budget breakdown.
    fetchAdminReadStats: async (from, to) => {
      const snapshot = await chargedGetDocs(
        query(adminReadStats, where("date", ">=", from), where("date", "<=", to)),
        "readStatsQuery",
      );
      return rawDocuments(snapshot);
    },
    // Preferred by createReadStatsQuery; the chargedGetDocs paths above
    // stay as the fallback.
    fetchReadStatsSnapshot: async () => {
      const response = await fetch(READ_STATS_SNAPSHOT_URL, { cache: "no-store" });
      if (!response.ok) throw new Error(`read-stats snapshot fetch ${response.status}`);
      return response.json();
    },
    // Same as fetchAdminReadStats but for hud_read_stats — one doc per HUD
    // per day, merge-updated every ~5 min. `readTotal` / `writeTotal` are
    // the running totals for the HUD's session, not per-window counters,
    // so aggregation should treat them as latest-known-state, not sums
    // over time. Charged with the "hudStatsQuery" label.
    fetchHudReadStats: async (from, to) => {
      const snapshot = await chargedGetDocs(
        query(hudReadStats, where("date", ">=", from), where("date", "<=", to)),
        "hudStatsQuery",
      );
      return rawDocuments(snapshot);
    },
    // Firestore-project-wide totals written every 3h by the Cloud Monitoring
    // cron (see Tampermonkeys/firebase/scripts/fetch-firestore-usage.mjs).
    // One doc per UTC day; delta from our attributed reads = untracked
    // (Pal's site + old HUDs + scrapers). Charged with a distinct label so
    // the dashboard's per-label breakdown shows what the dashboard itself
    // costs to open.
    fetchReadStatsTotal: async (from, to) => {
      const snapshot = await chargedGetDocs(
        query(readStatsTotal, where("date", ">=", from), where("date", "<=", to)),
        "totalStatsQuery",
      );
      return rawDocuments(snapshot);
    },
  };
}
