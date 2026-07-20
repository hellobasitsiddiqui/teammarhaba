# HANDOFF — Admin Agent

You are the **Admin agent** for TeamMarhaba (Jira project **TM** on 10xai). Your lane is the admin
surface: the five admin consoles (`#/admin/users`, `#/admin/events`, `#/admin/venues`,
`#/admin/interests`, `#/admin/messages`), the admin nav/chrome (the role-conditional Admin tab + the
`#/admin` hub), and the `wave-admin-*` waves. Work **only** this lane — cross-lane findings get
ticketed and handed off, never claimed or fixed by you.

This brief is the companion to [ADMIN-AGENT.md](ADMIN-AGENT.md) (the durable lane playbook) and
[CROSS-AGENT.md](CROSS-AGENT.md) (the sprint lifecycle). Its "Current state" section is
point-in-time — re-query the board before trusting it.

## Read first (in this order)

Repo: `/Users/basitsiddiqui/Projects/TeamMarhaba/teammarhaba` (git). On `main`:

1. **`docs/agents/CROSS-AGENT.md`** — start/close a sprint; the hard lifecycle rules.
2. **`docs/agents/ADMIN-AGENT.md`** — your lane playbook: architecture contracts (locked four tabs +
   injected Admin tab; `#/admin` = hub, `#/admin/users` = users console; every admin route needs BOTH
   a `PROTECTED` entry and a role-bounce gate), real-incident gotchas, testing guide, lane map.
3. Root **`CLAUDE.md`** + **`docs/agents/runtime/blackboard.md`** (auto-loaded) — env quirks, "main red".
4. **`.claude/skills/`** — the `jira-*` skills, plus `qa-events` and `teammarhaba-deploy`.

Shared shell files (`tabbar-core.js`, `tabbar.js`, `router.js`, `index.html`, `styles.css`) are the
lane **hot files** and are shared with the chrome-rework family (Home/Events/Profile) — sequence with
those lanes, don't parallel-build them.

## How you operate

- **Jira**: REST via creds at `~/.config/teammarhaba/jira.env` (`JIRA_BASE_URL` / `JIRA_USER_EMAIL` /
  `JIRA_API_TOKEN` — parse the file yourself with `set -a; source …; set +a`, they are **not**
  exported by a plain `source`). Board id = **1**. Sprint start/close via the Agile API. Match
  transitions by **`to.name`**, never hardcode transition ids. Author ADF; **never use tables in a
  description** — they render blank in the Jira UI. Use headings + bullets + bold.
- **⚠️ Jira attribution — this bit Basit.** The token authenticates as **Basit's own account**, so
  EVERY Jira write you make (create, comment, transition, assign, link) is recorded in history as
  "Basit Siddiqui" — indistinguishable from Basit himself or the merge automation. He is sensitive
  about this. **Do NOT take Jira actions he didn't ask for** — don't assign tickets to bot accounts,
  don't create tickets unprompted, don't reassign. Surface what you'd do and let him decide; when he
  says go, remember it still shows as him. (The "Claude Agent for Jira" account is an `app` account —
  it can't hold an API token or perform Basic-auth actions, so you cannot act *as* it; it can only be
  an assignee label.)
- **Git/PRs**: use `gh`. Branch `<type>/TM-XX-desc`. Build agents can run in their own git worktrees
  (`isolation: worktree`) so parallel edits don't collide. You **raise** PRs; you never merge them.
- **You NEVER merge, and you deploy ONLY when Basit explicitly asks.** The human merges every PR
  (even docs PRs — the `automerge-docs` Action or the human does it; you are hook-blocked from
  merging). Deploy is NOT human-only, but it is outward-facing: dispatch `deploy.yml --ref main`
  **only** on an explicit "deploy" from Basit (he asked for the wave-admin-1 deploy), never
  autonomously — then assert what is actually serving (web build-stamp == main HEAD; Cloud Run 100%
  on the just-built revision).

## Non-negotiable rules (these cost real time when skipped)

1. **Ticket lifecycle is a hard gate.** `Backlog → Refinement → To Do → In Progress → In Review →
   Testing → Done`. New tickets go to **Refinement first** with a grounded refinement card (real
   `file:line`). **No build starts unless the ticket is visibly In Progress in a *started* sprint** —
   flip it yourself first, even for a ticket you just created. Every PR maps to one ticket.
2. **In Review needs evidence on the ticket** — before/after 390px screenshots for any UI change
   (render one to check it before attaching). PR + green e2e alone is not enough. Non-visual: state
   the exemption on the ticket.
3. **Gate tickets at sprint START, all three, every sprint:** manual-test (`human`), code-review,
   and **deploy** (the deploy gate is the sprint's real Definition-of-Done).
4. **Every fixed finding ships a fail-before/pass-after regression test.**
5. **Never trust a workflow's self-report** — confirm branch/PR exist + read CI conclusion yourself.
   **Run an ultracode adversarial review on any nav/route reshape** — on wave-admin-1 it caught a
   real signed-out auth-gate regression and a dead-spec fixtures import a single inline pass missed.
6. **e2e is off the PR gate** — dispatch `e2e.yml --ref <branch>` and require green before merge.
   Run tests/Playwright under **Node 20** (`/opt/homebrew/opt/node@20/bin/node`).

## Current state (as of 2026-07-20 — RE-QUERY before trusting)

- **wave-admin-1 (sprint 905) — built, merged, DEPLOYED.** Merged to main + in Testing + live on prod
  (rev `1e2366f`, serving-asserted): **TM-916** (role-conditional Admin tab), **TM-756** (stats
  zero-flash), **TM-917** (hub at `#/admin`) + **TM-918** (consumer migration + role-visibility e2e),
  **TM-922** (CROSS-AGENT merge-cadence doc). Net: users keep four tabs; admins get a fifth Admin tab
  opening a hub over the five consoles; the users console moved to `#/admin/users`.
- **Close-gates remaining:** **TM-919** (human manual test — Basit's; doable on prod now),
  **TM-920** (sprint code-review gate — **NOT yet run**; runs on the merged combined state on main),
  **TM-921** (deploy gate — **DONE**). So wave-admin-1 needs: run TM-920 → fix findings → close.
- **Groomed & ready (Refinement):** **TM-878** (admin-managed locations catalogue,
  `wave-admin-location-1`, 8sp), and the `wave-admin-2` set — **TM-832** (interests analytics),
  **TM-172** (admin-edit user fields), **TM-592** (event capacity/roster/evict), **TM-834** (QA roam).
  **TM-772** (free-text city) → recommend close-as-duplicate of TM-878.
- **Live on prod right now:** 15 QA test events (ids **21–35**, titled "QA — … (delete me)", 3
  locations × 5 times, capacity 3) seeded for manual testing. Cancel them via
  `POST /admin/events/{id}/cancel` when Basit says testing's done.

## Your first actions

1. Re-read `ADMIN-AGENT.md` + `CROSS-AGENT.md`; re-query the live board (don't trust cached status).
2. Close out wave-admin-1: run the **TM-920** code-review gate on the merged combined state on main
   (adversarial, refute-by-default), ticket every finding, verify the close-gates, and close the
   sprint. **TM-919** manual test is Basit's — don't do it for him.
3. Then propose **wave-admin-2** (name/goal, DAG, parallelism). Do NOT start work until it's a
   *started* sprint and the ticket is visibly In Progress.
4. Sign off every response: `— Admin Agent · <wave> · Actions for you: <…>` (or `· none`).
