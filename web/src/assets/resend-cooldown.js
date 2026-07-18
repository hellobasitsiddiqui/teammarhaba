// Resend-code cooldown — the DOM half (TM-866). Pairs with resend-cooldown-core.js the way
// otp-input.js pairs with otp-input-core.js: ALL timing decisions (active? remaining? did this
// tick cross the deadline?) live in the pure core; this module only wires a real <button> and a
// 1-second interval to those decisions.
//
// login.js attaches one controller per send/resend button (the email "Resend" quiet link and the
// SMS "Text me a code" button) and calls:
//   • start()        — after a send the backend ACCEPTED (a failed send never starts a cooldown,
//                      so the user can retry immediately);
//   • reset()        — when the button's step is left (back to the email step, sign-out, sign-in),
//                      which also clears the interval — no timer leaks across step changes;
//   • isActive()     — the click-handler guard: a click during the window is a no-op. The disabled
//                      attribute already stops real users; this stops the programmatic/synthetic
//                      paths a disabled attribute can't (dispatchEvent'd clicks) — same philosophy
//                      as login.js's single-flight run();
//   • syncDisabled() — called by setBusy() after its blanket enable/disable sweep, so the busy
//                      window closing can never flicker-enable a button mid-cooldown (see below).
//
// While counting, the button is disabled and its text becomes "Resend in 0:29" (ticking once per
// second); at zero the ORIGINAL label and enabled state come back. Both wired buttons are
// text-only (no inner icon markup), so a plain textContent swap is safe — anyone adding an SVG
// inside these buttons later needs to revisit the label handling here.

import {
  DEFAULT_COOLDOWN_SECONDS,
  create,
  start as coreStart,
  reset as coreReset,
  isActive as coreIsActive,
  tick,
  formatRemaining,
} from "./resend-cooldown-core.js";

/**
 * Attach cooldown behaviour to one send/resend button.
 *
 * @param {{button: HTMLButtonElement|null, announce?: (message: string) => void,
 *   durationSec?: number}} opts
 *   `button` — the control to hold + relabel (null-safe: returns null so callers can
 *   optional-chain, matching attachOtpInput's contract);
 *   `announce` — sink for the two polite screen-reader announcements: one at start ("You can
 *   request a new code in 30 seconds.") and one at expiry ("You can request a new code now.") —
 *   deliberately NOT one per tick, which would make a screen reader narrate the whole countdown;
 *   `durationSec` — window length (default {@link DEFAULT_COOLDOWN_SECONDS}).
 * @returns {{start: () => void, reset: () => void, isActive: () => boolean,
 *   syncDisabled: () => void}|null}
 */
export function attachResendCooldown({ button, announce, durationSec = DEFAULT_COOLDOWN_SECONDS }) {
  if (!button) return null;

  // Captured once so reset/expiry can restore EXACTLY what the markup shipped ("Resend" /
  // "Text me a code") — the countdown label is derived state, never the source of truth.
  const originalLabel = button.textContent;

  let state = create(durationSec);
  let timerId = null; // the 1-second interval while counting; null whenever inactive

  function stopTimer() {
    if (timerId != null) {
      clearInterval(timerId);
      timerId = null;
    }
  }

  /** Put the button back to its shipped state (label + enabled). */
  function restore() {
    button.disabled = false;
    button.textContent = originalLabel;
  }

  /**
   * One clock observation — the interval body. Deadline-based (the core derives remaining from
   * Date.now()), so a late or skipped interval fire (throttled background tab, a test clock
   * fast-forward that fires due timers only once) still renders the correct remaining time and
   * still crosses the finish line exactly once.
   */
  function onTick() {
    const result = tick(state, Date.now());
    state = result.state;
    if (result.active) {
      button.textContent = `Resend in ${formatRemaining(result.remaining)}`;
      return;
    }
    // Inactive: the window is over (or was reset under us). Stop ticking and restore the button;
    // announce ONLY on the tick that genuinely crossed the deadline (`expired` is edge-triggered
    // in the core), never on a plain reset — leaving a step shouldn't chat to the screen reader.
    stopTimer();
    restore();
    if (result.expired) announce?.("You can request a new code now.");
  }

  return {
    /**
     * Begin the window — call ONLY after a send the backend accepted. Usually invoked inside
     * run()'s busy window (every control already disabled); the disabled + countdown label set
     * here then survives setBusy(false)'s re-enable sweep via syncDisabled().
     */
    start() {
      const next = coreStart(state, Date.now());
      if (next === state) return; // already counting (core's no-double-start) — keep the first window
      state = next;
      stopTimer(); // belt-and-braces: never two intervals, whatever a future caller does
      onTick(); // paint "Resend in 0:30" + disabled NOW, not a second from now
      button.disabled = true;
      timerId = setInterval(onTick, 1000);
      announce?.(`You can request a new code in ${durationSec} seconds.`);
    },

    /** Cancel + restore, silently — the step-left / sign-out / sign-in path. Idempotent. */
    reset() {
      stopTimer();
      state = coreReset(state);
      restore();
    },

    /** Is the window still open? The click-handler guard for programmatic clicks. */
    isActive() {
      return coreIsActive(state, Date.now());
    },

    /**
     * Re-assert `disabled` if (and only if) the window is open — called by setBusy() right after
     * its blanket sweep writes every control's disabled flag. Runs in the same synchronous task
     * as the sweep, so the browser never paints the in-between enabled state (no flicker). It
     * only ever DISABLES — re-enabling stays the exclusive job of the expiry tick / reset(), so
     * this can never fight a concurrent busy window.
     */
    syncDisabled() {
      if (coreIsActive(state, Date.now())) button.disabled = true;
    },
  };
}
