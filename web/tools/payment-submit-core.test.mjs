// Tests for the card-submit lifecycle + stuck-payment backstop (TM-642). Framework-free — Node's
// built-in test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// THE BUG these pin: on the checkout, a card the Revolut widget rejects/declines CLIENT-side sometimes
// calls NEITHER onSuccess NOR onError, and there was no timeout — so the Pay/Subscribe button stayed
// disabled on "Processing payment…" forever, with no feedback and no retry (found in the payment e2e
// when a non-Revolut card number left it permanently stuck). The fix models one submit as a tiny state
// machine with a client-side TIMEOUT backstop; all the transition + precedence + re-enable logic lives
// in the pure membership-checkout-core.js so it is testable without a DOM or a real timer.
//
// It imports ONLY the pure core (membership-checkout-core.js), never the DOM views (membership-checkout.js
// / membership-subscribe.js), which statically import api.js → the Firebase CDN that Node can't load. The
// views' wiring is pinned separately by the source-level guards in membership-checkout-screen.test.mjs
// and membership-subscribe-screen.test.mjs.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PAYMENT_SUBMIT_STATE,
  PAYMENT_SUBMIT_EVENT,
  PAYMENT_STUCK_HINT,
  PAYMENT_SUBMIT_TIMEOUT_MS,
  CARD_VALIDATION_HINT,
  nextPaymentSubmitState,
  isPaymentSettled,
  isPaymentRetryable,
  isPaymentPending,
  createCardSubmitController,
  summarizeCardValidation,
} from "../src/assets/membership-checkout-core.js";

// --- shared copy + constants -----------------------------------------------------------------------

