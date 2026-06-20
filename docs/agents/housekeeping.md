# Housekeeping backlog — idle-time tasks

Small, low-risk chores any agent can pick up when it is **idle** (the claim loop found no
ready Jira ticket) **and** it has spare token budget left before the current usage window
(the rolling 5-hour / weekly limit) resets. This keeps an otherwise-blocked agent productive
without waiting on the dependency graph — and without leaving budget unused before it expires.

## When to pull from here
Pick a housekeeping item only when **both** hold:
1. You ran the claim loop and there is **no ready ticket** (everything is blocked, In Progress
   elsewhere, or human-reserved), **and**
2. you have meaningful token budget remaining in the current window.

A ready Jira ticket **always wins** over housekeeping — don't start a chore if real work exists.

## Rules
- These are **chores**: low-risk, reversible, **no cloud / paid-resource / prod changes**. If an
  item turns out to be non-trivial or touches cloud/prod, **stop and raise a proper Jira ticket** instead.
- **Claim lightly** so two agents don't collide: edit the item to
  `- [~] <task> — claimed <agentId> <ISO>`; on completion `- [x] <task> — done <agentId> <PR/url>`.
- **One small `chore` PR per item**; tight diff; branch `chore/<short-kebab-desc>`; follow the
  normal PR → In Review → merged flow. (No Jira ticket needed for trivial items; create one if it grows.)
- **Append-only for ideas**: spotted a chore mid-task? Add it to the backlog below rather than acting
  immediately. Same spirit as `blackboard.md`.
- This file is **per-run scratch** (deleted with the source on a replay). Anything that must survive a
  replay also belongs in a Jira ticket or `REPLAY.md`. See the redo keep-list.

## Backlog
- [ ] Audit & convert remaining historical Jira comments from wiki markup to GitHub-flavored markdown
  (repo convention). Known offenders: TM-81 (evidence + finding comments), TM-66 (finding comment),
  TM-80 (finding comments). _(agent-A already fixed TM-84's two comments, 2026-06-20.)_
- [ ] Verify all `docs/agents/*` and `CLAUDE.md` cross-links resolve; fix any stale paths.
- [ ] Ensure `.gitignore` covers Gradle artifacts (`.gradle/`, `build/`) ahead of the Gradle redo (ADR-0001).
- [ ] Add `docs/decisions/README.md` indexing the ADRs (currently just ADR-0001).
- [ ] Spell/format pass over `README.md` + the surface stub READMEs for consistency.

_Seeded by agent-A, 2026-06-20. Extend freely._
