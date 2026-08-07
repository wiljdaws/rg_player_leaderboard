# Firestore read-cost migration plan

_Last updated: 2026-08-06_

## TL;DR

- **Immediate quota crunch is architectural, not data-model.** 102K reads/day
  hit Firebase's free ceiling because every site viewer subscribes to a live
  Firestore query and every HUD write fans out to every viewer.
- **The right move is a small hybrid migration, not a full rewrite.** Move
  the *site's public reads* off Firestore onto a static JSON blob served
  from a CDN. Keep Firestore for HUD writes, admin CRUD, and admin reads.
- **Projected cost at 1000 users: under $1/mo, all-in.** Read pressure on
  Firestore drops to effectively zero for public traffic.
- **Effort: ~2 weeks of focused solo work, fully reversible via a config flag.**
- **Do not migrate to Supabase.** Its Free tier has a 7-day auto-pause and
  a 200-concurrent-realtime-client cap that are worse for a hobby workload.
- **A full Cloudflare migration is viable long-term** but not needed now.
  Revisit if the hybrid path stops being enough.

---

## Contents

1. [Why we're here](#why-were-here)
2. [What we evaluated](#what-we-evaluated)
3. [Recommended path: hybrid static-JSON](#recommended-path-hybrid-static-json)
4. [Timeline](#timeline)
5. [Rollback plan](#rollback-plan)
6. [Costs at 100 / 500 / 1000 users](#costs-at-100--500--1000-users)
7. [Optional future: full Cloudflare migration](#optional-future-full-cloudflare-migration)
8. [Why not Supabase](#why-not-supabase)
9. [Open questions](#open-questions)

---

## Why we're here

The Firebase console showed:

- **102K Firestore reads in 24h** (free tier is 50K/day → warning triggered)
- 2.3K writes, 5 deletes — writes are not the problem
- 15 peak concurrent snapshot listeners

The reads break down roughly as:

| Source | Estimated share |
|---|---|
| Site's `onSnapshot` subscriptions × HUD write fan-out | ~50% |
| HUD opponent-popup cache reading top-100 directly (`useLeaderboardCache: false` default) | ~30% |
| Dev thrash today (heavy iteration + cache-busted reloads) | ~10-15% |
| Admin roster fetch (100 reads per admin sign-in, no cache) | ~5% |
| Config + blacklist lookups + everything else | ~<1% |

The architectural root cause: `onSnapshot` charges **1 read per document per
change**. When any player's stats update, every listener on that playlist gets
charged for the affected doc. At 100-doc top lists × 15 concurrent viewers ×
frequent HUD writes, this is inherently expensive.

---

## What we evaluated

Three parallel research passes were run (see git log for the agent-generated
reports embedded in commit history):

### 1. Supabase (Postgres + realtime, full migration)

Would replace Firestore entirely. Postgres + Realtime channels + Auth.

**Verdict: don't do it.**

- 7-day auto-pause on the Free tier makes Pro ($25/mo) mandatory in practice
- 200 concurrent Realtime clients on Free (lower than Firebase Spark's ceiling)
- Migration effort: **40-60 hours solo** plus coordination with abuarqob's
  site (which shares the Firebase project)
- The one real win — collapsing 700 lines of Firestore rules to ~80 lines of
  RLS + Postgres CHECK constraints — isn't worth the effort by itself
- Realtime cost model is comparable to Firestore, not clearly cheaper

### 2. Cloudflare full stack (Workers + D1 + R2 + optional DOs)

Would replace Firestore with SQLite-at-edge and serve reads through Workers.

**Verdict: viable long-term, but overkill for now.**

- $5/mo Workers Paid is effectively mandatory for headroom (10M req/mo included)
- Skipping Durable Objects (realtime WebSockets) and using cron-generated
  static JSON in R2 is the killer pattern — free-tier survivable to well
  past 1000 concurrent users because R2 egress is free and CDN caches
- Migration effort: **8-12 working days solo** (skipping DOs)
- Keep Firebase Auth as a bolt-on (Worker verifies ID token via JWKS)
- HUD becomes simpler (single `fetch` vs importing 100KB SDK from gstatic)

### 3. Static-JSON hybrid (recommended)

Firestore stays for writes and admin. Site's public reads move to a JSON
file served from Cloudflare R2, rebuilt every 60s by an existing script.

**Verdict: yes, this.**

- Existing `firebase/scripts/build-leaderboard-cache.mjs` already does 90%
  of the work — queries top-100 per playlist, hashes for idempotency,
  enforces size caps. Just retarget its output.
- Migration effort: **~2 weeks solo**, most of it in ops (Cloud Run,
  Cloud Scheduler, R2 bucket, CI credentials) not code
- Site code delta: **~15 lines** — replace `subscribePlaylist` with a
  polling `fetch`
- Cost at 1000 concurrent users: **~$1/mo total**
- Fully reversible: flip a config flag, subscription goes back to Firestore

---

## Recommended path: hybrid static-JSON

### Architecture

```
                     ┌──────────────────────────────┐
   HUD (writes)  ──► │ Firestore leaderboard/{docs} │
                     └──────────────┬───────────────┘
                                    │
                    Firestore trigger + 60s cron
                                    │
                                    ▼
                     ┌──────────────────────────────┐
                     │ Cloud Run: build-leaderboard │
                     │  reads top-100/playlist,     │
                     │  hashes, uploads to R2       │
                     └──────────────┬───────────────┘
                                    │
                                    ▼
                     ┌──────────────────────────────┐
                     │ Cloudflare R2 public bucket  │
                     │  leaderboard-1v1.json        │
                     │  leaderboard-2v2.json        │
                     │  leaderboard-3v3.json        │
                     │  leaderboard-wins.json       │
                     └──────────────┬───────────────┘
                                    │  CDN edge-cached
                                    ▼
                     ┌──────────────────────────────┐
                     │ Site (polls /leaderboard-X   │
                     │  every 30s, uses ETag)       │
                     └──────────────────────────────┘

   Admin panel   ──► Firestore (unchanged)
   HUD reads     ──► Firestore admin/blacklist, atlas_config, etc.
                     Firestore leaderboard for opponent popup
                     (already gated by useLeaderboardCache flag)
```

### What actually changes

**Site (`rg_player_leaderboard`):**

- `js/firebase.js:82-142` — `subscribePlaylist` currently opens an
  `onSnapshot` on `where playlist == X orderBy mmr desc limit 100`.
  Replace with a polling fetch:

  ```js
  async function subscribePlaylist(playlist, handlers) {
    const url = `https://cdn.rocketgoal.example/leaderboard-${playlist}.json`;
    let etag = null;
    const poll = async () => {
      const headers = etag ? { "If-None-Match": etag } : {};
      const r = await fetch(url, { headers });
      if (r.status === 304) return;               // unchanged
      if (!r.ok) return;                          // silent fail, keep last-known
      etag = r.headers.get("etag") || etag;
      const body = await r.json();
      handlers.next({ rows: body.rows, fromCache: false });
    };
    await poll();
    const id = setInterval(poll, 30_000);
    return () => clearInterval(id);
  }
  ```

- `js/local-cache.js` — keep as-is. Local `localStorage` cache still serves
  the first paint before the initial poll returns.
- Admin panel — no changes. `addPlayer` / `updatePlayer` / `deletePlayer`
  still write to Firestore. `loadPlayerRoster` still reads Firestore
  (with the 5-min cache we already shipped in `3fa3aff`).
- Config: expose a `USE_STATIC_JSON` boolean somewhere obvious so we can
  flip back to `onSnapshot` in one commit if the JSON pipeline breaks.

**HUD (`rg_hud.user.js`):**

- No changes required. Continue writing to Firestore normally.
- Opponent-popup cache already checks `atlas_config/hud.useLeaderboardCache`
  (already recommended to flip → true in the Firebase console).

**Infrastructure (new, in `Tampermonkeys` repo):**

- `firebase/scripts/build-leaderboard-cache.mjs` already builds the JSON
  shape we need. Add an `--emit-json` flag that also uploads the JSON to
  R2 via its S3-compatible API (using `@aws-sdk/client-s3` or a small
  hand-rolled signer to avoid dependencies).
- **Cloud Run service** wrapping the script. Same auth pattern as the
  existing `firestore-aggregates.yml` workflow (Workload Identity
  Federation → GCP service account with Firestore reader role).
- **Cloud Scheduler job** hitting the Cloud Run endpoint on `*/1 * * * *`
  (60-second cron). Free tier covers 3 scheduled jobs; we only need 1.
- **Firestore trigger** (2nd-gen Cloud Function) on any write to
  `leaderboard/{docId}`. Debounces to at most 1 rebuild per 30s. Ensures
  fresh data after a real update without waiting for the next cron tick.
- **Cloudflare R2 bucket** with a public custom domain (or Cloudflare
  Worker in front for ETag control if we want to get fancy).
- **Cloudflare Cache-Control:** `public, max-age=15, stale-while-revalidate=60`
  so client polls that arrive within 15s of each other are served from
  edge cache with zero R2 hits.

### Freshness contract

- Worst-case staleness = **90 seconds** (60s cron tick + 30s poll interval)
- Best case (Firestore-trigger rebuild + client polling): **<15 seconds**
- Both are fine for a leaderboard. Nobody stares at rank #47 waiting for
  it to tick.

---

## Timeline

Realistic solo-dev, 2-3 hours/day:

| Week | What | Deliverable |
|---|---|---|
| 1 (days 1-2) | Extend `build-leaderboard-cache.mjs` with `--emit-json` mode + R2 uploader | Script produces valid JSON blobs uploaded to R2, tested end-to-end |
| 1 (days 3-4) | Deploy Cloud Run + Cloud Scheduler wiring, verify cron | Rebuild loop firing every 60s, JSON in R2 updates |
| 1 (day 5) | Cloudflare DNS + public bucket + cache-control headers | Site can `fetch` the JSON from a stable HTTPS URL |
| 2 (days 6-7) | Swap `subscribePlaylist` on the site behind a feature flag, ship dark | Site reads from JSON when flag is on, `onSnapshot` when off |
| 2 (day 8) | Flip the flag for 25% traffic (via URL param or localStorage bucket) | Observe read count drop, validate freshness |
| 2 (day 9) | Flip to 100%, watch Firestore reads for 24h | Reads should drop to ~admin-panel + HUD only |
| 2 (day 10) | Firestore trigger for on-demand rebuild (optional polish) | Fresh JSON within seconds of an important HUD write |

If we skip the Firestore-trigger polish, the timeline shortens to ~7-8 days.

---

## Rollback plan

The whole thing hinges on a single feature flag in the site's config. If the
JSON pipeline breaks, misbehaves, or delivers stale data:

1. Flip `USE_STATIC_JSON = false` in `js/config.js` and push (Pages redeploys
   in ~1 minute).
2. Site immediately reverts to `onSnapshot` behavior.
3. R2/Cloud Run/Scheduler keep running in the background; they don't cost
   anything meaningful when idle.

Because Firestore is still receiving all HUD writes throughout the migration,
there's no data-loss risk. Only the read-path can fail; the write-path is
unchanged.

---

## Costs at 100 / 500 / 1000 users

Assuming 30 KB JSON per playlist, 4 playlists, 30-second poll:

| Users | R2 storage | R2 egress (with CF cache) | Cloud Run vCPU-sec/mo | Firestore reads/day (post-migration) |
|---|---|---|---|---|
| 100 | <1 MB | ~4 GB/mo (edge-cached, 5% miss) | ~87k (well inside 400k free) | ~1K (admin panel + HUD only) |
| 500 | <1 MB | ~22 GB/mo | ~87k | ~3K |
| 1000 | <1 MB | ~43 GB/mo | ~87k | ~6K |

- **R2 egress is free** across all Cloudflare tiers. Only paid CDNs (Firebase
  Storage, GCS without Cloud CDN) would blow up here.
- **Cloud Run stays free** for this workload (400k vCPU-sec + 2M req/mo
  included).
- **Cloud Scheduler** is free (1 job < 3 free jobs).
- **Cloudflare R2** free tier: 10 GB storage, 1M Class A ops, 10M Class B
  ops per month. Rebuilds write 4 files × 60/hr × 730 hr = 175K writes/mo,
  well inside the 1M Class A free tier.

**Total cost at 1000 users: pennies.** The only line-item that could bite
is if we hit heavy egress before the CF edge cache warms up (miss rate
much higher than 5%). Still under $5/mo worst-case at 1000 users.

---

## Optional future: full Cloudflare migration

If the hybrid path ever stops being enough (e.g., we grow past what a
60s-stale cache can serve), the full Cloudflare stack is the next step:

- **D1** (SQLite) replaces Firestore
- **Workers** replace the HUD's direct Firestore SDK usage — HUD posts to
  a Worker endpoint, Worker validates + writes to D1
- **R2** stays for the static JSON snapshots
- **Firebase Auth stays** — Workers verify Firebase ID tokens via JWKS
- **Firestore Security Rules** replaced by validation logic in Workers
  (mechanical translation of the existing 700 lines)

Effort: an additional 8-12 working days on top of what we've built for the
hybrid. Cost: $5/mo Workers Paid + pennies for D1/R2.

Do this when:

- Firestore Blaze bill starts costing more than $5/mo consistently, OR
- We want SQL joins / analytics that Firestore can't do, OR
- We want to drop Firestore as a dependency entirely for licensing/vendor
  reasons.

Not before.

---

## Why not Supabase

For posterity, so we don't re-evaluate this every quarter:

- **7-day project auto-pause on Free tier.** For a hobby leaderboard with
  intermittent traffic, this is a killer. Pro ($25/mo) is effectively
  mandatory.
- **200 concurrent Realtime clients on Free.** Lower than Firebase Spark's
  ceiling. Fine at 100 users, blocking at 500+.
- **Realtime filter limitations.** `postgres_changes` doesn't support
  `ORDER BY / LIMIT` filters. Client receives every row change in the
  playlist and must re-sort — more bandwidth and CPU than Firestore's
  ordered snapshots.
- **Replication lag** under bursty writes (1-5s vs Firestore's typical
  <500ms) — the leaderboard would visibly lag during match-end flurries.
- **Migration effort** (40-60 hours) is 2-4x the hybrid path with a worse
  outcome.

The one thing Supabase does better — replacing 700 lines of Firestore
rules with ~80 lines of RLS + CHECK constraints — is a legitimate quality
improvement, but not remotely worth the migration cost by itself. If we
ever decide the rules file is unmanageable, we can refactor it in place
instead of moving databases.

---

## Open questions

Things to answer before day 1:

1. **abuarqob's old leaderboard site.** Do we deprecate it, or teach it to
   also read from the R2 JSON? If it keeps subscribing directly to
   Firestore, our savings are capped. Ideally: PR the old repo to also
   read from R2, then quietly deprecate it.
2. **Custom domain for R2.** Do we already have a domain on Cloudflare
   DNS? If not, we can start with the R2-provided `<bucket>.r2.dev` URL
   and add a custom domain later.
3. **Firestore trigger cost.** Free tier is 2M Cloud Function invocations/mo,
   very roomy. Confirm we're comfortable relying on that pricing not
   changing.
4. **Feature-flag delivery.** Do we ship the flag via `js/config.js`
   (requires a Pages redeploy to change), URL param
   (`?readSource=static`), or a Firestore doc read on page load
   (one more read at boot, but toggleable without deploy)? URL param
   during rollout, Firestore doc for the sticky value, is probably the
   right blend.

---

## Appendix: what we already shipped today

- ✅ `perf(admin): cache the version-breakdown roster for 5 minutes`
  (commit `3fa3aff`) — kills the 100-read-per-admin-signin bleed.
- ✅ `feat(ops): Cloud Run bridge for GCP Monitoring → Discord alerts`
  (commit `d1a0665`) — lets us see the next spike before we hit quota.

Recommended pre-migration flips (Firebase console, no code):

- `atlas_config/hud.useLeaderboardCache = true` — HUDs that support the
  flag (16.4+) switch to reading 1 doc instead of 100 for opponent popup.
- `atlas_config/hud.cacheRefreshHours = 6` (or higher) — halves-to-quarters
  the frequency.
- `admin/blacklist.minVersion = 16.4` — forces old HUDs to upgrade so they
  also start using the cache. Aggressive but bounded (~40 users affected).
- `admin/latest_version.versionNum = 17.3` — updates the soft nudge target
  (should already be auto-updated by the publish workflow, but worth
  double-checking).
