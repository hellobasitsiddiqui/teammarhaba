---
name: jira-epic-breakdown
description: Decompose an epic into independently agent-pickable Jira Tasks with dependency links and topological wave labels (TM project on 10xai). Use when planning/structuring a backlog, breaking an epic into tickets multiple agents can pick in parallel, or when asked about "waves", "blocked by" dependencies, or why to use Tasks instead of sub-tasks. Covers the Epic→Task model, group-1.x labels, the correct Blocks link direction, and wave computation.
---

# jira-epic-breakdown

Turn an epic into a backlog where **multiple agents can each grab one "ready" ticket** (zero unmet blockers) and work it in parallel.

## Bootstrap epic (the FIRST epic of a new project — run it LINEARLY)

Chicken-and-egg: the parallel, agent-self-hosting workflow needs the repo + its agent operating instructions to already exist, but they don't at the start. So a new project's **first epic is a small Bootstrap epic run LINEARLY** (each task strictly after the previous — NOT the parallel claim model):
1. Create the repo.
2. Seed agent operating instructions into the repo: root `CLAUDE.md` + `.claude/skills/` + `docs/agents/` (claim protocol, conventions). **Copy canonical files verbatim — don't re-derive.**
3. Minimal branch protection + the PR→merge flow the claim protocol relies on.

Drive the Bootstrap with **hand-fed starter prompts + user-level skills** (nothing's in the repo yet). The moment it lands the repo is the source of truth: every later epic uses **repo-based instructions** + the parallel claim protocol (`jira-task-claim`) — new agents clone, auto-load `CLAUDE.md`/`.claude/skills`, pull work, so kickoff prompts shrink to one line. Keep Bootstrap small (2–4 tasks); only the rest of the project gets the full Epic→Task DAG below.

## The model (Shape A: Epic → Task)

- **One Epic** per program area (e.g. "Foundation & DevOps").
- The granular work items become **Tasks** parented to the Epic. **Use Task, NOT Sub-task** — Jira sub-tasks (level −1) do **not** appear in the Backlog/Board independently and can't be sprinted alone. Only Epic + Story/Task (level 0) are independently pickable.
- Express the old "story" groupings as **labels** `group-1.1`, `group-1.2`, … (filter/group the backlog by these). Standard Jira can't make three levels all pickable, so the middle grouping becomes a label.
- If a single Task later needs breakdown, it can spawn its own Sub-tasks — giving an `Epic → Task → Sub-task` shape with the Task still pickable.

## Human tasks (track them too)

Not all work is automatable. Track human-only steps as **ordinary Tasks** with a **`human`** label, **assigned to a person** (never unassigned): start/close the sprint, review + merge PRs, provision billing/credentials, UI-only deletes or branch-protection. This keeps the board honest — it shows *all* the work, not just the agent slice. Two rules:
- Agents exclude them via `AND labels != "human"` in the find-ready query (and they're assigned, so `assignee is EMPTY` already hides them).
- **Don't wire a human task as a DAG blocker** of agent tasks (it stalls the fleet waiting on a person); note a genuine prerequisite (e.g. billing before the GCP-project task) in the description instead.
- The **Bootstrap epic is itself largely human** (create repo, set branch protection, start the sprint) — its steps are the canonical human tasks; give them the `human` label too.

## Write each ticket

Use the `jira-ticket-writer` skill for the Standard/Human description + pinned Agent prompt. Create as `Task`, parent = the epic key.

## Dependencies (`is blocked by` links)

For each ticket, list its blockers, then create a **Blocks** link per edge. **The connector's `createIssueLink` direction is inverted from its own docs** — to express "X is blocked by Y":

```
createIssueLink(type: "Blocks", inwardIssue: X (the blocked), outwardIssue: Y (the blocker))
```

Jira's link type defines `inward = "is blocked by"`, `outward = "blocks"`, so the **inward issue is the one that is blocked**. **Create one link first and read it back** (`searchJiraIssuesUsingJql` with `fields: ["issuelinks"]`) to confirm the arrow points the right way before bulk-creating.

## Wave labels (pick order)

Compute each ticket's **topological depth** and label it `wave-N`:

```
wave(t) = 0 if t has no blockers
        = 1 + max(wave(b) for b in blockers of t)
```

- `wave-0` = zero-dependency roots → agents start here.
- A ticket is **ready** when every blocker is merged to `main`.
- Apply wave labels in a **second pass**, after the dependency graph exists (the wave number falls out of the graph).

## Recommended process

1. Decompose into items; assign each: points, category label, `group-1.x`.
2. Create the Epic, then all Tasks (batch). Capture the returned keys → build a `WBS → key` map.
3. **Pilot first:** create one ticket, check the rendered result, fix formatting, then batch the rest.
4. Pass 2: create the `is blocked by` links (correct direction) + apply `wave-N` labels.
5. Hand off: tell the user to create/start the sprint in the UI (no MCP tool for that) and which `wave-0` tickets are ready now.

## Gotchas

See `jira-mcp-gotchas` — no delete/move/convert/sprint tools (UI-only), markdown limits, field ids. Converting existing sub-tasks to Tasks means **recreate** them as Tasks + (user) bulk-delete the old ones; you cannot change the type in place.
