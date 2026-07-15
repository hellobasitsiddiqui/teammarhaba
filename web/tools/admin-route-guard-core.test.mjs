// Unit tests for the router's admin-route guard decision (TM-733) — the pure rule that decides whether
// a caller on an admin route should be bounced to Home with the "Admins only." toast. The bug: a
// deep-link / reload straight to #/admin ran the guard BEFORE the background role lookup resolved, so a
// real admin was always bounced with a spurious toast. The fix holds the bounce until the role is known.
//
// Framework-free — Node's built-in test runner, picked up by `node --test web/tools/*.test.mjs`.

import assert from "node:assert/strict";
import { test } from "node:test";

import { shouldBounceNonAdmin } from "../src/assets/admin-route-guard-core.js";

test("bounces only a resolved non-admin", () => {
  assert.equal(shouldBounceNonAdmin({ isAdmin: false, roleResolved: true }), true);
});

test("holds (does NOT bounce) while the role is still unresolved — the deep-link/reload race (TM-733)", () => {
  // The exact defect: real admin deep-links #/admin, role not yet resolved so isAdmin is the fail-safe
  // false. The old code bounced+toasted here; now we hold until the follow-up re-guard.
  assert.equal(shouldBounceNonAdmin({ isAdmin: false, roleResolved: false }), false);
  // And an unresolved would-be admin is likewise held, never bounced.
  assert.equal(shouldBounceNonAdmin({ isAdmin: true, roleResolved: false }), false);
});

test("never bounces a resolved admin", () => {
  assert.equal(shouldBounceNonAdmin({ isAdmin: true, roleResolved: true }), false);
});

test("defaults are fail-safe: unknown state holds rather than bounces", () => {
  assert.equal(shouldBounceNonAdmin(), false);
  assert.equal(shouldBounceNonAdmin({}), false);
});
