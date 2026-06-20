# Agent Blackboard — shared operational notes

**Canonical seed** for the repo's `docs/agents/blackboard.md`. Append-only, broadcast to all agents (the *blackboard* / stigmergy pattern). **Read this on startup and after every claim**, before you start work — it carries cross-cutting operational knowledge so no agent rediscovers what another already learned.

**Rules**
- **Append, don't rewrite** (avoids clobbering other agents' notes). One entry per finding: `### YYYY-MM-DD HH:MM <agentId> — <title>`.
- This file is **per-run scratch** — it's deleted with the source on a replay. So anything that must survive (findings, sequence fixes) **also** goes in the relevant Jira ticket or `REPLAY.md`. See the redo keep-list.
- Ticket-specific coordination → **Jira comments**, not here. Here = environment, tooling, "main is red", reusable workarounds.
- Directed messages → `docs/agents/inbox/<agentId>.md` (optional mailboxes).

---

## Environment & toolchain (known state)

### 2026-06-20 — gcloud: installed + authed ✅ (but Homebrew cask is broken on this host)
- gcloud SDK **573.0.0** is installed and on PATH; `gcloud auth login` + `gcloud auth application-default login` are **done** (account `basit@10xai.co.uk`, ADC token verified). Only `gcloud config set project` remains, deferred until the project exists (TM-66).
- **Gotcha:** `brew install --cask google-cloud-sdk` extracts the SDK then fails its `virtualenv` postflight and rolls back. The SDK files survive and run fine. **Working installs:** symlink the survivors — `ln -sf /opt/homebrew/share/google-cloud-sdk/bin/{gcloud,gsutil,bq} /opt/homebrew/bin/` — or use Google's official tarball (no virtualenv postflight). Tracked on TM-81.

### 2026-06-20 — Docker: works ✅
- Docker is available on the host — TM-51 built and ran the nginx image fine (~41m incl. build). No Docker gap.

### 2026-06-20 — GCP billing: RESOLVED ✅ (cloud track released)
- Billing is confirmed/linked (TM-84 Done). TM-66/63/67 are **released** (unassigned, un-flagged) — **claimable now**. gcloud auth + billing are both done, so cloud / paid-resource tasks can proceed. Start with **TM-66** (create the project); TM-63 + TM-67 unlock once it's Done.

### 2026-06-20 22:18 agent-B — Artifact Registry repo exists now (created in TM-55)
- The Docker repo **`containers`** (region `europe-west2`) now exists. Backend image path: **`europe-west2-docker.pkg.dev/teammarhaba/containers/backend:<sha>`** (+`:latest`). Doc: `infra/gcp/artifact-registry.md`; machine-readable in `infra/gcp/config.yaml` → `artifact_registry`. **TM-60 (Cloud Run deploy) should pull this exact path** — read it from `config.yaml`, don't re-hardcode.
- **DAG gap (logged on TM-55):** TM-66 (1.5.1) enabled the AR *API* but no ticket created the *repo*; the TM-55 prompt calls repo provisioning "out of scope (1.5.1)" but 1.5.1=TM-66 didn't do it. I folded the one-line `gcloud artifacts repositories create` into TM-55 to keep the push functional. On replay, give the AR repo its own provisioning ticket (or extend TM-66) so it isn't a side effect of the CI ticket.

---

## Conventions reminders (full versions in the skills/docs)

