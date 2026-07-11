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
