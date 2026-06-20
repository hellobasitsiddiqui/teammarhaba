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

**Definition of done — demoable at review**
- Fresh clone → run locally → `GET /health` → 200.
- Backend **and** web both build as Docker images.
- A PR runs `mvn verify` and goes green (CI gate live).
- GCP/Firebase project with APIs + Firebase Auth on; Cloud SQL provisioned; GitHub→GCP keyless OIDC works.

**Not in this sprint** — deploying to Cloud Run (still part of the SKELETON phase, but a later sprint). The bones stand and CI is green; motion comes next.

**Status:** ✅ **ACTIVE** — "Sprint 1 - The Skeleton" (id 1), 2026-06-20 → 2026-06-24, **9 tasks** in scope. Next: run the **linear bootstrap** (TM-44 → TM-80) in one window, then launch agents A + B.

---

## Mechanics (read before creating sprints)

- **Adding tickets to a sprint works via the API** — set `customfield_10020 = <sprintId>` on each issue. The connector has no list-sprints tool, so discover the id by reading the field off an issue already in a sprint, or probe (`SCRUM Sprint 1` = **id 1** here).
- **Creating + starting a sprint is UI-only** — no API for the sprint lifecycle (activate + dates + name + goal). Do that on the board.
- Optional alternative grouping: a `sprint-<name>` **label** (e.g. `sprint-skeleton`) is queryable even before a real sprint exists — but with the Sprint field working, prefer the real field.
- Tasks already carry `wave-N` topological labels (`wave-0` = roots that block everything); use those + `DEPENDENCY-DAG.md` to pick a **dependency-closed** slice into each sprint (never sprint a task whose blocker is still in the backlog).

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
