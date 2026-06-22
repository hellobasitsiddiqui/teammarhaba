# TeamMarhaba — Replay / Learning Log

A **prompt-by-prompt replay** of how the TeamMarhaba "Foundation & DevOps" backlog was planned and built in Jira with an AI agent. A junior developer can work through this step by step: read the **Intent**, understand the **Decision & why**, paste the **Prompt to try** into the agent, and check the **Outcome**.

> Living document — append a new dated section at the end after every working session.

**Stack / decisions referenced throughout:** Java 21 / Spring Boot · Cloud SQL (Postgres) + Flyway · Firebase Auth · Cloud Run + Firebase Hosting + FCM · GitHub Actions · mono-repo. Jira project key **TM** (`10xai.atlassian.net`).

---

## Session 1 — 2026-06-20: Plan & build Epic 1 in Jira

### Step 1 — Find out what's in Jira
- **Intent:** Orient — how many tickets exist?
- **Decision & why:** Always discover the workspace before acting. The connected Jira had one empty project (`SCRUM`/TeamMarhaba), *not* the user's day-job hmcts project. Confirming the target project early avoids creating tickets in the wrong place.
- **Prompt to try:** `how many tickets are in jira?`
- **Outcome:** 0 tickets; one project (key `SCRUM`, later renamed `TM`).

### Step 2 — Establish what we're building (and what we're NOT)
- **Intent:** A spec file from another project was in the repo; clarify its role.
- **Decision & why:** `contact-directory-MASTER-SPEC.md` is a **reference for practices**, not a thing to rebuild. Recording this in memory stops the agent from scaffolding the wrong project later.
- **Prompt to try:** `read contact-directory-MASTER-SPEC.md and tell me what we'll reuse — features/practices only, we are NOT building Contact Directory`
- **Outcome:** Agent summarised the spec and saved a memory note: borrow patterns (JWT/auth, audit log, Git Flow, CI rigour, "bake fixes in day one"), don't rebuild.

### Step 3 — Pin down the architecture via Q&A
- **Intent:** Turn a vague "build a base across web/webview/android + backend" into concrete tech choices.
- **Decision & why:** Decisions were made one at a time with the *why* recorded: backend = **Java/Spring** (REST API, like the reference); DB = **Cloud SQL Postgres** (keeps JPA/Flyway/relational; ~$2-15/mo at low traffic; avoids a future migration from Firestore); auth = **Firebase Auth** (social logins out of the box); hosting = **Cloud Run + Firebase Hosting + FCM**; **mono-repo**.
- **Prompt to try:** `we're building a reusable app base across web, webview, android + a shared backend. Recommend a stack and hosting, asking me one decision at a time with the trade-offs.`
- **Outcome:** A locked decision set, saved to memory (`teammarhaba-base-decisions`).

### Step 4 — Decide the backlog shape, then the ticket format
- **Intent:** Structure Epic 1 (Foundation & DevOps) so multiple agents can each pick one ticket.
- **Decision & why:** Each ticket carries a **Standard** section (user story `As a… I want… so that…` + testable ACs + a Field/Value table), a **Human** section (context/why), and the **Agent execution prompt** as a **pinned first comment** (machine-executable, separated from the human-readable description). Markdown formatting for readability.
- **Prompt to try:** `draft the ticket format: description = Standard (user story + ACs) + Human (context); agent execution prompt as a pinned comment. Show me one example ticket.`
- **Outcome:** Approved format; a pilot ticket created and reviewed before bulk creation.

### Step 5 — Pilot one ticket, fix rendering, then bulk-create
- **Intent:** Don't create 40 tickets blind.
- **Decision & why:** Create a single pilot, inspect the **rendered** result, fix formatting gotchas (see Lessons), *then* batch. Cheaper to fix once than 36 times.
- **Prompt to try:** `create just the Epic + one sub-task as a pilot, then show me the live links so I can check the rendering before we do the rest`
- **Outcome:** Caught two markdown issues (below). Then created the full backlog.

### Step 6 — Dependencies + waves for parallel agents
- **Intent:** Let agents grab any "ready" ticket (zero unmet blockers).
- **Decision & why:** Express dependencies as Jira **`is blocked by`** links, then label each ticket with its **topological depth** (`wave-0` … `wave-N`). An agent picks any `wave-0` ticket, and a ticket becomes ready when all its blockers are merged.
- **Prompt to try:** `add 'is blocked by' links for the dependency graph, then label each ticket wave-N by topological depth so agents can pick zero-dependency tickets first`
- **Outcome:** 51 links + wave labels applied.

