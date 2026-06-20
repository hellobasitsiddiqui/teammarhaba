# TeamMarhaba — agent operating instructions

## What this is
TeamMarhaba is a **multi-surface application**: a one-page **web** app, a **WebView**
wrapper, a native **Android** app, and a shared **backend**.

**Stack:** Java 21 / Spring Boot · Cloud SQL (Postgres) · Firebase Auth · Cloud Run
(backend) + Firebase Hosting (web).

## Repo layout
| Path | Purpose |
| --- | --- |
| `/backend` | Java 21 / Spring Boot API service (Cloud Run) |
| `/web` | Web single-page front end (Firebase Hosting) |
| `/webview` | Shared WebView assets/wrapper for the native shells |
| `/android` | Native Android app |
| `/infra` | Infrastructure & deployment config (GCP, CI/CD) |

## How agents work here
Work is pulled from a Jira dependency-graph backlog (project **TM** on 10xai), not
assigned. Follow `.claude/skills/jira-task-claim` for the full protocol. In short:

1. **Scope** — only ever touch tasks in the **active sprint** (`sprint in openSprints()`).
   Backlog items are off-limits.
2. **Ready** — a task is workable only when every one of its *is blocked by* links
   points to a **Done** issue.
3. **Claim (the lock)** — flip the task `To Do → In Progress`, assign it to yourself,
   and post a `[claim] <agentId> <ISO-8601>` comment. The status flip is the mutual-exclusion
   lock; the comment breaks ties (earliest wins).
4. **Do the work** — follow the task's pinned **AGENT EXECUTION PROMPT**.
5. **PR → In Review** — when you open the PR, transition the task to **In Review** and
   comment `PR: <url>` on the ticket. It stays locked (not a cleared blocker) until merge.
6. **Merged → Done** — when the PR merges to `main`, transition to **Done**. That unblocks
   downstream tasks for the next agent.

Some tasks are console/settings changes with **no PR** (e.g. create the GCP project): skip
In Review, post a one-line evidence note, and go straight to Done.

## Conventions (current — newer than the numbered steps above)
- **Branch naming:** `<type>/TM-XX-short-kebab-desc` — `feature` (app code), `chore` (infra/CI/cloud/docs/config), `fix` (bug). e.g. `feature/TM-49-walking-skeleton`, `chore/TM-63-cloud-sql`.
- **Read the blackboard after you claim:** `docs/agents/blackboard.md` — append-only shared operational notes (env quirks, workarounds, "main red"). Append cross-cutting findings there so no agent rediscovers them.
- **Board fields / time tracking:** on **claim** set Start date (`customfield_10015`); on **PR/In Review** log a **worklog** of actual elapsed (`addWorklogToJiraIssue`) + set Due date (`duedate`) if unset; if **blocked/held** set Flagged = Impediment (`customfield_10021`). Story points = the estimate. See `jira-mcp-gotchas` → Time tracking.
- **Hit a wall? Log it — never fail silently:** comment the blocker + a `[finding → future improvement]` note; for human-only steps (interactive auth, console, secrets) raise a `human-in-the-loop` ticket and link it as a blocker.
- **Build tool = Gradle (Kotlin DSL)** for the backend going forward — unifies with the Gradle-native Android (TM-88). (The initial backend is still Maven; throwaway on the redo.)
- **Merged → Done is being automated** (GitHub Action, TM-86): on PR merge the ticket auto-transitions to Done. Until it lands, whoever merges moves the ticket to Done (step 6).

## Definition of Done
**Merged to `main`.** (No-PR tasks: the change is applied and evidenced on the ticket.)

## Pointers
- `docs/agents/AGENT-CLAIM-PROTOCOL.md` — the full pull-based claim protocol (states, loop, failure handling).
- `docs/agents/DEPENDENCY-DAG.md` — the dependency graph, leverage leaderboard, and execution order.
- `docs/agents/SPRINTS.md` — sprint naming scheme and what each sprint contains.
- `.claude/skills/jira-mcp-gotchas` — Jira/connector quirks (read before bulk Jira create/edit/link ops).
- `.claude/skills/` also has `jira-task-claim`, `jira-ticket-writer`, `jira-epic-breakdown`.
- `docs/agents/blackboard.md` — shared operational notes; **read after each claim**, append cross-cutting findings.

## Live operational notes (auto-loaded)
The blackboard is imported below, so every agent has it in context from startup. **Still re-read it after each claim** (loop step 4) for notes other agents appended mid-run, and append your own cross-cutting findings. Keep it small.

@docs/agents/blackboard.md
