// Source-level guard for the six-box OTP markup + wiring contract (TM-867). Framework-free —
// Node's built-in test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// Why source-level (like events-aria-describedby.test.mjs): login.js/otp-input.js can't be imported
// in Node — the api/auth import chain pulls `https:` Firebase modules the default ESM loader can't
// resolve — and the e2e harness runs on main only, AFTER merge. So the PR gate pins the contract
// textually: the boxes exist, carry the right a11y/mobile attributes, keep the stable first-box ids
// the e2e specs + Maestro flows fill, and login.js actually attaches the widget + the single-flight
// guard. The pure behaviour itself is covered by otp-input-core.test.mjs.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(HERE, "../src/index.html"), "utf8");
const LOGIN = readFileSync(join(HERE, "../src/assets/login.js"), "utf8");

/** Extract the inner HTML of the group container with the given id (non-greedy to its close). */
function groupMarkup(id) {
  const m = HTML.match(new RegExp(`<div id="${id}"[^>]*>([\\s\\S]*?)</div>`));
  assert.ok(m, `#${id} group exists in index.html`);
  return { openTag: HTML.match(new RegExp(`<div id="${id}"[^>]*>`))[0], inner: m[1] };
}

for (const [groupId, firstBoxId, labelId, labelText] of [
  ["emailcode-otp", "emailcode-code", "emailcode-otp-label", "6-digit code"],
  ["sms-otp", "sms-code", "sms-otp-label", "SMS code"],
]) {
  test(`#${groupId} is a labelled role=group of six numeric boxes with stable first-box id #${firstBoxId}`, () => {
    const { openTag, inner } = groupMarkup(groupId);

    // The group announces itself as one control to assistive tech, NAMED BY the visible field
    // label via aria-labelledby (TM-867 review fix): a duplicate aria-label let the accessible
    // name drift from the visible text — on the SMS step it actually did ("SMS code" visible vs
    // "6-digit code" announced), breaking label-in-name for voice-control users (WCAG 2.5.3).
    assert.match(openTag, /role="group"/, "container carries role=group");
    assert.match(
      openTag,
      new RegExp(`aria-labelledby="${labelId}"`),
      "group is named by its visible label",
    );
    assert.doesNotMatch(openTag, /aria-label=/, "no duplicate aria-label to drift from the visible text");
    assert.match(
      HTML,
      new RegExp(`<span id="${labelId}">${labelText}</span>`),
      `the visible '${labelText}' label carries the id the group points at`,
    );

    // Six inputs, every one on the numeric keypad, each announcing its position.
    const inputs = inner.match(/<input[^>]*>/g) ?? [];
    assert.equal(inputs.length, 6, "exactly six boxes");
    inputs.forEach((tag, i) => {
      assert.match(tag, /inputmode="numeric"/, `box ${i + 1} uses the numeric keypad`);
      assert.match(
        tag,
        new RegExp(`aria-label="Digit ${i + 1} of 6"`),
        `box ${i + 1} announces its position`,
      );
      // No maxlength anywhere: it would clip a multi-digit autofill/paste before the JS could
      // fan it out across the boxes (the JS truncates instead).
      assert.doesNotMatch(tag, /maxlength/, `box ${i + 1} has no maxlength`);
    });

    // First box: the stable automation id (e2e page.fill / Maestro tapOn) + the OS OTP suggestion.
    assert.match(inputs[0], new RegExp(`id="${firstBoxId}"`), "first box keeps the legacy id");
    assert.match(inputs[0], /autocomplete="one-time-code"/, "OS one-time-code suggestion targets box 1");
    // ONLY the first box: a one-time-code hint on later boxes would invite the OS to autofill the
    // whole code into the wrong box.
    inputs.slice(1).forEach((tag, i) => {
      assert.match(tag, /autocomplete="off"/, `box ${i + 2} opts out of autofill`);
    });
  });
}

test("login.js attaches the OTP widgets and wraps run() in the single-flight double-submit guard", () => {
  // The widget attaches once per group and auto-submits through the shared run() wrapper — the
  // exact seam requirement: no second verify path.
  assert.match(LOGIN, /attachOtpInput\(\{ group: els\.codeGroup, onComplete: \(\) => run\(verifyAndSignIn\) \}\)/);
  assert.match(LOGIN, /attachOtpInput\(\{ group: els\.smsCodeGroup, onComplete: \(\) => run\(verifySms\) \}\)/);
  // The double-submit guard is the tested-in-isolation makeSingleFlight, applied to run itself.
  assert.match(LOGIN, /const run = makeSingleFlight\(/);
});
