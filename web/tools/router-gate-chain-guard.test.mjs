// P0 shell coverage — the router's client-side gate chain can't be side-stepped (TM-738).
//
// WHY THIS IS A P0 (security-negative / critical-journey). router.js's `guard()` is the SPA's whole
// client-side access-control chain. It must run its checks in a fixed order, each early-returning, so a
// later gate can't be reached until the earlier one is satisfied:
//   1. signed-out on a protected route      → bounce to #/login (remember the intended route)
//   2. signed-in but NOT onboarded          → forced to #/onboarding, can reach NO other view (TM-250)
//   3. signed-in, onboarded, terms unaccepted→ forced to #/terms (only #/help slips through) (TM-170)
//   4. any admin route + resolved non-admin  → bounced Home ("Admins only.")  — for EVERY admin route
// The backend is the real authority, but if this chain's ORDER regressed (e.g. the admin check moved
// above the onboarding gate, or a new admin route shipped without `shouldBounceNonAdmin`), a not-yet-
// onboarded / non-admin user could reach a view they shouldn't — a visible security regression. The
// admin bounce is deliberately gated on `roleResolved` (via shouldBounceNonAdmin, TM-733) so the
// deep-link/reload race can't flash an admin view OR wrongly bounce a real admin.
//
// router.js can't be imported under `node --test` — it sits on the api.js → Firebase CDN import chain
// (a transitive `https:` specifier the default ESM loader can't resolve), exactly like
// membership-route-wiring.test.mjs and events-map-link-a11y.test.mjs. So this is a SOURCE-LEVEL guard:
// it reads router.js as text and pins the chain's structure/order, so a later edit can't silently
// reorder the gates or drop a guard. Picked up by the CI glob `node --test web/tools/*.test.mjs`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTER_SRC = readFileSync(join(HERE, "../src/assets/router.js"), "utf8");

/** Index of the FIRST occurrence of `re` in the source, or -1. Used to compare checkpoint ordering. */
function firstIndex(re) {
  const m = ROUTER_SRC.match(re);
  return m ? m.index : -1;
}

