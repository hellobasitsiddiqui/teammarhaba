# CROSS-AGENT — starting and closing a sprint

Load this when you pick up a work-stream sprint. Distilled from sprint **wave-login-1**
(sprint 871, closed 2026-07-18), which ran the full lifecycle cleanly end to end.
Lane-specific playbooks sit next to this file (e.g. [LOGIN-AGENT.md](LOGIN-AGENT.md)).

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
   repeat that): a `human`-labelled manual-test sign-off, a sprint code-review gate, and a deploy
   gate. Gate tickets are "born groomed" (complete scope + AC) and go straight to sprint To Do.

## Build pattern per ticket (what worked)

- **Implement → 3-lens adversarial review → fix**, one workflow per ticket. Lenses that earn their
  keep: correctness/regression, platform-UX + a11y, test-coverage ("would this assertion fail on
  regression?"). Pre-merge reviews caught 20 real findings across two PRs — including two
  blockers — before any human saw them.
- **Sequence conflict-pairs.** Two tickets on the same files = build the second only after the
  first MERGES (not after its PR is raised). A dependent build starts from fresh main.
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
- Cross-lane observations found during your sprint get **ticketed and handed off, never claimed**
  — and never silently dropped.
