// Resend-code cooldown — the DOM half (TM-866). Pairs with resend-cooldown-core.js the way
// otp-input.js pairs with otp-input-core.js: ALL timing decisions (active? remaining? did this
// tick cross the deadline?) live in the pure core; this module only wires a real <button> and a
// 1-second interval to those decisions.
//
// login.js attaches one controller per resend button (the email "Resend" quiet link and the SMS
// code step's "Text me another code" quiet link) and calls:
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
 *   isBusy?: () => boolean, codeNoun?: string, durationSec?: number}} opts
 *   `button` — the control to hold + relabel (null-safe: returns null so callers can
 *   optional-chain, matching attachOtpInput's contract);
 *   `announce` — sink for the two polite screen-reader announcements: one at start ("You can
 *   request a new email code in 30 seconds.") and one at expiry ("…now.") — deliberately NOT one
 *   per tick, which would make a screen reader narrate the whole countdown;
 *   `isBusy` — reports whether the caller currently has EVERY control disabled for an in-flight
 *   action (login.js's setBusy window). While it returns true, restore() defers the re-enable —
 *   an expiry tick or reset() landing mid-request must not hand back a clickable button whose
 *   click the single-flight run() would silently swallow (review fix on TM-866);
 *   `codeNoun` — what the announcements call the thing being resent ("email code" / "SMS code").
 *   Both cooldowns share the one #auth-status live region, so without the channel in the text an
 *   email expiry could tell a screen-reader user "you can request a new code" while they sit on
 *   the SMS step whose window is still held (review fix on TM-866);
 *   `durationSec` — window length (default {@link DEFAULT_COOLDOWN_SECONDS}).
 * @returns {{start: () => void, reset: () => void, isActive: () => boolean,
 *   syncDisabled: () => void}|null}
 */
export function attachResendCooldown({
  button,
  announce,
  isBusy,
  codeNoun = "code",
  durationSec = DEFAULT_COOLDOWN_SECONDS,
}) {
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

  /**
   * Put the button back to its shipped state (label + released width + enabled). The ENABLE is
   * skipped while the caller reports a busy window (isBusy — every control is disabled for an
   * in-flight action): writing disabled=false mid-flight would open a gap where a click passes
   * the isActive() guard only to be silently dropped by the single-flight run(), and would show
   * one enabled button inside an otherwise fully greyed-out form. The deferred enable needs no
   * bookkeeping — setBusy(false)'s blanket sweep re-enables the button when the window closes,
   * and syncDisabled() leaves it alone because the cooldown is no longer active.
   */
  function restore() {
    if (!isBusy?.()) button.disabled = false;
    button.textContent = originalLabel;
    if (button.style) button.style.minWidth = ""; // release the width reserved by start()
  }

  /**
   * Pin the button's width for the whole window — set once by start(), released by restore().
   * The display face (Gochi Hand) has PROPORTIONAL digits and no tabular-nums to opt into, so
   * each tick's label would otherwise change width by a couple of px — enough to re-distribute
   * (and, near the wrap breakpoint, re-wrap) the flex row it shares every second for 30s.
   * Measured against the widest label the window can show: '0' is the face's widest digit, so
   * "…0:00" bounds every m:ss. The swap + measure run in one synchronous task, so the browser
   * never paints the measuring label. Guarded for the fake-button unit harness (no layout there).
   */
  function reserveWidth() {
    if (!button.style || typeof button.offsetWidth !== "number") return;
    const painted = button.textContent;
    button.textContent = `Resend in ${formatRemaining(0)}`;
    const widest = button.offsetWidth; // forces layout of the widest label, never a paint
    button.textContent = painted;
    if (widest > 0) button.style.minWidth = `${widest}px`;
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
    if (result.expired) announce?.(`You can request a new ${codeNoun} now.`);
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
      reserveWidth(); // freeze the row geometry for the whole window (see doc comment above)
      timerId = setInterval(onTick, 1000);
      announce?.(`You can request a new ${codeNoun} in ${durationSec} seconds.`);
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
     * only ever DISABLES — re-enabling stays the exclusive job of the expiry tick / reset(),
     * and those defer their enable past any open busy window via isBusy (see restore()), so
     * neither direction can fight a concurrent busy window.
     */
    syncDisabled() {
      if (coreIsActive(state, Date.now())) button.disabled = true;
    },
  };
}