// The four ordered checkpoints, each anchored on its exact guard condition in guard().
const SIGNED_OUT_BOUNCE = /if\s*\(\s*!signedIn\s*&&\s*isProtected\(route\)\s*\)/;
const ONBOARDING_GATE = /if\s*\(\s*signedIn\s*&&\s*!isOnboarded\s*&&\s*route\s*!==\s*ONBOARDING\s*\)/;
const TERMS_GATE = /if\s*\(\s*signedIn\s*&&\s*isOnboarded\s*&&\s*needsTerms\s*&&\s*route\s*!==\s*TERMS\s*&&\s*route\s*!==\s*HELP\s*\)/;
const FIRST_ADMIN_BOUNCE = /if\s*\(\s*route\s*===\s*ADMIN\s*&&\s*shouldBounceNonAdmin\(/;

// --- The four gates all exist -----------------------------------------------------------------------

test("guard() has all four access-control checkpoints (signed-out, onboarding, terms, admin)", () => {
  assert.match(ROUTER_SRC, SIGNED_OUT_BOUNCE, "signed-out-on-protected bounce to login");
  assert.match(ROUTER_SRC, ONBOARDING_GATE, "first-login onboarding gate (TM-250)");
  assert.match(ROUTER_SRC, TERMS_GATE, "terms-acceptance gate (TM-170)");
  assert.match(ROUTER_SRC, FIRST_ADMIN_BOUNCE, "admin-route bounce for a non-admin (TM-133/TM-733)");
});

// --- Ordering: the chain runs signed-out → onboarding → terms → admin, and can't be reordered -------

test("the gate chain runs in order: signed-out → onboarding → terms → admin bounce", () => {
  const signedOut = firstIndex(SIGNED_OUT_BOUNCE);
  const onboarding = firstIndex(ONBOARDING_GATE);
  const terms = firstIndex(TERMS_GATE);
  const admin = firstIndex(FIRST_ADMIN_BOUNCE);

  assert.ok(signedOut >= 0 && onboarding >= 0 && terms >= 0 && admin >= 0, "all four checkpoints present");
  assert.ok(signedOut < onboarding, "the signed-out bounce precedes the onboarding gate");
  assert.ok(
    onboarding < terms,
    "the onboarding gate precedes the terms gate — a not-yet-onboarded user can't be diverted to terms first",
  );
  assert.ok(
    terms < admin,
    "the terms gate precedes the admin bounce — an ungated user is forced to terms before any admin view is considered",
  );
});

// --- Signed-out bounce preserves the intended route (return-after-login) ----------------------------

test("a signed-out user on a protected route is remembered then sent to login", () => {
  // The block must stash the intended route (via the best-effort safeSessionSet wrapper) and navigate
  // to LOGIN, then RETURN — so sign-in returns them to where they were headed and nothing else runs.
  assert.match(
    ROUTER_SRC,
    /if\s*\(\s*!signedIn\s*&&\s*isProtected\(route\)\s*\)\s*\{\s*safeSessionSet\(INTENDED_KEY,\s*route\);\s*go\(LOGIN\);\s*return;/,
    "signed-out-on-protected must remember the route (INTENDED_KEY) and go(LOGIN) then return",
  );
});

// --- Each gate early-RETURNS so a later gate is unreachable until it's satisfied --------------------

test("the onboarding and terms gates each early-return (redirect wins over everything after)", () => {
  // Onboarding gate ends in go(ONBOARDING); return; — nothing downstream (terms, admin, render) runs.
  assert.match(
    ROUTER_SRC,
    /go\(ONBOARDING\);\s*return;/,
    "the onboarding gate must go(ONBOARDING) then RETURN (so it wins over the terms + admin checks)",
  );
  // Terms gate ends in go(TERMS); return;.
  assert.match(
    ROUTER_SRC,
    /go\(TERMS\);\s*return;/,
    "the terms gate must go(TERMS) then RETURN (so it wins over the admin checks + render)",
  );
});

// --- EVERY admin route is gated via shouldBounceNonAdmin (no admin view is ungated) -----------------

test("every admin route in guard() is protected by shouldBounceNonAdmin (roleResolved-aware)", () => {
  // The ten ADMIN-only routes: hub (TM-917), users console (TM-917, moved to #/admin/users), events
  // console, event form, venues console, venue form, interests console, interest form (TM-779),
  // message compose, sent-history. Each must sit in an `if (<admin-route> && shouldBounceNonAdmin(...))`.
  const adminRouteConditions = [
    /route\s*===\s*ADMIN\s*&&\s*shouldBounceNonAdmin\(/,
    /route\s*===\s*ADMIN_USERS\s*&&\s*shouldBounceNonAdmin\(/, // TM-917: users console moved off #/admin
    /route\s*===\s*ADMIN_EVENTS\s*&&\s*shouldBounceNonAdmin\(/,
    /isAdminEventFormRoute\(route\)\s*&&\s*shouldBounceNonAdmin\(/,
    /route\s*===\s*ADMIN_VENUES\s*&&\s*shouldBounceNonAdmin\(/,
    /isAdminVenueFormRoute\(route\)\s*&&\s*shouldBounceNonAdmin\(/,
    /route\s*===\s*ADMIN_INTERESTS\s*&&\s*shouldBounceNonAdmin\(/, // TM-779: interests console
    /isAdminInterestFormRoute\(route\)\s*&&\s*shouldBounceNonAdmin\(/, // TM-779: interest form
    /isAdminMessageComposeRoute\(route\)\s*&&\s*shouldBounceNonAdmin\(/,
    /route\s*===\s*ADMIN_MESSAGES\s*&&\s*shouldBounceNonAdmin\(/,
  ];
  for (const cond of adminRouteConditions) {
    assert.match(ROUTER_SRC, cond, `admin route ${cond} must be guarded by shouldBounceNonAdmin`);
  }

  // Belt-and-braces: the count of shouldBounceNonAdmin calls equals the count of ENUMERATED admin
  // routes above. NOTE the real scope: this catches dropping a gate off a listed route, or adding a
  // gate without listing it — it does NOT catch a brand-new admin route that ships with NO gate at all
  // (it would be in neither list, so the counts still match). The per-route assertions above are the
  // real guard; keep this as a divergence tripwire, not a completeness proof.
  const bounceCalls = ROUTER_SRC.match(/shouldBounceNonAdmin\(\{\s*isAdmin,\s*roleResolved\s*\}\)/g) || [];
  assert.equal(
    bounceCalls.length,
    adminRouteConditions.length,
    `expected exactly ${adminRouteConditions.length} shouldBounceNonAdmin gates (one per admin route) — a new admin route needs its own gate`,
  );

  // Every admin bounce passes BOTH isAdmin and roleResolved (the TM-733 race fix): a bounce that read
  // only isAdmin would flash-bounce a real admin on deep-link/reload before their role resolves.
  assert.doesNotMatch(
    ROUTER_SRC,
    /shouldBounceNonAdmin\(\{\s*isAdmin\s*\}\)/,
    "no admin bounce may drop roleResolved — the guard must stay race-aware (TM-733)",
  );
});

test("the moved users console (#/admin/users) is in the PROTECTED set (TM-917 auth-gate regression)", () => {
  // The users console moved off #/admin (still PROTECTED) to #/admin/users. If ADMIN_USERS is NOT in
  // PROTECTED, a SIGNED-OUT deep-link to #/admin/users skips the auth gate (router line ~607): the
  // intended route isn't remembered and the role-bounce later fires "Admins only." + go(HOME) instead
  // of remember-then-#/login. This asserts the route joined the set — fails on the pre-fix source.
  assert.match(
    ROUTER_SRC,
    /const PROTECTED = new Set\(\[[^\]]*\bADMIN_USERS\b[^\]]*\]\)/,
    "ADMIN_USERS must be in the PROTECTED set so a signed-out #/admin/users deep-link is remembered + bounced to login",
  );
});

// --- The gate flags fail SAFE (documented contract the guard relies on) -----------------------------

test("isAdmin defaults to non-admin (fail-safe) until the role resolves", () => {
  // The guard trusts these module defaults; pin them so a refactor can't flip the fail-safe direction.
  assert.match(ROUTER_SRC, /let\s+isAdmin\s*=\s*false\s*;/, "isAdmin starts false (non-admin) until resolved");
  assert.match(ROUTER_SRC, /let\s+roleResolved\s*=\s*false\s*;/, "roleResolved starts false so the admin bounce is held, not fired");
});
