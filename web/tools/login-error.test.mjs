// Tests for the login screen's friendly auth-error mapping (TM-614). Framework-free — Node's
// built-in test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// login-error.js has zero DOM/Firebase/fetch deps, so we can assert the whole behaviour here:
// mapped Firebase codes become friendly text, unmapped codes fall back to a generic message
// (never the raw, Firebase-branded string — the TM-614 papercut), and a codeless ApiError keeps
// its own human message.

import assert from "node:assert/strict";
import { test } from "node:test";

import { authErrorMessage, MESSAGES, GENERIC_ERROR } from "../src/assets/login-error.js";

test("mapped Firebase codes resolve to their friendly message", () => {
  assert.equal(authErrorMessage({ code: "auth/wrong-password" }), MESSAGES["auth/wrong-password"]);
  assert.equal(authErrorMessage({ code: "auth/invalid-email" }), MESSAGES["auth/invalid-email"]);
});

test("newly-mapped common codes are covered (TM-614)", () => {
  assert.equal(
    authErrorMessage({ code: "auth/network-request-failed" }),
    "Network error — check your connection and try again.",
  );
  assert.ok(MESSAGES["auth/user-disabled"], "auth/user-disabled is mapped");
  assert.ok(MESSAGES["auth/missing-email"], "auth/missing-email is mapped");
});

test("an unmapped code falls back to the generic message, not the raw Firebase string", () => {
  const err = { code: "auth/some-brand-new-code", message: "Firebase: Error (auth/some-brand-new-code)." };
  const msg = authErrorMessage(err);
  assert.equal(msg, GENERIC_ERROR);
  assert.doesNotMatch(msg, /Firebase/, "must not leak the developer-facing Firebase string");
});

test("a codeless ApiError keeps its own human-friendly message", () => {
  assert.equal(
    authErrorMessage({ status: 403, message: "You need an admin role to view this page." }),
    "You need an admin role to view this page.",
  );
});

test("a coded error whose raw message would otherwise leak still uses the generic fallback", () => {
  // Even though a `.message` is present, a coded error must go through the map, not the raw string.
  const msg = authErrorMessage({ code: "auth/internal-error", message: "Firebase: Error (auth/internal-error)." });
  assert.equal(msg, GENERIC_ERROR);
});

test("falsy err clears the banner (empty string)", () => {
  assert.equal(authErrorMessage(null), "");
  assert.equal(authErrorMessage(undefined), "");
  assert.equal(authErrorMessage(""), "");
});

test("an error object with neither code nor message gets the generic fallback", () => {
  assert.equal(authErrorMessage({}), GENERIC_ERROR);
});

// TM-738 P2 (auth): the phone/SMS and email-code sign-in paths are the app's primary front doors, but
// their Firebase error codes weren't asserted here — only the password/email/network ones were. Pin
// that each of those codes resolves to a mapped, human-facing message (never the raw Firebase string
// and never the generic fallback), so a future edit to MESSAGES can't silently regress the phone/OTP
// error copy back to a developer-facing "Firebase: Error (auth/…)." leak on those flows.
test("SMS/phone and email-code path codes resolve to their friendly message (TM-738)", () => {
  const codeErrorPaths = [
    "auth/invalid-phone-number", // phone sign-in: a bad number
    "auth/invalid-verification-code", // phone/email OTP: a wrong code
    "auth/code-expired", // phone/email OTP: an expired code
  ];
  for (const code of codeErrorPaths) {
    const msg = authErrorMessage({ code, message: `Firebase: Error (${code}).` });
    // Uses the mapped copy verbatim...
    assert.equal(msg, MESSAGES[code], `${code} resolves to its mapped message`);
    // ...which is a real, non-generic, non-Firebase-leaking string.
    assert.notEqual(msg, GENERIC_ERROR, `${code} is mapped, not the generic fallback`);
    assert.doesNotMatch(msg, /Firebase/, `${code} must not leak the raw Firebase string`);
    assert.ok(msg.length > 0, `${code} has non-empty friendly copy`);
  }
});
