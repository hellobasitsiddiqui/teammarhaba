// Home DOM-shell wiring guards (TM-760, part of the TM-738 P1 home coverage). Framework-free — Node's
// built-in test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// CONTEXT (TM-738 audit, [home]): home-core.js — the pure feed / context-line / card view-model logic —
// is already behaviourally unit-tested (home-core.test.mjs, 12 tests). The remaining home P1 gap the
// audit names is "home.js DOM shell (loading / feed / empty / error / stale-guard) UNTESTED at every
// layer". home.js statically imports api.js → the Firebase CDN, so — exactly like membership-checkout.js
// / membership-subscribe.js — the module can NEVER be loaded under `node --test` (Node's ESM loader
// rejects the `https:` gstatic import). Its live render is therefore an e2e concern (deferred P1 e2e);
// what CAN be pinned at the unit layer, and what these guards do, is that the shell actually WIRES the
// five states onto the tested core — the same source-level-guard idiom membership-checkout-screen.test.mjs
// uses for its un-importable, api-coupled screen module.
//
// These are CHARACTERIZATION tests for EXISTING behaviour (no source change): every assertion below is
// grounded in the current home.js. They pin the seams the e2e keys off (the data-testids) and the
// decisions that are easy to regress silently (the monotonic stale-guard, the best-effort /me degrade,
// the delegation to home-core so Home and #/events never grow a second drifting formatter).

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "../src/assets/home.js"), "utf8");

// --- delegation: all decision logic lives in the tested pure core, not re-implemented here ----------
//
// The whole point of the *-core split (see home-core.js's header + AGENTIC-LESSONS "extract the pure
// logic to test it") is that the DOM shell is thin and delegates. If a future edit inlined the feed /
// context decision into home.js it would drift from the #/events vocabulary and escape the core's tests.

test("the shell delegates the section + context decision to the tested home-core (no re-implemented logic)", () => {
  assert.match(
    SRC,
    /import\s*\{[^}]*\bhomeContextLine\b[^}]*\}\s*from\s*"\.\/home-core\.js"/,
    "imports the context-line builder from home-core (where TM-734's honesty rules are unit-tested)",
  );
  assert.match(
    SRC,
    /import\s*\{[^}]*\bhomeSections\b[^}]*\}\s*from\s*"\.\/home-core\.js"/,
    "imports the sections view-model (grouping + collapse-empties + teaser cap) from home-core, not a local copy",
  );
  assert.match(SRC, /homeSections\(cards,\s*\{/, "builds the sections via homeSections(cards, ctx) — the tested decision (TM-969)");
  assert.match(SRC, /homeContextLine\(/, "sets the section context via homeContextLine — the tested copy");
});

// --- XSS-safety: text only ever reaches the DOM through ui.js el() / textContent, never innerHTML -----
//
// Event headings, locations and the city are all untrusted (TM-133 threat model). The shell must build
// nodes through ui.js's safe el()/clear() (textContent-only) — a stray innerHTML would be an injection seam.

test("the shell renders through the XSS-safe ui.js builder and never touches innerHTML", () => {
  assert.match(SRC, /import\s*\{[^}]*\bel\b[^}]*\}\s*from\s*"\.\/ui\.js"/, "builds nodes via ui.js el() (textContent-only)");
  assert.doesNotMatch(SRC, /\.innerHTML\s*=/, "no innerHTML assignment — untrusted event/city text must never inject markup");
});

// --- state 1: LOADING placeholder is painted immediately on entry -----------------------------------

test("state LOADING: entry paints an immediate 'Finding meetups…' placeholder (data-testid home-loading)", () => {
  const enter = SRC.slice(SRC.indexOf("export async function enterHome"));
  assert.match(enter, /"data-testid":\s*"home-loading"/, "the loading placeholder carries the e2e-keyed testid");
  assert.match(enter, /Finding meetups near you/, "…with the honest 'near you' loading copy");
  // The loading state is painted BEFORE the awaited fetch (synchronously on entry), so there's never a
  // blank frame while the listing loads.
  assert.ok(
    enter.indexOf('"home-loading"') < enter.indexOf("await Promise.all"),
    "the loading placeholder is painted before the awaited listing fetch (no blank first frame)",
  );
});

// --- state 2: FEED sections of cards (TM-969) --------------------------------------------------------

