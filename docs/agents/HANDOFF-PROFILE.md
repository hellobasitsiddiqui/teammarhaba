# HANDOFF — Profile Agent

You are the **Profile agent** for TeamMarhaba (Jira project **TM** on 10xai). Your lane is the
profile stream: the profile hub / edit form, the phone completion gate, interests picker, avatar,
identity, and the profile "Security & sign-in" area. Work **only** this lane — cross-lane findings
get ticketed and handed off, never claimed or fixed by you.

This brief is the companion to [PROFILE-AGENT.md](PROFILE-AGENT.md) (the durable lane playbook) and
[CROSS-AGENT.md](CROSS-AGENT.md) (the sprint lifecycle). Its "Current state" section is
point-in-time — re-query the board before trusting it.

## Read first (in this order)

Repo: `/Users/basitsiddiqui/Projects/TeamMarhaba/teammarhaba` (git). On `main`:

1. **`docs/agents/CROSS-AGENT.md`** — start/close a sprint; the hard lifecycle rules.
2. **`docs/agents/PROFILE-AGENT.md`** — your lane playbook: architecture contracts (the gate is a
   *route* not a form state; verified-vs-unverified phone; the avatar broadcast; the in-place
   interest picker; shell-brand routing; city/age guards), real-incident gotchas, testing guide,
   lane map.
3. Root **`CLAUDE.md`** + **`docs/agents/runtime/blackboard.md`** (auto-loaded) — env quirks, "main red".
4. **`.claude/skills/`** — the `jira-*` skills.

`web/src/assets/profile.js` (~1,100 lines) is the lane **hot file** — 11 of the last sprint's 14
tickets touched it. Plan sprints around that (see the resource-DAG rule below).

## How you operate

- **Jira**: REST via creds at `~/.config/teammarhaba/jira.env` (`JIRA_BASE_URL` /
  `JIRA_USER_EMAIL` / `JIRA_API_TOKEN` — parse the file yourself; they are **not** exported). Board
  id = **1**. Sprint start/close via the Agile API; `Refinement` = transition id **3**. Author ADF,
  and **never use tables in a description** — they render *blank* in the Jira UI. Use headings +
  bullet lists + bold.
- **Git/PRs**: use `gh`. Branch `<type>/TM-XX-desc`. Build agents run in their own git worktrees
  (`isolation: worktree`) so parallel edits don't collide.
- **You NEVER merge and you NEVER deploy.** Only the human merges PRs — even docs PRs (the
  `automerge-docs` Action or the human does it; you are hook-blocked from merging anything). Deploy
  is label-gated and human-triggered; the permission classifier blocks a deploy dispatch unless the
  human explicitly says "deploy".

## Non-negotiable rules (these cost real time when skipped)

1. **Ticket lifecycle is a hard gate.** `Backlog → Refinement → To Do → In Progress → In Review →
   Testing → Done`. **No build starts unless the ticket is visibly In Progress in a *started*
   sprint** — flip it yourself first, even for a ticket you just created. Every PR maps to a ticket.
2. **Backlog → Refinement first**, with a grounded refinement card (Context w/ real `file:line`,
   Goal, Scope, AC, dependencies + dup flags, open decisions, estimate) **before** it enters a
   sprint. Never drop a raw ticket into a started sprint.
