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

## Parallelism & the merge gate
- **The merge gate is the real bottleneck.** Agents finish in minutes; *unmerged* PRs stall the whole fleet (downstream tickets can't unblock). Keep the human merge loop tight. Only docs-only `*.md` PRs auto-merge; everything else waits on a human.
- **When the first PR of a wave merges, its siblings often flip to CONFLICTING.** The orchestrator should *proactively* rebase + `--force-with-lease` the feature branches (never merge) to keep them mergeable.
- **Conflicts are almost always additive** (keep-both / dedupe) — resolve on the feature branch, force-push, let CI re-run. Never resolve by merging into `main`.

## Sprints & claiming
- **A sprint must be STARTED (open) before agents can claim from it.** The find-ready query is `sprint in openSprints()`; tickets in a *future* (created-but-not-started) sprint are invisible → agents sit idle. Start the sprint first.
- **Every ticket you want worked must be IN the sprint.** Pulling only some in leaves the rest in the backlog, unclaimable. (We pulled only TM-110/114 once; the rest of the wave sat idle until moved.)
- **Trust the API, not the board.** The rendered board lags/caches; status+assignee from the API is the truth. (A ticket showed "To Do" on the board while actually In Progress.)
- **Shared Jira user → status is the lock, not assignee.** Race-safe claim = transition To Do→In Progress, then `[claim] <agentId> <ISO>`; earliest claim wins, others abandon.
- **Human-only steps get their own `human`-labelled ticket** — never bundle interactive/console/secret steps into an agent task, and **don't wire a human task as a DAG blocker** of agent tasks (it stalls the fleet waiting on a person).

## Drift & verification — don't trust "green"
- **"Green pipeline / green deploy" ≠ correct.** Assert the *real* postcondition. For CD: the revision serving traffic == the just-built SHA — not merely `/health` 200. (TM-131: prod served stale code for the entire project behind green deploys, because the verify only curled `/health`.)
- **`cancel-in-progress` on a shared `main` group strands deploys.** A `concurrency` group keyed on `github.ref` cancels the *previous* `main` run when a second merge lands — including its image-build/push job, so that commit's image never ships and its deploy strands waiting for it (TM-140/TM-146). Scope concurrency by event: cancel on PR branch refs (fast gate), but key `push` runs per-`github.sha` so back-to-back merges never cancel each other. Pair the prevention with a **scheduled reconcile** that re-deploys if the serving revision ≠ `main` HEAD — a deploy that *never landed* is invisible to both the per-deploy verify and a "Ready revision exists" canary.
- **Keep a drift guard for every contract:** DB schema (`ddl-auto: validate`), env (`.env.example` + fail-loud validator), format (Spotless), coverage (JaCoCo gate), deps (dependency-review / CodeQL / SBOM), API (OpenAPI drift check). Track status in `COMMON-FEATURES.md`.
- **A coverage tracker catches missing generics early.** Playwright e2e and the "seed the first ADMIN" gap were both found by auditing against the reference spec — not by an agent failing later.

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
