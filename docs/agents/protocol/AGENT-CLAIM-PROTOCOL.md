# Agent Task-Claim Protocol

A **pull-based, decentralized** way for N agents to work the Epic-1 backlog. Identical for **2 agents or 20** — no central scheduler, no fixed agent→task mapping. Every agent runs the same loop and pulls whatever is *ready*. Jira's `status` + `assignee` fields **are** the lock.

Pairs with `DEPENDENCY-DAG.md` (the graph + priority order).

> **Prerequisite — the linear Bootstrap.** This protocol assumes the repo and its agent operating instructions (`CLAUDE.md`, `.claude/skills/`, `docs/agents/`) already exist. Getting there is a separate, **linear** Bootstrap epic (create repo → seed agent rules into the repo → minimal branch protection), driven by hand-fed starter prompts + user-level skills. Only once it lands do agents clone, auto-load the repo rules, and run this parallel pull protocol.
>
> **For TeamMarhaba this is DONE** — `TM-44` (mono-repo) + `TM-80` (seed agent instructions) have landed, so agents now **clone `hellobasitsiddiqui/teammarhaba`, auto-load its `CLAUDE.md` + `.claude/skills`, and self-host**. The kickoff prompt is one line: agentId + "clone the repo and follow its CLAUDE.md / jira-task-claim". (Branch convention `<type>/TM-XX-short-desc` post-dates the seeded copy — carry it in the kickoff until a `chore` PR syncs it into the repo.)

> **Prerequisite — each agent gets its OWN working tree (git worktree or clone). REQUIRED.**
> The Jira claim lock coordinates *who owns a ticket*, but it does **not** isolate the filesystem.
> Two agents sharing one working directory **will corrupt each other**: one agent's `git checkout`
> silently switches the other's branch mid-build, and uncommitted files from one appear in the
> other's tree — leading to duplicated work and broken commits. *(This actually happened: two
> agents in one clone caused a mid-build branch switch and a duplicate `TM-105` implementation.)*
>
> So **every agent works in its own isolated working tree**, sharing the one remote:
> ```bash
> # from the shared clone, one linked worktree per agent — lighter than a second full clone,
> # and git refuses to check out the same branch in two worktrees (extra anti-collision).
> git worktree add ../tm-<agentId> main      # e.g. ../tm-agentA, ../tm-agentB
> # then each agent runs the claim loop entirely inside its own worktree dir.
> ```
> Worktree over clone: one `.git`/object store (one fetch, less disk) but fully independent
> working files, index, `HEAD`, and `target/` build output. Use **distinct branch-name prefixes
> per agent** if you want belt-and-braces on top of the Jira lock. The kickoff prompt should put
> each agent in its own worktree before it starts pulling tickets.

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

### Human tasks — tracked on the board, off-limits to agents
Not every step is automatable. Human-only steps — **start the sprint**, **review + merge PRs to `main`**, **set up GCP billing**, **UI-only deletes / branch protection** — are tracked as ordinary Tasks too, so the board reflects *all* the work, not just the agent slice (e.g. `TM-82` start sprint, `TM-83` review+merge, `TM-84` billing, `TM-85` delete TM-47). They're marked two ways so no agent ever touches them:
- **`human` label** + **assigned to a person** (never left unassigned).
- The candidate query gains `AND labels != "human"`; `assignee is EMPTY` already excludes anything assigned. Either guard alone suffices — both together are belt-and-suspenders.

Human tasks are **not** wired into the DAG as blockers of agent tasks (that would stall the fleet waiting on a person) — a genuine hard prerequisite (e.g. billing before `TM-66`) is noted in the description, not as a link. The one human gate the flow truly depends on is **review + merge**: it's what moves a ticket `In Review → Done` and unblocks its dependents.

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
  if not prePrVerify(t): continue             # re-read Jira RIGHT BEFORE the PR — bail if someone else got there
  openPr(t)
  onPrRaised(t): transition t -> In Review    # PR open, awaiting merge (still locked)
  onMergeToMain(t): transition t -> Done      # release downstream
  continue
```

### 1. findReady()
One query for the candidate pool, then filter by readiness client-side (vanilla Jira JQL can't test linked-issue status, so read the links):

```
JQL:  project = TM AND issuetype = Task AND status = "To Do"
      AND assignee is EMPTY AND labels != "human" AND sprint in openSprints()