test("PAYMENT_STUCK_HINT is the shared retryable copy shown when a submit gets stuck (TM-642)", () => {
  assert.equal(typeof PAYMENT_STUCK_HINT, "string");
  assert.match(PAYMENT_STUCK_HINT, /didn't go through/i);
  assert.match(PAYMENT_STUCK_HINT, /try again/i);
});

test("PAYMENT_SUBMIT_TIMEOUT_MS is a sane positive backstop window (TM-642)", () => {
  assert.ok(Number.isInteger(PAYMENT_SUBMIT_TIMEOUT_MS) && PAYMENT_SUBMIT_TIMEOUT_MS > 0);
  assert.ok(PAYMENT_SUBMIT_TIMEOUT_MS >= 10000, "long enough to clear a real round-trip incl. 3DS/SCA");
});

// --- the pure state machine ------------------------------------------------------------------------

test("submit moves IDLE → PENDING; a stray callback before any submit is ignored (TM-642)", () => {
  assert.equal(nextPaymentSubmitState(PAYMENT_SUBMIT_STATE.IDLE, PAYMENT_SUBMIT_EVENT.SUBMIT), PAYMENT_SUBMIT_STATE.PENDING);
  // A success/error/timeout that arrives with nothing in flight must not fabricate a terminal state.
  assert.equal(nextPaymentSubmitState(PAYMENT_SUBMIT_STATE.IDLE, PAYMENT_SUBMIT_EVENT.SUCCESS), PAYMENT_SUBMIT_STATE.IDLE);
  assert.equal(nextPaymentSubmitState(PAYMENT_SUBMIT_STATE.IDLE, PAYMENT_SUBMIT_EVENT.ERROR), PAYMENT_SUBMIT_STATE.IDLE);
  assert.equal(nextPaymentSubmitState(PAYMENT_SUBMIT_STATE.IDLE, PAYMENT_SUBMIT_EVENT.TIMEOUT), PAYMENT_SUBMIT_STATE.IDLE);
});

test("a TIMEOUT while PENDING settles to a retryable TIMEOUT state (the stuck-payment fix — TM-642)", () => {
  // THE core regression: with no timeout the machine had no way out of PENDING. It now does, and the
  // resulting state is retryable (the view re-enables the button + shows PAYMENT_STUCK_HINT).
  const next = nextPaymentSubmitState(PAYMENT_SUBMIT_STATE.PENDING, PAYMENT_SUBMIT_EVENT.TIMEOUT);
  assert.equal(next, PAYMENT_SUBMIT_STATE.TIMEOUT);
  assert.equal(isPaymentSettled(next), true, "timeout is terminal");
  assert.equal(isPaymentRetryable(next), true, "…and retryable — the button must re-enable");
});

test("onError while PENDING settles to a retryable ERROR state (TM-642)", () => {
  const next = nextPaymentSubmitState(PAYMENT_SUBMIT_STATE.PENDING, PAYMENT_SUBMIT_EVENT.ERROR);
  assert.equal(next, PAYMENT_SUBMIT_STATE.ERROR);
  assert.equal(isPaymentSettled(next), true);
  assert.equal(isPaymentRetryable(next), true, "a decline is retryable");
});

test("onSuccess while PENDING settles to SUCCESS — terminal and NOT retryable (TM-642)", () => {
  const next = nextPaymentSubmitState(PAYMENT_SUBMIT_STATE.PENDING, PAYMENT_SUBMIT_EVENT.SUCCESS);
  assert.equal(next, PAYMENT_SUBMIT_STATE.SUCCESS);
  assert.equal(isPaymentSettled(next), true);
  assert.equal(isPaymentRetryable(next), false, "a paid charge is never re-enabled for retry");
});

test("PRECEDENCE: a SUCCESS that arrives AFTER a TIMEOUT does NOT override the shown error (TM-642)", () => {
  // The defined precedence: the FIRST terminal event of an attempt wins. We already told the user it
  // didn't go through and re-enabled the button (they may have retried), so a late success from the
  // timed-out attempt must not silently flip the UI to success. The state stays TIMEOUT.
  assert.equal(
    nextPaymentSubmitState(PAYMENT_SUBMIT_STATE.TIMEOUT, PAYMENT_SUBMIT_EVENT.SUCCESS),
    PAYMENT_SUBMIT_STATE.TIMEOUT,
  );
  // Symmetrically, a late error/timeout after an error is ignored too (first terminal wins).
  assert.equal(
    nextPaymentSubmitState(PAYMENT_SUBMIT_STATE.ERROR, PAYMENT_SUBMIT_EVENT.SUCCESS),
    PAYMENT_SUBMIT_STATE.ERROR,
  );
  assert.equal(
    nextPaymentSubmitState(PAYMENT_SUBMIT_STATE.TIMEOUT, PAYMENT_SUBMIT_EVENT.ERROR),
    PAYMENT_SUBMIT_STATE.TIMEOUT,
  );
});

test("SUCCESS is locked: a late ERROR/TIMEOUT can't un-succeed it, and it never re-submits (TM-642)", () => {
  assert.equal(nextPaymentSubmitState(PAYMENT_SUBMIT_STATE.SUCCESS, PAYMENT_SUBMIT_EVENT.ERROR), PAYMENT_SUBMIT_STATE.SUCCESS);
  assert.equal(nextPaymentSubmitState(PAYMENT_SUBMIT_STATE.SUCCESS, PAYMENT_SUBMIT_EVENT.TIMEOUT), PAYMENT_SUBMIT_STATE.SUCCESS);
  assert.equal(nextPaymentSubmitState(PAYMENT_SUBMIT_STATE.SUCCESS, PAYMENT_SUBMIT_EVENT.SUBMIT), PAYMENT_SUBMIT_STATE.SUCCESS);
});

test("a retryable terminal (ERROR/TIMEOUT) re-enters PENDING only on a fresh SUBMIT (the retry — TM-642)", () => {
  assert.equal(nextPaymentSubmitState(PAYMENT_SUBMIT_STATE.ERROR, PAYMENT_SUBMIT_EVENT.SUBMIT), PAYMENT_SUBMIT_STATE.PENDING);
  assert.equal(nextPaymentSubmitState(PAYMENT_SUBMIT_STATE.TIMEOUT, PAYMENT_SUBMIT_EVENT.SUBMIT), PAYMENT_SUBMIT_STATE.PENDING);
});

test("an unknown/garbage current state is treated as IDLE (defensive — TM-642)", () => {
  assert.equal(nextPaymentSubmitState("WAT", PAYMENT_SUBMIT_EVENT.SUBMIT), PAYMENT_SUBMIT_STATE.PENDING);
  assert.equal(nextPaymentSubmitState(undefined, PAYMENT_SUBMIT_EVENT.SUCCESS), PAYMENT_SUBMIT_STATE.IDLE);
});

test("the state predicates classify each state correctly (TM-642)", () => {
  assert.equal(isPaymentPending(PAYMENT_SUBMIT_STATE.PENDING), true);
  assert.equal(isPaymentPending(PAYMENT_SUBMIT_STATE.IDLE), false);
  for (const s of [PAYMENT_SUBMIT_STATE.SUCCESS, PAYMENT_SUBMIT_STATE.ERROR, PAYMENT_SUBMIT_STATE.TIMEOUT]) {
    assert.equal(isPaymentSettled(s), true, `${s} is settled`);
  }
  for (const s of [PAYMENT_SUBMIT_STATE.IDLE, PAYMENT_SUBMIT_STATE.PENDING]) {
    assert.equal(isPaymentSettled(s), false, `${s} is not settled`);
  }
  assert.equal(isPaymentRetryable(PAYMENT_SUBMIT_STATE.ERROR), true);
  assert.equal(isPaymentRetryable(PAYMENT_SUBMIT_STATE.TIMEOUT), true);
  assert.equal(isPaymentRetryable(PAYMENT_SUBMIT_STATE.SUCCESS), false, "success is settled but NOT retryable");
  assert.equal(isPaymentRetryable(PAYMENT_SUBMIT_STATE.PENDING), false);
});

// --- the controller (state machine + timeout backstop, with an injected fake timer) ---------------

/** A one-shot fake timer harness — records the scheduled callback so a test can fire it deterministically. */
function fakeTimer() {
  let scheduled = null;
  return {
    setTimer: (fn, ms) => {
      scheduled = { fn, ms };
      return { id: 1 };
    },
    clearTimer: () => {
      scheduled = null;
    },
    /** Is a backstop currently armed? */
    armed: () => scheduled != null,
    /** The ms the backstop was armed for. */
    ms: () => (scheduled ? scheduled.ms : null),
    /** Fire the armed backstop (like the real one-shot timer: clears itself first). */
    fire: () => {
      if (!scheduled) return;
      const fn = scheduled.fn;
      scheduled = null;
      fn();
    },
  };
}

test("controller.begin() arms the backstop, moves to PENDING and emits PENDING (TM-642)", () => {
  const timer = fakeTimer();
  const emits = [];
  const ctl = createCardSubmitController({ ...timer, onChange: (s, d) => emits.push([s, d]) });

  assert.equal(ctl.getState(), PAYMENT_SUBMIT_STATE.IDLE);
  assert.equal(ctl.begin(), true, "a fresh submit proceeds");
  assert.equal(ctl.getState(), PAYMENT_SUBMIT_STATE.PENDING);
  assert.equal(timer.armed(), true, "the timeout backstop is armed while pending");
  assert.equal(timer.ms(), PAYMENT_SUBMIT_TIMEOUT_MS, "armed for the default window");
  assert.deepEqual(emits, [[PAYMENT_SUBMIT_STATE.PENDING, undefined]]);
});

test("controller: the backstop firing settles a stuck submit to TIMEOUT (fail-before/pass-after — TM-642)", () => {
  // FAIL-BEFORE: with no backstop, a submit whose widget never calls back stayed PENDING forever — the
  // stuck button. PASS-AFTER: the injected timer fires, the machine settles to TIMEOUT (retryable), and
  // exactly one TIMEOUT change is emitted so the view can re-enable + show PAYMENT_STUCK_HINT.
  const timer = fakeTimer();
  const emits = [];
  const ctl = createCardSubmitController({ ...timer, onChange: (s) => emits.push(s) });

  ctl.begin(); // → PENDING (widget never calls back)
  timer.fire(); // the 30s backstop elapses

  assert.equal(ctl.getState(), PAYMENT_SUBMIT_STATE.TIMEOUT);
  assert.equal(isPaymentRetryable(ctl.getState()), true, "the button re-enables after a stuck submit");
  assert.deepEqual(emits, [PAYMENT_SUBMIT_STATE.PENDING, PAYMENT_SUBMIT_STATE.TIMEOUT]);
});

test("controller: a late onSuccess AFTER the timeout is a no-op — no double-fire, error stays shown (TM-642)", () => {
  const timer = fakeTimer();
  const emits = [];
  const ctl = createCardSubmitController({ ...timer, onChange: (s) => emits.push(s) });

  ctl.begin(); // → PENDING
  timer.fire(); // → TIMEOUT (shown to the user, button re-enabled)
  const late = ctl.success(); // the real callback finally arrives, too late

  assert.equal(late, null, "a late success after settle returns null (ignored)");
  assert.equal(ctl.getState(), PAYMENT_SUBMIT_STATE.TIMEOUT, "the shown timeout state is preserved");
  assert.deepEqual(emits, [PAYMENT_SUBMIT_STATE.PENDING, PAYMENT_SUBMIT_STATE.TIMEOUT], "no second emit");
});

test("controller: onError while PENDING settles to ERROR, disarms the backstop, passes the detail (TM-642)", () => {
  const timer = fakeTimer();
  const emits = [];
  const ctl = createCardSubmitController({ ...timer, onChange: (s, d) => emits.push([s, d]) });

  ctl.begin();
  const moved = ctl.error({ message: "Card declined" });

  assert.equal(moved, PAYMENT_SUBMIT_STATE.ERROR);
  assert.equal(timer.armed(), false, "the backstop is disarmed once the widget reports an error");
  assert.deepEqual(emits, [
    [PAYMENT_SUBMIT_STATE.PENDING, undefined],
    [PAYMENT_SUBMIT_STATE.ERROR, { message: "Card declined" }],
  ]);
  // …and a stray timeout after that error is swallowed (the backstop can't override the shown decline).
  assert.equal(ctl.timeout(), null);
  assert.equal(ctl.getState(), PAYMENT_SUBMIT_STATE.ERROR);
});

test("controller: onSuccess while PENDING settles to SUCCESS, disarms the backstop; a late error is ignored (TM-642)", () => {
  const timer = fakeTimer();
  const emits = [];
  const ctl = createCardSubmitController({ ...timer, onChange: (s) => emits.push(s) });

  ctl.begin();
  ctl.success();
  assert.equal(ctl.getState(), PAYMENT_SUBMIT_STATE.SUCCESS);
  assert.equal(timer.armed(), false, "success disarms the backstop so it can never fire a stray timeout");

  assert.equal(ctl.error({ message: "late" }), null, "a late error after success is ignored");
  assert.equal(ctl.getState(), PAYMENT_SUBMIT_STATE.SUCCESS);
  assert.deepEqual(emits, [PAYMENT_SUBMIT_STATE.PENDING, PAYMENT_SUBMIT_STATE.SUCCESS]);
});

test("controller: begin() returns false once succeeded — a paid charge never re-submits (TM-642)", () => {
  const timer = fakeTimer();
  const ctl = createCardSubmitController({ ...timer });
  ctl.begin();
  ctl.success();
  assert.equal(ctl.begin(), false, "no re-submit after success");
  assert.equal(timer.armed(), false, "…and no backstop re-armed");
});

test("controller: after a TIMEOUT (or ERROR), begin() retries — back to PENDING with a fresh backstop (TM-642)", () => {
  const timer = fakeTimer();
  const emits = [];
  const ctl = createCardSubmitController({ ...timer, onChange: (s) => emits.push(s) });

  ctl.begin();
  timer.fire(); // → TIMEOUT, button re-enabled
  assert.equal(ctl.begin(), true, "the re-enabled button can retry");
  assert.equal(ctl.getState(), PAYMENT_SUBMIT_STATE.PENDING);
  assert.equal(timer.armed(), true, "a fresh backstop is armed for the retry");

  // The retry then succeeds cleanly.
  ctl.success();
  assert.equal(ctl.getState(), PAYMENT_SUBMIT_STATE.SUCCESS);
  assert.deepEqual(emits, [
    PAYMENT_SUBMIT_STATE.PENDING,
    PAYMENT_SUBMIT_STATE.TIMEOUT,
    PAYMENT_SUBMIT_STATE.PENDING,
    PAYMENT_SUBMIT_STATE.SUCCESS,
  ]);
});

test("controller tolerates no injected timer/sink (degrades gracefully — TM-642)", () => {
  // Constructed with no deps at all: begin() still advances the machine; it just has no backstop.
  const ctl = createCardSubmitController();
  assert.equal(ctl.begin(), true);
  assert.equal(ctl.getState(), PAYMENT_SUBMIT_STATE.PENDING);
  assert.equal(ctl.error(), PAYMENT_SUBMIT_STATE.ERROR);
});

// --- card-field inline validation summary (best-effort onValidation reader) ------------------------

test("summarizeCardValidation: an empty error array is valid; a populated one is invalid + a message (TM-642)", () => {
  assert.deepEqual(summarizeCardValidation([]), { valid: true, message: null });
  const bad = summarizeCardValidation([{ message: "Card number is incomplete" }]);
  assert.equal(bad.valid, false);
  assert.equal(bad.message, "Card number is incomplete");
});

test("summarizeCardValidation: the { errors: [...] } shape (TM-642)", () => {
  assert.deepEqual(summarizeCardValidation({ errors: [] }), { valid: true, message: null });
  const bad = summarizeCardValidation({ errors: [{ type: "expiry" }] });
  assert.equal(bad.valid, false);
  assert.equal(bad.message, "expiry", "falls back to a present field when there's no message");
});

test("summarizeCardValidation: the { valid, message } and boolean shapes (TM-642)", () => {
  assert.deepEqual(summarizeCardValidation({ valid: true }), { valid: true, message: null });
  assert.deepEqual(summarizeCardValidation({ valid: false, message: "CVC is wrong" }), {
    valid: false,
    message: "CVC is wrong",
  });
  // Invalid with no message → the generic hint.
  assert.deepEqual(summarizeCardValidation({ valid: false }), { valid: false, message: CARD_VALIDATION_HINT });
  assert.deepEqual(summarizeCardValidation(true), { valid: true, message: null });
  assert.deepEqual(summarizeCardValidation(false), { valid: false, message: CARD_VALIDATION_HINT });
});

test("summarizeCardValidation: an unknown/absent payload is treated as VALID so it never wrongly blocks (TM-642)", () => {
  // The whole point of degrading gracefully: if we can't understand the SDK's payload, don't block the
  // user — the timeout backstop is the guaranteed safety net, not this best-effort inline hint.
  for (const unknown of [undefined, null, 42, "??", {}, { other: 1 }]) {
    assert.deepEqual(summarizeCardValidation(unknown), { valid: true, message: null }, JSON.stringify(unknown));
  }
});
