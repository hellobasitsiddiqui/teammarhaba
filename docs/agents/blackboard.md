# Agent Blackboard — shared operational notes

**Canonical seed** for the repo's `docs/agents/blackboard.md`. Append-only, broadcast to all agents (the *blackboard* / stigmergy pattern). **Read this on startup and after every claim**, before you start work — it carries cross-cutting operational knowledge so no agent rediscovers what another already learned.

**Rules**
- **Append, don't rewrite** (avoids clobbering other agents' notes). One entry per finding: `### YYYY-MM-DD HH:MM <agentId> — <title>`.
- This file is **per-run scratch** — it's deleted with the source on a replay. So anything that must survive (findings, sequence fixes) **also** goes in the relevant Jira ticket or `REPLAY.md`. See the redo keep-list.
- Ticket-specific coordination → **Jira comments**, not here. Here = environment, tooling, "main is red", reusable workarounds.
- Directed messages → `docs/agents/inbox/<agentId>.md` (optional mailboxes).

---

## Environment & toolchain (known state)

### 2026-06-20 23:35 agent-A — ⚠ CD was fully RED: `iamcredentials.googleapis.com` was disabled (now fixed)
- **Symptom:** every keyless deploy + the CI `backend-image` push failed; Artifact Registry `containers/backend` was **empty**. Errors: `PERMISSION_DENIED / SERVICE_DISABLED` on `google-github-actions/auth`, and `firebase-tools` "Failed to authenticate, have you run firebase login?".
- **Cause:** WIF impersonation needs the **IAM Service Account Credentials API**; it was never enabled (missing from TM-66/TM-67's API set + `config.yaml`).
- **Fix (applied):** `gcloud services enable iamcredentials.googleapis.com --project=teammarhaba` (live, verified) + added to `config.yaml`/`deploy-auth.md` in PR #25. If you deploy and see PERMISSION_DENIED again, give IAM a few minutes to propagate, then re-run.

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

### createIssueLink direction — VERIFY by read-back (and against the UI)
- To create "X is blocked by Y" (Y blocks X): `type:"Blocks"`, `inwardIssue: Y` (the **blocker**), `outwardIssue: X` (the **blocked**). On read-back, the blocker shows as **`inwardIssue`** ("is blocked by") on the blocked issue; things it blocks show as `outwardIssue` ("blocks"). So **a task's blockers = its `inwardIssue` links.** ⚠️ An earlier version of this note had it reversed (said blocker = `outwardIssue`) — it cost a whole Epic-2 DAG inversion + 10 links a human had to delete by hand. Always read back one link **and** check the UI "blocks / is blocked by" heading.

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

## Local dev

### 2026-06-21 00:25 agent-B — Local stack: `docker compose up` (backend + web + Postgres), TM-52
- Root **`docker-compose.yml`** runs the whole system locally: `backend` (8080), `web` (8081), `postgres:16-alpine` (5432, named volume `pgdata`). All host ports bind **127.0.0.1 only**. Reads root `./.env` (copy from `.env.example`, set `DB_PASSWORD`). Bare `${VAR}` refs, no `:-default` (fails loud, pairs with TM-64).
- **Datasource is forward-wired, not yet live:** the backend image is still web-only (`spring-boot-starter-web`, no JDBC driver; config is `.properties`, not yaml). Compose passes `SPRING_PROFILES_ACTIVE=dev` + `SPRING_DATASOURCE_URL=jdbc:postgresql://postgres:5432/${DB_NAME}` (+user/pass) so it connects **automatically once the driver + datasource land (TM-70 profiles / TM-71 Flyway)**. Today the backend ignores it and just serves `/health`. So TM-52's AC "backend connects to Postgres" is wiring-complete but the live JDBC hop depends on TM-70/71 — flagged on TM-52.
- **For TM-71 (Flyway) dev testing:** this compose Postgres is your local target — the `dev` profile + the `SPRING_DATASOURCE_*` env above already point at it.
- Backend healthcheck avoids curl/wget (absent in the slim JRE image) — uses bash `/dev/tcp`. Verified: stack up, `/health` 200, data survives `down`+`up` (volume persists).

### 2026-06-21 01:35 agent-B — Testcontainers tests can't run locally on this host without a Docker API-version flag (TM-57)
- **Symptom:** any `@SpringBootTest` that uses the Testcontainers Postgres (TM-71/TM-57 ITs) fails locally with `BadRequestException: Status 400 ... client version 1.32 is too old. Minimum supported API version is 1.44` → `Container startup failed for image testcontainers/ryuk:0.7.0`. The suite dies in ~4s before any container starts.
- **Cause:** this host's Docker Desktop is API **1.52 (min 1.44)**; the docker-java bundled via the Spring Boot/Testcontainers BOM negotiates **1.32**. `DOCKER_API_VERSION` env is **not** honored by the surefire-forked client.
- **Local workaround (host-only, NEVER commit):** `TESTCONTAINERS_RYUK_DISABLED=true ./mvnw -DargLine="-Dapi.version=1.44" verify` — docker-java reads the `api.version` **system property** in the forked test JVM. With it, the full suite is green (20/20), Flyway applies, container is shared across ITs.
- **CI is unaffected** (GitHub runners' Docker is compatible) — these tests pass there unchanged, so this is purely a local-run convenience. If it becomes a recurring dev-time pain, the real fix is bumping the Testcontainers/docker-java version in `backend/pom.xml` (separate ticket — don't fold into a test ticket).

### 2026-06-21 02:20 agent-B — Structured logging + correlation ids (TM-73); Micrometer Tracing needs actuator
- Prod emits **JSON** (logback 1.5 built-in `ch.qos.logback.classic.encoder.JsonEncoder`, no extra dep) via `backend/src/main/resources/logback-spring.xml` (`<springProfile>` split: JSON on `prod`, readable console on `dev,test,default`). Every line carries MDC **`traceId`** set per request by `web.CorrelationIdFilter` (reads inbound `X-Request-Id` / `X-Cloud-Trace-Context`, else generates; echoes `X-Request-Id` back; clears MDC in finally).
- **Finding:** the ticket suggested **Micrometer Tracing**, but its Spring Boot auto-config lives in `spring-boot-actuator-autoconfigure` — so it needs `spring-boot-starter-actuator` (TM-74). TM-73 is *not* DAG-blocked by TM-74, so I used a standalone MDC filter to ship independently. **If/when you want real distributed tracing** (TM-75-adjacent), add `micrometer-tracing-bridge-brave` *and* rely on actuator being present (TM-74 merged) — then you can swap `%X{traceId}` for Micrometer's `%mdc`/`traceId` propagation and drop the manual filter (or keep it as the id source).
- Reusable: the `CorrelationIdFilter` + `logback-spring.xml` profile split is the logging baseline for any new backend work — just log via SLF4J and the id rides along.
### 2026-06-21 02:05 agent-B — Spring Security is now on the classpath (TM-74); actuator authz seam for TM-79
- TM-74 added `spring-boot-starter-security` + `spring-boot-starter-actuator`. `security.SecurityConfig` is the single `SecurityFilterChain`: **/actuator/health public, other /actuator/** authenticated, everything else permitAll** (httpBasic so anon → 401 not a 302; CSRF off; stateless; SS header-writing disabled so `SecurityHeadersFilter`/TM-78 stays the one header source).
- **TM-79 (Firebase Auth) extends this chain** — fill in the `authenticated()` half with ID-token verification; don't add a second chain.
- **Gotcha for any future `@WebMvcTest`:** with Spring Security on the classpath, a slice defaults to **deny-all (401)**. Fix = `@Import(SecurityConfig.class)` (the chain permits non-actuator paths; CSRF-off lets POST slices through). Done already for HealthControllerTest, SecurityHeadersWiringTest, GlobalExceptionHandlerTest.
- `/health` (skeleton controller) is intentionally kept separate from `/actuator/health` — the Cloud Run deploy probes `/health`, so don't repoint/remove it.

### 2026-06-21 13:20 agent-B — Firebase Auth seam live: API is default-deny (TM-79)
- The backend is now **default-deny**: `security.SecurityConfig` permits only `/health`, `/actuator/health/**`, `/v3/api-docs/**`, `/swagger-ui/**`; **everything else (all `/api/v1/**`, actuator `/info` `/metrics`) requires a verified Firebase ID token**. New backend endpoints are protected by default — no extra work to secure them; add to the permit-list only if a route must be public.
- **Auth contract:** `Authorization: Bearer <Firebase ID token>` → `auth.FirebaseAuthenticationFilter` verifies via Admin SDK → sets `VerifiedUser(uid,email)` principal (read with `@AuthenticationPrincipal VerifiedUser`). Missing/invalid → uniform RFC 7807 **401** (`auth.RestAuthenticationEntryPoint`, reuses `Problems.unauthorized`).
- **Creds:** Admin SDK uses **ADC** (Cloud Run runtime SA in prod; `gcloud auth application-default login` locally). **No SA key committed.** The `FirebaseAuth` bean is `@Lazy` + resolved via `ObjectProvider`, so token-free requests and the whole dev/test/CI boot never touch ADC — that's why the suite is green without Firebase creds.
- **Testing a protected endpoint:** in a `@SpringBootTest`/MockMvc test, either `@MockBean FirebaseAuth` + `Bearer <token>` (see `FirebaseAuthIntegrationTest`), or `.with(user("x"))` from `spring-security-test` to just supply an authenticated principal (see `ApiVersioningTest`). `@WebMvcTest` slices that only test mappings: `@AutoConfigureMockMvc(addFilters = false)`.

## Tooling hazards

### 2026-06-21 21:25 agent-D — ⚠ Agents share ONE git clone — work in your own `git worktree` (TM-124)
- **Hazard:** all agents operate in the same working clone (`~/Projects/teammarhaba-repo`). A clone has a single HEAD/working tree, so if another agent runs `git checkout` between your `git checkout -b feature/…` and your `git commit`, **your commit lands on whatever branch HEAD is on at commit time** (it landed on `main` for me on TM-108), the feature branch stays empty, the push is empty, and `gh pr create` fails with *"No commits between main and feature/…"*. The commit is only recoverable via `git reflog` — one prune from lost.
- **Also:** a stray commit on local `main` leaves it ahead of `origin/main`, so the next agent's `git checkout main && git pull && checkout -b` either inherits your commit or hits a divergent-history merge.
- **Fix (do this):** give yourself an isolated working tree — `git worktree add -b <type>/TM-XX-desc /tmp/<agentId>-wt origin/main`, do ALL your edits/commits/rebases there. A worktree has its own HEAD that other agents in the main dir can't move. Cheap (shares the object store). Remove with `git worktree remove`. I rebuilt TM-108 + this note this way.
- **If you already committed to the wrong branch:** `git branch -f <your-feature> <sha>` (from reflog) then push; reset local `main` only when it's checked out + clean (`[ "$(git branch --show-current)" = main ] && [ -z "$(git status --porcelain)" ] && git reset --hard origin/main`).
- **Before every `commit`/`push`:** sanity-check `git branch --show-current` is YOUR branch. Full write-up + proposed protocol fix: **TM-124**.
