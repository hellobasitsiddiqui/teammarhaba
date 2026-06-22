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

_Living document — append a dated lesson whenever the fleet teaches you one._
