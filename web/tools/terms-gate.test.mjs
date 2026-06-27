// Tests for the terms/privacy acceptance gate decision core (TM-170). Framework-free — Node's
// built-in test runner, same harness as splash-env.test.mjs / biometric-policy.test.mjs and picked
// up by the CI glob `node --test web/tools/*.test.mjs`.
//
// Guards the single contract terms-gate.js owns: WHO has to (re-)accept the terms. The rule is a
// version comparison against the server's currentTermsVersion (from GET /api/v1/me), with a
// deliberate fail-open when there's no current version to compare against.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  acceptedTermsVersion,
  currentTermsVersion,
  needsTermsAcceptance,
} from "../src/assets/terms-gate.js";

test("never-accepted user with a current version IS gated", () => {
  const me = { currentTermsVersion: "2026-06-01", termsAcceptedVersion: null };
  assert.equal(needsTermsAcceptance(me), true);
});

test("accepted the current version is NOT gated", () => {
  const me = { currentTermsVersion: "2026-06-01", termsAcceptedVersion: "2026-06-01" };
  assert.equal(needsTermsAcceptance(me), false);
});

test("accepted an OLDER version (a bump) IS gated again", () => {
  const me = { currentTermsVersion: "2026-06-01", termsAcceptedVersion: "2026-01-01" };
  assert.equal(needsTermsAcceptance(me), true);
});

test("absent termsAcceptedVersion key (fresh provision) IS gated", () => {
  const me = { currentTermsVersion: "2026-06-01" }; // key not present at all
  assert.equal(needsTermsAcceptance(me), true);
});

test("fails OPEN (not gated) when currentTermsVersion is missing", () => {
  assert.equal(needsTermsAcceptance({ termsAcceptedVersion: null }), false);
  assert.equal(needsTermsAcceptance({ currentTermsVersion: "", termsAcceptedVersion: null }), false);
});

test("fails OPEN on null/undefined profile (degraded /me)", () => {
  assert.equal(needsTermsAcceptance(null), false);
  assert.equal(needsTermsAcceptance(undefined), false);
});

test("whitespace around versions is ignored (trimmed compare)", () => {
  const me = { currentTermsVersion: " 2026-06-01 ", termsAcceptedVersion: "2026-06-01" };
  assert.equal(needsTermsAcceptance(me), false);
});

test("accessors normalise to trimmed strings, '' for absent", () => {
  assert.equal(currentTermsVersion({ currentTermsVersion: " v2 " }), "v2");
  assert.equal(currentTermsVersion({}), "");
  assert.equal(currentTermsVersion(null), "");
  assert.equal(acceptedTermsVersion({ termsAcceptedVersion: "v1" }), "v1");
  assert.equal(acceptedTermsVersion({ termsAcceptedVersion: null }), "");
  assert.equal(acceptedTermsVersion(null), "");
});
