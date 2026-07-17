// P2 characterization test for profile-core.js `profileStrength` — the AGE boundary (TM-738 coverage
// audit, profile surface; item `profileStrengthAgeBoundary`). Framework-free — Node's built-in test
// runner, the same harness as profile-core.test.mjs, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// WHY THIS GAP MATTERS (edge): the profile-completeness bar counts `age` as "present" using the exact
// rule `Number.isFinite(m.age) && m.age > 0` (profile-core.js). That single predicate decides whether a
// user is nudged to "Add your age" and how the percent renders. The existing profile-core.test.mjs only
// pins one age case for the strength model — `age: 0` inside a mixed "blank/zero field is unfilled"
// assertion. It never isolates the boundary around zero, nor the shapes the predicate treats specially:
//   - a NEGATIVE age (`> 0` fails) is NOT counted,
//   - a NON-INTEGER positive age IS counted (the strength model does NOT require an integer — that's the
//     edit form's `validateField`, a different seam; pinning this stops someone "helpfully" tightening
//     the strength rule to integers and silently changing the bar),
//   - a NON-NUMBER age (e.g. the string "20") is NOT counted (`Number.isFinite("20")` is false — the
//     model does not coerce),
//   - `NaN`/`Infinity` are NOT counted.
// If the predicate regresses (e.g. to a bare truthiness check, or `>= 0`, or a Number() coercion), the
// bar would mis-count age and the "what's missing" nudge would lie. These assert the SHIPPED behaviour,
// so they must pass green as-is.

import assert from "node:assert/strict";
import { test } from "node:test";

import { profileStrength } from "../src/assets/profile-core.js";

// Does the strength model count `age` as present for this value? True = the "your age" gap is absent.
function ageCounts(ageValue) {
  const s = profileStrength({ age: ageValue }, { hasPhoto: false });
  return !s.missing.includes("your age");
}

test("profileStrength counts a positive integer age just above the zero boundary", () => {
  assert.equal(ageCounts(1), true);
  assert.equal(ageCounts(18), true); // the app's real minimum self-reported age (TM-884; was 13).
  assert.equal(ageCounts(99), true); // the app's real maximum (TM-884; was 120).
  // Grandfathered out-of-band values (saved under the old 13–120 rule) still count toward strength —
  // the bar reflects what's on record; the 18–99 band is an edit-time rule, not a read-time one.
  assert.equal(ageCounts(15), true);
  assert.equal(ageCounts(120), true);
});

test("profileStrength does NOT count age at or below the zero boundary", () => {
  assert.equal(ageCounts(0), false); // zero is the exclusive lower bound — `> 0` fails.
  assert.equal(ageCounts(-1), false);
  assert.equal(ageCounts(-42), false);
});

test("profileStrength counts a NON-INTEGER positive age (the model does not require an integer)", () => {
  // The strength model's rule is finite && > 0 — it deliberately does NOT gate on integer-ness (that is
  // the edit form's job). Pinning this stops a well-meaning tightening from silently changing the bar.
  assert.equal(ageCounts(1.5), true);
  assert.equal(ageCounts(29.9), true);
});

test("profileStrength does NOT count a non-numeric or non-finite age (no coercion)", () => {
  assert.equal(ageCounts("20"), false); // Number.isFinite of a string is false — the model never coerces.
  assert.equal(ageCounts(NaN), false);
  assert.equal(ageCounts(Infinity), false);
  assert.equal(ageCounts(null), false);
  assert.equal(ageCounts(undefined), false);
});

test("the age boundary moves the whole strength percent by exactly one field (1/5 = 20%)", () => {
  // Everything else equal, a counted vs uncounted age is worth exactly one of the five strength fields.
  const withAge = profileStrength({ age: 30 }, { hasPhoto: false });
  const withoutAge = profileStrength({ age: 0 }, { hasPhoto: false });
  assert.equal(withAge.percent - withoutAge.percent, 20);
  assert.equal(withAge.filled - withoutAge.filled, 1);
});
