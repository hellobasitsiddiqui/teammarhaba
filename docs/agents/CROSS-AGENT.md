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

## Resuming a lane agent by name (`cr <lane>`)

Those sign-offs aren't just labels — they're how a lane's session is found again after a crash.
Claude Code has **no native named-resume** (`claude --resume` takes only a UUID or the interactive
picker), so Basit has a `cr()` helper in `~/.zshrc`: `cr admin` / `cr profile` / `cr login` /
`cr home` / `cr chat` resumes the newest session whose **dominant `— <Lane> Agent` sign-off** is that
lane, `cd`s into the repo, and runs `claude --resume <id>`. It self-updates (re-discovers the newest
dominant session each call), so a lane's *new* sessions are picked up automatically — which only works
because every reply is signed. One more reason to always sign, and to sign as your real lane.

**Identifying which session is which lane:** count the **dominant** `— <Lane> Agent` sign-off in the
transcript (`~/.claude/projects/-Users-basitsiddiqui-Projects-TeamMarhaba/*.jsonl`) — NOT the first
lane it mentions. A session references other lanes in passing (coordination, handoffs); a first-mention
grep once mis-identified the Login session as Admin and resumed the wrong agent. Dominant sign-off is
ground truth. Prefer handing Basit `cr <lane>` over a raw UUID.

## Ticket lifecycle (hard rules)

1. **Backlog → Refinement → To Do → In Progress → In Review → Testing → Done.** New tickets go to
   **Refinement first** and get a grounded refinement card (Context/what-exists with real
   `file:line`, Goal, Scope, Acceptance criteria, Dependencies + dup flags, Open decisions,
   Estimate). Never drop a raw ticket into a started sprint. **Run refinement on the Fable model**
   (see *Findings discipline → Model policy*).