fields: ["summary", "issuelinks", "labels", "customfield_10016"]
```
The `sprint in openSprints()` clause is the **scope gate** — only tickets in the started sprint are ever candidates. A candidate is **ready** ⟺ for every inward link of type *Blocks* ("is blocked by"), the linked issue's `statusCategory = Done`. (A task with no `is blocked by` links is always ready.)

### 2. pick() — priority + anti-collision
- Sort ready candidates by **leverage** (how many tasks they unblock — see the leaderboard in `DEPENDENCY-DAG.md`), tie-break `wave` asc, then key asc. This makes agents grab the highest-impact work first (keeps the critical path moving).
- **Thundering herd guard:** don't all grab the #1 task. Pick **randomly among the top `K` ready tasks**, where `K ≈ number of active agents` (or just top 3–5). With 20 agents this spreads them across distinct tasks instead of 19 colliding on one.
- **Hot-file avoidance (optional, soft tie-breaker):** the only conflicts that actually bite this flow are **concurrent branches editing the same "hot file"** — `backend/pom.xml`, `.github/dependabot.yml`, shared workflow YAMLs (`ci.yml`, `deploy.yml`), `backend/src/main/resources/application*.yml`, the README stubs. They're not parent/child clashes — they're *siblings* both touching one file. So when picking among the top-`K` ready tasks, **if another task is already In Progress / In Review that edits a hot file, prefer a ready task that does *not* touch that same hot file** (the pinned AGENT EXECUTION PROMPT lists each task's files/scope — read it). It's a tie-breaker, not a blocker: if every ready task touches the hot file, just take one and expect a trivial rebase. Don't branch a dependent off its parent's *branch* to dodge this — with squash-merge that creates worse history divergence; branch off `main` and rely on "ready = blockers Done" so `main` already has the parent's code.

### 3. claim() — race-safe even when all agents share ONE Jira user
In Claude Code every agent acts as **the same Jira account (you)**, so `assignee` can't distinguish agents. The real lock is the **status transition**; a **claim comment** breaks ties. Each running instance has an `agentId` (e.g. `agent-A`), passed in its kickoff prompt — **it MUST be unique per instance** (see the warning below).

```
transitionJiraIssue(t, "In Progress")          # THE LOCK: removes t from every
editJiraIssue(t, assignee = me)                #   other agent's To-Do/unassigned query
myClaim = addComment(t, "[claim] <agentId> <ISO-8601>")   # stamp who owns it — KEEP its comment id

# RE-VERIFY before doing any work — re-read truth from Jira, then bail unless all hold:
read t            # fresh status + all comments
abandon t if t.status != "In Progress"                       # moved on you: PR opened / reclaimed / Done
abandon t if any other run left a "PR: <url>" comment        # already being worked → don't duplicate
earliest = the earliest "[claim]" comment on t
abandon t if earliest is NOT `myClaim`                        # compare by COMMENT IDENTITY (id/timestamp),
                                                             #   not by agentId — see warning
else: you own t -> proceed
```

"Abandon" = leave it exactly as-is (do **not** roll the status back — the real winner owns it) and pick the next candidate.

The status flip is what enforces mutual exclusion (the candidate query is `status = "To Do" AND assignee is EMPTY`, so an In-Progress/assigned task is invisible to others). The re-verify settles the rare cases the lock alone can't: two agents flipping the *same* task in the same instant (earliest claim wins), or a task already in flight whose status flip you raced past.

> ⚠️ **Compare by claim-comment identity, never by agentId alone.** Resolving the tie with "is the earliest `[claim]`'s *agentId* mine?" silently breaks when **two instances share an agentId**: both see their own id as the owner and **both proceed** → duplicate work. This actually happened — two `agent-C` instances both built **TM-107** (PR #78 merged, #81 closed as a duplicate). The check above instead asks "is the earliest `[claim]` *the specific comment I just posted*?" (you kept its id), so the later duplicate yields even when the agentId matches. **Also give every running instance a unique agentId** (`agent-C1`, `agent-C2` — never two `agent-C`) so the status-lock + tie-break stay unambiguous; the identity check is the backstop for when that slips.

### 4. work() → In Review → Done
Execute the task's **pinned Agent execution prompt** on a branch named **`<type>/TM-XX-short-kebab-desc`** (`feature` = app code, `chore` = infra/CI/cloud/docs/config, `fix` = bug; e.g. `feature/TM-49-walking-skeleton`, `chore/TM-63-cloud-sql`).

**First-sub-task dedup checkpoint — yield early instead of double-building.** The claim-time re-verify (§3) can't catch an agent that *selected* this task while it was still `To Do` (before your claim landed) and is now building in its own worktree, blind to your claim. The pre-PR check below catches that — but only *after* both agents have built the whole ticket (the wasted double-builds: TM-151 #145/#146, TM-167 #162/#164). So **the moment you finish your Task's first sub-task** (the first checkpoint on its sub-task progress checklist — see GENESIS "break each non-trivial Task into sub-tasks as a mid-flight progress checklist"), **re-read the ticket's claims and yield if you're not the owner**:

```
read t                                           # fresh comments
claims = all "[claim]" comments on t
if claims.length > 1 and earliest(claims) is NOT myClaim:   # identity, not agentId (see §3)
    deleteComment(myClaim)                       # remove YOUR claim → the board shows ONE owner
    post "[yielded] <agentId> duplicate claim — earliest owner keeps it; stopping after sub-task 1"
    stop work on t (drop your branch) and pick the next ready task
