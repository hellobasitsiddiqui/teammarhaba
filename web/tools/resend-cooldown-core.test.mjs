// Unit tests for the resend-cooldown core (TM-866) — the pure countdown state machine behind
// resend-cooldown.js. Framework-free: Node's built-in test runner, picked up by the CI glob
// `node --test web/tools/*.test.mjs`. No fake timers anywhere — the core takes INJECTED
// timestamps, so every edge (start, tick-down, the expiry crossing, double-start, clock skew) is
// pinned with plain numbers. The DOM half (button relabel/disable, the 1s interval, aria-live
// announcements) is exercised by the e2e spec tm866-resend-cooldown.spec.mjs.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_COOLDOWN_SECONDS,
  create,
  start,
  reset,
  isActive,
  remainingSeconds,
  tick,
  formatRemaining,
} from "../src/assets/resend-cooldown-core.js";

// An arbitrary but realistic epoch base so the math in the assertions is easy to eyeball.
const T0 = 1_000_000;

// ---- create: a fresh cooldown is inert ------------------------------------------------------

test("a fresh cooldown is inactive: no remaining time, and tick reports nothing to do", () => {
  const s = create();
  assert.equal(s.durationMs, DEFAULT_COOLDOWN_SECONDS * 1000);
  assert.equal(isActive(s, T0), false);
  assert.equal(remainingSeconds(s, T0), 0);
  const r = tick(s, T0);
  assert.equal(r.active, false);
  assert.equal(r.expired, false, "an inactive cooldown never reports an expiry crossing");
  assert.equal(r.remaining, 0);
});

test("create honours a custom duration", () => {
  const s = start(create(5), T0);
  assert.equal(remainingSeconds(s, T0), 5);
  assert.equal(isActive(s, T0 + 4_999), true);
  assert.equal(isActive(s, T0 + 5_000), false);
});

// ---- start / tick / expiry ------------------------------------------------------------------

test("start opens the full window and does not mutate its input", () => {
  const before = create();
  const s = start(before, T0);
  assert.notEqual(s, before, "start from inactive returns a NEW state");
  assert.equal(before.endsAt, null, "input state is never mutated");
  assert.equal(isActive(s, T0), true);
  assert.equal(remainingSeconds(s, T0), 30, "the label reads the full 0:30 at the instant of start");
});

test("remaining counts down against the injected clock and rounds UP (ceil)", () => {
  const s = start(create(), T0);
  assert.equal(remainingSeconds(s, T0 + 1_000), 29);
  assert.equal(remainingSeconds(s, T0 + 29_000), 1);
  // 29.001s elapsed → 999ms left → still shows 1, not 0: the label never reads "0:00" while the
  // button is disabled (isActive and remaining>0 flip together at exactly t+30s).
  assert.equal(remainingSeconds(s, T0 + 29_001), 1);
  assert.equal(remainingSeconds(s, T0 + 29_999), 1);
  assert.equal(remainingSeconds(s, T0 + 30_000), 0);
});

test("the boundary is exclusive: at exactly endsAt the window is over", () => {
  const s = start(create(), T0);
  assert.equal(isActive(s, T0 + 29_999), true);
  assert.equal(isActive(s, T0 + 30_000), false);
});

test("tick mid-window: active, correct remaining, state unchanged", () => {
  const s = start(create(), T0);
  const r = tick(s, T0 + 12_345);
  assert.equal(r.active, true);
  assert.equal(r.remaining, 18, "ceil(17.655s) = 18");
  assert.equal(r.expired, false);
  assert.equal(r.state, s, "no state churn while simply counting");
});

test("the expiry crossing is reported EXACTLY once, however late the tick lands", () => {
  const s = start(create(), T0);
  // The observing interval was throttled (background tab) and wakes up 45s late — way past the
  // deadline. The first observation still reports the crossing…
  const first = tick(s, T0 + 75_000);
  assert.equal(first.active, false);
  assert.equal(first.expired, true, "the crossing tick announces 'you can resend now'");
  assert.equal(first.remaining, 0);
  // …and hands back an already-reset state, so the event can never re-fire.
  const second = tick(first.state, T0 + 76_000);
  assert.equal(second.expired, false, "expired is edge-triggered, not level-triggered");
  assert.equal(second.active, false);
});

// ---- no double-start ------------------------------------------------------------------------

test("starting an already-active cooldown is a no-op that does NOT extend the deadline", () => {
  const s = start(create(), T0);
  const again = start(s, T0 + 10_000); // a rogue second start 10s in
  assert.equal(again, s, "same reference back — the DOM layer keys on this to skip re-announcing");
  assert.equal(remainingSeconds(again, T0 + 15_000), 15, "still 15s left, not 25");
});

test("after expiry (or reset) a fresh start opens a full new window — resend after the wait works", () => {
  const s = start(create(), T0);
  const crossed = tick(s, T0 + 31_000).state; // window over
  const s2 = start(crossed, T0 + 40_000);
  assert.equal(remainingSeconds(s2, T0 + 40_000), 30, "a brand-new full window, not a leftover");
});

// ---- reset ----------------------------------------------------------------------------------

test("reset cancels the window silently: no expiry crossing is ever reported for it", () => {
  const s = start(create(), T0);
  const off = reset(s);
  assert.equal(isActive(off, T0 + 1_000), false);
  const r = tick(off, T0 + 31_000);
  assert.equal(r.expired, false, "leaving a step must not trigger the 'you can resend now' announcement");
});

test("reset is idempotent and returns the same reference when already inactive", () => {
  const s = create();
  assert.equal(reset(s), s, "callers can reset unconditionally on every step change without churn");
});

// ---- clock-skew clamps ----------------------------------------------------------------------

test("a wall clock that jumps BACKWARDS mid-window cannot inflate remaining past the duration", () => {
  const s = start(create(), T0);
  // NTP correction / OS-sleep weirdness: now is suddenly 20s BEFORE the start instant.
  assert.equal(remainingSeconds(s, T0 - 20_000), 30, "clamped at the promised window, never above");
  assert.equal(isActive(s, T0 - 20_000), true, "still held — it simply waits the promised 30s out");
});

test("remaining never goes below zero for long-expired states", () => {
  const s = start(create(), T0);
  assert.equal(remainingSeconds(s, T0 + 999_999), 0);
});

// ---- formatRemaining: the m:ss label --------------------------------------------------------

test("formatRemaining renders m:ss with padded seconds and unpadded minutes", () => {
  assert.equal(formatRemaining(30), "0:30");
  assert.equal(formatRemaining(29), "0:29");
  assert.equal(formatRemaining(5), "0:05");
  assert.equal(formatRemaining(0), "0:00");
  assert.equal(formatRemaining(90), "1:30"); // future-proofing: a server-seeded window could exceed 1m
  assert.equal(formatRemaining(-3), "0:00", "negative input clamps rather than rendering nonsense");
});
