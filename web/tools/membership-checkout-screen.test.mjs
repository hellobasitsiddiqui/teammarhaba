// Per-event checkout screen shell guards (TM-639). Framework-free — Node's built-in test runner, picked
// up by the CI glob `node --test web/tools/*.test.mjs`.
//
// membership-checkout.js statically imports api.js → the Firebase CDN, so the module can never be loaded
// under `node --test` (the same constraint that shaped membership-subscribe-screen.test.mjs). The pure
// cardholder-name validator IS behaviourally tested (isValidCardholderName / normalizeCardholderName in
// membership-checkout.test.mjs), so what remains for the DOM shell is that it actually WIRES the TM-639
// fix into the per-event PAY path — pinned here by source-level guards:
//
//   • REGRESSION (TM-639): the Pay button submitted the card field with NO cardholder name, so Revolut
//     rejected every charge with "Cardholder name must be at least two words". The shell must now render a
//     required "Name on card" field (pre-filled from the profile), validate it with the node-tested
//     ≥2-word gate, and pass the validated value to cardField.submit({ name }).
//   • REGRESSION (TM-639): createCardField had no `styles`, so Revolut's iframe inputs rendered unstyled
//     across the width. The shell must pass a `styles` object (the only way to theme the iframe inputs).

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "../src/assets/membership-checkout.js"), "utf8");

test("the per-event Pay flow renders a profile-filled 'Name on card' field via the shared helper (TM-639)", () => {
  assert.match(
    SRC,
    /import\s*\{[^}]*\bisValidCardholderName\b[^}]*\}\s*from\s*"\.\/membership-checkout-core\.js"/,
    "imports the pure cardholder-name validator from the core (where it is unit-tested)",
  );
  assert.match(SRC, /buildCardholderNameField\s*\(/, "renders the shared Name-on-card field");
  assert.match(SRC, /api\.getMe\(\)/, "pre-fills the name from the caller's profile (GET /me)");
  assert.match(SRC, /CARDHOLDER_NAME_HINT/, "shows the shared inline hint when the name is invalid");
});

test("the per-event Pay button blocks an invalid name and submits a { name } payload (TM-639)", () => {
  // An invalid (one-word) name blocks the submit and returns without charging.
  assert.match(
    SRC,
    /if\s*\(!isValidCardholderName\([\s\S]{0,40}\)\)\s*\{[\s\S]{0,220}return;/,
    "an invalid cardholder name must block the submit and return without charging",
  );
  // The card field is submitted WITH the validated cardholder name (the whole TM-639 fix).
  assert.match(SRC, /cardField\.submit\(\{\s*name:/, "the card field is submitted with a { name } payload");
  // The old no-metadata submit() that triggered the bug must be gone.
  assert.doesNotMatch(SRC, /cardField\.submit\(\)\s*;/, "the old no-metadata cardField.submit() must be gone");
});

test("the per-event card field is themed for the Revolut iframe via a styles object (TM-639)", () => {
  assert.match(
    SRC,
    /createCardField\(\{[\s\S]{0,200}styles:\s*revolutCardFieldStyles\(\)/,
    "createCardField must get a styles object (its number/expiry/CVC inputs live in Revolut's iframe)",
  );
});

// --- stuck-payment backstop is wired (TM-642) ------------------------------------------------------
//
// REGRESSION (TM-642): a card the widget rejects/declines client-side sometimes called NEITHER onSuccess
// NOR onError, and there was no timeout — so the Pay button sat disabled on "Processing payment…"
// forever. The pure lifecycle machine + timeout backstop live (and are behaviourally tested) in
// payment-submit-core.test.mjs; these guards pin that the per-event shell actually WIRES it.

test("the per-event Pay flow drives the submit through the controller + timeout backstop (TM-642)", () => {
  assert.match(
    SRC,
    /import\s*\{[^}]*\bcreateCardSubmitController\b[^}]*\}\s*from\s*"\.\/membership-checkout-core\.js"/,
    "imports the pure submit controller from the core (where the lifecycle machine is unit-tested)",
  );
  assert.match(SRC, /createCardSubmitController\(\{/, "…and constructs it");
  assert.match(SRC, /setTimer:\s*\([\s\S]{0,40}\)\s*=>\s*setTimeout\(/, "arms a real setTimeout backstop");
  assert.match(SRC, /clearTimer:\s*\([\s\S]{0,20}\)\s*=>\s*clearTimeout\(/, "and clears it on settle");
});

test("the per-event widget callbacks feed the controller, and TIMEOUT re-enables + shows the stuck hint (TM-642)", () => {
  assert.match(SRC, /onSuccess:\s*\(\)\s*=>\s*submitCtl\.success\(\)/, "onSuccess feeds the controller");
  assert.match(SRC, /onError:\s*\(message\)\s*=>\s*submitCtl\.error\(message\)/, "onError feeds the controller");
  assert.match(
    SRC,
    /case\s+PAYMENT_SUBMIT_STATE\.TIMEOUT:[\s\S]{0,400}PAYMENT_STUCK_HINT[\s\S]{0,120}payBtn\.disabled\s*=\s*false/,
    "the TIMEOUT branch must show PAYMENT_STUCK_HINT and re-enable the button (no more permanent stuck state)",
  );
  assert.match(
    SRC,
    /if\s*\(!submitCtl\.begin\(\)\)\s*return;[\s\S]{0,120}cardField\.submit\(/,
    "begin() (which arms the backstop) must precede cardField.submit()",
  );
});

test("the per-event Pay flow wires best-effort card-field validation feedback (TM-642)", () => {
  assert.match(
    SRC,
    /import\s*\{[^}]*\bsummarizeCardValidation\b[^}]*\}\s*from\s*"\.\/membership-checkout-core\.js"/,
    "imports the defensive onValidation reader from the core",
  );
  assert.match(SRC, /onValidation:\s*\(payload\)\s*=>/, "wires the card field's onValidation callback");
  assert.match(SRC, /summarizeCardValidation\(payload\)/, "…interpreting it defensively");
});
