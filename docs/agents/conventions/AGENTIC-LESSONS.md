# Agentic Development — Lessons Learned

Durable, cross-cutting lessons for running the TeamMarhaba agent fleet — the patterns and
anti-patterns we paid to learn. **How to orchestrate agents well**, distinct from the other docs:

| Doc | Holds |
|---|---|
| `blackboard.md` | per-run operational scratch (env quirks, "main is red") — disposable |
| `COMMON-FEATURES.md` | generic base-product feature coverage |
| `.claude/skills/` | how-to for specific tasks (ticket-writing, claiming, MCP gotchas) |
| **this file** | **how to run the fleet** — decomposition, parallelism, drift, scope, replay |

Kept on replay. **Append a dated lesson whenever the fleet teaches you one**, so each run is better than the last.

## Decomposition & dependencies
- **Partition tickets by file/package ownership.** Two parallel agents editing the same hot file (`User.java`, `pom.xml`, `application.yml`, a shared migration) collide at the merge gate. Give each parallel-eligible ticket its own files; if two ready tickets *must* touch the same file, **sequence them (one blocks the other) — don't parallelize.** (Sprint 7: TM-111 & TM-115 both eyed the admin user list — flagged as a watch; TM-110/114 stayed clean only because they happened to live in different packages — luck, not design.)
- **Keep a HOT-FILES list and plan around it.** Maintain a living list of the files that have *actually* caused merge conflicts, and at planning time **don't co-schedule two parallel tickets that both touch a hot file** — sequence them instead. Treat a hot file like a lock: minimise edits, keep them additive (keep-both resolves cleanly), and review the *whole* region on a change, not just your hunk. **Current hot files:**
  - `backend/src/main/java/com/teammarhaba/backend/user/User.java` — the central entity; many tickets extend it.
  - `backend/src/main/java/com/teammarhaba/backend/web/GlobalExceptionHandler.java` (+ its test) — every feature adds an exception mapping here (Sprint 7: #109 ↔ #110 collided exactly here).
  - `backend/src/main/resources/db/migration/` — Flyway version-number clashes are **git-invisible** (same `Vn`, different filename); pre-assign or renumber on rebase.
  - `pom.xml`, `application.yml` / `application-prod.yml` — shared backend config.
  - `docs/agents/runtime/blackboard.md` — every agent appends notes.
  Add to this list when a new file bites; prune when one stops being shared.
- **Flyway/DB migrations are a serialization point.** Two agents each adding `V3__*.sql` clash. Mitigate: pre-assign migration numbers per ticket, renumber on rebase, or use timestamped names.
- **Verify blocker-link direction with a read-back.** A wrong `createIssueLink` direction inverts the whole DAG (wave-0 roots look "blocked by" their own descendants). Create one link → read it back → glance at the UI "is blocked by" heading → *then* bulk-create. There's no delete-link API, so a wrong bulk-create is expensive.
- **Map the DAG before sizing the fleet.** Agents to run = width of the widest *ready* wave (Sprint 7 = 3). More agents than ready tickets just idle. The **critical path** (longest dependency chain) — not total story points — sets how long the sprint takes (Sprint 7: TM-111 → TM-133 → TM-134).
- **Reprint the DAG with live progress during execution, not just at scoping (user ask).** Show the wave-by-wave DAG once up front (tasks + blockers + parallel-agent count), then **reprint it roughly every ~2 tickets / whenever a wave advances**, marking each node ✅ Done · 🔵 In Review · 🟡 In Progress · ⬜ ready · ⛔ blocked. The orchestrator does this unprompted so the human keeps visibility into where the epic is without asking.

## Parallelism & the merge gate
- **The merge gate is the real bottleneck.** Agents finish in minutes; *unmerged* PRs stall the whole fleet (downstream tickets can't unblock). Keep the human merge loop tight. Only docs-only `*.md` PRs auto-merge; everything else waits on a human.
- **When the first PR of a wave merges, its siblings often flip to CONFLICTING.** The orchestrator should *proactively* rebase + `--force-with-lease` the feature branches (never merge) to keep them mergeable.
- **Conflicts are almost always additive** (keep-both / dedupe) — resolve on the feature branch, force-push, let CI re-run. Never resolve by merging into `main`.
- **Soft vs hard blocker links — parallelize the soft ones.** A `is blocked by` link is *hard* when the dependent needs the blocker's built output **or edits the same files** → it must wait (building early = rework + a conflict storm; the link is *why* they'd collide). It's *soft* when the two share only a **naming/interface contract** and touch **disjoint files** → they can build **in parallel despite the DAG arrow**, if the orchestrator fixes the shared contract in both agent prompts up front. *(Grows Skin: TM-210 theme-core (web) + TM-212 deploy-injection (`deploy.yml`) were linked but disjoint + shared only the `window.TEAMMARHABA_CONFIG.theme` contract → ran 2 agents at once, zero conflict.)* The autonomous fleet plays safe (claims only once a blocker is `Done`); **soft-link parallelism is an orchestrator judgement call** — spot the disjoint-file linked pairs and launch them together.
- **Parallel tracks/sprints stay trunk-based — don't add a `develop` branch.** `main` is the integration branch **and deploy is decoupled from merge** (TM-153 — deploy is a deliberate manual/config action, not on-merge), so `main` already means *"integrated, not yet released"* — exactly what a GitFlow `develop` provides, minus the overhead, and without breaking the fleet's *"ready = blocker `Done` on `main`"* detection (a `develop` branch would strand every dependent). Hide an in-progress multi-ticket feature with a **feature flag / config gate** (the `THEME`-config pattern), not a long-lived branch. Want a pre-prod look at integrated work? That's a **staging deploy target** (environment), not a branch.

## Sprints & claiming
- **A sprint must be STARTED (open) before agents can claim from it.** The find-ready query is `sprint in openSprints()`; tickets in a *future* (created-but-not-started) sprint are invisible → agents sit idle. Start the sprint first.
- **Every ticket you want worked must be IN the sprint.** Pulling only some in leaves the rest in the backlog, unclaimable. (We pulled only TM-110/114 once; the rest of the wave sat idle until moved.)
- **Trust the API, not the board.** The rendered board lags/caches; status+assignee from the API is the truth. (A ticket showed "To Do" on the board while actually In Progress.)
- **Shared Jira user → status is the lock, not assignee.** Race-safe claim = transition To Do→In Progress, then `[claim] <agentId> <ISO>`; earliest claim wins, others abandon.
- **Re-verify the claim twice: at claim time AND right before the PR.** Claiming alone doesn't isolate the claim→build→PR window: a second agent that *selected* the ticket while it was still `To Do` builds for minutes in its own worktree and never re-reads Jira, so the claim-time check can't see it — it opens a duplicate PR (TM-151: #145 merged, #146 a duplicate ~14 min later). Fix (TM-154): re-run the three claim checks (status still your In-Progress · no other `PR:` comment · earliest `[claim]` is yours) **immediately before `gh pr create`** and abort the PR if any fails. A doc change can't rescue an already-running build (it won't reload the skill) — it protects the *next* run.
- **Human-only steps get their own `human`-labelled ticket** — never bundle interactive/console/secret steps into an agent task, and **don't wire a human task as a DAG blocker** of agent tasks (it stalls the fleet waiting on a person).

## Drift & verification — don't trust "green"
- **"Green pipeline / green deploy" ≠ correct.** Assert the *real* postcondition. For CD: the revision serving traffic == the just-built SHA — not merely `/health` 200. (TM-131: prod served stale code for the entire project behind green deploys, because the verify only curled `/health`.)
- **`cancel-in-progress` on a shared `main` group strands deploys.** A `concurrency` group keyed on `github.ref` cancels the *previous* `main` run when a second merge lands — including its image-build/push job, so that commit's image never ships and its deploy strands waiting for it (TM-140/TM-146). Scope concurrency by event: cancel on PR branch refs (fast gate), but key `push` runs per-`github.sha` so back-to-back merges never cancel each other. Pair the prevention with a **scheduled reconcile** that re-deploys if the serving revision ≠ `main` HEAD — a deploy that *never landed* is invisible to both the per-deploy verify and a "Ready revision exists" canary.
- **Keep a drift guard for every contract:** DB schema (`ddl-auto: validate`), env (`.env.example` + fail-loud validator), format (Spotless), coverage (JaCoCo gate), deps (dependency-review / CodeQL / SBOM), API (OpenAPI drift check). Track status in `COMMON-FEATURES.md`.
- **A coverage tracker catches missing generics early.** Playwright e2e and the "seed the first ADMIN" gap were both found by auditing against the reference spec — not by an agent failing later.
- **A "green" dep-bump PR only proves what the PR gate actually ran.** Path-gated jobs make some bumps un-vetted: a `github/codeql-action` major showed green only because CodeQL path-skips workflow-only changes, so the new action was never exercised (TM-136). Before trusting a green dependency PR, confirm the bumped thing is on a job that *ran* (not `skipping`); if it's gated off, the green is meaningless.
- **An off-PR-gate e2e suite rots un-run — and shipped a real prod bug (TM-198/TM-199).** The Playwright e2e suite runs **nightly + on dispatch only, off the PR gate** (TM-134/TM-153), so the profile specs (TM-167/188/166/195) merged having **never actually run** — and were **5/7 red** the first time they ran. A merged-but-never-executed spec is *worse* than no spec: it reads as coverage while guarding nothing. **A sprint cannot rely on e2e for sign-off unless the suite is actually run green.** Add a guard so specs can't rot unseen — pick the proportionate one: a PR-gate **smoke subset**, run e2e on PRs touching `web/`, or a required **"nightly e2e green"** check before a sprint can close. (See GENESIS "Testing & drift guards".)
- **API/integration tests don't cover UI event wiring — the headline flow needs a browser test that actually runs (TM-199).** Edit-profile **Save did a native form submit → full page reload** (changes lost, no PATCH) because `const save = el("button"…)` **shadowed** `async function save(event)`, so the form's `onSubmit: save` bound the *button element* not the handler → no `preventDefault()`. Backend/integration tests were green throughout; only a real browser exercising the submit catches this. Lessons: (a) **never name a DOM element the same as its handler** — it silently shadows; use `saveBtn`. (b) The primary user flow of a feature needs an e2e that *runs in CI*, not just API coverage.
- **Dependabot major policy: deliberate in every ecosystem, not auto-PR'd (TM-136).** Auto-opening *major* bumps earned its keep nowhere — the open Actions/Docker majors all passed CI (so caught no breakage), arrived 5-at-once (noise), and hid a false-green (above). The breakage history is *maven* (Spring Boot 4 / springdoc 3, #56). So `ignore: version-update:semver-major` now covers maven **and** github-actions **and** docker; minor/patch still flow (keeps SHA pins fresh — TM-59). Do a major by hand when you actually want it. The `dependabot-auto-label.yml` backstop still tags any major that surfaces anyway (e.g. a security update, which the version-update ignore doesn't suppress). General rule: **suppress auto-PRs that don't catch real failures** — they're cost (noise + false confidence) with no benefit.

## Driving CI / e2e loops (orchestration)
- **Don't hand a background subagent a task whose main activity is silently waiting (TM-198/199).** Two background agents were **watchdog-killed (600s no output)** — one burned ~an hour standing up the e2e stack locally, the next stalled inside an ~8-min CI `gh run watch`. A subagent that mostly *waits* trips the no-output watchdog. **Drive e2e-fix / CI-validation loops inline from the orchestrator** — run `gh run watch <run-id>` as a **bash background** command so completion notifies you without an agent watchdog — and **prefer CI validation over local-stack setup** for e2e (standing up the emulator + Playwright stack locally is the slow, flaky path).
- **Diagnose e2e failures from the artifact screenshots, not the logs (TM-199).** Playwright uploads `test-failed-1.png` + trace + video; `gh run download <run-id> -n playwright-report` then viewing the PNG shows the actual on-screen state (here: the form had reset to empty) — far faster than grepping assertion text out of the log.

## Scope discipline
- **Build abstractions from a real consumer (YAGNI).** Don't build reusable frameworks (base entity, list conventions, a "UX kit") before a real feature needs them — you'll design the wrong abstraction. The admin console gave RBAC/audit/list-conventions a real consumer; *that's* when they became worth building.
- **Hunt bootstrap/seed gaps — "who creates the first X?"** The first ADMIN was chicken-and-egg: JIT provisions everyone as USER and set-role needs an existing admin → no path to the first admin until an env-driven seed was added.
- **One tight goal per sprint/epic.** When mid-flight work doesn't serve the current goal, that's scope creep — close the sprint on its goal and start a fresh one (we closed "Sign of Life" and opened "Grows Hands" rather than stuffing the admin slice into a finished sprint). Don't rewrite a sprint goal at the end to match what got done — it makes the goal meaningless.
- **Metadata lives in labels/issue-type, never summary prefixes** (`[human]`, `[bug]`, `Chore:`). Prefixes drift into inconsistency and can defeat the agent's `labels != "human"` find-ready filter.

## Process & replay
- **Fold mid-flight learnings into the source tickets** so the rebuild can't reintroduce the bug (TM-131's hardening was folded into TM-60/TM-63's ACs).
- **Attribute the PR/commit to the replay-owning *build* ticket, not just the bug** that surfaced it — else the rebuild (`labels = replay`) loses the change (PR for the deploy fix was re-pointed from the bug TM-131 to the build ticket TM-60).
- **No untracked PRs.** Every change traces to a ticket; idle agents raise a `chore` ticket *before* doing housekeeping.
- **Blackboard = per-run scratch; this file + tickets + `REPLAY.md` = anything that must survive a replay.**

## Runbook — orchestrator conflict sweep (working the merge gate)

The orchestrator's job while a wave has open PRs: keep them mergeable and surface what's ready — **without ever merging** (only docs-only `*.md` PRs auto-merge; everything else is the human's manual merge).

### Each sweep
1. `git fetch origin`
2. `gh pr list --state open --json number,title,mergeable,mergeStateStatus,headRefName`
3. JQL the active tickets for `status` + `assignee` (claims, In Review, cascade unblocks).
4. Act per the checks below; report **one line per PR** + anything resolved. Adjust cadence (see below).

### Reading `mergeStateStatus`
- `CLEAN` — mergeable + checks passed → **READY for the human's manual merge.**
- `UNSTABLE` — mergeable but a non-required/pending check (often path-skipped jobs) — usually fine; recheck.
- `DIRTY` / `CONFLICTING` — needs a rebase (below).
- `UNKNOWN` — GitHub still computing; recheck next sweep.

### Resolve a conflicting code PR (never merge)
```
git checkout <feature-branch>
git rebase origin/main
#   resolve — conflicts are almost always additive (keep BOTH sides) → git add → git rebase --continue
git push --force-with-lease         # FEATURE branch only — NEVER main
```
CI re-runs; report it back to ready. (The PR updates in place.)

### Predict conflicts before they bite — diff the open PRs
- **Hot-file overlap:** `comm -12 <(gh pr diff A --name-only|sort) <(gh pr diff B --name-only|sort)`. Any shared file → once one merges, the other goes CONFLICTING. Pre-warn; rebase the loser the moment the first merges. (Sprint 7: #109 & #110 shared `GlobalExceptionHandler.java`.)
- **Flyway version clash — git WON'T catch it.** Two migrations with the same `Vn` but different filenames are git-CLEAN yet fail Flyway at boot ("more than one migration with version n"); only CI (Testcontainers) catches it. `gh pr diff <n> --name-only | grep migration` and ensure each new migration takes the next free `Vn` across *all* open PRs **+ main**.
- **Shared-concept duplication — also git-clean.** Parallel tickets can each invent the same type in different files (Sprint 7: TM-111 and TM-115 each made a `PagedResponse`). No conflict, but a real divergence → raise a small **dedupe chore**; don't block the merge.

### Merge-order guidance (minimize churn + keep the cascade moving)
- Merge **independent** PRs first (no shared files, no shared migration).
- For PRs sharing a hot file: merge **one**, let the orchestrator rebase the other, **then** merge it — don't merge both blind.
- Land **convention/dependency** PRs before their consumers, so the consumer builds on the real thing (merge list-conventions/audit before the admin console that uses them).
- A PR that's a **blocker** (e.g. TM-111 → TM-133) unblocks the next wave — sequence it so the cascade resumes promptly.

### Cadence
- **~2 min** while PRs are landing/merging (the post-merge conflict window is time-sensitive).
- **~4–5 min** when agents are mid-build with no PRs (cuts noise; still inside the prompt-cache window).
- **Pause** when the fleet is idle by design (sprint not started / nothing claimable) — polling buys nothing.

_Living document — append a dated lesson whenever the fleet teaches you one._