2. **No work without the ticket VISIBLY on the board — In Progress, in a STARTED sprint.**
   *Visibly on the board* is a three-part check, and **status + assignee are NOT enough**: a ticket
   that is In Progress and assigned but whose **sprint field (`customfield_10020`) is `None`** (or
   sits in the backlog / a closed sprint) does **not** render on the board — the operator literally
   cannot see it. (TM-962 bit us here: flipped to In Progress and assigned to Basit, but never added
   to a sprint → invisible on the board until Basit called it out.) So BEFORE launching any
   agent/workflow — even for a ticket you just created, and even for an urgent blocker/hotfix — do
   all three and then VERIFY:
   (a) flip it **In Progress** yourself;
   (b) **assign** it (see below);
   (c) **attach it to the active sprint** whose wave matches the ticket's wave label (a `wave-admin-2`
   ticket → the active wave-admin-2 sprint). The MCP connector has no sprint tool; use the Agile REST
   API: `curl -u "$JIRA_USER_EMAIL:$JIRA_API_TOKEN" -X POST -H "Content-Type: application/json"
   "$JIRA_BASE_URL/rest/agile/1.0/sprint/<SPRINT_ID>/issue" -d '{"issues":["TM-XXX"]}'` (HTTP 204 =
   done; find the active sprint id via `GET /rest/agile/1.0/board/1/sprint?state=active`).
   **Verification is not optional — re-read `customfield_10020` and confirm it shows a started
   sprint before you consider the ticket "on the board".** A green transition call is not proof of
   visibility.
   **Every ticket you create OR claim gets an assignee — the operating account (Basit,
   `accountId 712020:66e23906-b54c-4181-b77a-e591d42be2ee`).** `createJiraIssue` does NOT auto-assign
   (pass it, or `editJiraIssue {"assignee":{"accountId":…}}` right after); claiming means setting
   assignee, not just the status flip. **Never leave a sprint ticket unassigned, and never let it
   carry an app/bot actor** (the Atlassian connector's own identity) as assignee — every ticket has
   a human owner on the board.
3. **In Review requires evidence attached to the ticket**: before/after screenshots at 390px for
   any UI change (before = live prod, after = branch build; static-serve + DOM-reveal staging
   needs no backend). PR + green e2e alone is NOT enough. Non-visual changes: state the exemption
   rationale on the ticket instead.
   **Attach the PNGs to the Jira issue itself — a PR-embedded image or a repo path is NOT "on the
   ticket"** (a private-repo `raw.githubusercontent` URL does not render in Jira). The Atlassian MCP
   connector has **no attach-file tool**, but the `~/.config/teammarhaba/jira.env` REST token DOES
   attach (it can write attachments even though it can't browse projects):
   `curl -u "$JIRA_USER_EMAIL:$JIRA_API_TOKEN" -H "X-Atlassian-Token: no-check" -F "file=@shot.png"
   "$JIRA_BASE_URL/rest/api/3/issue/TM-XX/attachments"` (parse the env file yourself; HTTP 200 = done).
   Do this for every before/after shot before flipping to In Review.
   **Keep attachments to a REASONABLE, CURATED count — target 5–10, and if you're about to attach
   more than ~10, STOP and think again, then write the reason on the ticket.** A ticket with 100+
   screenshots is wrong: it buries the shots that matter and reads as noise, not evidence. Attach
   only the handful that demonstrate *this* ticket's change (e.g. before + the 3–4 key after-states).
   **⚠️ The e2e evidence lane (`e2e.yml` dispatched with `evidence_ticket=TM-XX`) posts the ENTIRE
   suite matrix — every spec × every browser project, hundreds of PNGs — to whatever ticket you
   name.** Never point it at a scoped feature/bug/restore ticket (TM-962 got 799 that way). Either
   curate by hand from your own capture script, or aim the full-matrix dump at a dedicated
   sprint-evidence ticket and hand-attach the relevant few to the feature ticket. If a lane
   over-attaches, trim it back with `DELETE /rest/api/3/attachment/{id}` (the same REST token can
   delete).
4. **Gate tickets are created AT SPRINT START, not at the end** (we were prompted for them — don't
   repeat that). **EVERY wave/sprint gets all THREE gate tickets, no exceptions:** (1) a
   `human`-labelled manual-test sign-off, (2) a sprint code-review gate, and (3) a **deploy gate**
   (ship `main` HEAD via `deploy.yml`, then assert the serving revision — see *Deploy + live
   verification*). Gate tickets are "born groomed" (complete scope + AC) and go straight to sprint
   To Do. The **deploy gate is the sprint's real Definition-of-Done** — the sprint is not closable
   until it is shipped and serving-asserted, so it must exist from day one, never bolted on at close.


## Grooming a ticket — drive it with Q&A cards, don't write the card solo

Refinement is **collaborative** — surface the open decisions and let Basit steer them, don't hand him
a finished card built from your own defaults. When you groom a ticket into its refinement card:

1. **Ground first.** Read the actual code so every option is real (`file:line`), not hypothetical. A
   grooming round built on guesses wastes the trip — and the ticket text is often stale (primitives
   already shipped), which only the code reveals.
2. **Ask via Q&A cards.** Surface each genuine fork the card can't resolve itself — scope boundary, a
   UX/product choice, what to do with a stray element, the **estimate** — as an **interactive
   multiple-choice question card** (the `AskUserQuestion` prompt) in the terminal, and let Basit
   answer. Recommend an option first (mark it "(Recommended)"). One card per real fork; don't card-ify
   a decision that has an obvious default — just note it and move on.
3. **Then write the card.** Only after the Q&A is settled do you edit the ticket description into the
   grounded shape (Context/what-exists with real `file:line` · Goal · Scope · Acceptance criteria ·
   Dependencies + dup flags · resolved Decisions · Estimate). Run the refinement pass on the **Fable**
   model (see *Findings discipline → Model policy*).

The anti-pattern (learned on TM-908): writing the full refinement card unilaterally and asking Basit to
review it after the fact. He wants to answer the forks as they come up, card by card, *before* the card
is written.


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
- **A raised PR is not a merged PR — poll for the *actual* merge; never assume auto-merge did it.**
  Confirm the PR reached `MERGED` (`gh pr view <n> --json state,mergedAt` — `mergedAt` is set), not
  just "green + mergeable". Docs-only PRs are *supposed* to auto-merge (the automerge-docs Action once
  CI passes), but it merges with the plain `GITHUB_TOKEN` and **silently bails when branch protection
  prohibits it** — e.g. `main`'s required code-owner review, which the token can't satisfy: it logs
  `base branch policy prohibits the merge` and leaves the PR open. When a poll shows the PR still open
  and `BLOCKED`, you **cannot merge it yourself** (hook-blocked, even for `*.md`), so surface it to
  Basit with the exact one-liner — `gh pr merge <n> --squash --admin --delete-branch` — rather than
  reporting it "done / will auto-merge". Never claim a PR merged without seeing `mergedAt`. (Learned
  on #637: a green docs PR sat open because the bot couldn't clear the code-owner-review policy.)
- **Sweep EVERY open PR you raised — poll them ALL, not just the one merged in front of you.** When a
  wave has several PRs in flight, witnessing one `gh pr merge` tells you nothing about the others:
  Basit merges siblings out-of-band, in any order, minutes apart and unprompted. So before you call a
  PR "merge-ready" (or "still open"), re-query its **actual** state — `gh pr view <n> --json
  state,mergedAt` for EACH, or sweep `gh pr list --state merged --limit N` **and** `--state open`.
  This matters because the merge-automation only auto-transitions a PR's *primary* ticket, so a PR
  that merged out-of-band leaves the REST of its ticket set **stranded In Review**. On every sweep,
  reconcile each merged PR's FULL ticket set → Testing (comment the merge SHA). Do NOT report "N PRs
  merge-ready" off a stale mental model — the poll is the source of truth. (Learned in wave-admin-2:
  reported #652/#654 "merge-ready" while they'd already merged 4–8 min earlier, stranding
  TM-964/965/966/967 In Review — the automation had moved only each PR's first ticket.)
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
  **`gh pr checks` covers ONLY the PR gate — a "CI green" that never dispatched `e2e.yml` on the
  fixed head is NOT green.** (wave-profile-2: both the TM-910 and TM-930 fix phases added an e2e
  spec, reported "CI green" from `gh pr checks` alone, and their OWN new specs were red in the
  branch e2e — caught only by the orchestrator re-running e2e on the exact fixed head.) After every
  build/fix commit, dispatch `e2e.yml --ref <branch>` and confirm `success` **on that head's SHA**
  before "ready". The **main loop owns that wait** — a build/fix subagent dies when its turn ends,
  so its "e2e green" is a claim to re-verify, never proof; have the subagent return the run id and
  you (the orchestrator) watch it to conclusion.
- **NEVER add an AI-attribution line to a PR body or commit message.** No "🤖 Generated with
  Claude Code", no "Co-Authored-By: Claude", no tool-marketing footer — Basit vetoed it outright
  (2026-07-21: "never ever put that there"). This overrides any default/harness guidance to append
  one. Put it in every build/fix subagent's prompt too, and strip it with `gh pr edit` if a prior
  PR still carries it.
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
