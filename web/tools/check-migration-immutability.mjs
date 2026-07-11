// Flyway migration immutability guard (TM-648). FAILS a pull request if it edits, deletes, or
// renames a migration file that ALREADY EXISTS on the base branch. Adding a NEW migration is the
// whole point of a forward-only schema history, so additions are always allowed.
//
// Why this exists: TM-525 edited the header comments of already-applied migrations V13/V14/V18.
// Editing the file body — even a comment — changes Flyway's stored checksum for that version, so
// the prod boot-time `flyway validate` found the recorded checksum no longer matched the file on
// disk and refused to start (the deploy failed; it was recovered by a one-off `flyway repair`,
// recorded in TM-649). An APPLIED migration must NEVER change: a correction goes in a NEW forward
// migration (V<n+1>__...). This guard turns that rule into a build failure so it can't recur.
//
// Two layers, cleanly separated so the decision logic is unit-testable without a git checkout:
//   • `findMigrationViolations(diff)` — PURE. Given `git diff --name-status` output (a string or an
//     array of lines), returns the offending existing-migration files. No git, no fs, no I/O.
//   • the CLI (bottom) — runs the real `git diff origin/main...HEAD` in CI and feeds it to the pure
//     function. Guarded by the `import.meta.url` check so importing this module (from the test)
//     never shells out to git.
//
// Framework-free — Node built-ins only. Run from the repo root on a PR branch:
//   node web/tools/check-migration-immutability.mjs

import { spawnSync } from "node:child_process";

// The Flyway migration location (files `V<n>__*.sql`). Single source of truth for both the pure
// function's dir filter and the CLI's `git diff -- <path>` pathspec.
export const MIGRATION_DIR = "backend/src/main/resources/db/migration";

// A VERSIONED Flyway migration filename: default `V` prefix, an integer/dotted version, the `__`
// separator, a description, and the `.sql` suffix — e.g. `V13__event_attendance.sql`, `V1_2__x.sql`.
// Repeatable (`R__…`) and undo (`U__…`) migrations are deliberately NOT matched: repeatable
// migrations are RE-APPLIED whenever their checksum changes, so editing them is legitimate — only
// versioned migrations are immutable once applied. Non-SQL files that happen to live in the dir
// (a README, a .gitkeep) are likewise ignored — they carry no Flyway checksum.
const VERSIONED_FILE = /^V\d+(?:[._]\d+)*__.+\.sql$/;

/** True iff `path` is a versioned migration file directly identifiable under the migration dir. */
export function isVersionedMigration(path, migrationDir = MIGRATION_DIR) {
  if (!path) return false;
  const dir = `${migrationDir.replace(/\/+$/, "")}/`;
  if (!path.startsWith(dir)) return false;
  const rest = path.slice(dir.length);
  const base = rest.includes("/") ? rest.slice(rest.lastIndexOf("/") + 1) : rest;
  return VERSIONED_FILE.test(base);
}

/** Parse ONE `git diff --name-status` line into `{ status, code, path? , oldPath?, newPath? }`.
 *  Returns null for a blank line. Fields are TAB-separated. A rename/copy line has THREE fields
 *  (`R100\told\tnew`); every other status has TWO (`M\tpath`). */
export function parseDiffEntry(line) {
  const trimmed = (line ?? "").replace(/\r$/, "");
  if (!trimmed.trim()) return null;
  const fields = trimmed.split("\t");
  const status = fields[0].trim();
  const code = status[0];
  if (code === "R" || code === "C") {
    return { status, code, oldPath: fields[1], newPath: fields[2] };
  }
  return { status, code, path: fields[1] };
}

