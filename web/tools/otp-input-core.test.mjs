// Unit tests for the six-box OTP core (TM-867) — the pure state logic behind otp-input.js.
// Framework-free: Node's built-in test runner, picked up by the CI glob
// `node --test web/tools/*.test.mjs`. No DOM — otp-input-core.js is browser-free by construction;
// the DOM half (otp-input.js) is exercised by the e2e spec tm867-otp-6box.spec.mjs.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  OTP_LENGTH,
  sanitizeDigits,
  emptyValues,
  codeOf,
  isComplete,
  distribute,
  applyBackspace,
  arrowTarget,
  makeSingleFlight,
} from "../src/assets/otp-input-core.js";

// ---- sanitizeDigits: the single choke-point for "digits only" -------------------------------

test("sanitizeDigits strips spaces/formatting and caps at the box count", () => {
  assert.equal(sanitizeDigits(" 123 456 "), "123456");
  assert.equal(sanitizeDigits("12-34.56"), "123456");
  assert.equal(sanitizeDigits("1234567890"), "123456"); // over-long input truncates, never overflows
  assert.equal(sanitizeDigits("abc"), ""); // pure non-digit → nothing
  assert.equal(sanitizeDigits(null), "");
  assert.equal(sanitizeDigits(undefined), "");
});

// ---- distribute: typing fills + advances, the 6th digit completes ---------------------------

test("typing one digit at a time fills each box, advances focus, and completes on the 6th", () => {
  let values = emptyValues();
  const code = "493817";
  for (let i = 0; i < OTP_LENGTH; i++) {
    const r = distribute(values, i, code[i]);
    values = r.values;
    assert.equal(values[i], code[i], `digit ${i + 1} lands in box ${i + 1}`);
    if (i < OTP_LENGTH - 1) {
      assert.equal(r.focusIndex, i + 1, "focus auto-advances to the next box");
      assert.equal(r.complete, false, "not complete until every box is filled");
    } else {
      assert.equal(r.focusIndex, OTP_LENGTH - 1, "focus clamps at the last box");
      assert.equal(r.complete, true, "the 6th digit completes the code");
    }
  }
  assert.equal(codeOf(values), code);
  assert.equal(isComplete(values), true);
});

test("a full-length code pasted into ANY box distributes one digit per box from box 1", () => {
  // Box 3 receives the paste (index 3), formatted with spaces — the sanitised full code still
  // fills from box 0, which is also how the OS one-time-code autofill path works.
  const r = distribute(emptyValues(), 3, " 12 34 56 ");
  assert.deepEqual(r.values, ["1", "2", "3", "4", "5", "6"]);
  assert.equal(r.complete, true, "a distributed full code auto-completes");
  assert.equal(r.focusIndex, OTP_LENGTH - 1);
});

test("a partial paste writes forward from the receiving box and truncates at the last box", () => {
  // 3 digits pasted into box 4 (index 4): only boxes 5 and 6 exist to the right, so "9" is dropped.
  const r = distribute(emptyValues(), 4, "789");
  assert.deepEqual(r.values, ["", "", "", "", "7", "8"]);
  assert.equal(r.complete, false);
  assert.equal(r.focusIndex, OTP_LENGTH - 1);
});

test("non-digit input is rejected as a no-op (same values, same focus, never complete)", () => {
  const before = ["1", "2", "", "", "", ""];
  const r = distribute(before, 2, "x");
  assert.deepEqual(r.values, before);
  assert.equal(r.focusIndex, 2, "focus stays on the box that rejected the input");
  assert.equal(r.complete, false);
  assert.deepEqual(before, ["1", "2", "", "", "", ""], "input state is never mutated");
});

test("typing into an already-filled state can re-complete (the correct-a-digit-after-error path)", () => {
  const full = ["1", "2", "3", "4", "5", "6"];
  const r = distribute(full, 0, "9");
  assert.deepEqual(r.values, ["9", "2", "3", "4", "5", "6"]);
  assert.equal(r.complete, true, "a corrected digit re-fires completion (run() guards re-entry)");
});

// ---- applyBackspace: clear-in-place, then walk left -----------------------------------------

test("backspace on a filled box clears it and keeps focus there", () => {
  const r = applyBackspace(["1", "2", "3", "", "", ""], 2);
  assert.deepEqual(r.values, ["1", "2", "", "", "", ""]);
  assert.equal(r.focusIndex, 2);
});

test("backspace on an empty box clears the PREVIOUS box and moves focus onto it", () => {
  const r = applyBackspace(["1", "2", "3", "", "", ""], 3);
  assert.deepEqual(r.values, ["1", "2", "", "", "", ""]);
  assert.equal(r.focusIndex, 2);
});

test("backspace on an empty first box is a harmless no-op that stays put", () => {
  const r = applyBackspace(emptyValues(), 0);
  assert.deepEqual(r.values, emptyValues());
  assert.equal(r.focusIndex, 0);
});

// ---- arrowTarget: left/right navigation, clamped --------------------------------------------

test("arrow keys navigate between boxes and clamp at both ends", () => {
  assert.equal(arrowTarget(2, "ArrowLeft"), 1);
  assert.equal(arrowTarget(2, "ArrowRight"), 3);
  assert.equal(arrowTarget(0, "ArrowLeft"), 0, "no wrap-around at the first box");
  assert.equal(arrowTarget(OTP_LENGTH - 1, "ArrowRight"), OTP_LENGTH - 1, "no wrap-around at the last box");
  assert.equal(arrowTarget(2, "a"), null, "other keys are not navigation");
  assert.equal(arrowTarget(2, "Backspace"), null);
});

// ---- makeSingleFlight: the double-submit guard login.js wraps run() in ----------------------

test("makeSingleFlight drops a re-entrant call while the first is in flight", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const guarded = makeSingleFlight(async () => {
    calls++;
    await gate; // hold the first call open so the second arrives mid-flight
    return "done";
  });

  const first = guarded();
  const second = guarded(); // fired while the first is pending — must NO-OP
  release();

  assert.equal(await first, "done");
  assert.equal(await second, undefined, "the dropped call resolves undefined without running");
  assert.equal(calls, 1, "the wrapped action ran exactly once");
});

test("makeSingleFlight releases the lock after completion AND after a throw", async () => {
  let calls = 0;
  const ok = makeSingleFlight(async () => ++calls);
  await ok();
  await ok();
  assert.equal(calls, 2, "sequential calls all run — only overlap is dropped");

  const boom = makeSingleFlight(async () => {
    throw new Error("verify failed");
  });
  await assert.rejects(boom(), /verify failed/);
  // A failed verify must not brick the form: the next attempt still goes through.
  await assert.rejects(boom(), /verify failed/, "lock released after the throw");
});
