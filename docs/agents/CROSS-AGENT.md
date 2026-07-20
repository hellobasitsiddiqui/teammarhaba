# CROSS-AGENT — starting and closing a sprint

Load this when you pick up a work-stream sprint. Distilled from sprint **wave-login-1**
(sprint 871, closed 2026-07-18), which ran the full lifecycle cleanly end to end.
Lane-specific playbooks sit next to this file (e.g. [LOGIN-AGENT.md](LOGIN-AGENT.md)).

## Say which agent you are (every response)

Basit runs several fleet agents in parallel (Admin, Login, Profile, Design, …) and can't tell them
apart unless you say so. Do BOTH, every response:

1. **Set the shell/terminal title to your agent name** and keep it set on every response, so the
   window/tab itself always shows who's replying — e.g. emit the OSC escape
   `printf '\033]0;Profile Agent\007'` (swap in your own lane name). Re-emit it each turn; some
   shells reset the title after a command runs.
2. **Sign off EVERY response with a status footer** — so Basit knows who's replying, what they're
   working, and whether the ball is in his court. Two lines:
   - your agent name + the wave/sprint you're on — e.g. `— Profile Agent · working wave-profile-2`;
   - an explicit **Actions for you:** line naming the concrete thing awaiting Basit (e.g.
     `merge PR #605`, `approve the sprint start`, `authenticate the MCP`), or **`none`** when nothing
     is blocked on him. Never make him hunt for whether there's a ball in his court — state it every
     response, even to say there isn't one.

Also name your lane when you pick up a sprint. Never leave him guessing who's replying. If a lane
playbook exists for you, its name is your agent name.

## Ticket lifecycle (hard rules)

1. **Backlog → Refinement → To Do → In Progress → In Review → Testing → Done.** New tickets go to
   **Refinement first** and get a grounded refinement card (Context/what-exists with real
   `file:line`, Goal, Scope, Acceptance criteria, Dependencies + dup flags, Open decisions,
   Estimate). Never drop a raw ticket into a started sprint.
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
  routing variations (the onboarding gate hides `#signout-btn`; our live QA "failed" while the
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
