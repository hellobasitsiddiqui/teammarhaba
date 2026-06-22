# SEED MANIFEST — the portable agent-OS kit (TM-138)

**What this is:** the table of contents + keep-list for the agent operating system, so you can **copy the generic OS into a fresh repo, edit one file, and run one runbook** to bootstrap a new project (or replay this one). Promotes the keep-list out of memory and into the repo.

## The kit at a glance

```
CLAUDE.md                         ← root; auto-loaded by Claude Code (keep in place)
.claude/skills/                   ← jira-* skills; auto-loaded by location (keep in place)
docs/agents/
  GENESIS.md                      ← run-FIRST bootstrap/replay checklist
  CONSTANTS.md                    ← the ONE file you edit to re-skin
  SEED-MANIFEST.md                ← this file
  protocol/                       ← how the fleet operates
    AGENT-CLAIM-PROTOCOL.md
    DEPENDENCY-DAG.md             ← (project-specific graph)
    housekeeping.md
  conventions/
    AGENTIC-LESSONS.md            ← fleet-orchestration playbook
  project/                        ← THIS build's instance (rewrite on a new project)
    COMMON-FEATURES.md · SPRINTS.md · EPIC-2-PLAN.md · REPLAY.md
  runtime/                        ← per-run scratch (ships empty / regenerated)
    blackboard.md · inbox/
```

> **Why `CLAUDE.md` + `.claude/` stay at the root:** Claude Code auto-loads them **by location**. The kit is therefore "`CLAUDE.md` + `.claude/` + `docs/agents/`" copied together — not a single relocatable folder.

## Keep-list — what travels, what gets rewritten, what starts empty

| Path | Role | On replay / new project |
| --- | --- | --- |
| `CLAUDE.md` | **GENERIC-OS** | copy as-is; it points to `CONSTANTS.md` for all project values |
| `.claude/skills/` | **GENERIC-OS** | copy as-is |
| `docs/agents/GENESIS.md` | **GENERIC-OS** | copy as-is; run it first |
| `docs/agents/CONSTANTS.md` | **GENERIC-OS (edit me)** | copy, then overwrite every value for the new project |
| `docs/agents/SEED-MANIFEST.md` | **GENERIC-OS** | copy as-is |
| `docs/agents/protocol/AGENT-CLAIM-PROTOCOL.md` | **GENERIC-OS** | copy as-is |
| `docs/agents/protocol/housekeeping.md` | **GENERIC-OS** | copy as-is |
| `docs/agents/conventions/AGENTIC-LESSONS.md` | **GENERIC-OS** | copy as-is; append new cross-cutting lessons |
| `docs/agents/protocol/DEPENDENCY-DAG.md` | **PROJECT-INSTANCE** | regenerate from the new epic breakdown |
| `docs/agents/project/COMMON-FEATURES.md` | **PROJECT-INSTANCE** | keep the generic feature rows; reset the status column |
| `docs/agents/project/SPRINTS.md` | **PROJECT-INSTANCE** | new sprint log |
| `docs/agents/project/EPIC-*-PLAN.md` | **PROJECT-INSTANCE** | new epic plans |
| `docs/agents/project/REPLAY.md` | **PROJECT-INSTANCE** | the build's narrative; reset/restart |
| `docs/agents/runtime/blackboard.md` | **RUNTIME** | ships empty (the canonical seed header only); agents append at runtime |
| `docs/agents/runtime/inbox/` | **RUNTIME** | per-agent mailboxes; starts empty |

**Source repos** (this build's actual app/infra) are **not** part of the kit — a replay deletes them and rebuilds from `labels = replay` tickets. See `project/REPLAY.md`.

## Replay into a new repo — the one-pager

1. **New empty repo** (default branch `main`).
2. **Copy the GENERIC-OS paths** above into it (`CLAUDE.md`, `.claude/`, `docs/agents/{GENESIS,CONSTANTS,SEED-MANIFEST}.md`, `protocol/`, `conventions/`, an empty `runtime/blackboard.md`).
3. **Edit `CONSTANTS.md`** — every value for the new project (name, GCP/Jira/GitHub ids).
4. **Run `GENESIS.md`** — the linear Sprint-0 bootstrap (human prereqs → GCP/IAM wiring → repo + merge→Done Action → Jira project).
5. **Launch the fleet** — agents run `/jira-task-claim`, self-host from the repo, and pull `labels = replay` (or the new backlog) wave by wave.
