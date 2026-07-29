// Tests for the login screen's friendly auth-error mapping (TM-614). Framework-free — Node's
// built-in test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// login-error.js has zero DOM/Firebase/fetch deps, so we can assert the whole behaviour here:
// mapped Firebase codes become friendly text, unmapped codes fall back to a generic message
// (never the raw, Firebase-branded string — the TM-614 papercut), and a codeless ApiError keeps
// its own human message.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  authErrorMessage,
  MESSAGES,
  GENERIC_ERROR,
  hasCountryCode,
  INVALID_PHONE_WITH_COUNTRY_CODE,
  INVALID_PHONE_WITHOUT_COUNTRY_CODE,
  isTooManyDigits,
  smsSendPreflightError,
  E164_MAX_DIGITS,
  TOO_MANY_DIGITS_MESSAGE,
} from "../src/assets/login-error.js";

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

// TM-1149 — Bug 1: the invalid-phone copy must not tell a user to add a country code they already
// supplied. Reported case: on the SMS sign-in step the user entered "+44747009007" (a valid +44
// prefix but a digit short), Firebase threw `auth/invalid-phone-number`, and the FIXED copy said
// "include the country code (e.g. +1…)" — which is wrong twice over: the +44 country code WAS there,
// and the example region was US on a UK-first app. Assert the copy is now context-aware.
test("invalid-phone copy does NOT tell a user to add a country code they already supplied (TM-1149)", () => {
  const err = { code: "auth/invalid-phone-number", message: "Firebase: Error (auth/invalid-phone-number)." };

  // The exact reported input: a country code IS present (starts with "+44"), so the message must
  // point at the DIGITS and must NOT ask the user to include a country code.
  const withCode = authErrorMessage(err, { hasCountryCode: true });
  assert.equal(withCode, INVALID_PHONE_WITH_COUNTRY_CODE);
  assert.doesNotMatch(
    withCode,
    /country code/i,
    "must not tell the user to add a country code that is already present",
  );
  assert.doesNotMatch(withCode, /Firebase/, "must not leak the raw Firebase string");

  // No country code present → prompting for one is correct here.
  const withoutCode = authErrorMessage(err, { hasCountryCode: false });
  assert.equal(withoutCode, INVALID_PHONE_WITHOUT_COUNTRY_CODE);
  assert.match(withoutCode, /country code/i, "when none is present, DO prompt for the country code");
});

test("the neutral (no-context) invalid-phone default is correct whether or not a code is present (TM-1149)", () => {
  // Callers that pass no context get the MESSAGES default. It must not falsely assert a missing
  // country code (the bug) — a neutral "check the number and country code" is correct either way —
  // and it must use a UK-first (+44…) example, not the odd US +1… on a UK-first app.
  const msg = authErrorMessage({ code: "auth/invalid-phone-number" });
  assert.equal(msg, MESSAGES["auth/invalid-phone-number"]);
  assert.doesNotMatch(
    msg,
    /include the country code/i,
    "the neutral default must not assert the country code is missing",
  );
  assert.doesNotMatch(msg, /\+1\b/, "should not use a US +1 example on a UK-first app");
  assert.match(msg, /\+44/, "uses a UK-first example");
});

test("hasCountryCode detects a leading + (trimmed), for the SMS-path error context (TM-1149)", () => {
  assert.equal(hasCountryCode("+44747009007"), true);
  assert.equal(hasCountryCode("  +447700900123 "), true, "leading/trailing whitespace is trimmed");
  assert.equal(hasCountryCode("07700900123"), false, "a national number with no + has no country code");
  assert.equal(hasCountryCode(""), false);
  assert.equal(hasCountryCode(null), false);
  assert.equal(hasCountryCode(undefined), false);
});

