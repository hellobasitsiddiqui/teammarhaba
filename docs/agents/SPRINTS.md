# TeamMarhaba — Sprints (naming scheme + log)

Single source for sprint **names**, **goals**, and the running **log**. Living doc — add each sprint as it's planned. (Merged from the former `SPRINT-NAMES.md` + sprint log on 2026-06-20.)

---

## Naming scheme — Anatomy ✅ DECIDED (2026-06-20)

Sprint names tell the story of the product **growing in capability**, nothing → shippable MVP. The anatomy arc is canonical because Epic 1 is literally a *walking skeleton* (TM-49 = Spring Boot walking-skeleton service) — the metaphor is grounded in the real architecture, not decoration. **Use this scheme.** Alternatives at the bottom are reference-only unless Basit changes the decision.

| # | Sprint name | Theme | Roughly maps to |
|---|-------------|-------|-----------------|
| 1 | **SKELETON** | The frame stands up — repo, CI/CD, deploy pipeline, `/health` service | Epic 1 (Foundation backlog) |
| 2 | **SPINE** | Backbone: core data model, auth seam, migrations | data + Firebase Auth |
| 3 | **FLESH** | First real features on the frame | feature epics |
| 4 | **MUSCLE** | Strength: performance, scaling, hardening | non-functional |
| 5 | **SENSES** | Perception: logging, metrics, alerting, traces | observability |
| 6 | **ABLE BODY** | Stands on its own and *does* things — shippable MVP | release |

