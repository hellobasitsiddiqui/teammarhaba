# Agent Task-Claim Protocol

A **pull-based, decentralized** way for N agents to work the Epic-1 backlog. Identical for **2 agents or 20** — no central scheduler, no fixed agent→task mapping. Every agent runs the same loop and pulls whatever is *ready*. Jira's `status` + `assignee` fields **are** the lock.

Pairs with `DEPENDENCY-DAG.md` (the graph + priority order).

> **Prerequisite — the linear Bootstrap.** This protocol assumes the repo and its agent operating instructions (`CLAUDE.md`, `.claude/skills/`, `docs/agents/`) already exist. Getting there is a separate, **linear** Bootstrap epic (create repo → seed agent rules into the repo → minimal branch protection), driven by hand-fed starter prompts + user-level skills. Only once it lands do agents clone, auto-load the repo rules, and run this parallel pull protocol.

---

## State model (encoded in Jira, no extra infrastructure)

| Meaning | How it's represented |
|---|---|
| **In scope** | the ticket is **in the active (started) sprint** — `sprint in openSprints()`. A ticket merely sitting in the Backlog is **OFF-LIMITS**. |
| Available | in scope **and** `status = To Do` **and** `assignee is EMPTY` |
| Claimed (owned, in flight) | `status = In Progress` (this is **the lock** — hides it from every other agent's query) **and** a pinned `[claim] <agentId> <time>` comment marks *which* agent owns it |
| In review (PR raised, awaiting merge) | `status = In Review` (set the moment the PR is opened — **still locked**, `statusCategory = indeterminate`, so it stays out of the To-Do pool *and* does not count as a cleared blocker for dependents) |
| Complete | `status = Done` (set when the PR merges to `main`) |
| **Ready** | an available task whose **every** `is blocked by` link points to a `Done` issue |

A task you can start = **in scope AND available AND ready**. The sprint is the **human control valve**: agents only ever touch tickets you've deliberately pulled into the started sprint — never raw backlog items.

### Scope gate — only the active sprint
- **Promote to work it.** Drag a task from the Backlog into the started sprint = "approved for agents." Leave it in the Backlog = agents ignore it.
- **Dependency-closure caveat.** A sprint task whose blocker is still in the Backlog can **never go ready** (its blocker won't be worked). So when you compose a sprint, pull in **dependency-closed slices** — include each task's blockers (use `DEPENDENCY-DAG.md` / the `wave-N` order; e.g. take everything up to wave-K, or a full sub-tree). An agent that sees a sprint task blocked by an out-of-sprint task should **flag it, not work around it**.
- No seeding needed beyond this: once the sprint is started, the two roots (`TM-44`, `TM-66`) have zero blockers, so they're ready immediately.

---

## The loop (every agent runs this — identical code)

```
loop:
  candidates = findReady()                 # see JQL below
  if candidates is empty:
      if any task is In Progress elsewhere:
          sleep(backoff); continue          # a blocker may finish soon
      if open tasks remain but none ready:
          # DAG stall (shouldn't happen) or all remaining are In Progress -> wait
          sleep(backoff); continue
      else:
          exit                              # backlog drained, nothing left
  t = pick(candidates)                       # priority + jitter, see below
  if not claim(t): continue                  # someone beat me -> try again
  work(t)                                     # follow the pinned AGENT EXECUTION PROMPT
  onPrRaised(t): transition t -> In Review    # PR open, awaiting merge (still locked)
  onMergeToMain(t): transition t -> Done      # release downstream
  continue
```

### 1. findReady()
One query for the candidate pool, then filter by readiness client-side (vanilla Jira JQL can't test linked-issue status, so read the links):

```
JQL:  project = TM AND issuetype = Task AND status = "To Do"
      AND assignee is EMPTY AND sprint in openSprints()
fields: ["summary", "issuelinks", "labels", "customfield_10016"]
```
The `sprint in openSprints()` clause is the **scope gate** — only tickets in the started sprint are ever candidates. A candidate is **ready** ⟺ for every inward link of type *Blocks* ("is blocked by"), the linked issue's `statusCategory = Done`. (A task with no `is blocked by` links is always ready.)

### 2. pick() — priority + anti-collision
- Sort ready candidates by **leverage** (how many tasks they unblock — see the leaderboard in `DEPENDENCY-DAG.md`), tie-break `wave` asc, then key asc. This makes agents grab the highest-impact work first (keeps the critical path moving).
- **Thundering herd guard:** don't all grab the #1 task. Pick **randomly among the top `K` ready tasks**, where `K ≈ number of active agents` (or just top 3–5). With 20 agents this spreads them across distinct tasks instead of 19 colliding on one.

### 3. claim() — race-safe even when all agents share ONE Jira user
In Claude Code every agent acts as **the same Jira account (you)**, so `assignee` can't distinguish agents. The real lock is the **status transition**; a **claim comment** breaks ties. Each agent has a unique `agentId` (e.g. `agent-A`), passed in its kickoff prompt.

```
transitionJiraIssue(t, "In Progress")          # THE LOCK: removes t from every
editJiraIssue(t, assignee = me)                #   other agent's To-Do/unassigned query
addComment(t, "[claim] <agentId> <ISO-8601>")  # stamp who owns it
# resolve the rare simultaneous double-flip:
read t.comments
owner = earliest "[claim]" comment's agentId
if owner != me:  abandon t (do NOT touch it further) and pick the next candidate
else:            you own t -> proceed
```

The status flip is what enforces mutual exclusion (the candidate query is `status = "To Do" AND assignee is EMPTY`, so an In-Progress/assigned task is invisible to others). The claim comment only settles the rare case where two agents flipped the *same* task in the same instant — earliest stamp wins, the loser just walks away (it does **not** roll the status back, since the winner already owns it).

### 4. work() → In Review → Done
Execute the task's **pinned Agent execution prompt**. **As soon as you open the PR:**
1. `transitionJiraIssue(t, "In Review")` (transition id `31`) — moves the ticket to the review column. It's **still locked** (`In Review` is `statusCategory = indeterminate`, so it's outside the `status = "To Do"` candidate pool *and* doesn't count as a cleared blocker), so downstream stays blocked until merge.
2. **Comment on the ticket:** `PR: <url>` (so the link lives on the ticket for anyone watching).
3. **Return it to whoever spawned you** in your status line / final message.

*Where possible* — some tasks are console/settings changes with **no PR** (e.g. create the GCP project, enable branch protection). For those there's nothing to review: **skip In Review**, post a one-line **evidence note** (what you changed + a link to the resource/setting), and transition straight to Done.

When the PR **merges to `main`**, `transition t -> Done`. That Done flips every dependent whose last blocker was `t` into *ready* — the next poll picks them up automatically. This is the whole unlock mechanism. (A task only ever reaches Done from In Review via a merge, or directly for no-PR tasks.)

> **Automated since TM-86:** the `Jira merge → Done` GitHub Action (`.github/workflows/jira-merge-to-done.yml`) does this `In Review -> Done` step for you — on merge to `main` it reads the `TM-NNN` key from the branch (or PR title) and transitions that issue to Done. It fails soft (a missing key or unavailable transition never blocks the merge), and requires the one-time repo secrets `JIRA_BASE_URL` / `JIRA_USER_EMAIL` / `JIRA_API_TOKEN`. Agents may still transition manually as a fallback if the secrets aren't configured.

---

## Failure handling (matters at 20 agents)

- **Dead/abandoned agent:** a task stuck `In Progress` with no linked PR and no update for `T` (e.g. 2h) may be **reclaimed** by any agent or a sweeper: clear `assignee`, transition back to `To Do`. Then it re-enters the ready pool. A task in `In Review` with a linked PR is **not** stale — it's waiting on a human merge, not a dead agent; leave it. Only reclaim `In Review` if it has *no* PR link (an agent flipped it then died) — same reset: clear `assignee`, back to `To Do`.
- **Idempotent claim:** if an agent crashes mid-claim, the next loop re-reads truth from Jira — no local state to corrupt.
- **Optional sweeper** (a `/loop` or scheduled agent): every few minutes, recompute readiness from scratch and reclaim stale In-Progress tasks. Pure backstop; the protocol is self-correcting without it.

---

## Why it scales 2 → 20 unchanged

- **No assignment step.** Agents pull; they're never told *which* task — so adding/removing agents needs zero config.
- **Self-balancing.** A fast agent simply pulls more tasks; a slow one pulls fewer. Work-stealing, not push.
- **Bounded by the graph, not the protocol.** Useful concurrency = DAG **width** (~10 simultaneously-ready tasks at the peak here) and **critical-path depth** (7). So:
  - 2 agents → near-fully utilized throughout.
  - ~10 agents → peak throughput; finish time approaches the 7-deep critical path.
  - 20 agents → still correct, but ~half sit idle waiting for blockers — extra agents don't speed *this* epic up beyond the width-10 ceiling. (More agents help a *wider* backlog, e.g. once Epics 2–7 add parallel tracks.)

**Rule of thumb:** spin up `min(width, available agents)` ≈ up to ~10 for Epic 1. The protocol accepts any number; the DAG decides how many can actually be busy.

---

## Quick reference — the only JQL an agent needs

```
# in-scope + available + unclaimed (then filter ready by reading issuelinks)
project = TM AND issuetype = Task AND status = "To Do" AND assignee is EMPTY AND sprint in openSprints()

# what's currently owned/in flight in this sprint (for backoff decisions — a blocker
# here may finish soon, so wait rather than exit). Covers both active work and open PRs.
project = TM AND issuetype = Task AND status IN ("In Progress", "In Review") AND sprint in openSprints()

# raised but not yet merged — awaiting human merge (visibility only, do not reclaim if PR linked)
project = TM AND issuetype = Task AND status = "In Review" AND sprint in openSprints()

# done so far in this sprint
project = TM AND issuetype = Task AND status = Done AND sprint in openSprints()
```

> Drop the `sprint in openSprints()` clause only if you deliberately want agents to work the whole project regardless of sprint — **not recommended**; the sprint is your scope control.