else:
    you're the sole/earliest owner -> continue
```

This turns a duplicate into ~one sub-task of wasted work instead of a whole build, and leaves exactly **one** `[claim]` so the winner is unambiguous (if *you* hold the earliest claim, you keep going — the other instance is the one that yields). It **complements** the pre-PR re-verify, it doesn't replace it — keep both (a duplicate can still appear after your first sub-task). This is why every non-trivial Task carries sub-tasks: the first one is the early dedup tripwire, not just progress reporting.

**Pre-PR re-verify — close the claim→build→PR window.** The claim-time re-verify (§3) settles races *at claim time*, but a build can take many minutes, and a second agent that *selected* this same task **before your claim landed** (while it was still `To Do`) builds in its own worktree and **never re-reads Jira** — so it never sees your claim, your In-Progress flip, or your In-Review transition, and opens a **duplicate PR**. So **immediately before opening the PR (ideally before the final push), re-read the ticket and abort the PR unless all hold** — leave your branch in place, post a one-line note (`[finding]` / evidence), and pick the next task:

```
read t                                          # fresh status + all comments
abandon-PR t if t.status != "In Progress"       # someone reached In Review/Done first
abandon-PR t if any other run left a "PR: <url>" comment
abandon-PR t if the earliest "[claim]" is NOT myClaim   # identity, not agentId (see §3)
else: open the PR
```

One cheap Jira read, **deterministic for this class**: in the **TM-151** double-build, the ticket was already `In Review` with the winner's `PR:` comment by the time the duplicate opened its PR (#146, ~14 min after it had selected the still-`To Do` ticket; #145 merged, #146 closed as a duplicate) — a pre-PR read would have aborted it. Note a doc change alone can't rescue an **already-running** build (a mid-flight instance won't reload this file), but it makes every subsequent run's builds safe. This is the §3 check, **re-run at the latest possible moment** — claim-time and pre-PR together bracket the whole window.

**As soon as you open the PR:**
1. `transitionJiraIssue(t, "In Review")` (transition id `31`) — moves the ticket to the review column. It's **still locked** (`In Review` is `statusCategory = indeterminate`, so it's outside the `status = "To Do"` candidate pool *and* doesn't count as a cleared blocker), so downstream stays blocked until merge.
2. **Comment on the ticket:** `PR: <url>` (so the link lives on the ticket for anyone watching).
3. **Return it to whoever spawned you** in your status line / final message.

*Where possible* — some tasks are console/settings changes with **no PR** (e.g. create the GCP project, enable branch protection). For those there's nothing to review: **skip In Review**, post a one-line **evidence note** (what you changed + a link to the resource/setting), and transition straight to Done.

When the PR **merges to `main`**, the ticket moves to **Testing** (the QA gate; `Done` is set only after Testing passes — TM-703). The **merge itself** — the ticket leaving In Review — is the unlock signal: it flips every dependent whose last blocker was `t` into *ready*, and the next poll picks them up automatically (dependents unlock **on merge**, they do NOT wait for QA/Done). This is the whole unlock mechanism. (A task reaches Testing from In Review via a merge, then Done after QA; a no-PR task can be set Done directly.)

> **Automated since TM-86:** the `Jira merge → Testing` GitHub Action (`.github/workflows/jira-merge-to-testing.yml`) does this `In Review -> Testing` step for you — on merge to `main` it reads the `TM-NNN` key from the branch (or PR title) and transitions that issue to **Testing** (the QA gate; **Done** is set only after Testing passes — TM-703). It fails soft (a missing key or unavailable transition never blocks the merge), and requires the one-time repo secrets `JIRA_BASE_URL` / `JIRA_USER_EMAIL` / `JIRA_API_TOKEN`. Agents may still transition manually as a fallback if the secrets aren't configured.

---

## Failure handling (matters at 20 agents)

- **Dead/abandoned agent:** a task stuck `In Progress` with no linked PR and no update for `T` (e.g. 2h) may be **reclaimed** by any agent or a sweeper: clear `assignee`, transition back to `To Do`. Then it re-enters the ready pool. A task in `In Review` with a linked PR is **not** stale — it's waiting on a human merge, not a dead agent; leave it. Only reclaim `In Review` if it has *no* PR link (an agent flipped it then died) — same reset: clear `assignee`, back to `To Do`.
- **Idempotent claim:** if an agent crashes mid-claim, the next loop re-reads truth from Jira — no local state to corrupt.
- **Optional sweeper** (a `/loop` or scheduled agent): every few minutes, recompute readiness from scratch and reclaim stale In-Progress tasks. Pure backstop; the protocol is self-correcting without it.

---

## Logging, findings & inter-agent notes

The tickets + their sequence + the findings are the **durable product** — the source code is rebuilt from them on each **replay**. So logging is not optional:

- **Log every blocker on the ticket.** Missing tool, broken env, missing/mis-ordered prerequisite, or ambiguous AC → comment it, plus a `[finding → future improvement]` note on how the ticket or the DAG sequence should change next time. Never fail silently. (Worked example: `TM-81` gcloud.)
- **Human-only steps get their own human-only ticket (labelled `human`)**, linked as a blocker — never bundle interactive auth/console/secret steps into an agent task.
- **Sequence prerequisites up front.** The classic miss here: the GCP/toolchain setup (install gcloud → human `auth login` + `application-default login` → billing → create project) was never sequenced, so an agent hit "GCP isn't set up." Prerequisites like this belong at the **front of the DAG** (the linear bootstrap's human half), correctly ordered, so no agent ever discovers them reactively.

**Inter-agent notes (proposed — see `REPLAY.md` design log; decision pending).** A *blackboard*: `docs/agents/runtime/blackboard.md`, append-only, broadcast — shared operational knowledge that isn't ticket-specific ("no Docker in the sandbox", "gcloud needs the symlink workaround", "main is red — hold deploys"). Read on startup + after each claim so no one rediscovers what another agent already learned. Optional per-agent `docs/agents/runtime/inbox/<agentId>.md` mailboxes for directed handoffs (actor-style). **Durable vs ephemeral:** the blackboard/mailboxes are per-run scratch and are deleted with the source on replay, so anything that must survive (findings, workarounds, sequence fixes) must ALSO live in the ticket or `REPLAY.md`. Ticket-specific coordination stays in **Jira comments** (durable + human-visible).

---

## Board fields & time logging (keep it a fully-functional board)

Every worked ticket carries real timeline + effort data, so the board, burndown, and velocity actually work:

| Field | Id | When set |
|---|---|---|
| **Start date** | `customfield_10015` | on **claim** (To Do → In Progress) — "work began" |
| **Due date** | `duedate` | at claim — target (sprint end by default) |
| **Story points** | `customfield_10016` | at planning — the **estimate** |
| **Time spent (worklog)** | `addWorklogToJiraIssue` | on **PR / In Review** — actual elapsed (`timeSpent` + `started` = claim time) |
| **Flagged = Impediment** | `customfield_10021` = `[{"value":"Impediment"}]` | when **blocked / held**; cleared when unblocked |
| Resolution date | (auto) | on **Done** |

- For AI agents the worklog is **wall-clock minutes**, far under a human estimate — that's the point: real per-ticket velocity.
- **Original/Remaining Estimate aren't on the Task screen** → not settable via API. Enabling them is a one-time **UI admin** step; until then story points are the estimate. See `jira-mcp-gotchas` → Time tracking.

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
# labels != "human" keeps human-only tasks (start sprint, review+merge, billing) out of the agent pool
project = TM AND issuetype = Task AND status = "To Do" AND assignee is EMPTY AND labels != "human" AND sprint in openSprints()

# what's currently owned/in flight in this sprint (for backoff decisions — a blocker
# here may finish soon, so wait rather than exit). Covers both active work and open PRs.
project = TM AND issuetype = Task AND status IN ("In Progress", "In Review") AND sprint in openSprints()

# raised but not yet merged — awaiting human merge (visibility only, do not reclaim if PR linked)
project = TM AND issuetype = Task AND status = "In Review" AND sprint in openSprints()

# done so far in this sprint
project = TM AND issuetype = Task AND status = Done AND sprint in openSprints()
```

> Drop the `sprint in openSprints()` clause only if you deliberately want agents to work the whole project regardless of sprint — **not recommended**; the sprint is your scope control.
