// Tests for the Flyway migration immutability guard (TM-648). Framework-free — Node's built-in test
// runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// These exercise the PURE decision function `findMigrationViolations`, which takes
// `git diff --name-status` output. The tests double as the fail-before/pass-after evidence: before
// this change the function did not exist; here we prove a simulated "edit V13" diff is REJECTED and
// a "add V42" diff is ACCEPTED.

import assert from "node:assert/strict";
import { test } from "node:test";

import { findMigrationViolations, isVersionedMigration, MIGRATION_DIR } from "./check-migration-immutability.mjs";

const DIR = MIGRATION_DIR; // "backend/src/main/resources/db/migration"

test("MODIFYING an already-applied V13__*.sql is a violation (the TM-525 regression)", () => {
  const diff = `M\t${DIR}/V13__event_attendance_offer_bookkeeping.sql`;
  const violations = findMigrationViolations(diff);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].status, "M");
  assert.equal(violations[0].path, `${DIR}/V13__event_attendance_offer_bookkeeping.sql`);
});

test("ADDING a new V42__*.sql is allowed — the whole point of forward-only migrations", () => {
  const diff = `A\t${DIR}/V42__add_new_column.sql`;
  assert.deepEqual(findMigrationViolations(diff), []);
});

test("DELETING an existing migration is a violation", () => {
  const diff = `D\t${DIR}/V14__create_event_reminder_sends.sql`;
  const violations = findMigrationViolations(diff);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].status, "D");
  assert.equal(violations[0].path, `${DIR}/V14__create_event_reminder_sends.sql`);
});

test("RENAMING an existing migration is a violation (flags the source path)", () => {
  // Rename lines are `R<score>\t<old>\t<new>` — the OLD path is the applied file being moved away.
  const diff = `R100\t${DIR}/V18__events_age_band.sql\t${DIR}/V18__events_age_group.sql`;
  const violations = findMigrationViolations(diff);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].status, "R100");
  assert.equal(violations[0].path, `${DIR}/V18__events_age_band.sql`);
});

test("non-migration file edits are ignored", () => {
  const diff = [
    "M\tbackend/src/main/java/com/teammarhaba/App.java",
    "M\tweb/src/assets/api.js",
    "A\tdocs/adr/0001.md",
    `A\t${DIR}/V43__forward_fix.sql`, // a NEW migration alongside code changes — still fine
  ].join("\n");
  assert.deepEqual(findMigrationViolations(diff), []);
});

test("a mixed diff flags ONLY the edited existing migration, not the added one", () => {
  const diff = [
    `A\t${DIR}/V42__add_column.sql`, // allowed
    `M\t${DIR}/V13__event_attendance_offer_bookkeeping.sql`, // violation
    "M\tbackend/pom.xml", // ignored
  ].join("\n");
  const violations = findMigrationViolations(diff);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].path, `${DIR}/V13__event_attendance_offer_bookkeeping.sql`);
});

test("renaming a NON-migration file INTO the migration dir is allowed (adds a forward migration)", () => {
  // Source is not an existing migration; the new versioned name is effectively a new migration.
  const diff = `R090\tscratch/draft.sql\t${DIR}/V44__from_draft.sql`;
  assert.deepEqual(findMigrationViolations(diff), []);
});

test("a repeatable migration (R__*.sql) is NOT treated as immutable", () => {
  // Repeatable migrations are re-applied when their checksum changes, so editing one is legitimate.
  const diff = `M\t${DIR}/R__refresh_views.sql`;
  assert.deepEqual(findMigrationViolations(diff), []);
});

test("a non-SQL file in the migration dir (e.g. README) is ignored", () => {
  const diff = `M\t${DIR}/README.md`;
  assert.deepEqual(findMigrationViolations(diff), []);
});

test("accepts either a string or an array of diff lines", () => {
  const asArray = findMigrationViolations([`M\t${DIR}/V13__x.sql`, "A\tother.txt"]);
  const asString = findMigrationViolations(`M\t${DIR}/V13__x.sql\nA\tother.txt`);
  assert.deepEqual(asArray, asString);
  assert.equal(asArray.length, 1);
});

test("empty diff (no migration changes) yields no violations", () => {
  assert.deepEqual(findMigrationViolations(""), []);
  assert.deepEqual(findMigrationViolations("\n\n"), []);
});

test("isVersionedMigration recognises V-files and rejects everything else", () => {
  assert.equal(isVersionedMigration(`${DIR}/V13__x.sql`), true);
  assert.equal(isVersionedMigration(`${DIR}/V1_2__x.sql`), true); // dotted/underscored version
  assert.equal(isVersionedMigration(`${DIR}/R__x.sql`), false); // repeatable
  assert.equal(isVersionedMigration(`${DIR}/notes.txt`), false);
  assert.equal(isVersionedMigration("backend/src/main/java/App.java"), false);
});
