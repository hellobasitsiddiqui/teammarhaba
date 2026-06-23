# Replay dry-run report (TM-145)

**Goal:** prove the portable agent-OS seed (TM-138) actually bootstraps — "copy the generic OS → edit one file → run one runbook" — rather than assuming it. This is a **dry run**: copy the GENERIC-OS paths into a scratch dir, edit `CONSTANTS`, walk `GENESIS`, and look for anything that wouldn't work in a truly fresh repo. No production resources used.

## Method
1. Copied only the GENERIC-OS paths per `SEED-MANIFEST.md` keep-list into a scratch dir (`CLAUDE.md`, `.claude/`, `docs/agents/{GENESIS,CONSTANTS,SEED-MANIFEST}.md`, `protocol/`, `conventions/`, an empty `runtime/blackboard.md`).
2. Probed: (a) hard-coded old project name/ids in copied files, (b) references from copied files to files that were *not* copied, (c) keep-list vs reality.

## Gaps found → resolution

| # | Gap | Severity | Fix |
| --- | --- | :--: | --- |
| 1 | **`DEPENDENCY-DAG.md` was in the generic `protocol/` bucket** but is pure project-instance (83 `TM-…` keys). Copying `protocol/` wholesale would drag TeamMarhaba's dependency graph into a new project. | high | **Moved** `protocol/DEPENDENCY-DAG.md` → `project/DEPENDENCY-DAG.md`; repointed all references. `protocol/` is now pure-generic (copy-wholesale honest). |
| 2 | **Stale path in `jira-task-claim` skill** — `Projects/TeamMarhaba/AGENT-CLAIM-PROTOCOL.md` (a pre-reorg leftover that never existed at that path). | med | **Fixed** → `docs/agents/protocol/AGENT-CLAIM-PROTOCOL.md`; bare `DEPENDENCY-DAG.md` → `docs/agents/project/DEPENDENCY-DAG.md`. |
| 3 | **Generic files carry the worked-example name** — `CLAUDE.md`'s title + intro prose are TeamMarhaba-specific, so "edit CONSTANTS only" isn't quite enough. | med | **Added a "Rename the worked example" step** to the SEED-MANIFEST runbook (find/replace name + rewrite `CLAUDE.md` intro). `CONSTANTS.md` stays the source of truth for *values*; this covers prose. |
| 4 | Generic files reference project-instance docs not in the seed (`project/SPRINTS.md`, `project/REPLAY.md`, `project/DEPENDENCY-DAG.md`). | low | **Documented as expected** — these are *forward references* written during the build (epic breakdown + GENESIS), not missing-file bugs. Noted explicitly in the runbook. |

## Verdict
With fixes #1–#3 applied and #4 documented, the seed bootstraps by **copy → edit `CONSTANTS` → rename → run `GENESIS`**. The keep-list now matches reality (`protocol/` pure-generic, `DEPENDENCY-DAG` in `project/`). "A fresh repo can be bootstrapped from the seed" is now **demonstrated**, not assumed.

## Not yet done (follow-up, out of scope here)
- A *live* end-to-end replay (actually run GENESIS against a real new GCP/Jira project) — this dry run validates the **kit's structure + self-containment**, not the cloud bootstrap. Worth a future ticket when a throwaway project is available.
