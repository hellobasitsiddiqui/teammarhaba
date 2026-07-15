// Regression tests for settleOrFallback (extracted from router.js) — backfilled for the TM-307
// login dead-end.
//
// TM-307: after an email-code sign-in inside the Android WebView, verify succeeded and the user was
// signed in, but the app stayed on the login screen. Root cause: an un-timed `await` on
// getIdToken()/GET /me, which could hang forever, so navigation off #/login never fired. The fix
// bounded that wait with settleOrFallback but shipped WITHOUT a test. These tests backfill that
// guard: the whole point of the helper is that it ALWAYS settles (never hangs, never rejects) and
// reports whether it fell back — the exact contract router.js's post-sign-in guard relies on.
//
// Framework-free — Node's built-in test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.

import assert from "node:assert/strict";
import { test } from "node:test";

import { settleOrFallback, singleFlight, DROPPED } from "../src/assets/async-util.js";

test("resolves with the real value when the promise settles before the timeout", async () => {
  const outcome = await settleOrFallback(Promise.resolve("ADMIN"), 1000, "USER");
  assert.deepEqual(outcome, { timedOut: false, value: "ADMIN" });
});

test("falls back (timedOut) when the promise never settles within ms — the TM-307 hang", async () => {
  // Models the WebView getIdToken()/GET /me that neither resolves nor rejects.
  const neverSettles = new Promise(() => {});
  const outcome = await settleOrFallback(neverSettles, 10, "USER");
  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.value, "USER");
});

test("falls back with the error attached when the promise rejects before the timeout", async () => {
  const boom = new Error("token exchange failed");
  const outcome = await settleOrFallback(Promise.reject(boom), 1000, "USER");
  assert.equal(outcome.timedOut, false);
  assert.equal(outcome.error, boom);
  assert.equal(outcome.value, "USER");
});

test("never rejects, even when the input promise rejects (callers must not need a try/catch)", async () => {
  await assert.doesNotReject(() => settleOrFallback(Promise.reject(new Error("x")), 50, null));
});

test("a slow-but-in-budget promise still resolves with its real value, not the fallback", async () => {
  const slow = new Promise((r) => setTimeout(() => r({ onboardingCompleted: true }), 5));
  const outcome = await settleOrFallback(slow, 1000, null);
  assert.equal(outcome.timedOut, false);
  assert.deepEqual(outcome.value, { onboardingCompleted: true });
});

// --- singleFlight: the reusable re-entrancy guard behind TM-721 (double-tap / double-Refresh) ---------

test("singleFlight drops a concurrent call while one is in flight — the command runs ONCE", async () => {
  // Models a double-tapped event action / double-clicked admin Refresh: the second tap must not fire a
  // second command (which showed two contradictory toasts / ran two full account walks).
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const guarded = singleFlight(async () => { calls++; await gate; return calls; });

  const first = guarded();      // starts, then parks on the gate
  const second = guarded();     // fires WHILE the first is in flight → must be dropped
  assert.equal(await second, DROPPED, "the re-entrant call is dropped, not run");
  assert.equal(calls, 1, "the wrapped fn was invoked exactly once");

  release();
  assert.equal(await first, 1, "the first call still resolves with its real result");
});

test("singleFlight releases after the run settles — a LATER call runs normally", async () => {
  let calls = 0;
  const guarded = singleFlight(async () => ++calls);
  assert.equal(await guarded(), 1);
  assert.equal(await guarded(), 2, "once the first settled the latch is open again");
});

test("singleFlight releases the latch even when the run REJECTS (a failed run can't wedge it shut)", async () => {
  let attempt = 0;
  const guarded = singleFlight(async () => {
    attempt++;
    if (attempt === 1) throw new Error("boom");
    return "ok";
  });
  await assert.rejects(() => guarded(), /boom/);
  assert.equal(await guarded(), "ok", "the next call runs — the failed run released the latch in finally");
});
