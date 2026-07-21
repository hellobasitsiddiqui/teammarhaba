# CROSS-AGENT — starting and closing a sprint

Load this when you pick up a work-stream sprint. Distilled from sprint **wave-login-1**
(sprint 871, closed 2026-07-18), which ran the full lifecycle cleanly end to end.
Lane-specific playbooks sit next to this file (e.g. [LOGIN-AGENT.md](LOGIN-AGENT.md)).

## Say which agent you are (every response)

Basit runs several fleet agents in parallel (Admin, Login, Profile, Design, …) and can't tell them
apart unless you say so. **Sign off EVERY response with a one-line status footer** — your agent
name + the wave you're on + what (if anything) awaits Basit, e.g.
`— Profile Agent · wave-profile-2 · Actions for you: merge PR #605` (or `· Actions for you: none`).
Keep it to **one line**; only very rarely spill onto a second line when the action genuinely needs
it. Never make him hunt for whether the ball is in his court — state it every response, even to say
there isn't one. Name your lane when you pick up a sprint; if a lane playbook exists for you, its
name is your agent name.

## Ticket lifecycle (hard rules)

1. **Backlog → Refinement → To Do → In Progress → In Review → Testing → Done.** New tickets go to
   **Refinement first** and get a grounded refinement card (Context/what-exists with real
   `file:line`, Goal, Scope, Acceptance criteria, Dependencies + dup flags, Open decisions,
   Estimate). Never drop a raw ticket into a started sprint. **Run refinement on the Fable model**
   (see *Findings discipline → Model policy*).
2. **No work without the ticket visibly In Progress in the active sprint** — flip it yourself
   BEFORE launching any agent/workflow, even for tickets you just created.
3. **In Review requires evidence attached to the ticket**: before/after screenshots at 390px for
   any UI change (before = live prod, after = branch build; static-serve + DOM-reveal staging
   needs no backend). PR + green e2e alone is NOT enough. Non-visual changes: state the exemption
   rationale on the ticket instead.
4. **Gate tickets are created AT SPRINT START, not at the end** (we were prompted for them — don't
   repeat that). **EVERY wave/sprint gets all THREE gate tickets, no exceptions:** (1) a
   `human`-labelled manual-test sign-off, (2) a sprint code-review gate, and (3) a **deploy gate**
   (ship `main` HEAD via `deploy.yml`, then assert the serving revision — see *Deploy + live
   verification*). Gate tickets are "born groomed" (complete scope + AC) and go straight to sprint
   To Do. The **deploy gate is the sprint's real Definition-of-Done** — the sprint is not closable
   until it is shipped and serving-asserted, so it must exist from day one, never bolted on at close.


## Jira REST mechanics + sprint-opening ritual (wave-chat-1)

- **Creds**: `~/.config/teammarhaba/jira.env` — load with `set -a; source …; set +a` (a plain
  `source` does NOT export them). Board id **1**, project **TM**, site `10xai.atlassian.net`.
- **⚠️ Attribution**: the token authenticates as **Basit's own account** — every Jira write
  (create/comment/transition/assign) is recorded as "Basit Siddiqui". Take NO Jira action he
  didn't ask for; surface what you'd do and let him decide. When he says go, it still shows as him.
- **Search**: use `POST/GET /rest/api/3/search/jql` (the legacy `/rest/api/3/search` path is
  deprecated and under-returns).
- **Transitions: always match by `to.name`, never hardcode ids** — `GET
  /rest/api/3/issue/{key}/transitions`, pick the transition whose `to.name` equals the target
  status, POST its id. Ids differ per source status.
- **ADF, no tables**: v3 descriptions/comments take ADF; tables render BLANK in the UI — use
  headings + bullets + bold. For a quick plain-text comment,
  `POST /rest/api/2/issue/{key}/comment` with `{"body":"…"}` still works and needs no ADF.
