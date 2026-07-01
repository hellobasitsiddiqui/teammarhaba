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

## APK download host — GitHub Release asset (TM-331)

The signed Android APK is hosted **outside** Firebase Hosting, as a **GitHub Release asset**, so it
is **immune to web deploys**. A Firebase Hosting deploy replaces the *whole* site: `deploy.yml`'s web
job rebuilds `web/dist` from `web/src` (no binary) and a `firebase deploy --only hosting` would wipe
any `/downloads/teammarhaba.apk` placed in Hosting — the TM-331 bug, where the `/download` page then
served the SPA `index.html` renamed `.apk`. Hosting the APK on a GitHub Release removes that whole
class of failure: web deploys never touch a Release asset.

- **Public URL:** `https://github.com/hellobasitsiddiqui/teammarhaba/releases/latest/download/teammarhaba.apk`
  (GitHub redirects `/releases/latest/download/<name>` to whichever Release is marked *latest*.)
- **Publisher:** the `release` job in `.github/workflows/android-release.yml` publishes the signed
  APK as an asset named exactly `teammarhaba.apk` on every signed release, using the `gh` CLI with the
  built-in `GITHUB_TOKEN` (`contents: write`). It tags the Release with the same `git describe`
  versionName it stamps into the APK + web `buildVersion`, creating the Release and marking it latest
  the first time (`gh release create <tag> --latest …`) and clobbering the asset on a re-run
  (`gh release upload <tag> teammarhaba.apk --clobber`). No GCS, no bucket, no new credential.
- **Consumer:** the `/download` page (`web/src/download/index.html`) links its "Download the app"
  button straight at the public `/releases/latest/download/teammarhaba.apk` URL.

### Why a Release asset (not a public GCS bucket)

The first cut of TM-331 hosted the APK in a public GCS bucket. Making the bucket world-readable
needs an `allUsers` `roles/storage.objectViewer` binding, which the org policy
`iam.allowedPolicyMemberDomains` (domain-restricted sharing) **rejects** — the bind fails with
`HTTPError 412`. The **repository is public**, so a Release asset is already a public,
unauthenticated download with **no IAM, no bucket, and no org-policy exception**, and is no security
downgrade versus the intended public bucket.

### Setup

**None.** No bucket to create, no IAM to grant. The workflow uses the built-in `GITHUB_TOKEN`; the
only requirement is the `release` job's `permissions: contents: write` (already set). Until the
first signed release runs (blocked on the TM-245 keystore secrets), the `/releases/latest/download/`
URL 404s and the `/download` page degrades gracefully.

> **Production host follow-up (TM-336):** a `github.com` Release URL is fine for the current
> direct-download MVP, but the proper production host (a custom domain / CDN in front of the APK) is
> tracked in **TM-336**.

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
