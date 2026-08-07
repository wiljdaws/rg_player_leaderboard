# Emulator-first local dev setup

_Save for later — companion to [migration-plan.md](./migration-plan.md) and
[rollout-checklist.md](./rollout-checklist.md)._

## Why

On 2026-08-06 our own dev iteration cost ~50-60K Firestore reads because
every reload of the deployed site hits **production Firestore**. We
already shipped two guardrails to prevent it happening again:

- **Content-hash pre-commit hook** (this repo `.githooks/pre-commit`) —
  bumps the asset version only when JS/CSS actually change, so unrelated
  commits don't force cache-bust reloads.
- **Runtime read-budget with persistent circuit breaker** (`js/read-budget.js`)
  — auto-degrades if a session burns too many reads.

Both are *reactive* — they contain damage but don't prevent it. The
emulator setup below is the **proactive** fix: local dev iteration
touches no production data whatsoever.

## What it takes

Roughly **2-3 hours setup**, then infinite iteration at zero prod cost.

## Existing infrastructure to reuse

The Tampermonkeys repo already runs a Firestore emulator for its rules
tests. Pull these files across / reference them from here:

- `/Users/dawsonwilliams/code/Tampermonkeys/firebase/firebase.json` — emulator config
- `/Users/dawsonwilliams/code/Tampermonkeys/firebase/firestore.rules` — same rules used in prod
- `/Users/dawsonwilliams/code/Tampermonkeys/firebase/scripts/run-emulator-test.mjs` — Java 21 shim
- `/Users/dawsonwilliams/code/Tampermonkeys/firebase/scripts/snapshot-production.mjs` — one-time seed source

## Steps

### 1. Extend the site's config

Add to `js/config.js`:

```js
export const EMULATOR_CONFIG = Object.freeze({
  firestoreHost: "127.0.0.1",
  firestorePort: 8080,
  authHost: "127.0.0.1",
  authPort: 9099,
  projectIdOverride: "demo-rgleaderboard",
});

export function resolveUseEmulator({ url = null } = {}) {
  const params = new URL(url || globalThis.location?.href).searchParams;
  if (params.get("emulator") === "0") return false;
  if (params.get("emulator") === "1") return true;
  const host = globalThis.location?.hostname || "";
  return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0";
}
```

### 2. Wire the site's gateway

In `js/firebase.js`, right after `getAuth` and before any `collection()`:

```js
const { connectFirestoreEmulator } = firestoreMod;
const { connectAuthEmulator } = authMod;

const useEmulator = resolveUseEmulator();
const config = useEmulator
  ? { ...FIREBASE_CONFIG, projectId: EMULATOR_CONFIG.projectIdOverride }
  : FIREBASE_CONFIG;
const app = initializeApp(config);
const db = getFirestore(app);
const auth = getAuth(app);

if (useEmulator) {
  connectFirestoreEmulator(db, EMULATOR_CONFIG.firestoreHost, EMULATOR_CONFIG.firestorePort);
  connectAuthEmulator(auth, `http://${EMULATOR_CONFIG.authHost}:${EMULATOR_CONFIG.authPort}`, { disableWarnings: true });
  console.warn("[rgLB] EMULATOR MODE — reads/writes are local");
}
```

### 3. Seed the emulator once

From the Tampermonkeys repo:

```bash
cd /Users/dawsonwilliams/code/Tampermonkeys/firebase
npm run snapshot:production -- --project rgleaderboard
# → outputs firebase/.snapshots/{ts}-rgleaderboard/snapshot.json
```

This uses your gcloud creds and costs a one-time ~50-60K reads. Amortize
that across unlimited local reloads.

Convert the snapshot into a Firestore emulator export dir
(`firestore_export/` with `.overall_export_metadata`) with a small
transform script — one afternoon of work, or just seed the emulator
manually and `firebase emulators:export ./seed` after.

### 4. Launch the emulator

```bash
cd /Users/dawsonwilliams/code/Tampermonkeys/firebase
firebase emulators:start --only firestore,auth \
  --project demo-rgleaderboard \
  --import ./seed --export-on-exit ./seed
```

Keep this running in a background terminal. Cold boot ~4-8s on M-series
Mac. Subsequent iterations are zero-cost.

### 5. Update Playwright scripts

Every screenshot script under `/tmp/marquee-check/*.mjs` currently does:

```js
await page.goto("http://localhost:5184/?playlist=1v1", ...)
```

Change to:

```js
await page.goto("http://localhost:5184/?playlist=1v1&emulator=1", ...)
```

Single find-replace. The `resolveUseEmulator` helper picks up the flag
and the SDK auto-connects locally.

### 6. Admin auth in dev

`signInWithPopup` doesn't work against the emulator (no OAuth). Two
options:

**Preferred:** Use the Auth emulator UI at `http://127.0.0.1:4000/auth`
to seed an admin user (`underflagfg@gmail.com` matching the production
`isAdminUser` allowlist). Then swap the sign-in path in dev to
`signInWithEmailAndPassword`. Emulator rules evaluate
`request.auth.token.email` identically to prod.

**Fallback:** `signInAnonymously` and monkey-patch `isAdminUser` to
return true when `useEmulator === true`.

### 7. CI story (nice-to-have)

Once the emulator setup is stable, GitHub Actions can run integration
tests without any prod Firestore reads:

```yaml
- uses: actions/setup-java@v4
  with: { distribution: temurin, java-version: 21 }
- run: npm install -g firebase-tools
- run: firebase emulators:exec --only firestore,auth \
         --import ./seed -- "node tests/integration.mjs"
```

## Known gotchas

- SDK v10 handles emulator CORS automatically — no config changes.
- Firestore emulator uses HTTP long-polling, not WSS — no cert dance.
- `includeMetadataChanges: true` fires an extra `fromCache` snapshot
  against the emulator; harmless, but tests should filter it.
- Project ID **must** be overridden to `demo-rgleaderboard` in emulator
  mode — the SDK will complain otherwise.
- Java 21 is required for the emulator. On macOS: `brew install openjdk@21`.

## Verdict

Cleanly viable. The only real cost is the one-time seed transform.
After that, every reload during iteration is free, and Playwright
screenshot storms have zero read impact on prod. Ship this next time
you have a Saturday afternoon.
