// Resend-code cooldown — the pure, browser-free core (TM-866).
//
// Split out of the DOM layer the same way otp-input-core.js was split out of otp-input.js: this is
// the unit-testable half — given a cooldown state and an injected "now" timestamp, decide whether
// the cooldown is active, how many whole seconds remain, and whether this observation is the one
// that crossed the finish line — with zero DOM/timer dependencies, so `node --test
// web/tools/*.test.mjs` (the PR gate) can pin every edge without fake timers. resend-cooldown.js
// owns the actual button, the 1-second interval, and the aria-live announcements; login.js owns
// WHEN a cooldown starts (only after a send the backend accepted).
//
// The design is deadline-based, not counter-based: start() records an absolute `endsAt` and every
// observation derives "remaining" from the CURRENT clock. That means a missed/late interval tick
// (background tab throttling, a Playwright clock fast-forward that fires due timers only once)
// still lands on the truth — a decrementing counter would drift by exactly the ticks it missed.
//
// Every function is pure: state in → new state out, no mutation of the input. The state shape is
// deliberately dumb: `{ durationMs, endsAt }` where `endsAt: null` means "inactive".

/**
 * Default cooldown length, in seconds. Client-fixed by decision on TM-866: the backend's own
 * per-address send cooldown (app.auth.email-code.send-cooldown, default 60s) remains the real
 * abuse guard — this client window exists for UX (a visible countdown instead of a surprise 429),
 * so it is deliberately SHORTER than the server's. Seeding it from the server's Retry-After is a
 * noted follow-up, not built here.
 */
export const DEFAULT_COOLDOWN_SECONDS = 30;

/**
 * A fresh, INACTIVE cooldown.
 *
 * @param {number} [durationSec] window length in whole seconds (default {@link DEFAULT_COOLDOWN_SECONDS})
 * @returns {{durationMs: number, endsAt: number|null}} `endsAt` null = not counting down
 */
export function create(durationSec = DEFAULT_COOLDOWN_SECONDS) {
  return { durationMs: durationSec * 1000, endsAt: null };
}

/**
 * Begin the countdown at `now` — but ONLY from an inactive state.
 *
 * A start while already counting returns the input state UNCHANGED (same object reference — the
 * DOM layer keys on that to skip creating a second interval / re-announcing). This "no double
 * start" rule is deliberate: every legitimate start corresponds to a send the backend accepted,
 * and a send can only be triggered while the button is enabled, i.e. while no cooldown is
 * running — so a second start mid-window is by definition a caller bug, and silently extending
 * the user's wait would be the wrong way to absorb it.
 *
 * @param {{durationMs: number, endsAt: number|null}} state current state (not mutated)
 * @param {number} now injected timestamp (Date.now() in production, anything in tests)
 * @returns {{durationMs: number, endsAt: number|null}} a NEW active state, or `state` itself if
 *   the cooldown was already running
 */
export function start(state, now) {
  if (isActive(state, now)) return state; // no double-start — see doc comment
  return { ...state, endsAt: now + state.durationMs };
}

/**
 * Cancel the countdown (step left, sign-out, sign-in — any "this button's context is gone").
 * Idempotent: resetting an inactive state returns the same reference, so callers can reset
 * unconditionally on every step change without churn.
 *
 * @param {{durationMs: number, endsAt: number|null}} state
 * @returns {{durationMs: number, endsAt: number|null}}
 */
export function reset(state) {
  if (state.endsAt == null) return state;
  return { ...state, endsAt: null };
}

/**
 * Is the cooldown still holding the button at `now`? The boundary is exclusive: at exactly
 * `endsAt` the window is OVER (remaining is 0, the button may re-enable) — matching the ceil()
 * in {@link remainingSeconds}, so "active" and "remaining > 0" can never disagree.
 *
 * @param {{durationMs: number, endsAt: number|null}} state
 * @param {number} now
 * @returns {boolean}
 */
export function isActive(state, now) {
  return state.endsAt != null && now < state.endsAt;
}

/**
 * Whole seconds left, for the "Resend in 0:29" label. Rounded UP (ceil), so the label reads the
 * full duration for the entire first second (a start at t shows "0:30" until t+1s, not a
 * flickering instant "0:29") and never shows "0:00" while the button is still disabled.
 *
 * Clamped both ways: never below 0 (long-expired / inactive states read 0), and never above the
 * configured duration — a wall clock that jumps BACKWARDS mid-window (NTP correction, OS sleep
 * weirdness) would otherwise make the label count UP past the promised window.
 *
 * @param {{durationMs: number, endsAt: number|null}} state
 * @param {number} now
 * @returns {number} 0..durationSec whole seconds
 */
export function remainingSeconds(state, now) {
  if (state.endsAt == null) return 0;
  const remaining = Math.ceil((state.endsAt - now) / 1000);
  return Math.max(0, Math.min(remaining, Math.ceil(state.durationMs / 1000)));
}

/**
 * One observation of the clock — the single call the DOM layer's interval makes each second.
 *
 * Returns the full render decision in one shot:
 *   • `active`    — keep the button disabled and show `remaining`;
 *   • `expired`   — TRUE on exactly the observation that crossed the deadline (the returned state
 *                   is already reset, so every later tick reports `active: false, expired: false`).
 *                   This edge-trigger is what lets the DOM layer re-enable + announce "you can
 *                   request a new code now" precisely once, however late the tick arrives;
 *   • `remaining` — whole seconds left (0 when inactive/expired).
 *
 * @param {{durationMs: number, endsAt: number|null}} state current state (not mutated)
 * @param {number} now injected timestamp
 * @returns {{state: {durationMs: number, endsAt: number|null}, active: boolean,
 *   remaining: number, expired: boolean}}
 */
export function tick(state, now) {
  if (state.endsAt == null) return { state, active: false, remaining: 0, expired: false };
  if (!isActive(state, now)) {
    // The deadline passed since the last look: report the crossing once and hand back a clean
    // inactive state so the event can't re-fire.
    return { state: reset(state), active: false, remaining: 0, expired: true };
  }
  return { state, active: true, remaining: remainingSeconds(state, now), expired: false };
}

/**
 * Format whole seconds as the m:ss countdown the label shows — 30 → "0:30", 90 → "1:30",
 * 5 → "0:05". Minutes are not zero-padded (nobody writes "00:30" on a resend link); seconds
 * always are, so the width only changes once per minute boundary.
 *
 * @param {number} totalSeconds whole seconds, ≥ 0
 * @returns {string}
 */
export function formatRemaining(totalSeconds) {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
