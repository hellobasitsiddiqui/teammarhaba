// Unit tests for the build/version stamp core (TM-610) + the admin role-badge label (TM-612),
// backfilled under TM-847.
//
// The TM-824 closure review of "TM Easy Wins 1" found both fixes CORRECT but shipped WITHOUT
// regression tests. This file backfills exactly those two:
//   • TM-610 — shortSha / trimRevision / the collapse-vs-split decision from build-info.js, extracted
//     into build-info-core.js so they're importable here (they were untested private closures in the
//     build-info.js IIFE).
//   • TM-612 — the roleBadge "ADMIN → Admin" / "USER → User" mapping, extracted into admin-role-core.js
//     as roleLabel (roleBadge itself can't be imported under `node --test` — it pulls the Firebase CDN
//     via ui.js/api.js).
//
// Framework-free — Node's built-in test runner, picked up by the CI glob
// `node --test web/tools/*.test.mjs` (ci.yml web-build job). No DOM/Firebase, so it runs in plain Node
// exactly like footer-core.test.mjs / tabbar-core.test.mjs.

import assert from "node:assert/strict";
import { test } from "node:test";

import { shortSha, trimRevision, buildStampParts } from "../src/assets/build-info-core.js";
import { roleLabel } from "../src/assets/admin-role-core.js";

// --- TM-610: shortSha -------------------------------------------------------------------------------

test("shortSha truncates a full 40-char hex git SHA to its 7-char short form (TM-610)", () => {
  // A real 40-char git SHA → the first 7 chars (what `git rev-parse --short HEAD` produces).
  assert.equal(shortSha("08c87f9a1b2c3d4e5f60718293a4b5c6d7e8f901"), "08c87f9");
  // Case-insensitive: an upper-case SHA still matches the 40-hex pattern and truncates.
  assert.equal(shortSha("ABCDEF0123456789ABCDEF0123456789ABCDEF01"), "ABCDEF0");
});

test("shortSha leaves already-short / non-SHA identifiers untouched (TM-610)", () => {
  // An already-short SHA (e.g. the value config.js is stamped with at deploy) passes through unchanged.
  assert.equal(shortSha("08c87f9"), "08c87f9");
  // The local fallback "dev" is not a SHA → untouched.
  assert.equal(shortSha("dev"), "dev");
  // A legacy `git describe` string from an older backend is not a 40-hex SHA → untouched.
  assert.equal(shortSha("v1.4.2-13-g08c87f9"), "v1.4.2-13-g08c87f9");
  // A 39-char (too short) and a 41-char (too long) hex string are NOT full SHAs → untouched, not sliced.
  assert.equal(shortSha("08c87f9a1b2c3d4e5f60718293a4b5c6d7e8f90"), "08c87f9a1b2c3d4e5f60718293a4b5c6d7e8f90");
  assert.equal(
    shortSha("08c87f9a1b2c3d4e5f60718293a4b5c6d7e8f9012"),
    "08c87f9a1b2c3d4e5f60718293a4b5c6d7e8f9012",
  );
});

test("shortSha returns '' for a missing/empty id (TM-610)", () => {
  assert.equal(shortSha(""), "");
  assert.equal(shortSha(undefined), "");
  assert.equal(shortSha(null), "");
});

// --- TM-610: trimRevision ---------------------------------------------------------------------------

test("trimRevision reduces a Cloud Run revision name to a compact r<number> (TM-610)", () => {
  // The canonical `<service>-<NNNNN>-<suffix>` shape → just the revision number.
  assert.equal(trimRevision("teammarhaba-backend-00184-rik"), "r00184");
  // Leading zeros in the revision number are preserved (r00219, not r219).
  assert.equal(trimRevision("teammarhaba-backend-00219-abc"), "r00219");
  // A revision with no random suffix (just `<service>-<NNNNN>`) still trims to the number.
  assert.equal(trimRevision("teammarhaba-backend-00007"), "r00007");
});

test("trimRevision hides 'local' / missing / non-matching revisions (TM-610)", () => {
  // Running off Cloud Run → "local" → hidden (empty), not shown raw.
  assert.equal(trimRevision("local"), "");
  // Missing / empty → hidden.
  assert.equal(trimRevision(""), "");
  assert.equal(trimRevision(undefined), "");
  assert.equal(trimRevision(null), "");
  // Anything that doesn't end in `-<digits>` (optionally `-<suffix>`) → hidden rather than shown raw.
  assert.equal(trimRevision("not-a-revision-name"), "");
});

// --- TM-610: the collapse-vs-split decision ---------------------------------------------------------

test("buildStampParts COLLAPSES when web and backend are the same commit (TM-610)", () => {
  // The normal case: both surfaces deployed from the same commit → one value, collapsed=true.
  const parts = buildStampParts({
    webVersion: "08c87f9a1b2c3d4e5f60718293a4b5c6d7e8f901",
    apiSha: "08c87f9a1b2c3d4e5f60718293a4b5c6d7e8f901",
    revision: "teammarhaba-backend-00219-abc",
  });
  assert.equal(parts.web, "08c87f9");
  assert.equal(parts.api, "08c87f9");
  assert.equal(parts.collapsed, true);
  assert.equal(parts.revSuffix, " · r00219");
});

test("buildStampParts SPLITS when the web and backend SHAs have drifted (TM-610)", () => {
  // The two surfaces drifted apart (a stale deploy) → NOT collapsed, so build-info.js labels each.
  const parts = buildStampParts({
    webVersion: "08c87f9a1b2c3d4e5f60718293a4b5c6d7e8f901",
    apiSha: "a1b2c3d4e5f60718293a4b5c6d7e8f9010203040",
    revision: "teammarhaba-backend-00219-abc",
  });
  assert.equal(parts.web, "08c87f9");
  assert.equal(parts.api, "a1b2c3d");
  assert.equal(parts.collapsed, false);
  assert.equal(parts.revSuffix, " · r00219");
});

test("buildStampParts does NOT collapse when the backend hasn't answered (no api SHA) (TM-610)", () => {
  // Backend unreachable / no usable SHA → api is "" and collapsed is false (nothing to compare against),
  // so build-info.js keeps the web-only stamp rather than falsely collapsing.
  const parts = buildStampParts({ webVersion: "08c87f9", apiSha: "", revision: "local" });
  assert.equal(parts.web, "08c87f9");
  assert.equal(parts.api, "");
  assert.equal(parts.collapsed, false);
  assert.equal(parts.revSuffix, ""); // "local" → no revision suffix
});

// --- TM-612: the admin roleBadge label --------------------------------------------------------------

test("roleBadge maps ADMIN → 'Admin' and USER → 'User' (TM-612)", () => {
  // The core the admin console's roleBadge() uses for its label (extracted so it's testable). The badge
  // shows a friendly label, not the raw enum token.
  assert.equal(roleLabel("ADMIN"), "Admin");
  assert.equal(roleLabel("USER"), "User");
});

test("roleBadge label is 'Admin' ONLY for the exact ADMIN token; everything else is 'User' (TM-612)", () => {
  // Only the exact "ADMIN" token yields "Admin" — a non-admin role, an unknown/future role, or a
  // lower-case value all fall to the safe "User" default (never accidentally shows "Admin").
  assert.equal(roleLabel("MODERATOR"), "User");
  assert.equal(roleLabel("admin"), "User"); // case-sensitive: only the upper-case enum is Admin
  assert.equal(roleLabel(""), "User");
});