test("state FEED: a populated listing renders the personalized sections with the e2e-keyed testids (TM-969)", () => {
  // Each present section is a headed block; the near-you teaser carries a "See all events →" hand-off.
  assert.match(SRC, /"data-testid":\s*"home-section"/, "the populated feed renders testid-tagged section blocks");
  assert.match(SRC, /"data-testid":\s*"home-section-title"/, "each section carries a light header (title) testid");
  assert.match(SRC, /"data-testid":\s*"home-see-all"/, "the near-you teaser carries the 'See all events →' hand-off testid");
  assert.match(SRC, /"data-testid":\s*"home-event-card"/, "each card carries the home-event-card testid");
  assert.match(SRC, /"data-testid":\s*"home-going-count"/, "the 'N going' pill carries its testid");
  // The section iteration paints exactly what the tested core returns (each section top→bottom).
  assert.match(SRC, /for\s*\(const\s+section\s+of\s+model\.sections\)/, "renders each home-core section in order");
  // The "See all" link is gated on the section being the teaser (never on the attending sections).
  assert.match(SRC, /section\.isTeaser\s*&&\s*section\.seeAllHref/, "the See-all link is shown only for the teaser section");
  // The card is the whole tap-target anchor (matching the #/events browse card) — an <a href> to the
  // detail, never a nested RSVP control that would duplicate the tested events-core gate.
  assert.match(SRC, /"a",\s*\{[\s\S]{0,120}href:\s*model\.href/, "the card is an <a> whose href is the model's detail route");
});

// --- state 3: EMPTY first-run state ------------------------------------------------------------------

test("state EMPTY: an empty feed swaps in the paper-empty-home state with its CTA to #/events", () => {
  assert.match(SRC, /if\s*\(model\.isEmpty\)/, "the empty decision reads home-core's isEmpty (the tested decision)");
  assert.match(SRC, /"data-testid":\s*"home-empty"/, "the empty state carries the home-empty testid");
  assert.match(SRC, /No events yet/, "…the paper-empty-home heading");
  assert.match(SRC, /href:\s*"#\/events"/, "…and a primary CTA that routes to the events browse list");
});

// --- state 4: ERROR + retry (never a dead blank feed) ------------------------------------------------
//
// A listing-fetch failure must land on a friendly retry state, never leave the feed blank. The retry
// must re-run the SAME entry point (so it re-fetches), and the error must be caught, not thrown.

test("state ERROR: a listing-fetch failure renders a caught retry state that re-runs enterHome", () => {
  assert.match(SRC, /catch\s*\(err\)\s*\{[\s\S]{0,200}renderError\(/, "a fetch failure is caught and routed to the error state");
  const err = SRC.slice(SRC.indexOf("function renderError"));
  assert.match(err, /"data-testid":\s*"home-error"/, "the error state carries the home-error testid");
  assert.match(err, /Couldn't load events/, "…a friendly failure heading");
  assert.match(err, /onClick:\s*\(\)\s*=>\s*enterHome\(\)/, "…and a Retry that re-runs the same entry point (re-fetches)");
});

// --- state 5: STALE-GUARD (monotonic renderToken) ---------------------------------------------------
//
// The MOST regression-prone piece: a slow fetch that resolves AFTER the user navigated away (or
// re-entered) must not paint stale content over the current view. home.js guards this with a
// module-level monotonic token captured per entry and re-checked after every await.

test("state STALE-GUARD: a per-entry monotonic token gates every post-await paint", () => {
  assert.match(SRC, /let\s+renderToken\s*=\s*0/, "a module-level monotonic render token exists");
  assert.match(SRC, /const\s+mine\s*=\s*\+\+renderToken/, "each entry captures its own incremented token");
  // Both post-await continuation points (the catch AND the success path) bail when a newer entry has run.
  const guards = SRC.match(/if\s*\(mine\s*!==\s*renderToken\)\s*return;?/g) || [];
  assert.ok(guards.length >= 2, `both the error and success continuations re-check the token (found ${guards.length})`);
  // The success guard fires AFTER the fetch settles but BEFORE the feed is painted, so a stale resolve
  // can't overwrite the current view.
  const successGuardAt = SRC.indexOf("if (mine !== renderToken) return", SRC.indexOf("await Promise.all"));
  assert.ok(successGuardAt !== -1, "the success path re-checks the token after the awaited fetch");
  assert.ok(successGuardAt < SRC.indexOf("homeSections(cards"), "…and does so before building/painting the feed");
});

// --- best-effort /me: its failure degrades the city hint, never blanks the feed ---------------------
//
// /me only powers the "near <city>" location HINT in the context line. Its failure must degrade the
// city to unknown ("near you"), NEVER take down the feed — so it's loaded through a swallow-and-null
// helper, separate from the listing fetch whose failure IS the error state.

test("best-effort /me: a profile-load failure degrades the city hint to null and never blanks the feed", () => {
  const loadMe = SRC.slice(SRC.indexOf("async function loadMe"));
  assert.match(loadMe, /catch\s*\([\s\S]{0,160}return\s+null;/, "loadMe swallows its failure and returns null (city unknown)");
  // The context line is (re)set from me?.city — a null me degrades to the neutral 'near you' copy.
  assert.match(SRC, /homeContextLine\(me\?\.\s*city\)/, "the context line reads me?.city — null degrades to 'near you', feed unaffected");
});

// --- defensive: a missing feed mount never throws ---------------------------------------------------

test("defensive: enterHome returns quietly when the feed mount is absent (never throws)", () => {
  const enter = SRC.slice(SRC.indexOf("export async function enterHome"));
  assert.match(enter, /const\s+feed\s*=\s*\$\(FEED_ID\);[\s\S]{0,80}if\s*\(!feed\)\s*return;/, "a missing #tm-home-feed returns early, no throw");
});