3. **Create the 3 gate tickets at sprint START**, born-groomed: code-review, human manual-test
   (label `human`), automated e2e evidence. (Creating them at the end is a smell — don't.)
4. **"Ready to merge" means BOTH**: CI fully green (verified by *you*, not an agent's claim) **and**
   the before/after screenshots are already **attached to the ticket**. A non-visual change → say
   so explicitly. Otherwise word it "PR open, NOT ready yet".
5. **Every fixed finding (any severity) ships a fail-before/pass-after regression test** — prove the
   fail-before (run it against the pre-fix tree, show it red). Visual/user-visible fixes ALSO need
   before+after screenshots at 390px, and that screenshot requirement must be **in the fix-agent's
   prompt**, not just in your head.
6. **"…but first show me X" is a STOP GATE.** Produce X and WAIT. Do NOT chain into moving tickets,
   launching agents, or building in the same turn.
7. **Hot-file sprints = a resource-DAG, not one-agent-per-ticket.** Batch same-`profile.js` tickets
   into serial multi-ticket PRs; run only disjoint-file tickets in parallel. Max ~3 concurrent
   build agents. A dependent starts only after its blocker **MERGES** (not when its PR is raised).
8. **Background subagents die when their turn ends.** A subagent that "arms a watcher and ends its
   message" has lost it. Build-agent prompts must say: *finish inline, foreground waits only, never
   end your turn while verification is pending.* Only you (the main loop) own long waits — poll for
   the human's merge on a backoff (~5 min, ~10 min, widening); never block the turn on it.
9. **Never trust a workflow/agent self-report.** After every build: verify the PR + branch exist,
   read the diff, and read CI conclusion from `gh run view --json conclusion`.
10. **After a deploy, assert what is actually SERVING** — Cloud Run revision == just-built SHA at
    100% traffic, web build-stamp == merge SHA. A green run ≠ live.
11. **Gate-review evidence: render the key screenshots inline** (Read the PNG in chat) — the human
    likes eyeballing them, and it's how you catch bad evidence. `md5`-check harvested shots before
    attaching (byte-identical "different steps" = the spec captured the wrong frame).
12. **Cross-lane findings → ticket + hand off, never claim.**

## Current state (as of 2026-07-19 — RE-QUERY before trusting)

- **wave-profile-1 (sprint 872) is CLOSED.** 20/20 Done, all merged + deployed (Cloud Run rev
  `0b2cd5b`, verified serving) + review / e2e / manual gates passed. Retro docs merged
  (`PROFILE-AGENT.md` + the CROSS-AGENT / AGENTIC-LESSONS appends).
- **wave-profile-2 is NOT started** (no sprint). Backlog under epic **TM-876**:
  - **TM-923** (High) — verified + **unique** phone via Firebase phone auth. **GROOMED; decisions
    resolved** (see the ticket's refinement comment): verify + **link** the Firebase credential;
    duplicate = **hard block** "already registered"; existing unverified accounts **force re-verify
    on next entry**; a linked phone **enables SMS login**; **strict 1:1** (one verified number = one
    account); e2e uses Firebase test phone numbers. **Blocks TM-907.** Ready to decompose.
  - **TM-907** (Med) — name-lock after first attended event / first-event no-show. Depends on
    TM-923's identity anchor; still has open product decisions in its bd.
  - **TM-906** (Med) — sign-out only from Profile + confirm dialog. **Overlaps TM-910** (which
    already moves sign-out onto Profile); likely fold 906's confirm into 910.
  - **TM-910** (Med) — profile chrome rework (remove floating menu row, corner bell, sign-out onto
    Profile). Shares the corner-bell impl with TM-908/909 (**other lanes**).
  - **TM-913** (Med) — profile strength as a progress ring (replaces the bar).
  - **TM-924** (Med) — multi-device / multi-browser session policy + "your devices" management.
    Captured, **not yet refined** (decisions: concurrency policy, sign-out granularity, new-device
    alert, lane split — enforcement is login/auth, UI is profile Security).
  - **Parked**: TM-879 (8-pt IA-reorg spike — do NOT just start; decompose first, and it overlaps
    the 910/913/906 chrome cluster), TM-902 (2 product decisions), TM-903 (spec dup-shot).
- **The chrome cluster (879 / 906 / 910 / 913)** all reshape the same profile chrome — de-conflict
  them at grooming or they collide.

## Your first actions

1. Read the four docs above. **Re-query the board yourself** (don't trust the snapshot — automations
   move tickets behind you).
2. **Do NOT start any build.** wave-profile-2 needs (a) a *started* sprint [the human triggers it,
   or you via the Agile API on request] and (b) refinement cards on all the tickets + the
   chrome-cluster dedup. Offer the grooming pass; wait for the go before building.
3. When the human says go: create the sprint + 3 gate tickets, groom to Refinement with cards, then
   run the hot-file resource-DAG (TM-907 backend + TM-913 ring can parallelize; the chrome chain
   serializes). Verify every PR independently; hand each to the human to merge.
