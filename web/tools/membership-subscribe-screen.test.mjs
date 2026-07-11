// Subscribe-screen shell guards (TM-629). Framework-free — Node's built-in test runner, picked up by
// the CI glob `node --test web/tools/*.test.mjs`.
//
// membership-subscribe.js statically imports api.js → auth.js → the Firebase CDN, so the module can
// never be loaded under `node --test` (the same constraint that shaped events-map-link-a11y.test.mjs
// and deploy-theme-retired.test.mjs). The pure halves of these fixes ARE behaviourally tested —
// subscriptionActivatedFor / pollSubscriptionActivation in membership-subscribe-core.test.mjs — so
// what remains for the DOM shell is that it actually WIRES them, which these source-level guards pin:
//
//   • REGRESSION (stale poll, TM-629): the activation poll used to run detached from the mount — the
//     router only hides the section on navigation, so a poll started on one visit later painted
//     "You're subscribed!" into the re-rendered screen (e.g. after hopping to the OTHER tier's
//     subscribe route). The shell must run the node-tested pollSubscriptionActivation with an
//     `isStale` tied to a per-mount generation, and render nothing on "stale".
//
//   • REGRESSION (no in-flight guard, TM-629): neither "Continue to payment" nor the Pay button
//     disabled itself while the checkout POST / card submit ran — a double-click created two
//     server-side checkouts / double-submitted the card field.
//
//   • REGRESSION (blank screen, TM-629): router.js accepts ANY suffix under #/membership/subscribe/
//     (tier validity is the screen's job), but the screen's answer to an invalid tier
//     (#/membership/subscribe/GOLD) was a silent early `return` — a VISIBLE, EMPTY section: blank
//     screen, no copy, no way back. It must render a fallback instead.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "../src/assets/membership-subscribe.js"), "utf8");

// --- the activation poll is mount-aware ------------------------------------------------------------

test("the shell delegates the activation poll to the node-tested core loop (TM-629)", () => {
  assert.match(
    SRC,
    /import\s*\{[^}]*\bpollSubscriptionActivation\b[^}]*\}\s*from\s*"\.\/membership-subscribe-core\.js"/,
    "membership-subscribe.js must import pollSubscriptionActivation from the core (where the loop is unit-tested)",
  );
  assert.match(SRC, /pollSubscriptionActivation\(\{/, "…and actually call it");
  // The old hand-rolled loop — the one that keyed success off `subscribed && tier` and could not be
  // cancelled — must be gone.
  assert.doesNotMatch(
    SRC,
    /view\.subscribed\s*&&\s*view\.tier\s*===\s*tier/,
    "the stale-CANCELED-satisfiable `subscribed && tier` success check must not come back",
  );
});

test("the poll's isStale is tied to a per-mount generation, and 'stale' renders nothing (TM-629)", () => {
  assert.match(SRC, /let\s+mountGeneration\s*=\s*0/, "a module-level mount generation counter exists");
  assert.match(
    SRC,
    /const\s+generation\s*=\s*\+\+mountGeneration/,
    "every enterMembershipSubscribe() bumps the generation, staling earlier mounts' async work",
  );
  assert.match(
    SRC,
    /isStale:\s*\(\)\s*=>\s*generation\s*!==\s*mountGeneration/,
    "the poll's staleness is the generation comparison",
  );
  assert.match(
    SRC,
    /if\s*\(outcome\s*===\s*"stale"\)\s*return;/,
    "a stale outcome must return WITHOUT touching the section (no reflectDone into a re-rendered screen)",
  );
});

// --- in-flight guards on the payment buttons --------------------------------------------------------

test("Continue-to-payment disables itself while the checkout is in flight and re-enables on failure (TM-629)", () => {
  // The guard: bail if already in flight, then disable for the duration.
  assert.match(
    SRC,
    /if\s*\(startBtn\.disabled\)\s*return;[\s\S]{0,80}startBtn\.disabled\s*=\s*true/,
    "startSubscribePayment must be a no-op while a checkout is already in flight, then disable the button",
  );
  // Failure paths re-enable so "try again" stays possible (the shared failStart helper).
  assert.match(
    SRC,
    /if\s*\(startBtn\)\s*startBtn\.disabled\s*=\s*false/,
    "every failure path must re-enable the start button (via the failStart helper)",
  );
});