// TM-1149 (increment) — the free, precise E.164 "too many digits" (>15) too-long check on the SMS
// path. Only the universal 15-digit ceiling is enforced locally; per-country "too short" precision
// is deliberately deferred to TM-1155 (no length table in countries.js).
test("isTooManyDigits flags a number with more than 15 E.164 digits, counting digits only (TM-1149)", () => {
  assert.equal(E164_MAX_DIGITS, 15, "the E.164 ceiling is 15 digits");

  // 15 digits is the max — allowed; 16 is over. The leading "+" and any separators don't count.
  assert.equal(isTooManyDigits("+123456789012345"), false, "exactly 15 digits is allowed");
  assert.equal(isTooManyDigits("+1234567890123456"), true, "16 digits is too many");
  assert.equal(
    isTooManyDigits("+44 7700 900 123 4567 890"),
    true,
    "separators are ignored — 17 digits here is still too many",
  );

  // The reported-style short number and a normal UK number are NOT too long (this check only bites
  // the over-long case — Firebase still validates the rest).
  assert.equal(isTooManyDigits("+44747009007"), false, "a too-SHORT number is not caught by the too-long check");
  assert.equal(isTooManyDigits("+447700900123"), false, "a normal UK mobile is fine");

  // Blank / non-string is not "too long".
  assert.equal(isTooManyDigits(""), false);
  assert.equal(isTooManyDigits(null), false);
  assert.equal(isTooManyDigits(undefined), false);
});

test("smsSendPreflightError rejects a >15-digit number with the too-many-digits message, and passes others through (TM-1149)", () => {
  // Over-long → returns the Error the send handler throws (its .message is the precise copy).
  const err = smsSendPreflightError("+1234567890123456"); // 16 digits
  assert.ok(err instanceof Error, "an over-long number yields an Error to throw");
  assert.equal(err.message, TOO_MANY_DIGITS_MESSAGE);
  assert.equal(err.message, "That number has too many digits — please check it.");
  // Codeless, so authErrorMessage renders its .message verbatim (never a mapped/generic string).
  assert.equal(err.code, undefined, "the preflight error is codeless so its precise message is shown");
  assert.equal(authErrorMessage(err), TOO_MANY_DIGITS_MESSAGE, "renders the precise message verbatim");

  // A valid-length number → null → the handler proceeds to Firebase.
  assert.equal(smsSendPreflightError("+447700900123"), null, "a valid-length number proceeds (no preflight error)");
  assert.equal(smsSendPreflightError("+44747009007"), null, "a too-SHORT number is left for Firebase, not blocked here");
});

// Proves the CONTRACT the coordinator asked for: a >15-digit number produces the "too many digits"
// message AND does NOT reach the Firebase call. login.js can't be imported under Node (its api/auth
// chain pulls https: Firebase modules), so we drive the EXACT control flow sendSms() runs — resolve
// the preflight, throw on error BEFORE awaiting the (spied) Firebase call — over a spy that records
// whether it was reached. The source guard in sms-error-placement.test.mjs pins that login.js's
// sendSms really is this shape (preflight-throw before startPhoneSignIn).
test("an over-long SMS number is rejected locally and never reaches the Firebase call (TM-1149)", async () => {
  let firebaseCalled = false;
  const startPhoneSignInSpy = async () => {
    firebaseCalled = true;
    return { confirm: async () => {} };
  };

  // The exact preflight-then-send flow of login.js's sendSms(), factored to the pure seam.
  async function sendSmsFlow(phone) {
    const preflightError = smsSendPreflightError(phone);
    if (preflightError) throw preflightError;
    return startPhoneSignInSpy(phone);
  }

  await assert.rejects(
    () => sendSmsFlow("+1234567890123456"), // 16 digits — too many
    (e) => e.message === TOO_MANY_DIGITS_MESSAGE,
    "over-long number throws the precise too-many-digits message",
  );
  assert.equal(firebaseCalled, false, "Firebase signInWithPhoneNumber is NOT reached for an over-long number");

  // Control: a valid-length number DOES proceed to the Firebase call.
  firebaseCalled = false;
  await sendSmsFlow("+447700900123");
  assert.equal(firebaseCalled, true, "a valid-length number proceeds to the Firebase call");
});
