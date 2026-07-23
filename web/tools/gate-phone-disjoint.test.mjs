// TM-994 — the 6 first-run-gate e2e specs generate a run-unique GB gate phone `+4477009<tail>` where
// `<tail>` is 5 clock-derived digits. That normalized 12-digit key is the SAME length as the seeded
// persona band `+4477009001NN` (NN = 00…08 ⇒ tails 00100–00108), so the old `uniqueTestPhone` "different
// digit length ⇒ never a persona" reasoning did NOT protect these specs: when the clock tail landed in
// 00100–00108 (~1 run in 1100) the generated number was byte-for-byte a persona number, and the second
// account to claim it hit Firebase `credential-already-in-use` + the backend `users_phone_normalized_uq`
// 409 — an opaque ~1/1100 flake.
//
// This test IS the fix's proof: it exhausts the entire 00000–99999 tail space and asserts the new
// fixtures helpers (`outOfPersonaBand` / `uniqueGateGbNumber`) are disjoint from the persona band BY
// CONSTRUCTION — no clock value can produce a colliding number. It also pins the OLD raw formula as
// PROVABLY colliding, so this file documents exactly the flake window it closes.
//
// Fail-before: on the pre-fix tree these named exports don't exist, so the import throws and every test
// in this file errors (RED). Pass-after: all green. Framework-free — Node's built-in runner, picked up
// by the CI glob `node --test web/tools/*.test.mjs`.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ALL_PERSONAS,
  PERSONA_TAIL_MIN,
  PERSONA_TAIL_MAX,
  outOfPersonaBand,
  uniqueGateGbNumber,
} from "../e2e/fixtures.mjs";

/** Digits-only normalized key, matching the backend `users_phone_normalized_uq` normalization. */
const norm = (e164) => e164.replace(/[^0-9]/g, "");

/** The set of normalized persona numbers the seeded fixtures own (the 1:1-unique claims). */
const PERSONA_KEYS = new Set(ALL_PERSONAS.map((p) => norm(p.phone)));

test("the persona band constants match the seeded +4477009001NN persona numbers", () => {
  // Sanity-anchor the band the helper excludes against the ACTUAL seeded persona tails, so the exclusion
  // can't silently drift away from what it's protecting against.
  const personaTails = ALL_PERSONAS.map((p) => Number(norm(p.phone).slice(-5)));
  assert.equal(Math.min(...personaTails), PERSONA_TAIL_MIN, "min persona tail should be 00100");
  assert.equal(Math.max(...personaTails), PERSONA_TAIL_MAX, "max persona tail should be 00108");
  // Every seeded persona lives in the +4477009 prefix (so the band is the ONLY reserved region there).
  for (const p of ALL_PERSONAS) {
    assert.ok(norm(p.phone).startsWith("4477009"), `${p.phone} should be in the +4477009 persona prefix`);
  }
});

test("outOfPersonaBand NEVER returns a tail in 00100–00108, across the whole 00000–99999 space", () => {
  for (let n = 0; n < 100_000; n++) {
    const out = Number(outOfPersonaBand(n));
    assert.ok(
      out < PERSONA_TAIL_MIN || out > PERSONA_TAIL_MAX,
      `outOfPersonaBand(${n}) = ${out} landed in the reserved persona band`,
    );
  }
});

test("outOfPersonaBand always yields a 5-digit string and is idempotent", () => {
  for (const n of [0, 5, 99, 100, 104, 108, 109, 1108, 99_999]) {
    const out = outOfPersonaBand(n);
    assert.equal(out.length, 5, `outOfPersonaBand(${n}) must be zero-padded to 5 digits`);
    assert.equal(outOfPersonaBand(out), out, `outOfPersonaBand must be idempotent (${n})`);
  }
});

test("uniqueGateGbNumber's E.164 can NEVER equal a seeded persona number, for any 5-digit clock tail", () => {
  // Exhaust every possible seed tail (the clock only ever contributes its low 5 digits) and assert the
  // generated number's normalized key is not one of the reserved persona keys. This is the invariant the
  // OLD inline `+4477009${Date.now()%100000}` formula violated for tails 00100–00108.
  for (let tail = 0; tail < 100_000; tail++) {
    const { e164 } = uniqueGateGbNumber(tail);
    assert.ok(!PERSONA_KEYS.has(norm(e164)), `uniqueGateGbNumber(${tail}) → ${e164} collided with a persona`);
  }
});

test("uniqueGateGbNumber keeps the exact GB shape the specs type (national 7700 9XXXXX / E.164 +4477009XXXXX)", () => {
  const { national, e164 } = uniqueGateGbNumber(48_213);
  assert.match(national, /^7700 9\d{5}$/, "national must be 7700 9XXXXX (10-digit GB mobile)");
  assert.match(e164, /^\+4477009\d{5}$/, "e164 must be +4477009XXXXX");
  // The national's composed digits must equal the E.164's digits (picker prepends +44).
  assert.equal(`+44${national.replace(/\D/g, "")}`, e164);
});

test("the golden-path per-project suffix keeps chromium and mobile-chromium runs distinct", () => {
  const stamp = 1_700_000_050_010; // a fixed stamp for determinism
  const chromium = uniqueGateGbNumber(stamp, "0").e164;
  const mobile = uniqueGateGbNumber(stamp, "1").e164;
  assert.notEqual(chromium, mobile, "the 0/1 project suffix must produce two different numbers");
});

test("REGRESSION ORACLE: the OLD raw `+4477009${tail}` formula DID collide with a persona (this is the flake)", () => {
  // Reproduce the pre-fix inline generator and prove it hits a persona number for a tail in the band —
  // so the value of the de-banding above is concrete, not hypothetical. If this ever stops colliding,
  // the persona band moved and the fix's premise needs revisiting.
  const oldRaw = (tail) => `+4477009${String(tail % 100_000).padStart(5, "0")}`;
  assert.ok(PERSONA_KEYS.has(norm(oldRaw(100))), "old formula with tail 00100 should hit a persona (it did)");
  // …and the new helper, given the SAME colliding tail, escapes the band.
  assert.ok(!PERSONA_KEYS.has(norm(uniqueGateGbNumber(100).e164)), "new helper must escape the band for tail 00100");
});