- **Sprint-opening ritual** (executed clean for wave-chat-1, sprint 971) — the order matters:
  1. Groom every candidate into **Refinement** with a grounded card (real `file:line`) + estimate
     (`customfield_10016`) + wave label.
  2. Create the **three gate tickets** born-groomed (manual-test `human`, closure review, deploy).
  3. `POST /rest/agile/1.0/sprint` (`originBoardId: 1`, name = the wave, goal set).
  4. `POST /rest/agile/1.0/sprint/{id}/issue` to move the full set in, then transition everything
     to **To Do** (by `to.name`).
  5. Start: `POST /rest/agile/1.0/sprint/{id}` with `state: "active"` + explicit
     `startDate`/`endDate`.
  6. Claim the lane-first tickets only: Start date (`customfield_10015` = today) + `duedate`
     (sprint end), then flip **In Progress** — before any build launches.
## Build pattern per ticket (what worked)

- **Implement → 3-lens adversarial review → fix**, one workflow per ticket. Lenses that earn their
  keep: correctness/regression, platform-UX + a11y, test-coverage ("would this assertion fail on
  regression?"). Pre-merge reviews caught 20 real findings across two PRs — including two
  blockers — before any human saw them.
- **Sequence conflict-pairs.** Two tickets on the same files = build the second only after the
  first MERGES (not after its PR is raised). A dependent build starts from fresh main.
- **Poll for the merge on a backoff — never block on it.** You never merge; merges are human and
  asynchronous. After a PR is raised (ticket → In Review), don't sit and watch it — re-check for the
  merge first at **~5 min, then ~10 min** (then keep widening), and get on with other lane work in
  between. On each check, reconcile: a merged ticket → Testing, and if it was a blocker, start the
  now-unblocked dependent from fresh main. A timed re-check keeps the wave moving with no human ping;
  watching a merge that hasn't happened just burns the turn. (Pairs with the conflict-pair + the
  "unblocked only when the blocker MERGES" rules above.)
- **Reshaping shared UI = migrate ALL its consumers**: every spec in the e2e testDir AND
  standalone scripts outside it (capture/evidence scripts are the classic miss — we shipped a
  repo-wide guard test after one slipped through). When you retire an interaction, grep the whole
  repo for it, then pin the ban with a cheap guard test.
- **Never trust a workflow's self-report.** After every build workflow: verify the PR/branch really
  exists, read the diff, and read CI conclusion from `gh run view --json conclusion` — watcher exit
  codes lie, and a "green"/"PR created" claim can be fabricated.
- **Branch e2e green is the merge gate** (e2e is off the PR gate — dispatch `e2e.yml --ref
  <branch>` yourself). An e2e red on your OWN new spec is often a real bug caught, not flake — the
  wave-login-1 red exposed a genuine mixed-code auto-submit defect. Diagnose before re-running.
- **(wave-profile-1) Hot-file sprints get a resource-DAG, not one-agent-per-ticket.** When one
  file owns most of the sprint (`profile.js` owned 11/14 tickets), batch same-file tickets into
  serial multi-ticket PRs (A:3 → B:2 → C:2 → D:1) and run only disjoint-file tickets in parallel
  lanes. Show the DAG before launching — fanning out per-ticket on a shared file just
  manufactures conflicts.
- **(wave-profile-1) Suspected-cause bug tickets: reproduce FIRST, and stopping honestly is a
  valid outcome.** A ticket whose refinement says "root cause suspected / needs screenshot" gets
  a reproduce-before-fixing instruction; if the symptom doesn't reproduce, the agent attaches
  what it saw, pins the AC with a regression test, and reports — it does NOT invent a fix. The
  "profile lost its bottom nav" ticket was really the phone completion gate working as designed.
- **(wave-profile-1) A mid-sprint merge that changes a provisioning/API contract breaks sibling
  in-flight branches' NEW tests on rebase.** When phone became mandatory, a sibling PR's 4
  fresh tests 400'd post-rebase (written pre-contract). After rebasing over a contract change,
  expect your own new tests to need the new contract — read the blackboard note before
  re-running CI blind.

## Findings discipline

