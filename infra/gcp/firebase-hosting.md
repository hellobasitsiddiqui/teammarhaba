# Firebase Hosting — web CD (TM-61 / 1.4.2)

The web surface is continuously delivered to **Firebase Hosting** on every merge to
`main`. Firebase Hosting provides the CDN, TLS, and a default domain.

## How it deploys

`.github/workflows/deploy.yml` (job `web`) runs on `push` to `main`:

1. **Build** — mirrors `web/Dockerfile`'s build stage: copies `web/src/` into
   `web/dist/` (the build seam; a real bundler drops in here later).
2. **Auth** — keyless via Workload Identity Federation (TM-67). It impersonates
   `gha-deployer@teammarhaba.iam.gserviceaccount.com`, which holds
   `roles/firebasehosting.admin`. No service-account JSON key exists.
3. **Deploy** — `firebase-tools deploy --only hosting` to the **live** channel,
   using the WIF credentials as Application Default Credentials.

Config:

- `firebase.json` — `public: web/dist`, SPA rewrite (`**` → `/index.html`).
- `.firebaserc` — default project `teammarhaba`.

The live site is served over HTTPS on the Firebase Hosting domain
(`https://teammarhaba.web.app` / `https://teammarhaba.firebaseapp.com`).

## Deploy-time config injection

Between **Build** and **Deploy**, the `web` job rewrites the built
`web/dist/assets/config.js` so the live bundle carries real values (never
hardcoded in the repo):

- **Backend API URL** — resolved from Cloud Run (`window.TEAMMARHABA_CONFIG.apiBaseUrl`).
- **Build stamp** — `git describe --tags` (`buildVersion`, TM-142 / TM-155).
- **Active theme** — the `THEME` repo variable (`window.TEAMMARHABA_CONFIG.theme`, TM-212).

**Switching the live theme:** set the **`THEME`** repo variable
(Settings → Secrets and variables → Actions → Variables) to **`sketch`**, **`doodle`** or
**`clean`** and redeploy. It defaults to **`sketch`** (the hand-drawn wireframe) when the variable is unset.
See [CONTRIBUTING.md → Switching the live theme](../../CONTRIBUTING.md#switching-the-live-theme).

## APK download bucket (TM-331)

The signed Android APK is hosted **outside** Firebase Hosting, in a public Google Cloud Storage
bucket, so it is **immune to web deploys**. A Firebase Hosting deploy replaces the *whole* site:
`deploy.yml`'s web job rebuilds `web/dist` from `web/src` (no binary) and a `firebase deploy --only
hosting` would wipe any `/downloads/teammarhaba.apk` placed in Hosting — the TM-331 bug, where the
`/download` page then served the SPA `index.html` renamed `.apk`. Hosting the APK in its own bucket
removes that whole class of failure: web deploys never touch the bucket.

- **Object:** `gs://teammarhaba-downloads/teammarhaba.apk`
- **Public URL:** `https://storage.googleapis.com/teammarhaba-downloads/teammarhaba.apk`
- **Publisher:** the `release` job in `.github/workflows/android-release.yml` runs
  `gcloud storage cp … --content-type=application/vnd.android.package-archive --cache-control=no-cache`
  on every signed release, overwriting the object in place. It authenticates with the *same* keyless
  WIF identity (`gha-deployer`) as every other deploy step — no new credential.
- **Consumer:** the `/download` page (`web/src/download/index.html`) links its "Download the app"
  button straight at the public URL.

### One-time setup (human/infra — required before the first release upload)

Run once with an owner/admin identity (the CI `gha-deployer` SA can't create the bucket itself):

```bash
PROJECT=teammarhaba
BUCKET=teammarhaba-downloads
SA=gha-deployer@${PROJECT}.iam.gserviceaccount.com

# 1) Create the bucket (uniform access; europe-west2 to match the rest of the stack).
gcloud storage buckets create "gs://${BUCKET}" \
  --project="${PROJECT}" --location=europe-west2 --uniform-bucket-level-access

# 2) Make objects in it publicly readable (anonymous GET — this is a public download).
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member=allUsers --role=roles/storage.objectViewer

# 3) Let CI (gha-deployer) write the APK. Scoped to THIS bucket, not project-wide.
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${SA}" --role=roles/storage.objectAdmin
```

> Org policy note: the same domain-restricted-sharing exception that lets Cloud Run bind `allUsers`
> (TM-96) is needed for the public `objectViewer` binding above. Until the bucket exists + the SA
> binding is in place, the workflow's APK-upload step **warns and stays green** (the signed APK is
> still attached to the run as the `app-release-apk` artifact), so this step never blocks a release.

## Rollback (previous release)

Every deploy creates an immutable **release**; Hosting keeps the history, so
rollback is selecting a prior release — no rebuild needed.

**Console (fastest):** Firebase Console → **Hosting** → the site's **release
history** → on the previous good release click **⋮ → Rollback**. Traffic switches
to that release immediately.

**CLI:** list releases and re-point live to a previous version:

```bash
# List recent releases (newest first) with their version names
firebase hosting:releases:list --project teammarhaba   # (or via the Console)

# Roll back by re-deploying the last known-good commit:
git revert <bad-merge-commit> && git push origin main   # re-runs deploy.yml
```

Prefer the Console **Rollback** for an instant revert; use `git revert` when you
also want the repo state to match what's live.