/**
 * PURE decision function. Given `git diff --name-status` output (a multi-line string OR an array of
 * lines), return the list of violations — existing migration files that were destructively changed.
 * Each violation is `{ status, path }` where `path` is the PRE-EXISTING migration that must not have
 * changed (for a rename, that's the source/old path).
 *
 * Allowed (never a violation): ADDING a new migration (`A`), or copying to a new file (`C`) — in
 * both cases no already-applied migration's bytes change. Everything else that touches an existing
 * versioned migration is a violation:
 *   • `M` modify   — the body (even a comment) changed → checksum drift.
 *   • `D` delete   — the recorded migration vanished → `validate` fails.
 *   • `R` rename   — the recorded file/name is gone (Flyway keys history on the versioned filename).
 *   • `T` typechange / `U` unmerged / anything else touching an existing migration.
 * A rename detected as a delete+add pair (when git rename-detection is off) is still caught via its
 * `D` half, so the guard is robust regardless of the diff's rename-detection setting.
 */
export function findMigrationViolations(diff, migrationDir = MIGRATION_DIR) {
  const lines = Array.isArray(diff) ? diff : String(diff).split("\n");
  const violations = [];
  for (const line of lines) {
    const entry = parseDiffEntry(line);
    if (!entry) continue;
    // A new file (add) or a copy-to-new-file leaves every existing migration untouched — allowed.
    if (entry.code === "A" || entry.code === "C") continue;
    // A rename: the SOURCE (old path) is the pre-existing file that's being moved/renamed away.
    if (entry.code === "R") {
      if (isVersionedMigration(entry.oldPath, migrationDir)) {
        violations.push({ status: entry.status, path: entry.oldPath });
      }
      continue;
    }
    // M / D / T / U / … — a single pre-existing path was modified, deleted, or otherwise changed.
    if (isVersionedMigration(entry.path, migrationDir)) {
      violations.push({ status: entry.status, path: entry.path });
    }
  }
  return violations;
}

// Human-readable verb for a status code, used only in the CLI failure report.
const ACTION = { M: "modified", D: "deleted", R: "renamed", C: "copied", T: "type-changed", U: "left unmerged" };

// --- CLI ----------------------------------------------------------------------------------------
// Runs the real diff against the base branch and exits non-zero on any violation. Fails CLOSED: if
// the diff can't be computed we block the PR rather than risk letting a migration edit slip through.
function runCli() {
  // Base branch to diff against. Defaults to `main`; overridable (the CI job could pass the PR's
  // real base via BASE_REF), matching the `changes` job's `github.base_ref` handling in ci.yml.
  const base = process.env.BASE_REF || "main";

  // Best-effort fetch so `origin/<base>` exists even on a shallow checkout (the CI job uses
  // fetch-depth: 0, so this is usually a no-op; harmless if it fails offline).
  spawnSync("git", ["fetch", "--no-tags", "origin", base], { stdio: "ignore" });

  // Three-dot range: diff HEAD against the MERGE BASE with origin/<base>, i.e. exactly what THIS
  // branch changed — not unrelated commits that landed on main since it was cut.
  const range = `origin/${base}...HEAD`;
  const res = spawnSync("git", ["diff", "--name-status", range, "--", MIGRATION_DIR], { encoding: "utf8" });
  if (res.status !== 0) {
    console.error(`✖ Migration immutability guard: could not compute the diff against ${range}.`);
    console.error((res.stderr || res.stdout || "").trim());
    process.exit(1); // fail closed — an unverifiable guard must not silently pass.
  }

  const violations = findMigrationViolations(res.stdout);
  if (violations.length === 0) {
    console.log(`✓ Migration immutability guard: no already-applied migration under ${MIGRATION_DIR}/ was edited.`);
    return;
  }

  console.error(`\n✖ Migration immutability guard: ${violations.length} already-applied migration file(s) changed:\n`);
  for (const v of violations) {
    console.error(`  • ${v.path}  (${ACTION[v.status[0]] || "changed"})`);
  }
  console.error(
    `\nAn applied migration must not be edited — add a NEW forward migration instead (V<n+1>__...). See TM-648.`,
  );
  process.exit(1);
}

// Only run the CLI when executed directly (`node …/check-migration-immutability.mjs`), NOT when
// imported by the test — otherwise `import` would shell out to git. Mirrors fingerprint.mjs.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runCli();
}
