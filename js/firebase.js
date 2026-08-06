// The SDK is loaded from gstatic on demand so the site stays build-free.

import { FIREBASE_CONFIG, MAX_PLAYLIST_ROWS, SDK, isPlaylist } from "./config.js";
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
    subscribePlaylist,
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
