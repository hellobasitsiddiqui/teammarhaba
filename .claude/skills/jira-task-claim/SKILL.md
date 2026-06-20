---
name: jira-task-claim
description: Decentralized pull-based protocol for one of N agents to claim and work the next ready task from a Jira dependency-graph backlog (TM project on 10xai). Use when an agent needs to pick up work autonomously from the Foundation backlog, when coordinating multiple agents (2 or 20) without a central scheduler, or when asked "what should I work on next" / "claim a task". Jira status+assignee is the lock; readiness = all 'is blocked by' links Done.
---

# jira-task-claim

You are **one of N agents** (2 or 20 — you don't know or care). Pull the next ready task from the TM backlog, claim it race-safely, work it, mark it Done, repeat. No central scheduler. Jira `status` + `assignee` is the lock. Full spec: `Projects/TeamMarhaba/AGENT-CLAIM-PROTOCOL.md`; graph + priority: `DEPENDENCY-DAG.md`.

## State
- **In scope** = ticket is in the active started sprint (`sprint in openSprints()`). A ticket sitting in the Backlog is OFF-LIMITS — never work it.
- Available = in scope AND `status = "To Do"` AND `assignee is EMPTY`
- Claimed = `status = "In Progress"` AND assigned to an agent
- In review = `status = "In Review"` (set when you open the PR; **still locked**, and NOT a cleared blocker for dependents until it reaches Done)
- Done = `status = Done` (set when the PR merges to `main`)
- **Ready** = an available task whose **every** `is blocked by` linked issue is `Done` (no blockers = ready)

The **sprint is the scope gate**: only work tickets the human pulled into the started sprint. If a sprint task is blocked by a task still in the Backlog, it can never go ready — **flag it, don't work around it**.

## Loop
1. **Find ready.** JQL: `project = TM AND issuetype = Task AND status = "To Do" AND assignee is EMPTY AND sprint in openSprints()`, requesting `fields: ["summary","issuelinks","labels","customfield_10016"]`. Keep only candidates where every inward *Blocks* ("is blocked by") link points to a `Done` issue.
2. **Pick.** Sort ready by leverage (unblock-most-first; see DEPENDENCY-DAG.md leaderboard), tie-break wave asc then key. **Anti-collision:** choose *randomly among the top ~3–5 (≈ agent count)* so N agents don't all grab the same one.
3. **Claim (race-safe — all agents share one Jira user, so status is the lock, not assignee).** `transitionJiraIssue(In Progress)` (this hides it from other agents' `status = "To Do"` query) → `editJiraIssue(assignee = me)` → `addComment("[claim] <agentId> <ISO-time>")`. Then read the comments: if the **earliest** `[claim]` is a different agentId, you lost a simultaneous race — **abandon it** (don't touch it, don't roll back status) and pick the next. Otherwise you own it. You get your `agentId` from your kickoff prompt.
4. **Work + report.** Read the task's **pinned `AGENT EXECUTION PROMPT` comment**, do exactly that, open a PR. **The moment the PR exists:** `transitionJiraIssue(In Review, id 31)`, add a ticket comment `PR: <url>`, AND return the link in your final message. If the task has **no PR** (a console/settings change), post a one-line evidence note instead and skip straight to Done on completion.
5. **Done.** When the PR merges to `main`, `transitionJiraIssue(Done, id 51)`. That unlocks dependents automatically (their next poll sees all blockers Done).

> Transition ids on this board: **In Progress 21 · In Review 31 · Done 51 · To Do/reclaim 11**.
6. **Repeat.** If nothing ready but tasks are `In Progress` elsewhere, back off and retry (a blocker may finish). If no open tasks remain, stop.

## Rules
- **Never work a ticket that isn't in the active sprint** (`sprint in openSprints()`). Backlog tickets are out of scope until a human promotes them.
- Never work a task you didn't successfully claim (assignee == you after re-read).
- Never start a task with an unmet blocker — re-check readiness at claim time, not just from labels.
- Done means **merged to main**, not "PR opened".
- Stuck task (In Progress, no PR, no update ~2h) may be reclaimed: clear assignee → `To Do`.

## Scaling
Useful concurrency is bounded by the DAG **width** (~10 ready at peak for Epic 1) and **critical path** (7 deep), not by agent count. 20 agents is safe but ~half idle on this epic — that's expected. The protocol is unchanged for any N.

## Connector gotchas
See `jira-mcp-gotchas`. Key ones: vanilla JQL can't filter by linked-issue status (read `issuelinks` and check client-side); story-point field = `customfield_10016`; no sprint/delete tools.
