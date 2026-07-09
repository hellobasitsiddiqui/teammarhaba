// Tests for the boot-screen tagline logic (TM-381). Framework-free — Node's built-in test runner,
// picked up by the CI glob `node --test web/tools/*.test.mjs`. Covers the two behaviours the AC calls
// out: a UNIFORM random pick, and NO IMMEDIATE REPEAT of the previous launch's tagline — driven with
// an injected RNG so the assertions are deterministic across the RNG's whole [0, 1) range.

import assert from "node:assert/strict";
import { test } from "node:test";

import { TAGLINES, pickTagline } from "../src/assets/boot-core.js";

/** A deterministic RNG stub that yields the given values in order (then repeats the last). */
function rngOf(...values) {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

test("the seed list is the ten configured taglines, frozen and unique", () => {
  assert.equal(TAGLINES.length, 10);
  assert.ok(Object.isFrozen(TAGLINES), "TAGLINES must be frozen so the shared list can't be mutated");
  assert.equal(new Set(TAGLINES).size, TAGLINES.length, "no duplicate taglines");
  assert.ok(TAGLINES.includes("You're just my cup of tea"));
  assert.ok(TAGLINES.includes("I like you a latte"));
  assert.ok(TAGLINES.includes("Marhaba! The kettle's on."));
});

test("uniform pick — rng maps linearly onto the candidate list", () => {
  const list = ["A", "B", "C", "D"];
  // With no `previous`, every item is a candidate: index = floor(rng * 4).
  assert.equal(pickTagline(list, null, rngOf(0)), "A");
  assert.equal(pickTagline(list, null, rngOf(0.25)), "B");
  assert.equal(pickTagline(list, null, rngOf(0.5)), "C");
  assert.equal(pickTagline(list, null, rngOf(0.99)), "D");
});

test("no immediate repeat — the previous tagline is never returned again", () => {
  const list = ["A", "B", "C", "D"];
  // Excluding B leaves [A, C, D]; sweep the RNG range and assert B never comes back.
  for (const r of [0, 0.2, 0.33, 0.5, 0.66, 0.8, 0.999]) {
    const pick = pickTagline(list, "B", rngOf(r));
    assert.notEqual(pick, "B", `rng=${r} must not re-pick the previous tagline`);
    assert.ok(list.includes(pick));
  }
});

test("no immediate repeat holds across the real seed list", () => {
  // Every seed tagline, used as `previous`, must be excluded from the next pick for every RNG value.
  for (const previous of TAGLINES) {
    for (const r of [0, 0.15, 0.37, 0.5, 0.73, 0.9, 0.9999]) {
      assert.notEqual(pickTagline(TAGLINES, previous, rngOf(r)), previous);
    }
  }
});

test("the excluded-previous candidate pool is still uniform (indices shift past the removed item)", () => {
  const list = ["A", "B", "C", "D"];
  // Previous = A → pool [B, C, D]; index = floor(rng * 3).
  assert.equal(pickTagline(list, "A", rngOf(0)), "B");
  assert.equal(pickTagline(list, "A", rngOf(0.5)), "C");
  assert.equal(pickTagline(list, "A", rngOf(0.99)), "D");
});

test("a `previous` that isn't in the list — the whole list is fair game", () => {
  const list = ["A", "B", "C"];
  assert.equal(pickTagline(list, "Z", rngOf(0)), "A");
  assert.equal(pickTagline(list, "Z", rngOf(0.99)), "C");
});

test("degenerate lists — single item and empty", () => {
  // Single item: returned even when it equals `previous` (there's no alternative to avoid a repeat).
  assert.equal(pickTagline(["only"], "only", rngOf(0.5)), "only");
  assert.equal(pickTagline(["only"], null, rngOf(0.5)), "only");
  // Empty / invalid input: nothing to show.
  assert.equal(pickTagline([], null, rngOf(0)), null);
  assert.equal(pickTagline(null, null, rngOf(0)), null);
});

test("rng returning exactly 1.0 is clamped in-bounds (never undefined)", () => {
  const list = ["A", "B", "C"];
  assert.equal(pickTagline(list, null, rngOf(1)), "C");
  assert.equal(pickTagline(list, "C", rngOf(1)), "B"); // pool [A, B], clamp to last
});

test("defaults — pickTagline() with no args uses the seed list and Math.random", () => {
  const pick = pickTagline();
  assert.ok(TAGLINES.includes(pick), "a bare call returns one of the seed taglines");
});
