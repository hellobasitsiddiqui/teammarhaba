// Six-box OTP input — the pure, browser-free core (TM-867).
//
// Split out of otp-input.js the same way alerts-core.js was split out of alerts.js: this is the
// unit-testable half — given the current box values and a user action (typed/pasted text at a box,
// Backspace at a box, an arrow key), decide the NEXT box values, WHICH box takes focus, and whether
// the code is now COMPLETE — with zero DOM/event dependencies, so `node --test web/tools/*.test.mjs`
// (the PR gate) can guard the behaviour without a browser. otp-input.js owns the actual <input>
// elements and events; login.js owns what "complete" means (auto-verify).
//
// The state shape is deliberately dumb: an array of OTP_LENGTH single-character strings ("" = empty
// box). Every function here is pure — it returns a NEW array and never mutates its input — so the
// DOM layer can treat "state in → render out" as the whole contract.

/** How many digits (and therefore boxes) a code has — matches the backend's 6-digit email/SMS codes. */
export const OTP_LENGTH = 6;

/**
 * Strip everything that isn't a digit and cap the length. This single choke-point is how "non-digit
 * input rejected" and "paste strips spaces/formatting" are both enforced: whatever the browser hands
 * us (typed char, pasted "123 456", an OS one-time-code autofill), only 0-9 survives.
 *
 * Eastern Arabic (٠١٢٣٤٥٦٧٨٩, U+0660–U+0669) and Extended Arabic-Indic / Persian (۰-۹,
 * U+06F0–U+06F9) digits NORMALISE to ASCII first rather than being stripped: an Arabic-locale
 * numeric keypad (very relevant to this product's Saudi user base) can emit these for the digit
 * keys, and stripping them would make every keystroke silently vanish with no error at all.
 *
 * @param {unknown} text anything the DOM produced (input value, clipboard text); non-strings coerce
 * @param {number} [max] maximum digits to keep (default OTP_LENGTH)
 * @returns {string} up to `max` ASCII digit characters
 */
export function sanitizeDigits(text, max = OTP_LENGTH) {
  return String(text ?? "")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)) // Arabic-Indic → ASCII
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0)) // Persian → ASCII
    .replace(/\D/g, "")
    .slice(0, max);
}

/**
 * A fresh all-empty state.
 * @param {number} [length]
 * @returns {string[]}
 */
export function emptyValues(length = OTP_LENGTH) {
  return Array(length).fill("");
}

/** @param {string[]} values @returns {string} the assembled code, e.g. "123456" (may be partial) */
export function codeOf(values) {
  return values.join("");
}

/** @param {string[]} values @returns {boolean} true when every box holds exactly one digit */
export function isComplete(values) {
  return values.every((v) => v.length === 1);
}

/**
 * Apply typed/pasted/autofilled text at a box — the one write-path for digits.
 *
 * Semantics (the tests pin these):
 *   • A FULL-length code (after sanitising) fills ALL boxes from box 0, no matter which box received
 *     it. This is what makes "paste into ANY box" and the OS one-time-code autofill (which inserts
 *     the whole code into the focused box) both work.
 *   • Anything shorter writes from the given box onward, overwriting, truncated at the last box —
 *     the normal "type a digit, auto-advance" path is just the 1-digit case of this.
 *   • Text with no digits at all is a no-op (non-digit input rejected): same values, same focus.
 *
 * @param {string[]} values current state (not mutated)
 * @param {number} index the box the text landed in (0-based)
 * @param {unknown} text raw text from the DOM (unsanitised)
 * @returns {{values: string[], focusIndex: number, complete: boolean}} next state, the box that
 *   should take focus (the box after the last digit written, clamped to the final box), and whether
 *   all boxes are now filled (the caller's cue to auto-submit)
 */
export function distribute(values, index, text) {
  const digits = sanitizeDigits(text, values.length);
  if (!digits) return { values: values.slice(), focusIndex: index, complete: false };

  // Full code anywhere ⇒ start over from box 0; partial input writes forward from where it landed.
  const start = digits.length === values.length ? 0 : index;
  const next = values.slice();
  const usable = digits.slice(0, next.length - start); // never write past the last box
  for (let i = 0; i < usable.length; i++) next[start + i] = usable[i];

  return {
    values: next,
    focusIndex: Math.min(start + usable.length, next.length - 1),
    complete: isComplete(next),
  };
}

/**
 * Apply Backspace at a box. Two cases, matching the muscle-memory of every OTP widget:
 *   • the box has a digit → clear IT, keep focus here (a second Backspace then walks left);
 *   • the box is empty   → clear the PREVIOUS box and move focus onto it (clamped at box 0).
 *
 * @param {string[]} values current state (not mutated)
 * @param {number} index the box that received Backspace
 * @returns {{values: string[], focusIndex: number}}
 */
export function applyBackspace(values, index) {
  const next = values.slice();
  if (next[index]) {
    next[index] = "";
    return { values: next, focusIndex: index };
  }
  const prev = Math.max(0, index - 1);
  next[prev] = "";
  return { values: next, focusIndex: prev };
}

/**
 * Where an arrow key moves focus, or null for any other key (caller lets it through untouched).
 * Clamped at both ends — no wrap-around, matching native form-field expectations.
 *
 * @param {number} index the currently-focused box
 * @param {string} key a KeyboardEvent.key value
 * @param {number} [length]
 * @returns {number|null}
 */
export function arrowTarget(index, key, length = OTP_LENGTH) {
  if (key === "ArrowLeft") return Math.max(0, index - 1);
  if (key === "ArrowRight") return Math.min(length - 1, index + 1);
  return null;
}

/**
 * Wrap an async function so that re-entrant calls while one is in flight are silently DROPPED
 * (they resolve to undefined without invoking the function). login.js wraps its shared `run()`
 * in this: the OTP widget's auto-submit and the visible "Sign in" button can never race a second
 * verify request out of the door. The lock always releases — even when the wrapped call throws —
 * so a failed verify never bricks the form.
 *
 * @template {(...args: any[]) => Promise<any>} F
 * @param {F} fn
 * @returns {(...args: Parameters<F>) => Promise<Awaited<ReturnType<F>>|undefined>}
 */
export function makeSingleFlight(fn) {
  let inFlight = false;
  return async (...args) => {
    if (inFlight) return undefined; // a verify is already running — the extra trigger no-ops
    inFlight = true;
    try {
      return await fn(...args);
    } finally {
      inFlight = false;
    }
  };
}