Notes:
- Each name is a **phase** that may span **several 4-day sprints** (Epic 1 alone is 81 pts → at 2 agents × 4 days, the SKELETON phase ≈ 4–5 sprints). Name the Jira sprints `SKELETON 1`, `SKELETON 2`, … then `SPINE 1`, …
- "BONES" is deliberately *not* a separate phase — a skeleton already is bones, so it would overlap. **SPINE** covers the structural-backbone phase instead.
- To collapse the early game: merge SPINE + FLESH into **FLESH & BONES**.
- **Every project starts with a short, LINEAR Bootstrap** (create repo → seed agent operating instructions → minimal protection) *before* the themed phases — it primes the repo so agents self-host. **Future projects: make it an explicit first epic (a "Sprint 0 / Genesis").** TeamMarhaba folded it into SKELETON 1 inline (`TM-44 → TM-80`).
- **Each sprint also carries human tasks** (start/close the sprint, review + merge PRs, billing/credentials, UI deletes) — tracked as `human`-labelled tickets assigned to a person, so the board shows *all* the work, not just the agent slice. Agents skip them (`labels != "human"` + they're assigned). See `AGENT-CLAIM-PROTOCOL.md` → "Human tasks".

---

## Sprint 1 — SKELETON (1)

First sprint of the SKELETON phase: the opening foundation slice. Bones that stand and a pipeline that's green — no movement (deploy) yet; that lands in a later SKELETON sprint.

- **Length:** 4 days
- **Agents:** 2 (`agent-A`, `agent-B`) via the `/jira-task-claim` skill — one root each at kickoff (TM-44, TM-66), then pull onward.

**Goal**
> Stand up the skeleton: a runnable, containerised `/health` backend with its cloud project, Cloud SQL database, keyless deploy auth, and a green CI gate — the load-bearing frame every later feature attaches to. Bones that stand and a pipeline that's green; no features yet.

**Linear bootstrap (do FIRST, sequentially, one window):** `TM-44` (create repo) → `TM-80` (1.1.6 seed agent operating instructions into the repo). This primes the repo so the parallel agents can self-host from it. Run it as one linear thread *before* launching agents A + B (see `AGENT-CLAIM-PROTOCOL.md` → Prerequisite).

**Scope — 9 Tasks (19 pts), loaded into the sprint (id 1)**
| Key | Task | Wave |
|---|---|:--:|
| TM-44 | 1.1.1 mono-repo structure | 0 |
| TM-66 | 1.5.1 GCP/Firebase project | 0 |
| TM-49 | 1.2.1 Spring Boot walking skeleton (`/health`) | 1 |
| TM-51 | 1.2.3 web static Dockerfile (nginx) | 1 |
| TM-67 | 1.5.2 keyless GitHub→GCP OIDC | 1 |
| TM-63 | 1.4.4 Cloud SQL + connector + Secret Manager | 1 |
| TM-80 | 1.1.6 seed agent operating instructions (bootstrap) | 1 |
| TM-50 | 1.2.2 multi-stage backend Dockerfile | 2 |
| TM-53 | 1.3.1 PR CI (lint + test + build) | 2 |

**Human tasks in this sprint** — `human`-labelled, assigned to a person, excluded from the agent pool (see `AGENT-CLAIM-PROTOCOL.md` → "Human tasks").
| Key | Human task | Status |
|---|---|---|
| TM-82 | Start the sprint (UI — no API) | ✅ Done |
| TM-83 | Review + merge agent PRs → `main` (the In Review → Done gate) | ongoing |
| TM-84 | Confirm GCP billing linked (prereq for TM-66 / TM-63) | To Do |

(One-off `TM-85` "delete dropped TM-47" sits in the **backlog**, not the sprint — pure admin.)

**Definition of done — demoable at review**
- Fresh clone → run locally → `GET /health` → 200.
- Backend **and** web both build as Docker images.
- A PR runs `mvn verify` and goes green (CI gate live).
- GCP/Firebase project with APIs + Firebase Auth on; Cloud SQL provisioned; GitHub→GCP keyless OIDC works.

**Not in this sprint** — deploying to Cloud Run (still part of the SKELETON phase, but a later sprint). The bones stand and CI is green; motion comes next.

**Status:** ✅ **ACTIVE** — "Sprint 1 - The Skeleton" (id 1), 2026-06-20 → 2026-06-24. **Bootstrap DONE** (`TM-44` + `TM-80` merged); scope = **9 agent tasks** + **3 human tasks** (`TM-82/83/84`). **Agent A running**; Agent B not yet launched. Agents self-host from the repo (clone `hellobasitsiddiqui/teammarhaba` → auto-load `CLAUDE.md` + `.claude/skills` → pull). Ready roots when A/B poll: `TM-66`, `TM-49`, `TM-51`.

---

## Sprints 2–4 — rest of Epic 1 (summary; inline log wasn't kept)

Sprints 2–4 carried the remainder of Epic 1 to Done: the CI image build/push + Cloud Run / Firebase Hosting deploys (groups 1.3/1.4), the data layer (Cloud SQL wiring, Flyway migrations, Testcontainers harness — 1.2/1.3/1.6), and the backend "wakes up" internals — Spring profiles + validation, RFC 7807 errors, `/api/v1` versioning, security headers, full Actuator, structured JSON logging, OpenAPI/Swagger, Firebase ID-token auth (default-deny), and Micrometer → Cloud Monitoring (group 1.6). **Sprint 4 = "Sprint 4 - Wakes Up".** As of **2026-06-21** all of these are merged to `main`.

---

## Sprint 5 — THICK SKIN (Foundation Finish) — PLANNED

Completes **Epic 1 (Foundation)**: the CI/security-hardening, repo-hygiene, and dev-experience tasks left after the deploy + backend work landed. After this, the foundation epic is 100% done and feature epics (Epic 2+) can begin.

- **Length:** 4 days
- **Agents:** 2 (`agent-A`, `agent-B`) via `/jira-task-claim`
- **Goal:** Give the foundation a thick skin — a coverage-gated, security-scanned, supply-chain-hardened CI that rejects secrets, plus clean repo hygiene + decision/architecture/security docs and a zero-friction dev loop (pre-commit + a command runner). No new product features.

**Scope — 9 agent Tasks (18 pts), dependency-closed (every blocker is Done):**

| Key | Pts | Task | Ready? |
|---|:--:|---|---|
| TM-46 | 2 | 1.1.3 Repo hygiene (README, LICENSE, CODEOWNERS, templates, .env.example) | ✅ ready |
| TM-48 | 2 | 1.1.5 Decision records + architecture + security docs | ✅ ready |
| TM-58 | 1 | 1.3.6 Secret scanning + push protection | ✅ ready |
| TM-54 | 2 | 1.3.2 JaCoCo coverage gate (merge-blocking) | ✅ ready |
| TM-56 | 2 | 1.3.4 Security scanning: CodeQL + dependency-review / Dependabot | ✅ ready |
| TM-59 | 2 | 1.3.7 Supply-chain hardening: SHA-pinned Actions + CycloneDX SBOM | ✅ ready |
| TM-68 | 2 | 1.5.3 Linter/formatter + pre-commit hooks | ✅ ready |
| TM-69 | 2 | 1.5.4 Dev command runner (Makefile/Taskfile + scripts) | ✅ ready |
| TM-65 | 3 | 1.4.6 PR preview environments (Firebase preview + per-PR Cloud Run revision) | ✅ ready |

**Human / HITL (assign to a person; agents skip — `human` label):**

| Key | Task | Note |
|---|---|---|
| TM-85 | Delete dropped task TM-47 (UI cleanup) | admin |
| TM-96 | Decide + enable public (allUsers) access for backend Cloud Run | prod-readiness; optional this sprint |

**Definition of done — demoable at review**
- A PR is blocked when coverage drops below the JaCoCo gate, and when CodeQL / dependency-review flags an issue; a CycloneDX SBOM is produced by the build.
- Secret scanning + push protection on; pushing a secret is rejected.
- Fresh clone → one command (the dev runner) builds/tests; pre-commit hooks install cleanly.
- README / LICENSE / CODEOWNERS / PR + issue templates present; ADRs + architecture + security docs in `docs/`.

**Not in this sprint (deliberately deferred):**
- **TM-45** (1.1.2 Branch strategy + protection) and its prerequisite **TM-97** (upgrade to GitHub Pro) — branch protection on a private repo needs Pro; deferred until that decision is made.
- Product features (Epic 2+); pre-prod Cloud SQL private-IP hardening (TM-95); the allUsers/org-policy decision (TM-96) — a later **prod-readiness** slice.

**To start it (human, UI):** create the sprint on the board (e.g. `Sprint 5 - Foundation Finish`, 4-day window), then either drag the 10 agent tickets in, or share the sprint id and an agent can bulk-set `customfield_10020` on them via the API. Then **Start sprint**.

---

## Mechanics (read before creating sprints)

- **Adding tickets to a sprint works via the API** — set `customfield_10020 = <sprintId>` on each issue. The connector has no list-sprints tool, so discover the id by reading the field off an issue already in a sprint, or probe (`SCRUM Sprint 1` = **id 1** here).
- **Creating + starting a sprint is UI-only** — no API for the sprint lifecycle (activate + dates + name + goal). Do that on the board.
- Optional alternative grouping: a `sprint-<name>` **label** (e.g. `sprint-skeleton`) is queryable even before a real sprint exists — but with the Sprint field working, prefer the real field.
- Tasks already carry `wave-N` topological labels (`wave-0` = roots that block everything); use those + `DEPENDENCY-DAG.md` to pick a **dependency-closed** slice into each sprint (never sprint a task whose blocker is still in the backlog).
- **Board fields for a functional sprint:** each worked ticket gets a **Start date** (`customfield_10015`, set on claim), **Due date** (`duedate`, = sprint end), **story points** (estimate), and a **worklog** of actual time (`addWorklogToJiraIssue`) on PR; blocked tickets get **Flagged = Impediment** (`customfield_10021`). Original Estimate needs a one-time UI admin toggle (not on the Task screen) — story points stand in. Full table: `AGENT-CLAIM-PROTOCOL.md` → "Board fields & time logging".

---

## Sprint template (copy for the next one)

```
## Sprint N — <ANATOMY NAME> (k)
- Length: <days>
- Agents: <n> via /jira-task-claim
- Goal: <single outcome sentence>
- Scope: <dependency-closed task list with keys + waves>
- Definition of done: <demoable checks>
- Not in this sprint: <explicit exclusions>
```

---

## Alternative schemes (reference only — not in use)

Same "grows in capability" spirit; pick one and stay consistent if ever switching.

- **Coming alive (Frankenstein/spark):** SKELETON → STITCHED → SPARK → PULSE → IT LIVES
- **Construction / building** (legible to non-devs): FOUNDATION → FRAME → WIRING → WALLS → FIT-OUT → MOVE-IN
- **Rocket / launch** (punchy): SCAFFOLD → IGNITION → BOOSTER → ORBIT → LANDING
- **Growth (seed → bloom):** SEED → ROOTS → SPROUT → BLOOM → HARVEST
- **Climbing** (fewer phases): BASECAMP → ASCENT → RIDGE → SUMMIT
