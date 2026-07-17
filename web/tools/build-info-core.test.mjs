// Regression tests for the build/version-stamp pure core (TM-847). Framework-free — Node's built-in
// test runner, picked up by the CI glob `node --test web/tools/*.test.mjs` (ci.yml web-build job).
//
// WHY THIS EXISTS: the TM Easy Wins 1 closure review (TM-847) flagged that build-info.js's shortSha()
// and trimRevision() lived inside the IIFE with ZERO coverage. TM-610 introduced them (short-SHA both
// surfaces + compact Cloud Run revision), so a silent break there would misreport which build is live —
// exactly the confusion the stamp exists to prevent. These pin the CURRENT behaviour so any change is a
// real fail-before/pass-after guard.
//
// The collapse/split render branch (web === api → one collapsed stamp; differ → split) is the pure
// formatBuildStamp() in footer-core.js, which build-info.js imports and footer-core.test.mjs already
// covers; the collapse/split cases are re-pinned here too so the whole stamp contract is asserted in
// one place alongside the SHA/revision inputs that feed it.

import assert from "node:assert/strict";
import { test } from "node:test";

import { shortSha, trimRevision } from "../src/assets/build-info-core.js";
import { formatBuildStamp } from "../src/assets/footer-core.js";

test("shortSha: a 40-char hex SHA is truncated to its first 7 chars", () => {
  // A real full git SHA (40 hex) → first 7.
  assert.equal(shortSha("0123456789abcdef0123456789abcdef01234567"), "0123456");
  // Case-insensitive (git can emit upper-case), still exactly 40 hex → truncated.
  assert.equal(shortSha("ABCDEF0123456789ABCDEF0123456789ABCDEF01"), "ABCDEF0");
});

test("shortSha: anything not a 40-char SHA is passed through unchanged", () => {
  // An already-short SHA (7 chars) is left alone.
  assert.equal(shortSha("08c87f9"), "08c87f9");
  // The local "dev" placeholder passes through.
  assert.equal(shortSha("dev"), "dev");
  // A legacy `git describe` string from an old backend is not 40 hex → untouched.
  assert.equal(shortSha("v1.2-3-gabc"), "v1.2-3-gabc");
  // A 40-char string that ISN'T all hex (has a 'z') is NOT a SHA → passed through whole.
  assert.equal(shortSha("z123456789abcdef0123456789abcdef01234567"), "z123456789abcdef0123456789abcdef01234567");
  // Empty / absent → "" (build-info.js relies on this for the "dev"-less no-config case).
  assert.equal(shortSha(""), "");
  assert.equal(shortSha(undefined), "");
  assert.equal(shortSha(null), "");
});

test("trimRevision: a Cloud Run revision collapses to r<number>", () => {
  // <service>-<NNNNN>-<suffix> → keep just the padded revision number.
  assert.equal(trimRevision("teammarhaba-backend-00184-rik"), "r00184");
  // A revision with no random suffix still matches (the suffix group is optional).
  assert.equal(trimRevision("teammarhaba-backend-00219"), "r00219");
});

test("trimRevision: 'local' and non-matching values are hidden (empty string)", () => {
  // Off Cloud Run (local dev) → hidden, not shown raw.
  assert.equal(trimRevision("local"), "");
  // A value with no trailing -<digits> group doesn't match → hidden.
  assert.equal(trimRevision("weird"), "");
  // Absent → hidden.
  assert.equal(trimRevision(""), "");
  assert.equal(trimRevision(undefined), "");
  assert.equal(trimRevision(null), "");
});

test("collapse/split: web === api collapses to one stamp; differ splits (build-info render branch)", () => {
  // The exact inputs build-info.js feeds formatBuildStamp: shortSha(webVersion) + shortSha(api sha) +
  // the ` · <rev>` suffix from trimRevision. This pins the render branch the closure review flagged.
  const web = shortSha("0123456789abcdef0123456789abcdef01234567"); // "0123456"
  const rev = trimRevision("teammarhaba-backend-00184-rik"); // "r00184"
  const revSuffix = rev ? ` · ${rev}` : "";

  // web === api → COLLAPSE to a single `<sha> · <rev>` (both surfaces on the same commit).
  assert.equal(
    formatBuildStamp({ webSha: web, apiSha: web, revSuffix }),
    "0123456 · r00184",
  );

  // web !== api → SPLIT to a labelled `web <sha> · backend <sha> · <rev>` (surfaces drifted).
  const apiDrift = shortSha("fedcba9876543210fedcba9876543210fedcba98"); // "fedcba9"
  assert.equal(
    formatBuildStamp({ webSha: web, apiSha: apiDrift, revSuffix }),
    "web 0123456 · backend fedcba9 · r00184",
  );

  // Before the backend answers (web only, no apiSha) → the labelled web-only stamp.
  assert.equal(formatBuildStamp({ webSha: web }), "web 0123456");
});
