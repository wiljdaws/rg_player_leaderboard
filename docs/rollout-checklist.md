# Static-JSON rollout checklist

_Companion to [migration-plan.md](./migration-plan.md). All code is shipped;
this doc is the operator recipe for turning it on._

## Status right now

Everything is committed, tested, and dark. The site defaults to Firestore
(`READ_SOURCE_DEFAULT = "firestore"` in `js/config.js`), so nothing about
production behavior changes until you flip the flag.

Commits already on `main`:

| Repo | Commit | What |
|---|---|---|
| Tampermonkeys | `175d5ec` | Cloud Run server, R2 uploader, `--emit-json` mode, +tests |
| Tampermonkeys | `290da89` | Deploy workflow, Scheduler setup script, deploy runbook |
| rg_player_leaderboard | `a29160f` | Read-source dispatcher, feature flag, `subscribePlaylistJson`, +tests |
| rg_player_leaderboard | `dd46306` | Per-poll delta detection (live-flair preservation), +tests |
| rg_player_leaderboard | `4097b44` | Migration plan doc |

Everything below is the operator's side. No more code changes required
unless something breaks during rollout.

---

## Phase 1 — one-time infra setup

_Estimated time: 30–45 minutes._

### 1.1 Cloudflare R2

- Sign in to https://dash.cloudflare.com → **R2 → Overview → Create bucket**
- Name: `rg-leaderboard-cache` (or whatever you prefer; remember for later)
- Location hint: closest to your GCP region (`us-central1` → `Automatic` is fine)
- **R2 → Manage R2 API Tokens → Create API Token**
  - Permission: **Object Read & Write**
  - Bucket: the one you just created
  - Save the **Access Key ID** and **Secret Access Key** (won't be shown again)
  - Also grab your **Account ID** from the R2 dashboard URL or right-side pane

### 1.2 GCP Secret Manager

Store the R2 creds and a rebuild shared secret. Run these from any shell
with `gcloud` authed:

```bash
PROJECT=rgleaderboard

# R2 creds (paste values when prompted, then Ctrl+D)
gcloud secrets create r2-access-key-id --project=$PROJECT --data-file=- <<< "PASTE_ACCESS_KEY_ID"
gcloud secrets create r2-secret-access-key --project=$PROJECT --data-file=- <<< "PASTE_SECRET_ACCESS_KEY"
gcloud secrets create r2-account-id --project=$PROJECT --data-file=- <<< "PASTE_ACCOUNT_ID"
gcloud secrets create r2-bucket --project=$PROJECT --data-file=- <<< "rg-leaderboard-cache"

# Rebuild shared secret (used by Scheduler/Firestore-trigger to call /rebuild)
gcloud secrets create rebuild-shared-secret --project=$PROJECT --data-file=- <<< "$(openssl rand -hex 32)"
```

### 1.3 Grant SA access to the secrets

The Cloud Run runtime SA needs read access to all five secrets. Default is
`{PROJECT_NUMBER}-compute@developer.gserviceaccount.com`.

```bash
PROJECT_NUMBER=$(gcloud projects describe $PROJECT --format='value(projectNumber)')
SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

for SECRET in r2-access-key-id r2-secret-access-key r2-account-id r2-bucket rebuild-shared-secret; do
  gcloud secrets add-iam-policy-binding "$SECRET" \
    --project=$PROJECT \
    --member="serviceAccount:${SA}" \
    --role=roles/secretmanager.secretAccessor
done
```

### 1.4 Grant WIF principal Cloud Run deploy access

The GitHub Actions WIF service account (`GCP_SA_EMAIL`) already has
Firestore rights but needs run.admin + serviceAccountUser to deploy:

```bash
DEPLOY_SA="<value of your GCP_SA_EMAIL github secret>"

gcloud projects add-iam-policy-binding $PROJECT \
  --member="serviceAccount:${DEPLOY_SA}" \
  --role=roles/run.admin

gcloud projects add-iam-policy-binding $PROJECT \
  --member="serviceAccount:${DEPLOY_SA}" \
  --role=roles/iam.serviceAccountUser
```

### 1.5 (Optional but recommended) Custom domain on R2

The public bucket URL is `<bucket>.<account>.r2.dev` out of the box. That
works but is ugly and rate-limited. For a real domain:

- Cloudflare dashboard → your zone → **R2 → Settings → Public access → Connect Domain**
- Pick a subdomain like `cdn.rocketgoal.example` (choose whatever you like)
- Cloudflare handles the DNS record + certs automatically
- Once connected, the JSON URLs will be
  `https://cdn.rocketgoal.example/leaderboard-1v1.json` etc.
- **Set cache rules** on the zone: Cache Rules → Create rule → match
  `hostname eq "cdn.rocketgoal.example"` → set edge cache TTL 15s and
  respect origin cache-control headers (Cloud Run sets
  `Cache-Control: public, max-age=15, stale-while-revalidate=60`).

---

## Phase 2 — first deploy

_Estimated time: 15 minutes._

### 2.1 Trigger the Cloud Run deploy

The deploy workflow (`.github/workflows/deploy-rebuild-service.yml`) fires
on any push to `main` touching `firebase/scripts/**`. Options:

**Option A (recommended):** Trigger it manually via GitHub Actions UI:

- Go to https://github.com/wiljdaws/Tampermonkeys/actions/workflows/deploy-rebuild-service.yml
- Click **Run workflow** → keep defaults (project: `rgleaderboard`) → **Run**

**Option B:** Push any tiny commit under `firebase/scripts/`:

```bash
cd /Users/dawsonwilliams/code/Tampermonkeys
git commit --allow-empty -m "chore: trigger initial rebuild service deploy"
git push origin main
```

The workflow will `gcloud run deploy` the service to `us-central1`.
Watch the run — first deploy takes ~2 minutes.

### 2.2 Capture the service URL

At the end of the deploy job, gcloud prints the URL. It'll look like
`https://leaderboard-rebuild-xxxxxxxxx-uc.a.run.app`. Save it — you need
it for the Scheduler setup and for the site config.

### 2.3 Smoke test

```bash
SERVICE_URL="https://leaderboard-rebuild-xxxxx-uc.a.run.app"
SECRET="$(gcloud secrets versions access latest --secret=rebuild-shared-secret)"

# Health
curl -sS "$SERVICE_URL/health"
# Expected: ok

# Manual rebuild
curl -sS -X POST "$SERVICE_URL/rebuild" -H "x-rebuild-secret: $SECRET"
# Expected: JSON like { "playlists": { "1v1": 100, "2v2": 100, "3v3": 100, "wins": 100 }, "ms": ... }

# Verify R2 has the objects
# Cloudflare R2 dashboard → your bucket → should see:
#   leaderboard-1v1.json
#   leaderboard-2v2.json
#   leaderboard-3v3.json
#   leaderboard-wins.json
```

If /health fails, check the Cloud Run logs. If `/rebuild` succeeds but no
R2 objects appear, check that the SA can read the R2 secrets.

### 2.4 Wire the cron

```bash
export SERVICE_URL="https://leaderboard-rebuild-xxxxx-uc.a.run.app"
export REBUILD_SHARED_SECRET="$(gcloud secrets versions access latest --secret=rebuild-shared-secret --project=rgleaderboard)"
bash /Users/dawsonwilliams/code/Tampermonkeys/firebase/scripts/setup-cloud-scheduler.sh
```

That creates `leaderboard-rebuild-cron` scheduled `*/1 * * * *`. Watch R2
timestamps for one minute — objects should update.

---

## Phase 3 — site rollout (gradual)

_Estimated time: 30 minutes across a day or two, mostly observation._

### 3.1 Point the site config at the URL

Edit `/Users/dawsonwilliams/code/rg_player_leaderboard/js/config.js`:

```js
// Before:
export const STATIC_JSON_URL_TEMPLATE = "https://cdn.rocketgoal.example/leaderboard-{playlist}.json";

// After (whatever domain you set up in 1.5, or the r2.dev URL):
export const STATIC_JSON_URL_TEMPLATE = "https://cdn.rocketgoal.io/leaderboard-{playlist}.json";
```

Commit + push. Pages redeploys. **`READ_SOURCE_DEFAULT` stays `"firestore"`
— nothing changes for the public yet.**

### 3.2 Dogfood

Open `https://wiljdaws.github.io/rg_player_leaderboard/?readSource=static&persist=1`
on your own browser. Devtools → Network tab should show:

- Fetches to `cdn.rocketgoal.io/leaderboard-1v1.json` every 30 seconds
- **No** Firestore `google.firestore.v1.Firestore/Listen` streams
- Console log: `[rgLB] read source: static`

Verify:

- Standings still render
- Names, flags, streaks, activity dots all appear
- Row changes (mmr moves, streak updates) animate — if you added the CSS
  for `changes[]` events. If not, the data is there but visually
  unchanged, which is fine.

Have Pal do the same on his end (mobile + desktop).

### 3.3 Watch reads in Firebase console

For the 24 hours that you and Pal are on `readSource=static`, the total
Firestore read count in the Firebase console should visibly plateau
around whatever the HUD + admin panel + abuarqob's site contribute.
Compare against the last "normal" day.

### 3.4 Flip the default

If dogfood looks good:

```js
// js/config.js
export const READ_SOURCE_DEFAULT = "static";
```

Commit + push. Pages redeploys. Every visitor now reads from the JSON
by default. Fallback to Firestore still triggers on 3 consecutive fetch
failures.

Watch the Firebase console for the next 24h — reads should crater.

---

## Rollback

If anything goes sideways:

**Fast rollback (5 minutes):**

Edit `js/config.js`:

```js
export const READ_SOURCE_DEFAULT = "firestore";
```

Commit + push. Pages redeploys. Site reverts to `onSnapshot` behavior.
Cloud Run, Scheduler, R2 all keep running quietly in the background —
they cost nothing when nobody's reading from R2.

**Deeper rollback (uninstall infra):**

- Disable the Scheduler job: `gcloud scheduler jobs pause leaderboard-rebuild-cron --location=us-central1`
- Or delete: `gcloud scheduler jobs delete leaderboard-rebuild-cron --location=us-central1`
- Delete Cloud Run service: `gcloud run services delete leaderboard-rebuild --region=us-central1`
- Delete R2 bucket via Cloudflare dashboard
- Revoke R2 API token
- (Optional) `gcloud secrets delete r2-access-key-id ...` for each secret

---

## Ongoing operations

### Freshness monitoring

Add a Cloud Monitoring alert on the Cloud Run service:
- Metric: `run.googleapis.com/request_count` filtered to
  `status_code_class="4xx" OR status_code_class="5xx"`
- Threshold: >5 errors/hour
- Route through the Discord bridge (`gcp-to-discord` Cloud Run service)

### Rebuild-loop verification

Once a day (or on-demand), verify:

```bash
# Should be updated within the last 90 seconds
curl -sI https://cdn.rocketgoal.io/leaderboard-1v1.json | grep -i last-modified
```

If it's older than a couple minutes, the Scheduler job may have stopped.
Check: `gcloud scheduler jobs describe leaderboard-rebuild-cron --location=us-central1`

### Version bumps to the rebuild service

Any push to `main` touching `firebase/scripts/**` re-triggers
`deploy-rebuild-service.yml`, redeploying Cloud Run. No manual step
needed after the first deploy.

---

## Open questions to resolve before rollout

1. **abuarqob's second leaderboard site.** Still hits Firestore directly.
   Options: PR the old repo to also read from the R2 JSON, or accept the
   ongoing read cost from that site. Without addressing it, our savings
   are capped at whatever fraction of total reads our site is responsible
   for.
2. **Firestore-trigger for on-demand rebuild.** Deferred to v2 per the
   migration plan. Cron-only means up to 60s of write-to-visibility lag.
   If that becomes a real complaint, wire the trigger — see the deploy
   runbook Step 7.
3. **Custom domain vs r2.dev.** `r2.dev` is fine for testing but Cloudflare
   applies rate limits and doesn't guarantee production SLA. Move to a
   custom domain before flipping the default.
