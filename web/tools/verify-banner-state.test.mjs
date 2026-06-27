// Tests for the email-verification banner's pure state core (TM-169). Framework-free — Node's
// built-in test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// verify-banner-state.js has zero DOM/Firebase/fetch deps, so we can assert the whole behaviour here:
// when the banner shows (driven off accountState.emailVerified), and how a resend attempt's HTTP
// outcome maps to the friendly states / messages / button-disabled flag.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  shouldShowBanner,
  resendOutcome,
  resendMessage,
  isResendDisabled,
  ResendState,
} from "../src/assets/verify-banner-state.js";

test("shouldShowBanner: only when we positively know the email is unverified", () => {
  assert.equal(shouldShowBanner({ accountState: { emailVerified: false } }), true, "unverified → show");
  assert.equal(shouldShowBanner({ accountState: { emailVerified: true } }), false, "verified → hide");
});

test("shouldShowBanner: signed out / unknown state never nags", () => {
  assert.equal(shouldShowBanner(null), false, "signed out (null me) → hide");
  assert.equal(shouldShowBanner(undefined), false, "undefined me → hide");
  assert.equal(shouldShowBanner({}), false, "no accountState → hide");
  assert.equal(shouldShowBanner({ accountState: {} }), false, "emailVerified undefined → hide");
  assert.equal(
    shouldShowBanner({ accountState: { emailVerified: null } }),
    false,
    "emailVerified null (credential-free dev) → hide",
  );
});

test("resendOutcome: success maps to SENT", () => {
  assert.equal(resendOutcome(null), ResendState.SENT);
  assert.equal(resendOutcome(undefined), ResendState.SENT);
});

test("resendOutcome: 422 → already verified, 429 → rate limited, else → failed", () => {
  assert.equal(resendOutcome({ status: 422 }), ResendState.ALREADY_VERIFIED);
  assert.equal(resendOutcome({ status: 429 }), ResendState.RATE_LIMITED);
  assert.equal(resendOutcome({ status: 502 }), ResendState.FAILED, "upstream Firebase failure → failed");
  assert.equal(resendOutcome({ status: 500 }), ResendState.FAILED);
  assert.equal(resendOutcome({}), ResendState.FAILED, "network error (no status) → failed");
});

test("resendMessage: each state has friendly, distinct copy", () => {
  const idle = resendMessage(ResendState.IDLE);
  const sending = resendMessage(ResendState.SENDING);
  const sent = resendMessage(ResendState.SENT);
  const rate = resendMessage(ResendState.RATE_LIMITED);
  const verified = resendMessage(ResendState.ALREADY_VERIFIED);
  const failed = resendMessage(ResendState.FAILED);

  const all = [idle, sending, sent, rate, verified, failed];
  assert.equal(new Set(all).size, all.length, "every state's message is distinct");
  for (const m of all) assert.ok(m.length > 0, "no empty message");

  assert.match(sent, /sent/i);
  assert.match(rate, /wait/i);
  assert.match(failed, /try again/i);
});

test("resendMessage: weaves the email into idle/sent copy when known, omits it cleanly otherwise", () => {
  assert.match(resendMessage(ResendState.IDLE, "a@b.com"), /a@b\.com/);
  assert.match(resendMessage(ResendState.SENT, "a@b.com"), /a@b\.com/);
  // No email → no dangling "to " fragment.
  assert.doesNotMatch(resendMessage(ResendState.IDLE, null), /\bto\s*$/);
  assert.doesNotMatch(resendMessage(ResendState.SENT), /\bto\b\s*\./);
});

test("isResendDisabled: disabled mid-flight and once already verified; clickable otherwise", () => {
  assert.equal(isResendDisabled(ResendState.SENDING), true);
  assert.equal(isResendDisabled(ResendState.ALREADY_VERIFIED), true);
  assert.equal(isResendDisabled(ResendState.IDLE), false);
  assert.equal(isResendDisabled(ResendState.SENT), false);
  assert.equal(isResendDisabled(ResendState.RATE_LIMITED), false, "user can retry after the cooldown");
  assert.equal(isResendDisabled(ResendState.FAILED), false, "user can retry after a failure");
});
