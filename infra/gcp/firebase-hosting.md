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
(Settings → Secrets and variables → Actions → Variables) to **`doodle`** or
**`clean`** and redeploy. It defaults to **`clean`** when the variable is unset.
See [CONTRIBUTING.md → Switching the live theme](../../CONTRIBUTING.md#switching-the-live-theme).

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
