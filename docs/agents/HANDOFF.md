# Agent Handoff — TeamMarhaba

Self-contained brief for an agent continuing this project **from a fresh account/machine**
(session memory does not travel — everything load-bearing is in this doc or the repo).
Written 2026-07-13. Cross-check live state before acting; nothing here overrides the board.

## What this project is

**TeamMarhaba** — a social meetup app (events, RSVPs with waitlist, per-event group chat,
memberships/payments). Mono-repo: `hellobasitsiddiqui/teammarhaba` on GitHub.

| Layer | Tech | Where |
|---|---|---|
| Backend | Spring Boot 3, Java 21 (Temurin 25 image), embedded Tomcat, Maven (`backend/mvnw`) | Cloud Run `teammarhaba-backend`, europe-west2, pinned 1×1vCPU/1GiB |
| DB | Postgres 16, Flyway migrations | Cloud SQL `teammarhaba:europe-west2:teammarhaba-pg` (db-f1-micro, HDD — pilot-sized; see TM-651) |
| Web | Vanilla JS + fingerprinted assets, paper/doodle theme | Firebase Hosting `teammarhaba.web.app` |
| Mobile | Android + iOS **WebView shells** loading the live web app (`android/`, `ios/`; JS bridge `TeamMarhabaJsBridge`) | not yet on the app stores |
| Auth | Firebase Auth (email-code passwordless TM-234; custom token via IAM signBlob) | roles: USER/ADMIN only — **no HOST role** |
| Payments | Revolut Merchant API (sandbox), `Order` per (user,event), webhook settles PENDING→PAID | TM-477/TM-478 |
| Tests | JUnit + Testcontainers (needs Docker), Playwright e2e under `web/e2e` (**Node 20**, not 26) | e2e is OFF the PR gate — dispatch `e2e.yml` manually before merging web changes |

Design references (committed + hosted): design kit / screen inventory (118 screens)
`teammarhaba-design.web.app/preview.html`; test personas + stories gallery
`teammarhaba-personas.web.app`; both sources live in the repo (`design-kit/`, `test-personas/`).

## Setup checklist (fresh account/machine)