### Board fields / time tracking — keep the board functional
- On **claim**: set **Start date** (`customfield_10015` = today).
- On **PR / In Review**: log a **worklog** of actual elapsed (`addWorklogToJiraIssue`, `timeSpent` + `started` = claim time) and set **Due date** (`duedate`) if unset.
- If **blocked/held**: set **Flagged = Impediment** (`customfield_10021` = `[{"value":"Impediment"}]`); clear when unblocked.
- Story points = the estimate (Original Estimate isn't on the Task screen — UI-admin toggle needed). See `jira-mcp-gotchas` → Time tracking.

### createIssueLink direction — VERIFY by read-back
- To express "X is blocked by Y": `type:"Blocks"`, `inwardIssue: X` (blocked), `outwardIssue: Y` (blocker). When you read an issue, **your blocker shows as `outwardIssue`**. An agent got this backwards once (TM-81→TM-66) — **always create one link and read it back** before trusting the direction.

### Hit a wall? Log it
- Comment the blocker on the ticket + a `[finding → future improvement]` note; raise a `human-in-the-loop` ticket for human-only steps. Never fail silently.

---

## Deploy patterns

### 2026-06-20 21:11 agent-A — Keyless deploy from CI: use the WIF action + ADC, not key-based actions
- TM-61 (web → Firebase Hosting) deploys keyless. Pattern for **any** GCP/Firebase deploy job (reusable for TM-60 backend → Cloud Run): `google-github-actions/auth@<sha>` (WIF, `id-token: write`) → it exports `GOOGLE_APPLICATION_CREDENTIALS`, which `firebase-tools`/`gcloud` pick up as ADC. **Do NOT use `FirebaseExtended/action-hosting-deploy`** — it wants a `firebaseServiceAccount` JSON key, and this project is keyless by design (TM-67, no key exists).
- `firebase deploy --only hosting` is run via `npx firebase-tools@<pinned>`; SA `gha-deployer` already has `roles/firebasehosting.admin`.
- **First-deploy assumption:** the default Hosting site (`teammarhaba.web.app`) is assumed to exist (Firebase Hosting API enabled in `config.yaml`). If the first live deploy 404s on the site, a human/agent may need a one-time `firebase init hosting` / site create — flagged here so it's not rediscovered.

### 2026-06-20 21:37 agent-A — Cloud Run backend deploy (TM-60): gcloud, probe flags, image-push race, allUsers risk
- TM-60 deploys `backend` to Cloud Run via `gcloud run deploy` (not the deploy-cloudrun action) so the `--startup-probe`/`--liveness-probe=httpGet.path=/health,...` comma-valued flags are clean. gcloud 573 supports those probe flags. Service `teammarhaba-backend`, region `europe-west2`, scale-to-zero, `--cpu-boost`.
- **Image-push race:** `deploy.yml` (push) and `ci.yml` `backend-image` (push) fire on the *same* merge, so the deploy polls Artifact Registry for `containers/backend:<sha>` before deploying. Reusable for TM-65 previews. Better long-term: gate deploy on CI success via `workflow_run` (logged as a finding on TM-60).
- **⚠ allUsers / org-policy risk:** the deploy uses `--allow-unauthenticated` (public API). If the 10xai org enforces domain-restricted sharing (`iam.allowedPolicyMemberDomains`), setting the `allUsers` invoker **fails** and the first deploy errors. If you hit this: either get the org policy exception (human/console) or drop `--allow-unauthenticated` and smoke-check with an identity token. Flagged on TM-60.
- Cloud SQL + DB secret are **pre-wired** in the deploy (`--add-cloudsql-instances`, `--set-secrets=DB_PASSWORD=...`, env) but the app has **no JDBC driver yet** (web-only skeleton) so nothing connects — wiring is forward-looking for the data-layer ticket.

### 2026-06-20 23:55 agent-A — Cloud Run deploy: CONFIRMED private (org blocks allUsers) + needs a runtime SA
- The allUsers risk above **materialised**: org `10xai` enforces `iam.allowedPolicyMemberDomains`, so `--allow-unauthenticated` fails. Resolution (TM-60 fix): deploy **`--no-allow-unauthenticated`** (private); public access deferred to **TM-96** (human-in-the-loop, org-policy exception). **TM-65 preview revisions will hit the same wall** — deploy them private too.
- **Runtime SA required:** the service must run as a dedicated SA (`teammarhaba-run@`, has `secretmanager.secretAccessor` on the DB secret + `cloudsql.client`) via `--service-account`. The **default compute SA lacks secret access** → deploy fails on `--set-secrets` without this. `gha-deployer` (project `iam.serviceAccountUser`) can act-as it. Reuse `teammarhaba-run` for any Cloud Run service that reads the DB secret.
- **Verify private services by Ready revision**, not a public curl: `gcloud run services describe ... --format='value(status.latestReadyRevisionName)'` (non-empty = startup probe on /health passed).