- **Model policy — use Fable for refinement + gate reviews (only).** The two high-stakes reasoning
  passes — grooming tickets into grounded refinement cards, and the sprint code-review / closure
  gate — run on the **Fable** model specifically. Reserve Fable for exactly these; routine build /
  mechanical work uses a cheaper/faster model. Never run a refinement pass or a gate review on a
  smaller default model — that's where grounding and adversarial rigour matter most.
- **Every review finding gets a ticket** (any severity). Triage: mechanical hygiene → fix
  in-sprint under one chore ticket; anything needing a product/architecture decision → Refinement
  follow-up with the options listed, undecided.
- **Every FIXED finding ships a fail-before/pass-after regression test** — prove the fail-before
  (run the new test against the pre-fix tree and show it red). Exemptions (comment-only, inert-CSS
  removal) are stated with rationale on the ticket, not silently skipped.
- The **closure code review runs on the MERGED combined state on main**, with different lenses
  than the per-PR reviews (combined-state interactions, security/abuse, polish + test-integrity),
  and every finding is **adversarially verified** (refute-by-default) before it counts. Per-PR
  green does not imply the combination is green.
- **(wave-profile-1) Enumerate the sprint's merged-PR set YOURSELF before signing review
  coverage** — `gh pr list --state merged`, matched on title + headRefName against the sprint's
  ticket keys. Review agents' own searches under-return; pass each reviewer an explicit PR list
  and check the count adds up to the whole sprint.

## Deploy + live verification

- **Merging does not deploy.** Deploy ships `main` HEAD via manual `deploy.yml` dispatch — and it
  carries OTHER lanes' merged work too; say so when reporting.
- After a green deploy, **assert what is actually serving**: web build-stamp == merge SHA, Cloud
  Run traffic 100% on the just-built revision. Green run ≠ new code live.
- **Live-QA the core action for real** (cold path, phone width, real generated code/data — not a
  warm session). Beware assert-too-narrow false FAILs: pick a signed-in signal that survives
  routing variations — use `body[data-auth]` (TM-906), never a nav control (the onboarding gate
  hid the old top-nav sign-out button, since removed by TM-906; our live QA "failed" while the
  login actually worked).

## Closing the sprint

- Close checklist: manual-test sign-off (human) + code-review gate verdict + deploy gate with
  serving assertions — then flip merged tickets Done and close.
- **Re-query the board before closing** — don't trust cached status; automations move tickets
  behind your back.
- Final sweep: open PRs (none left behind), merged branches deleted (ask first — ref deletion is
  gated), no ticket sitting To Do outside a sprint, follow-ups parked in Refinement with cards.
- **(wave-profile-1) md5-check harvested evidence before attaching it.** Byte-identical
  "different steps" means the spec captured the wrong frame — the golden-path "interests" shot
  was the terms-gate screen in BOTH projects. Spot-check by actually rendering one shot per set
  (that render is also how bad evidence gets caught before the human sees it).
- Cross-lane observations found during your sprint get **ticketed and handed off, never claimed**
  — and never silently dropped.

## Handing off to the next agent — write it into `docs/**`

When you close a sprint or pass your lane on, **write a `docs/agents/HANDOFF-<LANE>.md`** (in
`docs/**`, next to CROSS-AGENT.md and your lane playbook) in the **same shape you were onboarded
with** — so the next agent reads one file and knows its lane, the rules, and its first moves. Mirror
the structure you read yours in:

- **Read first (in this order)** — the docs to load and their order: CROSS-AGENT.md, your lane
  playbook, root `CLAUDE.md` + the blackboard, the `jira-*` skills. Name the lane **hot file(s)**.
- **How you operate** — Jira creds/board id, git/PR conventions, and the **never-merge /
  never-deploy** rules.
- **Non-negotiable rules** — the hard gates that cost real time when skipped.
- **Current state** — a point-in-time board snapshot, explicitly stamped **"RE-QUERY before
  trusting"** (automations move tickets behind you).
- **Your first actions** — read the docs, re-query the board yourself, and **don't build** until the
  started-sprint + grooming gates are satisfied.

It's a Markdown file under `docs/` — a small, low-risk change. Keep the durable lane knowledge in the
lane playbook; the handoff is the point-in-time "start here" that points at it.