1. `gh auth login` — needs push access to `hellobasitsiddiqui/teammarhaba`.
2. Clone the repo (agents typically keep a personal working clone, e.g. `~/Projects/teammarhaba-agentX`).
3. **Jira REST creds** — human must provision `~/.config/teammarhaba/jira.env` with
   `JIRA_BASE_URL=https://10xai.atlassian.net`, `JIRA_USER_EMAIL`, `JIRA_API_TOKEN`.
   Long/structured ticket bodies are authored as **ADF via REST** (python helper with
   `h()/p()/ul()/table()` builders — see any recent brain-dump ticket's pattern); the MCP
   connector is fine for short ops but echoes full bodies and can't do sprints/deletes.
4. Docker running (Testcontainers), Java 21+, Node 20 for Playwright.
5. `gcloud auth login` + ADC only needed for deploy verification / firebase CLI work.
   Gotcha: a stale `firebase login` token shadows fresh ADC — `npx firebase-tools logout`
   then deploy with `GOOGLE_APPLICATION_CREDENTIALS` set.

## Operating rules (non-negotiable)

- **NEVER merge PRs.** Open them, get them green, move the ticket to In Review. Merging is the
  human's. Only docs-only (`*.md`) PRs auto-merge via workflow.
- **No work outside an open sprint.** Only tickets in the started sprint
  (`sprint in openSprints()`). Backlog tickets are off-limits until the human pulls them in.
- **Claim protocol** (full spec: `AGENT-CLAIM-PROTOCOL.md`, skill `jira-task-claim`):
  status-flip is the lock — transition To Do→In Progress (id 21), assign self, comment
  `[claim] <agentId> <ISO>`; earliest claim comment wins a race. In Review = 31, Done = 51,
  reclaim/To Do = 11. Set Start date (`customfield_10015`) on claim; worklog + Due date at PR.
- **Never touch `human`-labelled tickets** — they're the human's (console/credentials/purchases).
  Need a human action? Raise a HITL ticket and link it as blocker; don't ask inline.
- **Ticket lifecycle on ALL work**: every PR maps to a ticket, even self-initiated ones.
  Done means **merged to main**, not PR-opened. A dependent ticket unblocks only when its
  blocker is MERGED.
- **Branches**: `feature/TM-XX-desc` | `fix/TM-XX-desc` | `chore/TM-XX-desc`. Commits:
  `TM-XX Imperative summary`. **No Claude attribution ever.**
- **No bug fix without a fail-before/pass-after regression test.** Prove the fail (strip the fix,
  run, restore). Reference example: TM-680 / PR #470.
- **Deploy is MANUAL**: `gh workflow run deploy.yml --ref main` (skill `teammarhaba-deploy`),
  then **verify the serving revision actually flipped** — web `buildVersion` in the fingerprinted
  `build-info` asset AND backend `GET /version` sha must equal main HEAD (TM-131 lesson:
  green deploy ≠ new code live).
- **CI traps**: two code merges to main seconds apart cancel the first's image build — let each
  merge's CI finish. e2e is off the PR gate — dispatch it for web-touching branches and require
  green before merge.
- **Jira gotchas**: no `>` blockquotes / `- [ ]` checkboxes; never HTML-escape `& < >`;
  story points = `customfield_10016`; **Blocks direction** — verify with JQL `linkedIssues()`,
  the MCP tool description is wrong (create: inward = blocker, outward = blocked).
- **Fleet**: max 3 build agents at once; read `docs/agents/blackboard.md` after claiming;
  append cross-cutting lessons to `docs/agents/AGENTIC-LESSONS.md`.
- **Replay scheme**: tickets carry `replay`/`no-replay`; QA bug root-causes get folded back into
  the canonical build ticket so a ticket-driven rebuild gets it right first time.

## State as of 2026-07-13

- **Sprint 539 "TM Events MVP 2" is active.** Query the board for current truth.
- **Live**: web + backend both serving `a9da7e0` (Cloud Run revision `00221-jir`) — includes
  TM-680 (sender's own chat messages no longer count as unread; done, deployed, awaiting the
  human's on-device check).
- **Membership/payments** deployed behind flags (sandbox, `SUBSCRIPTIONS_ENABLED=false`).
- **Capacity** (TM-651, grounded analysis on the ticket): current footprint comfortable to
  ~50 concurrent active users; SSE slots + db-f1-micro are the first cliffs; 100-user and
  1000-user dial sets + costs are on the ticket. Cheap wins (badge-poll merge, alerts caching,
  `@Async` FCM fan-out) are listed there and safe to ticket/build.
- **Open brain-dump spikes awaiting human decisions** (don't build until decided; decompose after):
  TM-670 presence re-confirmation · TM-671 interest probe/flash question · TM-672 Diamond early
  access · TM-673 QR door check-in · TM-674 table-mode chat split · TM-675 rate-us prompts ·
  TM-676 365-offers/gift-an-event. Human/business: TM-652 promo stall · TM-677 Dragon's Den ·
  TM-678 t-shirts (gated on naming ticket TM-668 — "circle" rebrand candidates).
- **Known future work themes**: TM-641 visual regression (gated on TM-509 UI refresh + human
  eyeball), TM-528 multi-context e2e (foundation for persona simulation TM-628), version-string
  cleanup TM-610 (the `/version` "describe monster") under the Easy Wins epic.

## Key repo docs

`docs/agents/AGENTIC-LESSONS.md` (fleet playbook) · `docs/agents/blackboard.md` (per-run scratch) ·
`AGENT-CLAIM-PROTOCOL.md` + `DEPENDENCY-DAG.md` (claim + graph) · `infra/gcp/*.md` (cloud runbooks)
· `android/README.md` (shell + JS bridge + version check) · `test-personas/` (cast, stories,
storyboard compositor).

## Style notes the human cares about

- Jira/GitHub text in GitHub-flavored markdown (ADF via REST for long Jira bodies).
- Slack drafts: casual, lowercase, no bold, `<url|text>` links, in a code block.
- Always show actionable URLs as markdown links. When asking the human to act on a record,
  reference what their screen shows (email/name), not internal ids.
- Decisions the agent can't make belong in a ticket's "Human decisions" section — surface,
  don't resolve.