test("the Pay button guards double-submit, validates the name, then submits with a { name } (TM-629/TM-639)", () => {
  // Still guards a double-submit while a charge is already in flight…
  assert.match(SRC, /if\s*\(payBtn\.disabled\)\s*return;/, "the Pay handler bails while a charge is already in flight");
  // …blocks an invalid (one-word) cardholder name and returns WITHOUT disabling/charging (so the user can
  // fix it and retry — the button stays enabled)…
  assert.match(
    SRC,
    /if\s*\(!isValidCardholderName\([\s\S]{0,40}\)\)\s*\{[\s\S]{0,220}return;/,
    "an invalid cardholder name must block the submit and return without charging",
  );
  // …then gates the submit on the controller's begin() and submits the card field WITH the validated
  // name (TM-639: no name ⇒ Revolut rejects "Cardholder name must be at least two words"). Since TM-642
  // begin() is what moves the machine to PENDING, and the button is disabled in the PENDING onChange
  // branch (not inline) — so the disable + the submit are pinned via begin() here and the PENDING branch below.
  assert.match(
    SRC,
    /if\s*\(!submitCtl\.begin\(\)\)\s*return;[\s\S]{0,120}cardField\.submit\(\{\s*name:/,
    "the Pay handler starts the controller (begin arms the backstop) then submits with a { name } payload",
  );
  assert.match(
    SRC,
    /case\s+PAYMENT_SUBMIT_STATE\.PENDING:[\s\S]{0,120}payBtn\.disabled\s*=\s*true/,
    "the PENDING onChange branch disables the button while a charge is in flight",
  );
  // The decline (onError) re-enable moved into the controller's ERROR onChange branch since TM-642 (the
  // widget's onError now just feeds the controller). A declined card must still re-enable Pay for a retry.
  assert.match(
    SRC,
    /case\s+PAYMENT_SUBMIT_STATE\.ERROR:[\s\S]{0,200}payBtn\.disabled\s*=\s*false/,
    "the ERROR onChange branch re-enables Pay so a declined card can be retried",
  );
});

// --- cardholder name field + themed card field (TM-639) --------------------------------------------

test("the shell renders a required 'Name on card' field pre-filled from the profile (TM-639)", () => {
  assert.match(
    SRC,
    /import\s*\{[^}]*\bisValidCardholderName\b[^}]*\}\s*from\s*"\.\/membership-checkout-core\.js"/,
    "imports the pure cardholder-name validator from the core (where it is unit-tested)",
  );
  assert.match(SRC, /buildCardholderNameField\s*\(/, "builds the shared Name-on-card field");
  assert.match(SRC, /api\.getMe\(\)/, "pre-fills the name from the caller's profile (GET /me)");
  assert.match(SRC, /CARDHOLDER_NAME_HINT/, "shows the shared inline hint when the name is invalid");
});

test("the card field is themed for the Revolut iframe, and merchant-save moved to submit() (TM-639)", () => {
  // The number / expiry / CVC inputs live in Revolut's iframe, so they're themed via the styles object.
  assert.match(
    SRC,
    /createCardField\(\{[\s\S]{0,200}styles:\s*revolutCardFieldStyles\(\)/,
    "createCardField must get a styles object (its inputs are unreachable by our CSS)",
  );
  // savePaymentMethodFor is SUBMIT-time metadata per the RevolutCheckout.js contract — it moved onto
  // submit() (with the name), off createCardField where it was silently ignored.
  assert.match(
    SRC,
    /cardField\.submit\(\{[\s\S]{0,90}savePaymentMethodFor:\s*"merchant"/,
    "the merchant-save flag is passed to submit() alongside the name",
  );
  assert.doesNotMatch(
    SRC,
    /createCardField\(\{[\s\S]{0,160}savePaymentMethodFor/,
    "savePaymentMethodFor must no longer sit on createCardField (the contract ignores it there)",
  );
});

// --- stuck-payment backstop is wired (TM-642) ------------------------------------------------------
//
// REGRESSION (TM-642): a card the widget rejects/declines client-side sometimes called NEITHER onSuccess
// NOR onError, and there was no timeout — so the Subscribe button sat disabled on "Processing payment…"
// forever. The pure lifecycle machine + timeout backstop live (and are behaviourally tested) in
// payment-submit-core.test.mjs; these guards pin that the shell actually WIRES it into the submit path.

test("the subscribe shell drives the submit through the node-tested controller + timeout backstop (TM-642)", () => {
  assert.match(
    SRC,
    /import\s*\{[^}]*\bcreateCardSubmitController\b[^}]*\}\s*from\s*"\.\/membership-checkout-core\.js"/,
    "imports the pure submit controller from the core (where the lifecycle machine is unit-tested)",
  );
  assert.match(SRC, /createCardSubmitController\(\{/, "…and constructs it");
  // The real timer is injected (the core stays DOM/timer-free); a genuine setTimeout backstop is armed.
  assert.match(SRC, /setTimer:\s*\([\s\S]{0,40}\)\s*=>\s*setTimeout\(/, "arms a real setTimeout backstop");
  assert.match(SRC, /clearTimer:\s*\([\s\S]{0,20}\)\s*=>\s*clearTimeout\(/, "and clears it on settle");
});

test("the widget callbacks feed the controller, and the TIMEOUT branch re-enables + shows the stuck hint (TM-642)", () => {
  // onSuccess/onError now delegate to the controller (which owns first-settle-wins / double-fire).
  assert.match(SRC, /onSuccess:\s*\(\)\s*=>\s*submitCtl\.success\(\)/, "onSuccess feeds the controller");
  assert.match(SRC, /onError:\s*\(message\)\s*=>\s*submitCtl\.error\(message\)/, "onError feeds the controller");
  // The TIMEOUT state clears "Processing payment…" (via the shared hint) and re-enables the button.
  assert.match(
    SRC,
    /case\s+PAYMENT_SUBMIT_STATE\.TIMEOUT:[\s\S]{0,400}PAYMENT_STUCK_HINT[\s\S]{0,120}payBtn\.disabled\s*=\s*false/,
    "the TIMEOUT branch must show PAYMENT_STUCK_HINT and re-enable the button (no more permanent stuck state)",
  );
  // The submit still only happens once the controller has moved to PENDING (begin() gates it).
  assert.match(
    SRC,
    /if\s*\(!submitCtl\.begin\(\)\)\s*return;[\s\S]{0,120}cardField\.submit\(/,
    "begin() (which arms the backstop) must precede cardField.submit()",
  );
});

test("the subscribe shell wires best-effort card-field validation feedback (TM-642)", () => {
  assert.match(
    SRC,
    /import\s*\{[^}]*\bsummarizeCardValidation\b[^}]*\}\s*from\s*"\.\/membership-checkout-core\.js"/,
    "imports the defensive onValidation reader from the core",
  );
  assert.match(SRC, /onValidation:\s*\(payload\)\s*=>/, "wires the card field's onValidation callback");
  assert.match(SRC, /summarizeCardValidation\(payload\)/, "…interpreting it defensively");
});

// --- invalid tier renders a fallback, not a blank screen --------------------------------------------

test("an invalid subscribe tier renders the 'Choose a plan' fallback with a way back — never a silent return (TM-629)", () => {
  // The null-tier branch must paint copy + a back link into the (visible) section…
  const branch = SRC.match(/if\s*\(!tier\)\s*\{([\s\S]*?)\n {2}\}/);
  assert.ok(branch, "enterMembershipSubscribe must still branch on a null tier");
  const body = branch[1];
  assert.doesNotMatch(
    body.trim(),
    /^return;/,
    "the null-tier branch must not silently return first — that was the blank screen",
  );
  assert.match(body, /clear\(section\)/, "the fallback repaints the section");
  assert.match(body, /Choose a plan/, "…with honest heading copy");
  assert.match(
    body,
    /href:\s*MEMBERSHIP_ROUTE/,
    "…and a navigation link back to the membership screen (the 'way back' the blank screen lacked)",
  );
});
