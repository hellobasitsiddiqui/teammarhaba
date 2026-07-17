// Regression tests for the admin role-label mapping (TM-612, TM-847). Framework-free — Node's built-in
// test runner, picked up by the CI glob `node --test web/tools/*.test.mjs` (ci.yml web-build job).
//
// WHY THIS EXISTS: the TM Easy Wins 1 closure review (TM-847) flagged that admin.js's roleBadge()
// mapped the raw role enum to a friendly label ("ADMIN" → "Admin") with ZERO coverage. A silent break
// there would surface a raw enum token in the admin console — the exact papercut TM-612 fixed. These
// pin the CURRENT mapping so any change is a real fail-before/pass-after guard.

import assert from "node:assert/strict";
import { test } from "node:test";

import { roleLabel } from "../src/assets/admin-role-label-core.js";

test("roleLabel maps the known role tokens to friendly labels (TM-612)", () => {
  assert.equal(roleLabel("ADMIN"), "Admin");
  assert.equal(roleLabel("USER"), "User");
});

test("roleLabel falls back to 'User' for an unknown or blank token", () => {
  // The current mapping is "ADMIN" → "Admin", everything else → "User". This mirrors the backend's
  // fail-safe-to-USER role resolution (auth.RoleClaims): an unrecognised or absent role is treated as a
  // plain user, never silently shown as an admin.
  assert.equal(roleLabel("MODERATOR"), "User");
  assert.equal(roleLabel("admin"), "User"); // case-sensitive: only exact "ADMIN" is Admin
  assert.equal(roleLabel(""), "User");
  assert.equal(roleLabel(undefined), "User");
  assert.equal(roleLabel(null), "User");
});
