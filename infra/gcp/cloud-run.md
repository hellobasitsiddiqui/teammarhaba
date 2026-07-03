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
| **Auth** | **public** — `allUsers` has `roles/run.invoker`, permitted via the scoped org-policy exception (see **Public access** below / **TM-96**). Since **TM-270** the deploy passes **no** `--[no-]allow-unauthenticated` flag at all: CD never modifies the IAM policy — the binding is *added* (idempotently, best-effort) by the public-access step and never removed. The app still requires a Firebase Bearer token; only `/health` is open. |

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
2. **Resolve image** (TM-194) — deploy `backend:<HEAD>` when that image exists (short
   bounded wait for a racing CI build), else walk ancestry and deploy the newest commit
   whose image *does* exist (docs-only HEADs build no image). Fails loudly if none found.
3. **Deploy a zero-traffic candidate** (TM-270) — `gcloud run deploy --no-traffic
   --tag=candidate` of the SHA-tagged image, running as the dedicated **runtime SA**
   `teammarhaba-run` (so the container — not the deploy SA — is what reads the DB secret /
   connects to Cloud SQL). The live revision keeps serving 100%; the candidate gets its own
   `https://candidate---…` URL. **No `--[no-]allow-unauthenticated` flag is passed** — the
   deploy never touches the public-access binding. (First-ever deploy of the service:
   `--no-traffic` is skipped — the first revision must take traffic, and there is nothing
   live to protect.)
4. **Health-gate the candidate** (TM-270) — assert the new revision reached **Ready**
   (Cloud Run only marks Ready after the `/health` startup probe passes), then curl the
   candidate tag URL's `/health` **directly** (never the service URL, which still routes to
   the old revision). `200` required where the service is public; `401/403` tolerated in an
   env without the TM-96 exception (Ready already proved health). Any other failure stops
   the deploy with traffic and IAM untouched.
5. **Promote** (TM-270) — `gcloud run services update-traffic --to-revisions=<candidate>=100`,
   **by name**. A single atomic API call: on failure, traffic simply stays 100% on the
   previous healthy revision.
6. **Enable public access** *(best-effort, replay-safe, `if: always()`)* — (re)assert the
   `allUsersIngress` tag on the service and bind `allUsers` as `run.invoker`, retrying while
   the org-policy condition propagates. **Every command here is non-fatal:** in an environment
   without the TM-96 exception (e.g. a fresh replay project), the bindings fail and the service
   simply stays private — the deploy still succeeds. Since TM-270 it runs on **every** outcome
   (`if: always()`), as defense-in-depth: it heals bootstrap/drift, and there is nothing to
   "restore" because the deploy never strips the binding. See *Public access (TM-96)* below.
7. **Verify rollout** (TM-131) — assert the revision serving 100% of traffic **is exactly the
   revision this run created** (this check is fatal — a green pipeline serving stale code is
   the TM-131 bug). The step then **reports** whether unauthenticated `/health` returns `200`
   (public) or not (private) — informational only.

### Deploy atomicity — the TM-270 invariant

> **A deploy may never leave the service less available or less public than it found it.**

Cause (TM-269 outage): the deploy used to run `gcloud run deploy --no-allow-unauthenticated`
(which **strips** the `allUsers` invoker binding) and re-bound public access in a *later* step.
A revision that failed its startup probe aborted the job **between** strip and re-bind →
prod was left private → `403` for every caller (SPA included), even though traffic had safely
stayed on the previous healthy revision. Any failed backend deploy took prod down.

The invariant is enforced by construction:

| Failure point | What happens | Service state |
| --- | --- | --- |
| No image found (build failed) | Resolve step fails | Untouched — old revision serving, public |
| Candidate never becomes Ready (bad startup) | `gcloud run deploy --no-traffic` exits non-zero | Traffic untouched (100% on old revision), IAM untouched — **stays public + serving** |
| Candidate Ready but direct `/health` fails | Gate step fails before any traffic moves | Same — old revision serving, public |
| Promote (`update-traffic`) fails | Single atomic call fails | Traffic still 100% on old revision, public |
| Serving revision ≠ just-built (TM-131) | Verify fails loudly | Whatever Cloud Run reports — investigate; IAM still untouched |

Plus: the public-access step runs `if: always()` (even after a failure upstream), so any
pre-existing missing binding is healed on every run regardless of deploy outcome.

**Traffic model consequence:** traffic is now pinned **by revision name** (not `LATEST`), so an
ad-hoc `gcloud run deploy` outside the workflow creates a revision that does **not** take
traffic by itself — promotion is always the explicit, health-gated `update-traffic` step. To
roll forward manually, deploy and then `update-traffic --to-revisions=<rev>=100` (or just
re-run the **Deploy** workflow). The `candidate` traffic tag always points at the most
recently deployed revision; after promotion its URL and the service URL serve the same thing.

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
Firebase Bearer token (TM-108). Cloud Run IAM (and the org tag binding) is **per-service, not
per-revision** — so tag URLs (`candidate---…`, `pr-N---…` previews from TM-65) share the
service's policy and are network-reachable wherever the service is public; they are still
gated by the Firebase Bearer token like everything else. This service-level scope is also why
`--no-allow-unauthenticated` on *any* deploy to the service (including a preview) used to
strip prod's public access — since TM-270 no deploy lane passes an IAM flag at all.

## First admin (replay setup — not code)

RBAC provisions every account as `USER` (JIT) and the set-role endpoint needs an existing admin — so a fresh deploy has **no admin** until one is seeded. Two replay-safe steps:
1. The runtime SA has **`roles/firebaseauth.admin`** (granted in the SA setup above) so it can write the role claim — without it the bootstrap *and* set-role silently fail (TM-140).
2. Set the **GitHub repo variable** `ADMIN_BOOTSTRAP_EMAIL` to the first admin's email — `deploy.yml` injects it, and the backend's `AdminBootstrap` (TM-110) promotes that account to `ADMIN` on startup. The account must **sign in once** first (so the Firebase user exists); after the deploy, the admin re-logs in to pick up the claim on a fresh token. (`/me` may still show `USER` — it reads the DB role; authorization uses the claim. See TM-140.)

## Out of scope
- App-side JDBC datasource / Flyway migrations (data-layer ticket) — the app has no DB driver yet.
- Per-PR Cloud Run preview revisions (TM-65 / 1.4.6) — intentionally remain private.
