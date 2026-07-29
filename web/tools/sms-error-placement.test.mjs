// Source-level guard for the SMS-path error PLACEMENT contract (TM-1149). Framework-free — Node's
// built-in test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// Why source-level (same reasoning as otp-input-markup.test.mjs): login.js can't be imported under
// Node — its api/auth import chain pulls `https:` Firebase modules the default ESM loader can't
// resolve — and the e2e harness runs on main only, AFTER merge. So the PR gate pins the contract
// textually.
//
// The bug being guarded (reported on iPhone Safari): the invalid-phone error rendered UP in the
// shared #auth-error banner in the EMAIL section, while the phone field that caused it is DOWN in
// the SMS section. The fix adds an inline #sms-error element INSIDE the SMS fieldset and routes the
// SMS send/verify path there — leaving the email-code/password paths on the shared banner. The pure
// copy behaviour (Bug 1) is covered by login-error.test.mjs; this file guards the placement (Bug 2).

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(HERE, "../src/index.html"), "utf8");
const LOGIN = readFileSync(join(HERE, "../src/assets/login.js"), "utf8");

test("#sms-error exists and lives INSIDE the SMS fieldset, next to the phone field (TM-1149)", () => {
  // The element exists and is a role=alert paragraph reusing the shared .auth-error styling.
  assert.match(
    HTML,
    /<p id="sms-error"[^>]*class="[^"]*\bauth-error\b[^"]*"[^>]*role="alert"[^>]*>/,
    "#sms-error is a role=alert .auth-error paragraph",
  );

  // It must sit in the SMS region — AFTER the SMS phone-step markup and BEFORE the SMS code step —
  // NOT in the email section. Anchor on stable landmarks either side.
  const phoneStepIdx = HTML.indexOf('id="sms-step-phone"');
  const smsErrorIdx = HTML.indexOf('id="sms-error"');
  const smsCodeStepIdx = HTML.indexOf('id="sms-step-code"');
  const recaptchaIdx = HTML.indexOf('id="recaptcha-container"');
  assert.ok(phoneStepIdx > 0 && smsErrorIdx > 0 && smsCodeStepIdx > 0 && recaptchaIdx > 0, "landmarks present");
  assert.ok(
    phoneStepIdx < smsErrorIdx && smsErrorIdx < smsCodeStepIdx,
    "#sms-error is between the SMS phone step and the SMS code step (adjacent to the phone field)",
  );
  assert.ok(
    smsErrorIdx < recaptchaIdx,
    "#sms-error is still within the SMS fieldset (before its recaptcha container)",
  );

  // And it must NOT be up in the email section: the shared #auth-error banner comes well before the
  // "Try another way" disclosure that opens the SMS section, so #sms-error must come AFTER it.
  const sharedBannerIdx = HTML.indexOf('id="auth-error"');
  const tryAnotherIdx = HTML.indexOf('id="try-another-btn"');
  assert.ok(
    sharedBannerIdx < tryAnotherIdx && tryAnotherIdx < smsErrorIdx,
    "#sms-error is inside the SMS disclosure, not up in the shared email-area banner",
  );
});

test("login.js maps els.smsError to #sms-error (TM-1149)", () => {
  assert.match(LOGIN, /smsError:\s*\$\("sms-error"\)/, "els.smsError references #sms-error");
});

test("login.js routes the SMS send/verify path to els.smsError, others to the shared banner (TM-1149)", () => {
  // The catch in run() must send SMS-path errors to the inline SMS surface, with the phone context.
  assert.match(
    LOGIN,
    /action === sendSms \|\| action === verifySms/,
    "run() distinguishes the SMS send/verify path",
  );
  assert.match(
    LOGIN,
    /writeError\(els\.smsError, err, phoneContext\(\)\)/,
    "SMS-path errors render in #sms-error with the country-code context",
  );
  // The country-code context comes from the phone field, so the invalid-phone copy is field-aware.
  assert.match(
    LOGIN,
    /function phoneContext\(\)\s*\{[\s\S]*hasCountryCode\(els\.phone\?\.value\)/,
    "phoneContext() reads whether the entered phone carries a country code",
  );
});
