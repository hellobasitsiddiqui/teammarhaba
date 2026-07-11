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

test("the Pay button guards double-submit and re-enables on a declined card (TM-629)", () => {
  assert.match(
    SRC,
    /if\s*\(payBtn\.disabled\)\s*return;\s*\n\s*payBtn\.disabled\s*=\s*true;[\s\S]{0,120}cardField\.submit\(\)/,
    "the Pay click handler must disable the button before submitting the card field",
  );
  assert.match(
    SRC,
    /onError:\s*\(message\)\s*=>\s*\{[\s\S]{0,240}payBtn\.disabled\s*=\s*false/,
    "the widget's onError must re-enable Pay so a declined card can be retried",
  );
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
