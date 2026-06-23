# Cloud Run — backend CD (TM-60 / 1.4.1)

The backend is continuously delivered to **Cloud Run** on every merge to `main`.
Cloud Run provides the managed runtime, HTTPS endpoint, and autoscaling.

| | |
| --- | --- |
| **Service** | `teammarhaba-backend` |
| **Region** | `europe-west2` |
| **Image** | `europe-west2-docker.pkg.dev/teammarhaba/containers/backend:<sha>` (from TM-55) |
| **Port** | 8080 (Spring binds Cloud Run's `PORT`) |
| **Scaling** | min `0` (scale-to-zero) · max `3` · startup CPU boost on |
| **Runtime SA** | `teammarhaba-run@teammarhaba.iam.gserviceaccount.com` (least-privilege: `secretmanager.secretAccessor` on the DB secret + `cloudsql.client` + `firebaseauth.admin` for RBAC custom-claim writes — TM-140) |
| **Auth** | **public** (`--allow-unauthenticated`) — `allUsers` has `roles/run.invoker`. The org enforces domain-restricted sharing, so this is permitted via a scoped exception (see **Public access** below / **TM-96**). The app still requires a Firebase Bearer token; only `/health` is open. |

## How it deploys

`.github/workflows/deploy.yml` (job `backend`) deploys current `main`. There are **two** ways to run
it, both deliberate (you choose when the live site changes — the Actions-minutes win of TM-153):

- **Manual** (`workflow_dispatch`) — from the Actions tab (*Deploy → Run*). Always available.
- **`deploy`-label auto-trigger** (TM-156, **live**) — add the **`deploy`** label to a PR and the merge
  auto-deploys `main`. An unlabelled merge deploys nothing. Implemented *in* this workflow (a
  `pull_request: [closed]` trigger gated on `merged && labelled deploy`) rather than a separate
  dispatcher, because a `GITHUB_TOKEN`-dispatched run can't start another workflow (the TM-148 trap).
  It deploys `DEPLOY_SHA = pull_request.merge_commit_sha` — the real merge commit on `main` that CI
  built the image for, **not** the ephemeral PR test-merge `github.sha`.

On run:

1. **Auth (deploy-time)** — keyless WIF (TM-67), impersonating `gha-deployer`
   (`roles/run.admin`, `iam.serviceAccountUser` to act-as the runtime SA). No JSON key.
2. **Wait for image** — CI's `backend-image` job (`ci.yml`) pushes `:<sha>` on the
   same merge event, so the deploy polls Artifact Registry until that immutable tag
   exists (≈10 min cap) before deploying. If CI fails, the deploy times out and fails.
3. **Deploy** — `gcloud run deploy` of the SHA-tagged image, running as the dedicated
   **runtime SA** `teammarhaba-run` (so the container — not the deploy SA — is what
   reads the DB secret / connects to Cloud SQL). Config below.
4. **Enable public access** *(best-effort, replay-safe)* — (re)assert the `allUsersIngress`
   tag on the service and bind `allUsers` as `run.invoker`, retrying while the org-policy
   condition propagates. **Every command here is non-fatal:** in an environment without the
   TM-96 exception (e.g. a fresh replay project), the bindings fail and the service simply
   stays private — the deploy still succeeds. See *Public access (TM-96)* below.
5. **Verify rollout** — assert the service has a `latestReadyRevisionName`. Cloud Run
   only marks a revision Ready after the `/health` **startup probe** passes, so a Ready
   revision *is* the proof `/health` serves `200` (this check is fatal). The step then
   **reports** whether unauthenticated `/health` returns `200` (public) or not (private) —
   informational only, so the deploy is green whether it ended public or private.

### Health probes (`/health`)

```
--startup-probe=httpGet.path=/health,httpGet.port=8080,initialDelaySeconds=10,timeoutSeconds=3,periodSeconds=10,failureThreshold=6
--liveness-probe=httpGet.path=/health,httpGet.port=8080,timeoutSeconds=3,periodSeconds=30,failureThreshold=3
```

Cloud Run **gates traffic on the startup probe** — a new revision receives traffic
only after `/health` passes, so an unhealthy revision never serves. The liveness
probe restarts a wedged container.

### Cloud SQL + secrets (pre-wired)

```
--add-cloudsql-instances=teammarhaba:europe-west2:teammarhaba-pg
--set-secrets=DB_PASSWORD=teammarhaba-db-app-password:latest
--set-env-vars=SPRING_PROFILES_ACTIVE=prod,DB_NAME=teammarhaba,DB_USER=app,INSTANCE_CONNECTION_NAME=teammarhaba:europe-west2:teammarhaba-pg
```

The Cloud SQL Auth Proxy socket is mounted at `/cloudsql/<connection_name>`. The app
does not consume the datasource yet (web-only skeleton, no JDBC driver); this wiring
is in place so the data-layer ticket only adds the driver + datasource URL. See
`backend/src/main/resources/application-prod.properties`.

### Runtime service account (least privilege)

The service runs as a dedicated SA — **not** the broadly-privileged default compute SA,
which also lacks access to the DB secret. Reproduce (`gcloud`):

```bash
PROJECT=teammarhaba
RUN_SA="teammarhaba-run@${PROJECT}.iam.gserviceaccount.com"

gcloud iam service-accounts create teammarhaba-run --project="$PROJECT" \
  --display-name="TeamMarhaba Cloud Run runtime"

# Read just the DB secret (scoped to the secret, not project-wide)
gcloud secrets add-iam-policy-binding teammarhaba-db-app-password --project="$PROJECT" \
  --member="serviceAccount:${RUN_SA}" --role="roles/secretmanager.secretAccessor"

# Connect to Cloud SQL (for the data layer, later)
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:${RUN_SA}" --role="roles/cloudsql.client" --condition=None

# Manage Firebase Auth custom claims — REQUIRED for RBAC role-writing. The admin
# bootstrap (TM-110) and the set-role endpoint (TM-111) call setCustomUserClaims /
# getUserByEmail via the Admin SDK. Token *verification* needs no IAM (login works
# without this), but *writing* a claim does — omit it and ALL role assignment
# silently fails in prod (TM-140).
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:${RUN_SA}" --role="roles/firebaseauth.admin" --condition=None
```

The deploy SA `gha-deployer` already holds project-level `roles/iam.serviceAccountUser`,
which lets it act-as (`--service-account`) this runtime SA at deploy time.

## Stranded-deploy hardening (TM-146)

A *green* deploy pipeline doesn't guarantee `main`'s latest code is what's serving. Two layers
keep CD self-correcting:

**1. Prevent — per-commit CI concurrency.** `ci.yml`'s concurrency is scoped by event: PRs cancel
superseded runs on the branch ref (fast gate); **`push` to `main` keys the group by `github.sha`
and does not cancel.** Previously a second merge arriving while the first was still building would
`cancel-in-progress` the first run — killing its `backend-image` push, so that commit's `:<sha>`
image never reached Artifact Registry. The deploy then strands ~10 min in *Wait for the SHA-tagged
image* and skips, looking like "still running, just wait" (hit live in TM-140). Per-commit groups
mean **every merged SHA builds and pushes its image**; the two deploys queue (`deploy.yml`
concurrency is `cancel-in-progress: false`) and both run, latest serving.

**2. Self-heal — `deploy-reconcile.yml`.** A scheduled workflow (every 30 min, `+ workflow_dispatch`)
asserts the revision serving 100% of untagged traffic runs the image built for `main` HEAD. If the
HEAD image exists but isn't serving (a stranded/skipped deploy), it re-dispatches **Deploy** to roll
forward — no human needed. It no-ops when in sync, when a Deploy is already in progress/queued, or
when HEAD has no image yet (a CI signal, surfaced by CI failure / the nightly canary instead). This
complements deploy.yml's *Verify rollout* (TM-131 — proves the just-deployed revision serves) and the
nightly canary (TM-118 — proves a Ready revision exists) by covering the gap they miss: *a deploy that
never landed at all.*

## Cold-start upgrade

`min-instances=0` means a request after idle pays a JVM cold start (helped by
`--cpu-boost`). To remove cold starts (at the cost of an always-on instance), set a
warm floor:

```bash
gcloud run services update teammarhaba-backend --project=teammarhaba --region=europe-west2 --min-instances=1
```

## Rollback (previous revision)

Each deploy creates an immutable revision; roll back by shifting 100% traffic to a
known-good one — no rebuild.

```bash
# List revisions (newest first)
gcloud run revisions list --service=teammarhaba-backend --project=teammarhaba --region=europe-west2

# Point all traffic at a previous revision
gcloud run services update-traffic teammarhaba-backend --project=teammarhaba --region=europe-west2 \
  --to-revisions=<previous-revision>=100
```

Or `git revert <bad-merge> && git push` to roll forward with the repo matching prod.

## Public access (TM-96) — DRS exception via resource tag

The service is **public** (`allUsers` → `roles/run.invoker`). The org `10xai`
(`103553953969`) enforces domain-restricted sharing (`iam.allowedPolicyMemberDomains`,
default allowed value = the Workspace customer `C0427lbt2`), which normally rejects
`allUsers`. Rather than open `allUsers` org- or project-wide, we added a **conditional
exception scoped to a resource tag**, so only explicitly-tagged services can go public.

One-time org setup (needs `roles/orgpolicy.policyAdmin` + `roles/resourcemanager.tagAdmin`
+ `roles/resourcemanager.tagUser` — org-owner-granted; **persists across replays**):

```bash
# 1. Org tag that marks "this resource may bind allUsers"
gcloud resource-manager tags keys   create allUsersIngress --parent=organizations/103553953969
gcloud resource-manager tags values create True --parent=103553953969/allUsersIngress

# 2. Conditional DRS policy: keep the domain restriction, allow ALL only for tagged resources
#    (organizations/103553953969/policies/iam.allowedPolicyMemberDomains)
#    rule A: allowedValues=[C0427lbt2]   rule B: allowAll=true WHEN matchTag(allUsersIngress=True)
gcloud org-policies set-policy drs-policy.yaml
```

Per-service (a replay re-does these for a freshly-created service):

```bash
# 3. Tag the Cloud Run service
gcloud resource-manager tags bindings create \
  --tag-value=103553953969/allUsersIngress/True \
  --parent=//run.googleapis.com/projects/teammarhaba/locations/europe-west2/services/teammarhaba-backend \
  --location=europe-west2

# 4. Bind allUsers (now permitted by the tagged exception; allow ~60-90s for policy propagation)
gcloud run services add-iam-policy-binding teammarhaba-backend \
  --member=allUsers --role=roles/run.invoker --region=europe-west2 --project=teammarhaba
```

**CD does steps 3–4 for you, idempotently and best-effort.** `deploy.yml` deploys private,
then its *Enable public access* step re-asserts the tag and binds `allUsers` with retry. The
tag binding persists on the service, so this stays public across deploys. Crucially these
commands are **non-fatal**: an environment *without* the one-time org setup above (a fresh
replay project, a different org) just stays private and the deploy stays green — **a replay
never hits the DRS wall.** The org-level setup (tag key/value, conditional policy, the three
role grants) is the only human/one-time piece, and it persists across replays of the same org.

**Security note:** public = network-reachable only; every real endpoint still requires a
Firebase Bearer token (TM-108). Preview revisions (TM-65) are *not* tagged → stay private.

## First admin (replay setup — not code)

RBAC provisions every account as `USER` (JIT) and the set-role endpoint needs an existing admin — so a fresh deploy has **no admin** until one is seeded. Two replay-safe steps:
1. The runtime SA has **`roles/firebaseauth.admin`** (granted in the SA setup above) so it can write the role claim — without it the bootstrap *and* set-role silently fail (TM-140).
2. Set the **GitHub repo variable** `ADMIN_BOOTSTRAP_EMAIL` to the first admin's email — `deploy.yml` injects it, and the backend's `AdminBootstrap` (TM-110) promotes that account to `ADMIN` on startup. The account must **sign in once** first (so the Firebase user exists); after the deploy, the admin re-logs in to pick up the claim on a fresh token. (`/me` may still show `USER` — it reads the DB role; authorization uses the claim. See TM-140.)

## Out of scope
- App-side JDBC datasource / Flyway migrations (data-layer ticket) — the app has no DB driver yet.
- Per-PR Cloud Run preview revisions (TM-65 / 1.4.6) — intentionally remain private.
