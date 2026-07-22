# HANDOFF — Chat Agent

You are picking up the **Chat** lane of TeamMarhaba (Circle). Companion docs: the durable lane
playbook is [CHAT-AGENT.md](CHAT-AGENT.md) (architecture contracts, gotchas, testing, lane map); the
fleet-wide lifecycle is [CROSS-AGENT.md](CROSS-AGENT.md). This file is the point-in-time "start here".

## Read first (in this order)

1. **[CROSS-AGENT.md](CROSS-AGENT.md)** — the sprint lifecycle + the HARD RULES every fleet agent
   follows (ticket gates, evidence, the Jira REST + sprint-opening ritual, deploy, no AI-attribution).
   The single most important doc — read it fully.
2. **[CHAT-AGENT.md](CHAT-AGENT.md)** — your lane playbook. The **hot files** are
   `web/src/assets/chat.js` (~2000-line DOM shell) + `chat-core.js` (the big pure core), the other
   `chat-*-core.js` modules, the chat routes in `router.js`, `events.js`/`event-chat-entry-core.js`
   (the "Open chat" deep-link), and the backend `chat/` service package.
3. Root **`CLAUDE.md`** + the blackboard (`docs/agents/runtime/blackboard.md`) — env quirks, "main
   red", the worktree hazard, the Testcontainers `api.version` local workaround.
4. `.claude/skills/` — the `jira-*` skills (`jira-task-claim`, `jira-ticket-writer`, `jira-mcp-gotchas`,
   `jira-epic-breakdown`).

## How you operate

