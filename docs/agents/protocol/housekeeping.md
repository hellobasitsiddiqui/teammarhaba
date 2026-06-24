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

## Ticket hygiene (periodic sweep)

Keeping the **backlog itself** clean is recurring housekeeping — the orchestrator (or an idle agent) should sweep periodically. The *rules* live in the ticket skills (`jira-ticket-writer`, `jira-epic-breakdown`); this is the checklist for applying them to the existing board:

- **No metadata prefixes in summaries.** Strip `[...]` / `Word:` prefixes (`[human-in-the-loop]`, `[human]`, `Human:`, `[bug]`, `Chore:`, `Tooling:`, …) — metadata belongs in labels/issue-type; summaries stay action-focused.
- **Human tickets → the single `human` label** (the label the find-ready filter excludes, `labels != "human"`). Never a summary prefix, never the legacy `human-in-the-loop` label.
- **Defects → the `Bug` issue type**, never a `[bug]` Task title.
- **Every ticket carries exactly one `replay` / `no-replay`** — the rebuild scope is `labels = replay`, so an unclassified ticket silently drops out.
- **Close stale tickets** already satisfied by merged work (verify first) and **close duplicates** (comment + link the survivor).
- When only normalizing a summary/label, **don't change** status, assignee, or the description body.

Done once wholesale in **TM-132** (2026-06-22): 19 summaries normalized, human label collapsed (`human-in-the-loop` → 0), TM-121 given `no-replay`; rules baked into the skills + agent docs (PRs #98/#99). Re-run the sweep whenever the board drifts.

## Backlog
- [x] Audit & convert remaining historical Jira comments from wiki markup to GitHub-flavored markdown
  (repo convention). Known offenders: TM-81 (evidence + finding comments), TM-66 (finding comment),
  TM-80 (finding comments). _(agent-A already fixed TM-84's two comments, 2026-06-20.)_ — done agent-C
  2026-06-21: TM-81 already converted by agent-A (all comments marked "Reposted as markdown"); TM-80
  already markdown (no wiki markup); TM-66 comment 10078 still had `{{...}}` wiki inline-code — converted
  to backticks. All three named offenders now clean.
- [x] Verify all `docs/agents/*` and `CLAUDE.md` cross-links resolve; fix any stale paths. — verified clean across all 24 md files (only hit was the literal `[text](url)` example in CLAUDE.md). agent-B 2026-06-20
- [x] Ensure `.gitignore` covers Gradle artifacts (`.gradle/`, `build/`) ahead of the Gradle redo (ADR-0001). — already satisfied (`build/`, `.gradle/`, `!gradle/wrapper/gradle-wrapper.jar` present); no change needed. agent-B 2026-06-20
- [x] Add `docs/decisions/README.md` indexing the ADRs (currently just ADR-0001). — done agent-A 2026-06-20 (branch `chore/adr-decisions-index`)
- [x] Spell/format pass over `README.md` + the surface stub READMEs for consistency. — reviewed root + all 6 surface READMEs; consistent, no typos. Refreshed the stale `infra/gcp/README.md` index (Related/out-of-scope) + removed the throwaway `.merge-to-done-test.md` instead. agent-B 2026-06-20 (branch `chore/gcp-docs-index-refresh`)

### Spikes (research → design note/ADR, no production code)
_These already have Jira tickets — claim the ticket (status lock) before working it; no need to raise a new one._
- [ ] **Spike: configurable per-field profile edit policy — [TM-201](https://10xai.atlassian.net/browse/TM-201).** Investigate how to enforce, post-login,
  that profile fields have **per-field mutability rules** — some **never changeable** (e.g. `email`),
  some **editable on a cadence** (e.g. `displayName` at most once per 7 days) — all driven by
  **configuration**, not hard-coded. Builds on the existing `PATCH /api/v1/me` (`MeController` /
  `UserService`, TM-107/TM-112). Deliverable: a short design note / ADR covering:
  - a policy model — per field `IMMUTABLE` | `EDITABLE` | `RATE_LIMITED(window)` — sourced from config
    (e.g. `application.yml` `user.field-policy.*`) so cadences are tunable without a logic change.
  - where enforcement lives (a validation layer in/around `UserService.updateDisplayName` / `PATCH /me`)
    and the reject shape — RFC 7807 `409`/`422` with a clear `retryAfter`/next-allowed-at.
  - how to track **last-changed per field** (column(s) on `users` vs a small audit table) to compute the
    cadence window.
  - the **email special case**: email is owned by the Firebase token, not our DB — document whether email
    is simply immutable via our API, or needs a Firebase re-verification flow (building that flow is out of scope).
- [ ] **Spike: developer role (RBAC) + in-app "developer info" panel — [TM-202](https://10xai.atlassian.net/browse/TM-202).** Investigate how a **developer**
  user signs in and sees an extra **diagnostics frame/section** the normal user doesn't — showing
  runtime info about the running app (build/version/commit, active profile, feature flags, recent
  request/trace id, dependency health, maybe a link to actuator). Two halves to scope:
  - **RBAC:** add a `DEVELOPER` role alongside `USER`. How is it assigned — Firebase **custom claims**
    (the claims wiring is flagged as TM-110) mapped onto the stored `User.role`? How does the backend
    authorize a developer-only endpoint (Spring Security authority check, default-deny preserved)?
  - **Surfacing the info:** a backend developer-only endpoint (e.g. `GET /api/v1/dev/info`, gated to
    `DEVELOPER`) that returns the runtime snapshot, and how the web app conditionally renders the panel
    only when `me.role == DEVELOPER`. Reuse actuator `/info`/`/metrics` (already authenticated) rather
    than re-inventing — document what's safe to expose and the prod-vs-dev gating.
  - **Security note:** must not leak secrets/internal detail to non-developers; the panel is authz-gated
    server-side, never just hidden client-side. Deliverable: a design note / ADR + a proposed ticket breakdown.

_Seeded by agent-A, 2026-06-20. Extend freely._
