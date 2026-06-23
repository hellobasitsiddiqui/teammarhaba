# GENESIS — initial setup checklist (Sprint 0 / Bootstrap)

**The single "do ALL of this up front" list.** Everything here was discovered or retrofitted **mid-flight** in TeamMarhaba's first build — so on the **replay** (delete the source, rebuild from the tickets) and on every new project, it belongs in the **initial steps** instead of being found halfway through. Run Sprint 0 **linearly**; only then start the parallel themed sprints.

> **Principle:** *any step we found ourselves doing halfway through is a Genesis step.* When a new mid-flight learning shows up, add it here.

## A. Human prerequisites — do FIRST (can't be automated; sequence before any cloud/build task)
- **gcloud:** install the SDK, then `gcloud auth login` + `gcloud auth application-default login` **with the Firebase scope** — `--scopes=openid,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/firebase`. The default cloud-platform-only scope **403s on Firebase ops** mid-build (it bit TM-66 → forced reactive re-auth TM-92). Verify `gcloud auth print-access-token`.
- **Add Firebase to the project via the Firebase console** up front — the `addFirebase` API/CLI may 403 even with the scope (TM-93); doing it in the console avoids a mid-build stall.
- **Docker:** installed + running (both Dockerfiles + CI need it).
- **GCP billing:** a billing account exists and is linked to the project (agents can't set up billing).
- Track each as a `human-in-the-loop` ticket, **linked as a blocker** of the cloud/build tasks, so no agent attempts them before the prereq is met. *(TeamMarhaba hit these reactively as TM-81 / TM-84.)*

## A2. GCP deploy wiring — APIs · service accounts · IAM (do before the first deploy)
*Every item here was discovered mid-deploy in Sprint 2 (PR #25, PR #26; follow-up TM-96) — front-load it so the first `git push` to `main` deploys green instead of failing on IAM.*

- **Enable the deploy-path APIs up front** — keyless WIF token exchange **403s without `iamcredentials`**, which blocked *all* CD until PR #25:
  ```bash
  gcloud services enable iamcredentials.googleapis.com run.googleapis.com \
    artifactregistry.googleapis.com secretmanager.googleapis.com sqladmin.googleapis.com \
    --project="$PROJECT"
  ```
- **Two separate service accounts — deploy vs runtime:**
  - **Deploy SA** (`gha-deployer`) — what WIF impersonates at deploy time: `roles/run.admin` (deploy Cloud Run) + `roles/iam.serviceAccountUser` (to *act-as* the runtime SA) + `roles/firebasehosting.admin` (deploy the web app — TM-61) + `roles/firebaserules.admin` (publish Storage security rules from CD — TM-191/TM-192; without it the CD storage step warns and no-ops). No JSON key.
  - **Runtime SA** (`<proj>-run@`) — what the *container* runs as (`--service-account=`); least privilege: `roles/secretmanager.secretAccessor` **scoped to each secret it reads** + `roles/cloudsql.client` + `roles/firebaseauth.admin` (to write RBAC role custom claims — without it the admin bootstrap *and* set-role silently fail in prod; TM-140). **Never run on the default compute SA** — it's over-privileged *and* can't read the secret, which is the exact fatal error that failed Sprint 2's first deploy (fixed in PR #26):
  ```bash
  gcloud iam service-accounts create <proj>-run --project="$PROJECT" --display-name="Cloud Run runtime"
  gcloud secrets add-iam-policy-binding <db-secret> --project="$PROJECT" \
    --member="serviceAccount:<proj>-run@${PROJECT}.iam.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:<proj>-run@${PROJECT}.iam.gserviceaccount.com" \
    --role="roles/cloudsql.client" --condition=None
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:<proj>-run@${PROJECT}.iam.gserviceaccount.com" \
    --role="roles/firebaseauth.admin" --condition=None   # write RBAC role custom claims (TM-140)
  ```
- **First admin (chicken-and-egg — a real replay step, not code).** JIT provisions every account as `USER` and set-role needs an existing admin, so a fresh repo has *no way in* without this. Promote the first admin via the env-driven bootstrap: set the **GitHub repo variable `ADMIN_BOOTSTRAP_EMAIL`** to that person's email (`deploy.yml` injects it), and have that account **sign in once** (so the Firebase user exists). On the next deploy/restart the backend writes the `ADMIN` claim (requires the runtime SA's `firebaseauth.admin`, above); the admin then re-logs in to refresh their token. *(Hit reactively in TM-139/TM-140 — the SA lacked the role, so the bootstrap silently failed.)*
- **Decide public vs private up front (org policy).** If the org enforces domain-restricted sharing (`constraints/iam.allowedPolicyMemberDomains`), `--allow-unauthenticated` (allUsers) **fails**. Default to **private** (`--no-allow-unauthenticated`); going public needs an **org-policy exception from an Org Policy Admin** → a `human-in-the-loop` ticket (the **TM-96** pattern), *not* something a project-scoped agent can do.
- **Verify the deploy by Ready-revision, not a public curl.** Cloud Run gates traffic on the `/health` **startup probe** and only marks a revision Ready after it passes — so asserting `latestReadyRevisionName` *is* proof `/health` serves 200, and it works even when the service is private.
- **Stamp the build id on the surfaces from day 1 (web first page + backend `/health`/`/version`).** Inject the short git SHA into the web bundle at deploy time (same seam as the API-base-URL injection) and expose the backend SHA + build time + Cloud Run revision. Web and backend deploy independently, so without a visible build id you cannot tell *which build is live* — which wasted real time in this build (a stale revision in TM-131, and a deploy that *failed* but looked like "just wait longer" in TM-140). Resolve everything at build/deploy time, never hardcoded, so a fresh replay shows correct values. *(Retrofitted as **TM-142**; front-load it.)* **Use `git describe --tags` for the version (TM-155) and tag *deliberate releases only*, not every deploy** — the `vX.Y.Z-N-gSHA` distance is the signal between tags; every deploy is already traceable via the SHA + Cloud Run revision, so tags are just human release names (TM-157).
- **Scope CI concurrency by event so back-to-back `main` merges don't strand deploys.** A `cancel-in-progress` group keyed on `github.ref` cancels the first merge's CI **image build** when a second merge lands ~seconds later — its `:<sha>` never pushes and that commit's deploy times out waiting for it (hit in TM-140: #128's deploy stranded, only saved because #129 carried the code forward). **Fix (front-load it — TM-146):** key the `concurrency.group` per-`github.sha` on `push` (cancel only on PR refs) so every merged SHA builds+pushes its image, **and** add a scheduled `deploy-reconcile` workflow that re-deploys when the serving revision ≠ `main` HEAD. With both, merging back-to-back is safe and a stranded deploy self-heals — no "don't merge fast" rule needed.
- **Fingerprint web assets + set cache headers from day 1.** Serving assets at stable URLs (`/assets/app.js`) with a default `max-age` makes a deploy **invisible to returning users for up to an hour** — a stale CSS cache made the TM-141 fix *look* unshipped. Emit content-hashed filenames (`app.[hash].js`) so a new deploy = new URL = instant cache-bust; serve `index.html` `no-cache` and hashed assets `immutable` (TM-144).
- **Set up every drift guard up front — including the API contract.** Beyond schema (`ddl-auto: validate`), env (`.env.example` validator), format (Spotless), coverage (JaCoCo), deps (dependency-review/CodeQL/SBOM): commit `openapi.json` + a `verify`-gated drift test so any REST API change must be regenerated + committed or CI fails (TM-135). Fast, PR-gating, no browser/cloud.
- **Gate deploy + e2e; keep only the cheap PR gate automatic (Actions-minutes).** Run the fast correctness CI on every PR (it's the enforced backstop — never move it to "run locally"), but make the **expensive** steps deliberate: **deploy = manual `workflow_dispatch`** *plus* an opt-in **`deploy`-label auto-trigger** (label a PR → its merge deploys `main`; unlabelled merges deploy nothing — TM-156, in-workflow `pull_request: closed` gated on `merged && labelled`, deploying the real merge commit not the PR test-merge); **e2e = nightly + on demand**, not per-merge. A docs-only change then costs ~0 minutes (skip via `paths-ignore`/job-gate), and the live site updates only when you choose (TM-151 / TM-153). Private repos meter Actions minutes; public repos don't.

## B. Repo + agent operating system (the linear bootstrap)
- Create the repo (default branch `main`).
- **Seed the repo COMPLETE from the start** (don't seed minimal then retrofit — TeamMarhaba had to sync-retrofit via TM-87 / TM-89):
  - `.claude/skills/` — `jira-task-claim`, `jira-ticket-writer`, `jira-epic-breakdown`, `jira-mcp-gotchas`.
  - `docs/agents/` — `AGENT-CLAIM-PROTOCOL`, `DEPENDENCY-DAG`, `SPRINTS`, **`blackboard.md`** (pre-seeded with known env workarounds).
  - `CLAUDE.md` with **all conventions baked in** (see C).
  - `CLAUDE.md` `@import docs/agents/runtime/blackboard.md` (auto-load) + blackboard read as a **claim-loop step**.
- Minimal branch protection + the PR→merge flow.
- **merge→Done GitHub Action** + its Jira API secrets — so a merged PR auto-moves its ticket to Done from day 1. *(Agents don't loop back after opening a PR; without this, tickets strand In Review — TeamMarhaba's TM-86.)* **Make the docs-only auto-merge path transition too:** a PR merged by the `automerge-docs` Action is `GITHUB_TOKEN`-authored, and GitHub **won't let that trigger** the merge→Done workflow — so wire the Jira "→ Done" transition *into* `automerge-docs` itself, or docs-PR tickets silently strand In Review (TM-148, hit on TM-138/TM-145).

## C. Conventions to bake into CLAUDE.md (every one was added mid-flight)
- **Branch naming:** `<type>/TM-XX-short-desc`, where `<type>` matches the *nature* of the work
  (not the convenience of the moment): `feature/` = an app feature (Story/Task), `fix/` = a Bug,
  `chore/` = infra / CI / cloud / docs / config. (e.g. a CI-minutes cut is `chore/`, not `feature/`.)
- **Markdown only — NEVER Jira wiki markup** (`h3.`, `{code}`, `{{...}}`, `[text|url]` render broken). Descriptions **and** comments.
- **Board fields / time tracking:** Start date on claim, Due date, **worklog** on PR, **Flagged = Impediment** when blocked. Story points = the estimate.
- **Blocker-logging:** log every wall as a ticket comment + a `[finding → future improvement]` note; split human-only steps into `human-in-the-loop` tickets.
- **Blackboard:** read after each claim (loop step) + auto-loaded via `@import`; append cross-cutting findings.
- **Build tool = Gradle (Kotlin DSL)** — unify with the Gradle-native Android; **don't default to Maven**.
- **One PR implements its one ticket.** A PR's branch/key must match the work it contains — never build an out-of-scope or deferred feature under a convenient ticket. The orchestrator *flags* a mis-scoped PR (doesn't merge it). *(An onboarding tour shipped under TM-135's OpenAPI-drift ticket — caught only by manual review.)*

## D. Jira project setup
- **Epic → Task** model (Tasks are pickable, not Sub-tasks); `group-1.x` + `wave-N` labels.
- **Every ticket is fully specified before it's pulled into a sprint — no thin tickets.** A Task carries a complete description up front: the **Standard** section (user story + *testable* ACs + a Field/Value table), any **Human/HITL** notes, and the **agent execution prompt** as the pinned first comment. A half-filled ticket = ambiguous scope → rework, duplicate builds, and un-reviewable PRs; if it can't be fully specified, it isn't ready. (Cheap to check at planning; expensive to discover mid-build.)
- **Break each non-trivial Task into sub-tasks as a mid-flight progress checklist.** Sub-tasks are coarse, *verifiable* milestones (a handful of real checkpoints — e.g. *migration written · entity+API wired · tests green · docs/openapi updated* — not a line-by-line to-do) that the working agent ticks off as it goes. This makes an **In-Progress Task's progress confirmable without reading the diff** — the orchestrator/human sees "3 of 5 done" and can catch a stuck/derailed task early. **The Task stays the pickable & sprintable unit; these sub-tasks are the *intra-task* breakdown, never separately claimed** — that's the standard Epic→Task→Sub-task shape, and it does **not** contradict the "Tasks are pickable, not Sub-tasks" rule above (that rule is about the *claim* unit, not a ban on sub-tasks).
- **Human-task tracking:** human-only steps (start sprint, review+merge, billing, UI deletes) = Tasks with the **`human`** label, **assigned to a person** (excluded from the agent claim pool).
- Board fields available (Start/Due date); *optionally* enable the **Time Tracking field** (UI admin) for hour-based Original Estimate — for AI agents, story points + worklogs already suffice, so usually skip.
- Sprint naming theme (anatomy: SKELETON → SPINE → …). Start with Sprint 0 / Genesis, then SKELETON 1.
- **Right-size the sprint box to the fleet** — ~1–2 days or goal-based slices, **not** calendar weeks (agents cleared a 4-day slice in ~1 day; the real limiter is human-gate throughput). **Freeze the sprint to new *feature* scope** — route mid-flight *feature* ideas to the next backlog for a clean burndown + true velocity.
- **Chore & bug-fix exception — work that *ships the committed sprint* may be pulled into the active sprint** (by the orchestrator/human, not a self-sprinting agent). Freeze stops new *features*; it must **not** block the operational work needed to actually deliver what's committed: a `chore` (CD/infra/CI/config — e.g. automating a manual deploy step), the deploy/enable step that wasn't fully done, or a **bug found in the closure review**. That's *finishing* the sprint, not expanding it. Guardrails: only `chore`/`bug` types tied to the current sprint goal (never a new feature smuggled in as a "chore"); added by the orchestrator/human; agents still never self-sprint (next). *(Sprint 170: the TM-188 blank-phone bug and the TM-191 CD-rules chore were legitimately pulled in this way; TM-185, a new feature, was bumped out.)*
- **Agents never self-sprint — discovered work goes to the backlog, not the active sprint.** A fleet agent *may* create a ticket for an improvement/follow-up it discovers, but must leave it in the **backlog** (To Do, no sprint, label it `future-improvement`/`no-replay` as appropriate). **Only the orchestrator/human pulls a ticket into a *started* sprint.** An agent that creates a ticket, adds it to the active sprint, *and* builds it breaks freeze, inflates scope, and bypasses planning + review — bump it back to the backlog (the PR can stay open for a future sprint). *(Happened in sprint 170: an agent self-sprinted TM-185 "profile change history"; the sibling backlog tickets TM-181/182/183/186/187 it parked correctly — the rule is: do that, never self-sprint.)*
- **No work outside an *open* sprint.** Don't move a ticket to In Progress or start hands-on work unless it sits in a *started* sprint — the started sprint is the unit of committed work. Sprint create/start is **UI-only** (the connector has no sprint tool), so the flow is: propose name + goal → a human starts it → *then* pull tickets in and work.
- **Sprint-closure gate — three mandatory items before a sprint closes.** A sprint is not "done" when its feature tickets are merged; it's done when it's been *verified and shipped*. Before closing any sprint, the orchestrator creates/completes:
  1. **A manual-testing ticket** — a `human`-labelled Task to manually exercise the sprint's delivered features end-to-end (the human residue automated tests don't cover: real auth/email, exploratory, "does it actually feel right"). Lands in the same sprint; closing waits on it.
  2. **A full code review** — a review pass over *everything the sprint changed* (not per-PR isolated diffs), to catch cross-ticket interactions, drift, and consistency. Raise a review ticket or run the review workflow; record findings as follow-up tickets.
  3. **A deploy** — ship the sprint's merged `main` to production (the `teammarhaba-deploy` skill / manual `workflow_dispatch`) and confirm the new build is actually serving (build-stamp matches HEAD). An unshipped sprint isn't finished.
  Only after manual test passes + review is clear + the deploy is verified does the human close the sprint. Treat these three as the sprint's Definition of Done, the same way green CI is a PR's.

## E. Then — parallel work
- Launch agents on `/jira-task-claim`; they self-host from the repo (clone → auto-load `CLAUDE.md` / skills / blackboard → pull). Kickoff = one line + `agentId`.

---
**Sources** — mid-flight tickets/PRs that became Genesis steps: `TM-80` (seed), `TM-81` (gcloud HITL), `TM-84` (billing), `TM-86` (merge→Done), `TM-87` (doc sync), `TM-88` (Gradle), `TM-89` (blackboard auto-load + markdown mandate); Sprint 2 deploy wiring → PR #25 (iamcredentials API), PR #26 (runtime SA + private deploy), `TM-96` (public-access org-policy HITL). Full story: `REPLAY.md`. Verified commands live in `infra/gcp/cloud-run.md` + `secrets-env.md`.
