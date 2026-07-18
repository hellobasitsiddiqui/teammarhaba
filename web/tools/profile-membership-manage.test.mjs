// Profile membership Manage-affordance regression guard (TM-882). Framework-free — Node's built-in
// test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// THE PAPERCUT (TM-882): `config.flags.membership` ships OFF, and while it is off the Profile
// membership row rendered a muted, NON-interactive "Manage →" <span> (profile.js) — link-styled copy
// that does nothing, so it read as a dead link. Not broken (the flag gate is deliberate; TM-478 flips
// it under epic TM-457), but ambiguous.
//
// THE FIX: the flag-OFF state is now an unambiguous "Coming soon" status badge (the tier cards' badge
// idiom, membership-tier.css) decided by the pure, node-tested profileManageAffordance()
// (membership-tier.js); flag ON still renders the live "Manage →" link to #/membership. profile.js
// itself can't be imported under `node --test` (it sits on the api.js → Firebase CDN chain), so the
// wiring half is a source-level guard — the established pattern (see profile-membership-row.test.mjs).

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { profileManageAffordance, MEMBERSHIP_ROUTE } from "../src/assets/membership-tier.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILE_SRC = readFileSync(join(HERE, "../src/assets/profile.js"), "utf8");

// --- half 1: the pure flag→affordance mapping -------------------------------------------------------

test("profileManageAffordance: flag ON is the live Manage link to the membership screen (TM-882)", () => {
  const on = profileManageAffordance(true);
  assert.equal(on.kind, "link");
  assert.equal(on.href, MEMBERSHIP_ROUTE); // the single shared route constant, never re-spelled
  assert.equal(on.label, "Manage →");
});

test("profileManageAffordance: flag OFF is an unambiguous coming-soon state, not a link (TM-882)", () => {
  const off = profileManageAffordance(false);
  assert.equal(off.kind, "coming-soon");
  assert.equal(off.label, "Coming soon");
  // The heart of the papercut: the OFF state must carry NO link affordance — no href, and none of the
  // link's "Manage →" wording (an arrow or "Manage" invites a click that does nothing).
  assert.equal(off.href, undefined);
  assert.doesNotMatch(off.label, /Manage|→/);
});

// --- half 2: profile.js renders the affordance, never a link-styled label that does nothing ---------

test("profile.js derives the Manage affordance from the pure mapping (TM-882)", () => {
  assert.match(
    PROFILE_SRC,
    /import\s*\{[^}]*\bprofileManageAffordance\b[^}]*\}\s*from\s*"\.\/membership-tier\.js"/,
    "profile.js must import profileManageAffordance — the shared, tested flag→affordance mapping",
  );
  assert.match(
    PROFILE_SRC,
    /profileManageAffordance\(\s*membershipEnabled\(\)\s*\)/,
    "the membership row's Manage affordance must be decided by profileManageAffordance(membershipEnabled())",
  );
});

test("profile.js flag-OFF state is the coming-soon badge, not a dead 'Manage →' label (TM-882)", () => {
  // The exact papercut: pre-fix the OFF branch rendered a non-interactive <span> whose text was the
  // link's own "Manage →" (fails this guard); post-fix no <span> carries that link wording (passes).
  assert.doesNotMatch(
    PROFILE_SRC,
    /el\(\s*"span",\s*\{[^}]*text:\s*"Manage →"/,
    "the flag-OFF membership row must NOT render a non-interactive span styled/worded as the Manage link",
  );
  assert.match(
    PROFILE_SRC,
    /tm-tier-badge-soon/,
    "the flag-OFF membership row must render the established Coming-soon badge (tm-tier-badge-soon)",
  );
});

test("profile.js flag-ON state still renders the live Manage link (TM-882)", () => {
  assert.match(
    PROFILE_SRC,
    /el\(\s*"a",\s*\{\s*class:\s*"tm-pf-go"/,
    "the flag-ON membership row must still be the live a.tm-pf-go Manage link",
  );
});