- **Jira**: REST via creds at `~/.config/teammarhaba/jira.env` (`JIRA_BASE_URL` / `JIRA_USER_EMAIL` /
  `JIRA_API_TOKEN` — parse the file yourself with `set -a; source …; set +a`, they are **not**
  exported by a plain `source`. Build subagents get this wrong — spell the exact var names out in their
  prompt or they'll fail the Jira write). Board id = **1**, project **TM**. Sprint start/close via the
  Agile API (`/rest/agile/1.0/sprint`). Search via `/rest/api/3/search/jql` (the legacy `/search` is
  deprecated + under-returns). Match transitions by **`to.name`**, never hardcode ids. Author ADF;
  **never use tables in a description** — they render blank. Attach evidence PNGs via
  `curl -u "$JIRA_USER_EMAIL:$JIRA_API_TOKEN" -H "X-Atlassian-Token: no-check" -F "file=@shot.png" "$JIRA_BASE_URL/rest/api/3/issue/TM-XX/attachments"`.
  For a quick plain-text comment, `POST /rest/api/2/issue/{key}/comment {"body":"…"}` works with no ADF.
- **⚠️ Jira attribution — this bit Basit.** The token authenticates as **Basit's own account**, so
  EVERY Jira write you make (create, comment, transition, assign, link) is recorded in history as
  "Basit Siddiqui" — indistinguishable from Basit himself or the merge automation. He is sensitive
  about this. **Do NOT take Jira actions he didn't ask for** — don't assign tickets to bot accounts,
  don't create tickets unprompted, don't reassign. Surface what you'd do and let him decide; when he
  says go, remember it still shows as him. (Note: every sprint ticket you DO create/claim must carry an
  assignee — the operating account, `accountId 712020:66e23906-b54c-4181-b77a-e591d42be2ee` — never
  leave one unassigned; claiming = setting assignee, not just the status flip.)
- **Git/PRs**: use `gh`. Branch `<type>/TM-XX-desc`. Build agents run in their own git worktrees so
  parallel edits don't collide — a fresh worktree has **no `web/e2e/node_modules`**, symlink it from
  the main clone for any capture/e2e run. You **raise** PRs; you never merge them. **Never add an
  AI-attribution line** ("Generated with Claude", "Co-Authored-By: Claude") to any commit or PR body —
  Basit vetoed it outright; strip it with `gh pr edit` if a prior PR carries it, and put the ban in
  every build/fix subagent prompt.
- **You NEVER merge, and you deploy ONLY when Basit explicitly asks.** The human merges every PR (even
  docs PRs; you are hook-blocked). PRs need an **approving review** to merge — `mergeStateStatus:
  BLOCKED` + `reviewDecision: REVIEW_REQUIRED` means Basit must approve, not that the PR is broken.
  Deploy is outward-facing: dispatch `deploy.yml --ref main` **only** on an explicit "deploy" from
  Basit, never autonomously — then assert what is serving (web build-stamp == main HEAD; Cloud Run 100%
  on the just-built revision). The deploy carries OTHER lanes' merged work too — say so.

## Non-negotiable rules (these cost real time when skipped)

1. **No build without the ticket visibly In Progress in a STARTED sprint** — flip it (and assign it)
   yourself first, even for tickets you just created.
2. **In Review needs 390px before/after evidence ATTACHED TO THE TICKET** for any UI change (mock
   harness; `before` = origin/main, `after` = branch; md5-check they differ). Non-visual → state the
   exemption rationale on the ticket. Don't over-exempt — a "barely visual" exemption twice hid a real
   defect in this lane.
3. **Every fixed finding ships a fail-before/pass-after test.** `chat.js` can't be imported in Node —
   put the decision in a `*-core.js` module OR write a source-guard test; prove the fail-before.
4. **Run the FULL suites before "green"**: `node --test web/tools/*.test.mjs` (Node 20) AND the backend
   classes. A lane-subset run has shipped two false greens here.
5. **A backend API change touches THREE artifacts**: the annotation/code, `backend/openapi.json`
   (regenerate via `OpenApiDriftTest -Dopenapi.generate=true`), and `web/src/api-docs/openapi.json`
   (`cp` the backend one). Two guards enforce it — do all three in one PR.
6. **Branch e2e green is the merge gate** — off the PR gate. `gh pr checks` green ≠ e2e green. Dispatch
   `e2e.yml --ref <branch>` and confirm `success` on the exact head SHA yourself; the main loop owns
   that wait. A red on your own new spec is usually a real bug — diagnose, don't blind-rerun.
7. **Never trust a subagent/workflow self-report.** Re-query the board, read the diff, read CI
   conclusion, view the evidence PNGs yourself. Verify the merge landed before transitioning to Testing
   (a "merged" that didn't land will strand a ticket in the wrong state).
8. **Reshaping shared chat UI = migrate ALL consumers** — including source-guard tests over `chat.js`
   and the standalone `capture-*.mjs`/e2e specs. Grep the whole repo, then pin the new shape.
9. **Cross-lane findings get ticketed and handed off, never claimed** (admin moderation UI, the bell
   TM-451). Every closure-review finding gets a ticket; refinement + gate reviews run on **Fable**.

## Current state (as of 2026-07-22 — RE-QUERY before trusting)

- **wave-chat-1 (sprint 971) is code-complete.** All 8 build tickets + the TM-957 closure batch are
  merged: TM-736/853/854/855/856/857/939/940/957 (PRs #609–#628, #630). TM-736/853/854/855/856/857 are
  **Done**; TM-939/940/957 in **Testing** (Testing→Done automation, TM-703).
- **Closure review (TM-942, Fable) done**: 10 findings, all minor/nit, **0 blockers**; verdict on the
  ticket. Deferred to Refinement: **TM-958** (action-menu survives repaint + keyboard a11y), **TM-959**
  (deep-link `resolveThreadUnread` page-walk + guard).
- **Remaining close-out**: **TM-943 deploy** (awaiting Basit's explicit "deploy") and **TM-941** human
  manual-test sign-off (best on the deployed app). After both: flip merged tickets Done + close the
  sprint.
- **Known real gaps (not blockers)**: frontend admin **moderation UI** is unwired (`chat-moderation-core.js`
  imported only by its test; backend live) — coordinate, don't claim. `resolveThreadUnread` still reads
  page 0 (TM-959).

## Your first actions

1. Read the docs above; re-query the board yourself (`sprint in openSprints()`, don't trust this
   snapshot — automations move tickets behind you).
2. If wave-chat-1 isn't closed yet: finish the close-out (get the "deploy" from Basit, assert the
   serving revision, confirm his manual sign-off, flip Done, close the sprint). Don't start wave-chat-2
   builds until the previous sprint is closed and a new one is started + the ticket is In Progress.
3. To groom wave-chat-2: pull the follow-ups (TM-958, TM-959) + the media/entity-detector backlog into
   Refinement with grounded `file:line` cards, propose the sprint (name, goal, DAG, parallelism), and
   surface the decisions for Basit — but **don't build** until it's a started sprint with the ticket
   visibly In Progress, and until he gives the go.

Sign off every response: `— Chat Agent · <wave> · Actions for you: <…>` (or `· none`).