### Step 7 — The big correction: sub-tasks aren't pickable
- **Intent:** User noticed the backlog showed only Stories, not the granular items.
- **Decision & why:** **Jira sub-tasks (level −1) never appear in the Backlog/Board independently** and can't be sprinted on their own — they ride with their parent Story. The agent-pickable unit must be a **level-0 type (Task/Story)**. We restructured to **Epic → Task** (Shape A): Foundation stays the one Epic, the 36 items become **Tasks**, and the `1.1–1.6` groupings became `group-1.x` **labels**. (Standard Jira can't make three levels all pickable; "Epic → Story → Task" you may have seen is really Epic → Story → Sub-task.)
- **Prompt to try:** `our agents need to pick one granular ticket from the backlog, but sub-tasks don't show there. Restructure so each item is a level-0 Task under the epic, with the area as a label. Plan it first.`
- **Outcome:** 36 sub-tasks rebuilt as Tasks `TM-44…TM-79` (the connector can't convert types in place, so I recreated them as Tasks; the user deletes the 42 old issues in the UI), links + labels re-applied, Epic description updated.

---

## Lessons & gotchas (carry these forward)

**Jira modelling**
- **Sub-tasks are not independently pickable.** For "an agent grabs one ticket from the backlog," use **Task** (level 0), not Sub-task. Use **labels** (`group-1.x`) for sub-grouping when you can't afford another hierarchy level.
- **Team-managed Jira hierarchy is fixed:** Epic → Story/Task (same level) → Sub-task. No level above Epic; a Story can't contain a Task.

**This Atlassian MCP connector**
- Descriptions/comments accept **markdown** (`contentFormat: "markdown"`). These render: headings, **bold**, `inline code`, tables, bullet/numbered lists, fenced code. These **do NOT** render: blockquotes (`>`) and task-list checkboxes (`- [ ]`) — they print literally. Use bold labels + plain bullets instead.
- **Do not HTML-escape** `&` `<` `>` — write them literally. Escaping shows `&amp;` in the rendered text (especially summaries).
- **`createIssueLink` direction is inverted in the tool's own description.** To express "X is blocked by Y", pass **`outwardIssue = Y` (the blocker)** and **`inwardIssue = X` (the blocked)**. Always create one link and read it back to confirm direction before bulk-creating.
- **No delete-issue, no move/convert-type, no create/start-sprint tools.** Those are UI-only. Plan around them: e.g. converting a sub-task to a Task means **recreate + (user) bulk-delete** the old ones; starting a sprint is a UI action.
- Field ids: **story points = `customfield_10016`**, **sprint = `customfield_10020`** (settable on issues, but you still start the sprint in the UI).
- Verify a representative result in the **rendered** UI before fanning out — a pilot saved redoing 36 tickets.

**Process**
- Decide one thing at a time and **record the *why*** (memory + ticket "Human" sections + ADRs). It stops decisions being re-litigated.
- "Bake known fixes in from day one" (fail-loud secrets, DB-level constraints, atomic guards) rather than ship the defect and patch later.

**Bootstrapping a new project (chicken-and-egg) — start with a LINEAR bootstrap epic**
- The repo and its agent operating instructions (`CLAUDE.md`, `.claude/skills/`, `docs/agents/`) can't exist before the repo is created — so the very first work can't follow repo-based rules. Resolve it with a small **Bootstrap epic run LINEARLY** (sequential, not the parallel claim model): (1) create the repo → (2) seed agent operating instructions into it → (3) minimal branch protection + the PR/merge flow the claim protocol needs.
- Drive the Bootstrap with **hand-fed starter prompts + user-level skills** (nothing's in the repo yet). Once it lands, every later epic switches to **repo-based instructions + the parallel claim protocol** — agents clone, auto-load `CLAUDE.md`/`.claude/skills`, pull work, and the kickoff shrinks to one line.
- TeamMarhaba did this **inline** (TM-44 + a seed task inside the Foundation epic) — a known shortcut. **Future projects: make it an explicit first epic.**

**Multi-agent coordination & human steps**
- **Status is the lock, not assignee.** When every agent shares one Jira user, the `To Do → In Progress` transition is what enforces mutual exclusion; a `[claim] <agentId> <time>` comment only breaks simultaneous ties (earliest wins).
- **Gate agents to the active sprint** (`sprint in openSprints()`) and pull only **dependency-closed** slices in — a sprint task whose blocker is still in the backlog can never go ready.
- **Track human-only steps as `human`-labelled Tasks assigned to a person**, so the board shows all the work, not just the agent slice. Agents skip them via `labels != "human"` (+ they're assigned). **JQL gotcha:** `labels != "x"` also drops *no-label* issues — safe here only because agent tasks always carry labels; the `assignee is EMPTY` gate is the null-safe primary guard.
- **Don't wire human tasks as DAG blockers** of agent work — it stalls the fleet on a person. Note hard prerequisites (e.g. billing before the GCP-project task) in the description instead.
- **Once the bootstrap lands, kickoff is one line.** Agents clone the repo and self-host (`CLAUDE.md` + `.claude/skills`); the kickoff only needs the agentId + anything newer than the seeded copy (here, the branch convention).

---

## Current state snapshot (end of Session 1)

- **Epic:** `TM-1` Foundation & DevOps.
- **36 Tasks:** `TM-44 … TM-79` (one per `1.x.y` item), each with a Standard+Human description, a pinned **Agent execution prompt** comment, story points, and labels `foundation` + category + `group-1.x` + `wave-N`.
- **Dependencies:** 51 `is blocked by` links; pick order via `wave-0 … wave-6`.
- **Superseded (delete in the UI):** the old Stories `TM-2, TM-4, TM-10, TM-15, TM-23, TM-30` and old sub-tasks `TM-3, TM-5–TM-9, TM-11–TM-14, TM-16–TM-22, TM-24–TM-29, TM-31–TM-43`. JQL: `project = TM AND issuetype in (Sub-task, Story)`.
- **Sprint:** "Sprint 1 - The Skeleton" is ACTIVE (2026-06-20 → 24) with **9 tasks**.
- **Bootstrap (inline):** `TM-47` (template bootstrap) dropped; `TM-80` (seed agent operating instructions into the repo) added, blocked by `TM-44`. Run the **linear bootstrap** `TM-44 → TM-80` in one window first, then launch parallel agents A + B.

---

## Session 2 — 2026-06-20: From backlog to a running multi-agent fleet

Picks up from Session 1 (36 Tasks under Epic `TM-1`). This session turns a static backlog into something a fleet can actually pull from — ordering, a coordination protocol, a scope gate, the sprint, the bootstrap, and the human steps.

### Step 8 — Order the work: dependency DAG + leverage
- **Intent:** with 36 inter-blocked tasks, which go first?
- **Decision & why:** compute a DAG from the `is blocked by` links; rank roots by **leverage** (how many tasks each unblocks) so agents grab the highest-impact work first and the critical path keeps moving.
- **Prompt to try:** `build a dependency DAG from the 'is blocked by' links; order tasks so the ones blocking the most others come first, and show the critical path.`
- **Outcome:** `DEPENDENCY-DAG.md` (Mermaid graph + leaderboard + 36-step order + 7-deep critical path). Leverage: TM-44 unblocks 32, TM-49 → 25, TM-66 → 10.

### Step 9 — Let any number of agents self-coordinate (the claim protocol)
- **Intent:** agents must pick work whether there are 2 or 20, with no central scheduler.
- **Decision & why:** a **pull protocol** where Jira `status` is the lock. An agent flips a ready task `To Do → In Progress` (hiding it from others' queries) and stamps a `[claim] <agentId> <time>` comment; collisions resolve by earliest stamp. Readiness = every `is blocked by` link is Done. Scales 2→20 unchanged; useful concurrency is bounded by DAG **width**, not agent count.
- **Prompt to try:** `design a pull-based claim protocol so N agents sharing one Jira user can each grab a ready task race-safely, no scheduler. Status is the lock.`
- **Outcome:** `AGENT-CLAIM-PROTOCOL.md` + the `jira-task-claim` skill.

### Step 10 — Scope gate: agents only touch the active sprint
- **Intent:** stop agents wandering the whole backlog.
- **Decision & why:** the candidate query carries `sprint in openSprints()` — the **started sprint is the human approval valve**. Caveat: only pull **dependency-closed** slices in (a sprint task blocked by a backlog task can never go ready).
- **Prompt to try:** `gate the agents so they only pull from the active started sprint, never the raw backlog — and explain the dependency-closure caveat.`
- **Outcome:** scope gate in protocol + skill.

### Step 11 — Theme and plan the sprint (anatomy)
- **Intent:** name + goal for Sprint 1.
- **Decision & why:** sprints follow a **human-anatomy** arc (SKELETON → SPINE → FLESH → MUSCLE → SENSES → ABLE BODY) — grounded because Epic 1 literally builds a *walking skeleton*. Sprint 1 = "The Skeleton".
- **Prompt to try:** `name the sprints on a 'product grows in capability' theme and write Sprint 1's goal + a dependency-closed scope.`
- **Outcome:** `SPRINTS.md`; Sprint 1 loaded + started in the UI.

### Step 12 — The bootstrap chicken-and-egg → linear first, then self-host
- **Intent:** agents are told to "follow the repo's rules" — but at t=0 the repo doesn't exist.
- **Decision & why:** every project opens with a small **LINEAR Bootstrap** (create repo → seed `CLAUDE.md`/`.claude/skills`/`docs/agents` into it → minimal protection), driven by hand-fed prompts. Once it lands, every later agent **self-hosts**: clone → auto-load repo rules → pull. TeamMarhaba did it inline (`TM-44` + `TM-80`); future projects make it an explicit first epic.
- **Prompt to try:** `the agent rules live in the repo, but the repo doesn't exist yet. Add a linear bootstrap that creates the repo and seeds the rules first, then have later agents self-host from it.`
- **Outcome:** `TM-80` seed task; after it merged, A/B kickoff = "clone `hellobasitsiddiqui/teammarhaba`, follow its CLAUDE.md / jira-task-claim."

### Step 13 — Track human-only steps as tickets
- **Intent:** some steps aren't automatable (start sprint, review+merge, billing) and were invisible on the board.
- **Decision & why:** track them as ordinary Tasks with a **`human`** label, **assigned to a person**, so the board shows all the work. Agents skip them (`labels != "human"` + assigned). Don't wire them as DAG blockers (stalls the fleet); note hard prerequisites in text. The **merge** is the one human gate the flow depends on.
- **Prompt to try:** `add the human-only steps (start sprint, review+merge PRs, billing) to the board as 'human'-labelled tasks assigned to me, and make agents skip them.`
- **Outcome:** `TM-82/83/84/85`; protocol + `jira-task-claim` + `jira-epic-breakdown` updated.

### State snapshot (end of Session 2)
- Bootstrap **done** (`TM-44`, `TM-80` merged); repo `hellobasitsiddiqui/teammarhaba` live + seeded.
- Sprint 1 "The Skeleton" active: **9 agent tasks + 3 human tasks**. **Agent A running**, Agent B pending launch.
- Docs current: `DEPENDENCY-DAG.md`, `AGENT-CLAIM-PROTOCOL.md`, `SPRINTS.md`. Skills: `jira-task-claim`, `jira-epic-breakdown`, `jira-ticket-writer`, `jira-mcp-gotchas`.
- Known follow-up: a `chore` PR to sync the branch convention into the repo's seeded `CLAUDE.md`/skill.

---

## Design decisions & future-improvement log — 2026-06-20 (live, during Session 2)

Captured mid-run because we will **delete the source and rebuild from these tickets** (a replay). The tickets + sequence + findings are the durable product; the code is disposable — so the second build must be strictly better than the first.

**→ The consolidated "do it up front" checklist is [`GENESIS.md`](../GENESIS.md).** Every mid-flight retrofit (toolchain/billing prereqs, branch naming, markdown-only, board fields/time-tracking, blocker-logging, blackboard + @import, merge→Done automation, Gradle, human-task tracking) is now an **initial** step there — so the replay never retrofits. **Rule: any step we found ourselves doing halfway through becomes a Genesis step** — keep adding to it.

**Confirmed (now in the agent docs — `jira-task-claim` skill + `AGENT-CLAIM-PROTOCOL.md`):**
- **Agents must log blockers as ticket comments** + a `[finding → future improvement]` note (how the ticket/sequence should change). Never fail silently. Human-only steps get their own `human-in-the-loop` ticket, linked as a blocker. Worked example: `TM-81` (gcloud).
- **Fully-functional board fields** (Basit, 2026-06-20): every worked ticket gets a **Start date** (`customfield_10015`, on claim), **Due date** (`duedate`), story-points **estimate**, a **worklog** of actual elapsed (`addWorklogToJiraIssue`) on PR, and **Flagged = Impediment** (`customfield_10021`) when blocked. Applied live: TM-49 (4m) + TM-51 (41m) logged, TM-66/63/67 flagged. **Caveat:** Original Estimate isn't on the Task screen → needs a one-time UI admin toggle; story points stand in. Baked into `jira-task-claim`, `AGENT-CLAIM-PROTOCOL`, `jira-mcp-gotchas`, `SPRINTS`, and the blackboard.
- **Done-on-merge gap → automation** (2026-06-20): agents go To Do → In Progress → In Review but **move on after opening the PR**, and GitHub↔Jira isn't integrated — so merged PRs left tickets stranded In Review (I moved TM-49/51 → Done by hand). Fix: new foundation ticket **TM-86** = a GitHub Action that auto-transitions the ticket to Done on PR merge (parse `TM-NNN` from the branch). Stopgap: the human merger moves it to Done (TM-83).
- **Build tool = Gradle** (decision **TM-88**, 2026-06-20): backend builds with Gradle (Kotlin DSL) going forward, unifying with the Gradle-native Android. Maven was only TM-49's initial default (throwaway on the redo). Cross-referenced from TM-49/50/53.
- **Repo sync** (**TM-87**, PR #6, 2026-06-20): the live agents self-host from the repo's TM-80 snapshot, which predated *all* of today's conventions — so none reached them until this `chore` PR pushed `CLAUDE.md` (+ a Conventions section), the skills, `docs/agents/*`, and the new `docs/agents/runtime/blackboard.md`. **Lesson → "seed it ALL up front":** future bootstraps seed the blackboard, conventions, merge→Done automation, build-tool decision, and an early toolchain HITL ticket from the start (now in the `jira-epic-breakdown` Bootstrap section).

**#1 sequencing fix for the redo — the GCP prerequisite was never sequenced.**
The chain *install gcloud → human `gcloud auth login` + `application-default login` → confirm/link billing → create GCP project (`TM-66`) → Cloud SQL / Run / OIDC* must be an explicit, correctly-ordered **bootstrap prerequisite at the front of the DAG** (the linear bootstrap's missing human half). agent-B hit it reactively (the host had **no gcloud at all**, and the Homebrew cask is broken on it). The host also had **no Docker** (likely what `TM-51` is hitting) — environment provisioning itself needs a human-in-the-loop bootstrap ticket. In the redo these are proactive and pre-sequenced so no agent ever meets "X isn't set up."

**Proposed — inter-agent messaging (a "blackboard"). Decision pending.**
Files agents read/write to coordinate. Names for the pattern: **blackboard** (shared store), **stigmergy** (coordinate via traces left in the environment), **actor-model mailboxes** (per-agent inbox), **pub/sub** (broadcast). Proposed shape:
- `docs/agents/runtime/blackboard.md` — append-only broadcast for *operational knowledge* (env quirks, workarounds, "main red"). Read on startup + after each claim → kills rediscovery.
- `docs/agents/runtime/inbox/<agentId>.md` — optional directed mailboxes for handoffs (low value at 2 agents; scales).
- **Durable vs ephemeral:** the bus is per-run scratch (deleted on replay); findings that must survive go in the ticket or this file. Ticket-specific coordination stays in Jira comments.
- Recommendation: start with the blackboard only; add mailboxes when a real handoff need appears.

**Open question — per-agent Jira identities? Decision pending.**
Give agent-A/-B their own Jira users/emails vs all sharing one account (current). *For:* `assignee` becomes the lock (drop the claim-comment tiebreak), live per-agent board visibility, cleaner history. *Against:* a paid seat per agent + per-agent API token/auth; the protocol was built to run N agents as one user (scales 2→20 with no provisioning). For the replay it's **not required** — claim comments already record agentId. Leaning: keep the shared user unless live per-agent visibility is wanted.

**Standing context:** once Sprint 1 / the foundation lands, we **delete the source and replay from the tickets**. Everything must be logged in tickets + this file so the second build is cleaner.

**Repo cleanup for the replay — keep / move / delete.** Don't wipe the whole repo; the **process + knowledge layer is durable**, only the **source is disposable** (rebuilt from tickets).
- **Keep / move to safety:** `CLAUDE.md` (root), `.claude/skills/**`, `docs/agents/**` (AGENT-CLAIM-PROTOCOL, DEPENDENCY-DAG, SPRINTS, + blackboard/inbox if adopted), any committed `REPLAY.md`. **Promote the blackboard's env-workarounds** (no Docker; gcloud cask broken → symlink fix) into a durable doc first — the blackboard file is per-run scratch but its content must survive.
- **Delete (rebuilt from tickets):** `/backend`, `/web`, `/webview`, `/android`; `/infra` (IaC — confirm first); build outputs / lockfiles.
- **Backstops:** Jira tickets are the real source of truth (separate from the repo); git history retains deleted source. Safest: tag the pre-clean commit → delete only source dirs → verify `CLAUDE.md` + `.claude/` + `docs/` survive → replay.

---

## Session 3 — 2026-06-20: Sprint 1 (SKELETON 1) executed, closed; Sprint 2 planned

First real execution — agents self-hosting from the repo, pulling the Sprint-1 slice, hitting blockers, finishing.

### What happened
- **Fleet burned down Sprint 1 in ~1 day.** All planned tasks + bootstrap Done: repo, `/health` walking skeleton, both Docker images, PR CI, GCP project + Firebase + Cloud SQL + keyless OIDC. DoD fully met. **Epic 1 ≈ ⅓ done** (this is the skeleton slice; deploy/observability/API-hardening/more-CI/hygiene still backlog).
- **Done-on-merge gap → automated.** Agents go To Do→In Progress→In Review but don't loop back to Done on merge, and GitHub↔Jira isn't wired → merged PRs stranded tickets In Review (hand-closed several). Fix: **TM-86** GitHub Action auto-transitions a ticket to Done when its `TM-NNN` branch merges. **Verified live** (throwaway **TM-91** → auto-Done) after the human added the Jira repo secrets (**TM-90**).
- **Agents raised their own HITL tickets when blocked** (the convention working): **TM-81** gcloud install/auth, **TM-92** re-auth ADC with the *firebase* scope (initial auth was cloud-platform-only → 403), **TM-93** add Firebase via console (`addFirebase` API 403'd even with the scope), **TM-84** billing. Pattern each time: agent does the agent-doable half, files a clean HITL ticket, human clears it, agent finishes.
- **Agents self-generated an improvement:** **TM-94** live DAG generator (Jira links → Mermaid) — supersedes the static `DEPENDENCY-DAG.md`.
- **Mid-flight corrections:** Gradle adopted as build standard (TM-88); repo docs/skills synced + blackboard seeded (TM-87, TM-89); markdown-only mandate after agents wrote Jira-wiki-markup evidence comments (fixed in skills + CLAUDE.md; reposted TM-81/84 comments); `.gitignore` credential-hardening folded into TM-44's prompt so the replay builds it in.

### Lessons (Sprint 1 retro)
- **Right-size the box to the fleet.** 4-day sprint finished in ~1 day → use **~1–2 day boxes or goal-based slices**; calendar timeboxes are near-meaningless for agents. The real limiter is **human-gate throughput** (billing, auth, secrets, merges), not agent speed.
- **Freeze the sprint (or decide not to).** ~8 tickets added mid-sprint; HITL ones unavoidable, but improvements should queue to the next backlog for clean burndown + true velocity.
- **Velocity — first data point:** ~19 planned pts + ~8 added, in ~1 day fleet wall-clock.
- **Pre-clear human gates up front** (GENESIS) — esp. gcloud auth **with the firebase scope** and Firebase-via-console, which bit TM-66 mid-flight.

### State at end of Session 3
- Sprint 1 complete (close on the board). merge→Done live; blackboard live; agents self-host.
- **Sprint 2 = "SKELETON 2: The Skeleton Walks"** (deploy slice TM-55/61/52/60/62 + TM-65 stretch; TM-64 deferred — blocked by TM-70) — planned in `SPRINTS.md`, awaiting board create + start.

_Next session: append Session 4 here._

---

## Session 4 — 2026-06-21: Sprints 2–4 executed; deploy hardening; replay/no-replay tagging

The fleet went from "stands + CI green" to a live, observable, authenticated backend — three sprints in quick succession, with the human as merge gate + conflict resolver.

### What happened
- **Sprint 2 (SKELETON 2 "The Skeleton Walks") — went live.** Backend on Cloud Run (private) + web on Firebase Hosting, auto-deploy on merge. The first real deploy surfaced three infra gaps, fixed reactively then folded into `GENESIS.md` §A2 so the replay deploys green first time:
  - PR #25 — enable `iamcredentials` API (keyless WIF token exchange 403s without it; blocked *all* CD).
  - PR #26 — dedicated least-privilege runtime SA (`teammarhaba-run@`, scoped `secretAccessor` + `cloudsql.client`) instead of the default compute SA (which lacked secret access — the fatal error); `--no-allow-unauthenticated` because the org enforces domain-restricted sharing (`allUsers` blocked).
  - **TM-96** raised (HITL): enable public access — needs an Org Policy Admin.
- **Sprint 3 (SPINE "Grows a Spine") — data backbone in ~48 min.** 7 tickets / 17 pts: profiles, docker-compose, Flyway/Postgres, RFC-7807 error model, `/api/v1`, security headers, Testcontainers. First→last merge 00:45→01:33 UTC. Velocity ~order-of-magnitude over Sprint 1 — conventions baked in; the only throttle is the human merge gate.
- **Sprint 4 (SENSES "Wakes Up") — prepared + loaded (id 36, future), not yet started.** 6 tickets / 14 pts: Actuator, OpenAPI, logging, fail-loud secrets, metrics, Firebase Auth seam.
- **Parallel-edit conflicts** — agents on the same sprint hit merge conflicts in *hot files* (`pom.xml`, `application.yml`, `README.md`) when two tickets append to the same region. Resolved by rebase-onto-main: TM-72 (dedupe a duplicate dependency), TM-76 (keep-both — Actuator + OpenAPI blocks were complementary). Conflicts are almost always *additive*; resolution = rebase + keep-both/dedupe → push the **feature branch** (never main) → let CI confirm.
- **Untracked housekeeping PRs** (#23, #32) — idle agents merged no-ticket chore work to main. Kickoff prompt now mandates raising a `chore` ticket first (no untracked PRs).
- **replay / no-replay tagging** — every TM ticket labeled so the source-rebuild scopes cleanly (see below).

### Lessons (Session 4)
- **Reuse the stored secret via a one-off `push`-triggered GitHub Action** for any Jira bulk op the MCP connector can't do (list sprints, bulk-add-to-sprint, bulk-label). Pattern: write `.github/workflows/<x>.yml` triggered on a `chore/<x>` branch → push → watch → delete the branch. Used for the Sprint 3/4 loaders, the (no-op) reversed-link "fix", and replay/no-replay tagging. No token paste; never touches main.
- **Calibrate link direction against a known-Done blocker before declaring a reversal.** A backwards *read* of issue-link direction made correct links look reversed; the "fix" was a semantic no-op (delete+recreate 9 already-correct links). In a GET readback: `outwardIssue` = the **blocker**; `inwardIssue` = the **dependent**.
- **Never push to `main` directly** — the auto-mode guard blocks it; use a feature branch. Branch protection isn't *enforced* on GitHub (free private repo needs Pro — TM-97), so the discipline is convention + the Claude-side guard.
- **Conflicts scale with parallel width on shared files** — 3 agents on one sprint ≈ 1–2 hot-file conflicts. Cheap to rebase-resolve; not worth slowing agents to avoid.

### replay / no-replay classification
- **`replay` (35)** — the 1.x.y foundation *build* tickets (TM-44–46, 48–79): code, CI, infra-as-code, config. Re-execute on the source-rebuild. Scope = `project = TM AND labels = replay`.
- **`no-replay` (20)** — TM-47 (dropped); TM-80/86/87/88/89/94 (meta — now baked into GENESIS/Sprint-0 seed); TM-81/82/83/84/85/90/92/93/95/96/97/98 (human/HITL/prod-readiness); TM-91 (throwaway). Human prereqs run up front per GENESIS §A.

### State at end of Session 4
- Sprints 1–3 complete; Sprint 4 loaded, awaiting close-3/start-4.
- Foundation epic (TM-1) ~80% done; ~1 more sprint (SKIN — security/supply-chain + devex/polish) closes it → **~5–6 sprints total**. Feature epics (other ~6 of 7) not yet ticketed.
- All tickets tagged replay/no-replay.

## Session 5 — 2026-06-22: Epic 2 (SPINE) built end-to-end; CD stale-revision fix; admin-console re-plan; agent-OS docs

Drove **Epic 2 (TM-102, "SPINE")** to completion across Sprint 6 (*Sign of Life*) and Sprint 7 (*Grows Hands*), acting as the **orchestrator**: planning, conflict-sweeping the merge gate, and folding learnings into source tickets.

### Built
- **Login chain live:** sign-up/login (email+social) → `/api/v1/me` → JIT user in Cloud SQL (two real accounts verified).
- **SPINE tail (Sprint 7):** RBAC via Firebase custom claims + seed-admin bootstrap (TM-110), `@PreAuthorize` + admin user endpoints with 404-not-403 + admin self-protection (TM-111), append-only audit (TM-113), reusable list/pagination conventions (TM-115), soft-delete + optimistic-lock on users (TM-114), the **admin users console** web UI (TM-133), and the first **Playwright browser-e2e** — main-only (TM-134).
- **Agent-OS docs grew:** `COMMON-FEATURES.md` (generic feature-coverage tracker), `AGENTIC-LESSONS.md` (fleet-orchestration playbook + merge-gate conflict-sweep runbook).

### Fixes & decisions
- **TM-131 — CD served stale code for the whole project behind green deploys.** Cause: DB-password drift (Flyway 28P01 → revisions never Ready) + traffic pinned to ancient revision #5; the verify only curled `/health` (false-green). Fixed live; hardened verify to assert *serving revision == just-built* (TM-60) + single-sourced the DB password (TM-63).
- **Admin-console slice (Option B):** the 5 abstract tail tickets had no consumer → re-planned as one real vertical slice so RBAC/audit/list-conventions get a real consumer + a UI to see users. Added TM-133/TM-134; re-scoped TM-114/115 to apply-to-users.
- **Epic boundaries:** closed Sprint 6 on its *met* goal (never rewrite a goal to match drift); opened Sprint 7. Deferred generic features (rate-limiting, CSP, account self-service, status page) → a future **Hardening epic** (adopts TM-95/97/98/99).
- **Replay-hardening of the seed:** no metadata prefixes in summaries; single canonical `human` label (the one the claim filter excludes); **corrected `createIssueLink` direction** in `jira-epic-breakdown` (it was inverted → would reverse the rebuilt DAG); TM-132 normalized 19 summaries.

### Lessons (Session 5) — full set in `docs/agents/conventions/AGENTIC-LESSONS.md`
- **Don't trust "green":** a green deploy/pipeline ≠ correct — assert the real postcondition (serving revision == built). (TM-131.)
- **Partition tickets by file/package** so parallel agents don't collide. **Flyway version clashes are git-invisible** (same `Vn`, different filename — only CI catches them). **Parallel tickets can duplicate a shared concept** (TM-111 & TM-115 each made a `PagedResponse`) — git-clean but a divergence → dedupe chore.
- **The merge gate is the real bottleneck;** rebase the conflicting sibling the instant the first of a wave merges (keep-both).
- **A sprint must be STARTED and tickets must be IN it** before agents claim; **trust the API, not the board** (a stale board showed In-Progress as To-Do).
- **YAGNI / build from a real consumer;** hunt **bootstrap/seed gaps** ("who creates the first admin?").
- **Attribute PRs to the replay-owning build ticket,** not just the bug.

### State at end of Session 5
- **Epic 1 (Foundation) done. Epic 2 (SPINE) complete** (last ticket TM-134 merging) — login + RBAC + admin console + audit + list conventions + e2e, demoable.
- Open: TM-135 (OpenAPI drift), TM-136 (dependabot policy), TM-138 (agent-OS reorg into a portable seed), TM-120 (constants file), a `PagedResponse` dedupe chore (unraised), the deferred Hardening epic. Pruned 72 merged branches.
- **Next: close Sprint 7; Epic 3 (FLESH = first real product feature, tenancy/teams candidate) is the next build epic.**

_Next session: append Session 6 here._
