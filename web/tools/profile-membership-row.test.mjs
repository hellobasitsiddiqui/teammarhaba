// Profile membership-row regression guard (TM-643). Framework-free — Node's built-in test runner,
// picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// THE BUG (TM-643): the Profile screen's membership row was HARDCODED to the literal
// "Pay as you go · first event free" (profile.js), ignoring the caller's real tier — so a Monthly
// subscriber still saw "Pay as you go" after subscribing, even though GET /me/membership already
// returned `{"tier":"MONTHLY"}`. Display-only; the backend was correct.
//
// THE FIX: the row is now painted from the caller's REAL membership via the pure, tested
// profileMembershipRow() mapping (membership-tier.js), which sources the tier NAME from the shared
// tier catalogue (tierMeta) so paid tiers read "Monthly member" / "Diamond member" and the free base
// keeps the shipped pay-as-you-go copy. profile.js itself can't be imported under `node --test` (it
// sits on the api.js → Firebase CDN chain), so the wiring half is a source-level guard — the
// established pattern (see membership-route-wiring.test.mjs / events-map-link-a11y.test.mjs).

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { profileMembershipRow, tierMeta } from "../src/assets/membership-tier.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILE_SRC = readFileSync(join(HERE, "../src/assets/profile.js"), "utf8");

// --- half 1: the pure tier→display mapping ----------------------------------------------------------

test("profileMembershipRow: MONTHLY shows the real paid tier label, not pay-as-you-go (TM-643)", () => {
  const row = profileMembershipRow({ tier: "MONTHLY" });
  assert.equal(row.tier, "MONTHLY");
  assert.equal(row.paid, true);
  assert.equal(row.text, "Monthly member");
  // The exact regression: a subscriber must NOT be shown the free-base copy.
  assert.notEqual(row.text, "Pay as you go · first event free");
});

test("profileMembershipRow: DIAMOND shows its real paid tier label (TM-643)", () => {
  const row = profileMembershipRow({ tier: "DIAMOND" });
  assert.equal(row.paid, true);
  assert.equal(row.text, "Diamond member");
});

test("profileMembershipRow: PAY_PER_EVENT keeps the shipped pay-as-you-go copy (TM-643)", () => {
  const row = profileMembershipRow({ tier: "PAY_PER_EVENT" });
  assert.equal(row.paid, false);
  assert.equal(row.text, "Pay as you go · first event free");
});

test("profileMembershipRow: unknown/missing tier falls back to the safe free-base copy (TM-643)", () => {
  // normalizeMembership coerces anything unknown/absent to the free base, so the row can never throw
  // or render a raw enum token — it degrades to the pay-as-you-go copy.
  for (const bad of [{ tier: "PLATINUM" }, {}, null, undefined, { tier: 42 }]) {
    assert.equal(profileMembershipRow(bad).text, "Pay as you go · first event free");
  }
});

test("profileMembershipRow: paid labels are sourced from the shared tier catalogue, not duplicated (TM-643)", () => {
  // "Monthly" / "Diamond" come straight from tierMeta(), so the row can never drift from the catalogue.
  assert.equal(profileMembershipRow({ tier: "MONTHLY" }).text, `${tierMeta("MONTHLY").label} member`);
  assert.equal(profileMembershipRow({ tier: "DIAMOND" }).text, `${tierMeta("DIAMOND").label} member`);
});

// --- half 2: profile.js is wired to the real tier, not a literal ------------------------------------

test("profile.js sources the membership tier from the API (GET /me/membership), TM-643", () => {
  assert.match(
    PROFILE_SRC,
    /import\s*\{[^}]*\bgetMembership\b[^}]*\}\s*from\s*"\.\/api\.js"/,
    "profile.js must import getMembership from api.js — the row can only reflect the real tier if it fetches it",
  );
  assert.match(
    PROFILE_SRC,
    /getMembership\(\)/,
    "profile.js must actually call getMembership() to read the caller's current tier on entry",
  );
});

test("profile.js renders the membership row via the pure tier→label mapping, not a hardcoded string (TM-643)", () => {
  assert.match(
    PROFILE_SRC,
    /import\s*\{[^}]*\bprofileMembershipRow\b[^}]*\}\s*from\s*"\.\/membership-tier\.js"/,
    "profile.js must import profileMembershipRow — the shared, tested tier→label mapping",
  );
  assert.match(
    PROFILE_SRC,
    /profileMembershipRow\(/,
    "the membership row's text must be derived by calling profileMembershipRow(), not a literal",
  );
  // The core of the bug: the hardcoded free-base literal must no longer live in the DOM view — it now
  // exists ONLY inside the pure profileMembershipRow() (membership-tier.js). This is the fail-before/
  // pass-after guard: pre-fix the literal was in profile.js (fails); post-fix it's gone (passes).
  assert.doesNotMatch(
    PROFILE_SRC,
    /text:\s*"Pay as you go · first event free"/,
    "the membership sub text must NOT be a hardcoded literal in profile.js — it must come from profileMembershipRow()",
  );
});
