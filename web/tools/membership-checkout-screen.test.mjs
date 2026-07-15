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

// --- CONFIRM ("Reserve my place") is a live frictionless RSVP, not a no-op (TM-726) ----------------
//
// REGRESSION (TM-726): the CONFIRM (FREE / INCLUDED) button "Reserve my place" was a silent no-op — its
// onClick only `console.info`ed the intended payload, so on the live checkout screen the button looked
// live but reserved nothing. It must now POST the same server-side checkout (api.checkout), which for a
// FREE / INCLUDED entitlement records a CONFIRMED order and confirms the RSVP with no card step, then
// reflect the confirmation. The module statically imports the Firebase CDN via api.js so it can't be
// loaded under `node --test`; these source-level guards pin the wiring (same approach as the TM-639/642
// guards above).

test("the CONFIRM button POSTs the frictionless RSVP via api.checkout, no longer a console.info no-op (TM-726)", () => {
  // The old silent no-op must be gone: no console.info of a checkout intent / payload on click.
  assert.doesNotMatch(
    SRC,
    /console\.info\(\s*["'`]\[membership-checkout\][^"'`]*intent/,
    "the old silent console.info('checkout intent') CONFIRM no-op must be gone",
  );
  // CONFIRM now routes to a real frictionless-RSVP handler…
  assert.match(SRC, /startConfirm\s*\(/, "CONFIRM click must invoke the frictionless RSVP handler");
  assert.match(
    SRC,
    /async\s+function\s+startConfirm\b[\s\S]{0,700}api\.checkout\(/,
    "…and startConfirm must POST the server-side checkout via api.checkout",
  );
});

test("the CONFIRM flow reflects the confirmed RSVP and stays non-throwing on failure (TM-726)", () => {
  const confirmFn = SRC.slice(SRC.indexOf("async function startConfirm"));
  // A frictionless settle reflects the reservation — gated on the REAL confirmed order status via the
  // shared isConfirmedCheckout predicate, NOT merely on paymentRequired===false (TM-743): an idempotent
  // repeat over a terminal FAILED/EXPIRED/CANCELLED/REFUNDED order also returns paymentRequired:false and
  // must not be mistaken for a live confirmation.
  assert.match(
    confirmFn,
    /isConfirmedCheckout\(result\)[\s\S]{0,160}reflectPaid\(/,
    "a CONFIRMED order (not merely paymentRequired:false) must reflect the confirmed reservation",
  );
  // Failure is caught and surfaced inline (never thrown), and the button is re-enabled to retry.
  assert.match(confirmFn, /catch\s*\([\s\S]{0,400}setPayStatus\(/, "a failed reserve must surface inline, not throw");
  assert.match(
    confirmFn,
    /catch\s*\([\s\S]{0,500}action\.disabled\s*=\s*false/,
    "a failed reserve must re-enable the button so the user can retry",
  );
  // An in-flight guard stops a double-tap double-posting the RSVP.
  assert.match(
    confirmFn,
    /if\s*\(action\s*&&\s*action\.disabled\)\s*return;/,
    "an in-flight guard must ignore a double-tap while the POST is running",
  );
});

// --- a failed checkout START (402 / 500) surfaces inline and never white-screens (TM-738 P1, TM-760) ---
//
// checkoutPayStartSurfaces402_500InlineReEnablesPay: startPayment POSTs api.checkout to open the order
// server-side; a 402 (payment-required error) / 500 from that call must render an inline, NON-throwing
// status on the Pay mount (never white-screen the checkout screen). Characterization of the EXISTING
// startPayment catch — the pure lifecycle/timeout machine is behaviourally tested in
// payment-submit-core.test.mjs; here the shell wiring is pinned by source guards, like the TM-639/642 ones.

test("a failed checkout START surfaces an inline retry status and never throws out of the screen (TM-760)", () => {
  const payFn = SRC.slice(SRC.indexOf("async function startPayment"), SRC.indexOf("async function mountRevolutCard"));
  // The checkout-start POST is wrapped in try/catch so a 402/500 cannot propagate out of the screen.
  assert.match(
    payFn,
    /try\s*\{[\s\S]{0,120}await\s+api\.checkout\(event\?\.id\)[\s\S]{0,80}\}\s*catch\s*\(err\)\s*\{/,
    "startPayment wraps api.checkout in try/catch so a 402/500 never white-screens the checkout screen",
  );
  // The catch surfaces an inline retry status via the Pay mount's aria-live line, then returns (no throw).
  assert.match(
    payFn,
    /catch\s*\(err\)\s*\{[\s\S]{0,220}setPayStatus\(mount,\s*"Couldn't start payment\. Please try again\."\)[\s\S]{0,40}return;/,
    "a checkout-start failure sets an inline 'try again' status on the mount and returns without throwing",
  );
});

test("the Pay button re-enables after a declined charge so the buyer can retry (TM-760)", () => {
  // The "ReEnablesPay" half: once the card widget is mounted, a declined/errored charge re-enables the Pay
  // button (the ERROR branch of the TM-642 lifecycle machine) so the buyer can fix the card and retry —
  // rather than the button sitting disabled forever.
  assert.match(
    SRC,
    /case\s+PAYMENT_SUBMIT_STATE\.ERROR:[\s\S]{0,300}payBtn\.disabled\s*=\s*false/,
    "a declined/errored charge must re-enable the Pay button for a retry",
  );
});

// --- confirmation copy gated on the REAL order status + PENDING resume (TM-743 / TM-744) -----------
//
// REGRESSION (TM-743): both the PAY (startPayment) and CONFIRM (startConfirm) flows keyed their
// "You're confirmed for this event." copy purely on `paymentRequired === false`. The backend returns
// paymentRequired:false for ANY non-PENDING existing order on an idempotent repeat — including the
// terminal, NON-attending FAILED (declined card) / EXPIRED / CANCELLED / REFUNDED states — so a buyer
// whose card was declined, returning to the screen, was falsely told they were confirmed. The fix gates
// the copy on the shared node-tested isConfirmedCheckout predicate (order.status === "CONFIRMED").
//
// TM-744: resuming a PENDING per-event payment used to dead-end because the backend never re-minted a
// token. Now that it re-mints (TM-739), startPayment mounts the widget with the returned token; the shell
// must NOT swallow that with a false confirmation before reading the token.

test("both checkout flows gate the confirmation copy on the shared CONFIRMED-status predicate (TM-743)", () => {
  assert.match(
    SRC,
    /import\s*\{[^}]*\bisConfirmedCheckout\b[^}]*\}\s*from\s*"\.\/membership-checkout-core\.js"/,
    "imports the pure CONFIRMED-status predicate from the core (where it is unit-tested)",
  );
  // The old, buggy gate — a bare `paymentRequired === false` immediately followed by reflectPaid — must be
  // gone from BOTH flows (it falsely confirmed terminal orders).
  assert.doesNotMatch(
    SRC,
    /paymentRequired\s*===\s*false\s*\)\s*\{\s*reflectPaid\(/,
    "the old paymentRequired===false → reflectPaid gate must be gone (it falsely confirmed terminal orders)",
  );
  // The PAY flow reflects the paid state only for a genuinely CONFIRMED order.
  const payFn = SRC.slice(SRC.indexOf("async function startPayment"));
  assert.match(
    payFn,
    /isConfirmedCheckout\(result\)[\s\S]{0,160}reflectPaid\(/,
    "startPayment must gate 'You're confirmed' on a CONFIRMED order, not merely paymentRequired:false",
  );
});

test("the PAY flow reads the re-minted token to resume a PENDING order rather than dead-ending (TM-744)", () => {
  const payFn = SRC.slice(SRC.indexOf("async function startPayment"));
  // The confirmed-status check comes BEFORE the token read, so a re-minted PENDING resume (paymentRequired
  // true, fresh token, status PENDING) falls through to the token and mounts the widget — not a false
  // confirmation and not the "could not be initialised" dead end.
  assert.match(
    payFn,
    /isConfirmedCheckout\(result\)[\s\S]{0,800}const\s+token\s*=\s*result\s*&&\s*result\.paymentToken/,
    "the CONFIRMED gate must precede the token read so a re-minted PENDING token is used to resume",
  );
  assert.match(payFn, /mountRevolutCard\(mount,\s*token,/, "the resumed token mounts the card widget");
});
