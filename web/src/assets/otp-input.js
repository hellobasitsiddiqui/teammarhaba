// Six-box OTP input — the DOM half (TM-867). Pairs with otp-input-core.js the way alerts.js pairs
// with alerts-core.js: ALL decisions (which box gets which digit, where focus goes, when the code is
// complete) live in the pure core; this module only wires real <input> elements to those decisions.
//
// The markup is static in index.html (six sibling <input class="auth-otp-box"> inside a
// role="group" container) — this module ATTACHES behaviour to it rather than building it, so the
// boxes exist and are inspectable even before the module graph boots. login.js calls attachOtpInput
// once per group (email step, SMS step) and passes the auto-submit action as onComplete.
//
// Why six real inputs (not one styled input, not a contenteditable): each box is a genuine form
// control, so screen readers announce "Digit N of 6" per box, focus is per-box, and the OS numeric
// keypad + one-time-code autofill behave natively. The first box carries
// autocomplete="one-time-code": the OS suggestion inserts the WHOLE code there and the core's
// distribute() fans it out across all six boxes.

import {
  distribute,
  applyBackspace,
  arrowTarget,
  codeOf,
  emptyValues,
} from "./otp-input-core.js";

/**
 * Attach OTP behaviour to a group of single-character boxes.
 *
 * @param {{group: HTMLElement|null, onComplete?: (code: string) => void}} opts
 *   `group` — the role="group" container holding the six <input> boxes (null-safe: returns null so
 *   callers can optional-chain, e.g. if a stale cached index.html predates the boxes);
 *   `onComplete` — called with the assembled 6-digit code whenever an action leaves ALL boxes
 *   filled (type of the 6th digit, a full paste, setValue). May fire more than once — e.g. the user
 *   corrects one digit after a failed verify and completes the code again; the caller is expected
 *   to guard re-entry (login.js's run() is single-flight).
 * @returns {{boxes: HTMLInputElement[], value: () => string, setValue: (code: unknown) => void,
 *   clear: () => void, focus: () => void}|null}
 */
export function attachOtpInput({ group, onComplete }) {
  if (!group) return null;
  const boxes = Array.from(group.querySelectorAll("input"));
  if (boxes.length === 0) return null;

  // The array (not the DOM) is the source of truth; render() makes the DOM match it. Every event
  // handler follows the same shape: derive next state via the core → adopt it → render → maybe
  // complete. That keeps the DOM impossible to drift from the state the core reasoned about.
  let values = emptyValues(boxes.length);

  /** Write state into the boxes; optionally move focus (select() so typing overwrites, not appends). */
  function render(focusIndex = null) {
    boxes.forEach((box, i) => {
      if (box.value !== values[i]) box.value = values[i];
    });
    if (focusIndex != null) {
      boxes[focusIndex].focus();
      boxes[focusIndex].select();
    }
  }

  /** Adopt a core result and fire onComplete when it says the code is whole. */
  function adopt(result) {
    values = result.values;
    render(result.focusIndex);
    if (result.complete) onComplete?.(codeOf(values));
  }

  boxes.forEach((box, i) => {
    // `input` (not keydown) is the digit path: it's what fires for taps on a mobile numeric keypad,
    // IME input, AND the OS one-time-code autofill — none of which produce reliable keydowns. The
    // box's whole value goes through distribute(): a single typed digit is the 1-char case; an
    // autofill that dumped "123456" into this one box is the full-code case (fans out from box 0).
    box.addEventListener("input", () => {
      if (box.value === "") {
        // The box was emptied in place (select-all + delete / cut): clear the slot, focus stays.
        values = values.slice();
        values[i] = "";
        render();
        return;
      }
      // Select-on-focus SHOULD make typing replace a filled box's digit — but Chrome/Safari
      // collapse a focus-handler selection to a caret on the click's mouseup (the classic
      // select-on-focus bug), so the typed digit can INSERT beside the old one instead: the value
      // becomes e.g. "28" (stored "2" + typed "8"). Recognise that exact shape — two chars, one of
      // them this box's stored digit — and treat it as a replace-in-place with the NEW char.
      // Without this, distribute() would spill the second char into (and clobber) the NEXT box and
      // auto-submit a doubly-wrong code (TM-867 review fix; the pointer/mouse-up re-select below
      // prevents most occurrences — this catches whatever still slips through).
      let text = box.value;
      if (text.length === 2 && values[i]) {
        if (text[0] === values[i]) text = text[1]; // caret was after the old digit
        else if (text[1] === values[i]) text = text[0]; // caret was before it
      }
      // Non-digit input comes back from distribute() as a no-op state — render() then visibly
      // rejects it by snapping the box back to its stored value.
      adopt(distribute(values, i, text));
    });

    // Backspace + arrows are keydown because we must preventDefault BEFORE the browser mutates the
    // field (Backspace on an empty box would otherwise just bubble; arrows would move the caret
    // inside the single char instead of between boxes).
    box.addEventListener("keydown", (e) => {
      if (e.key === "Backspace") {
        e.preventDefault();
        const result = applyBackspace(values, i);
        values = result.values;
        render(result.focusIndex);
        return;
      }
      const target = arrowTarget(i, e.key, boxes.length);
      if (target != null) {
        e.preventDefault();
        boxes[target].focus();
        boxes[target].select();
      }
    });

    // Paste into ANY box distributes the whole (sanitised) code — preventDefault because otherwise
    // the browser would insert the raw multi-char string into this single box first.
    box.addEventListener("paste", (e) => {
      e.preventDefault();
      adopt(distribute(values, i, e.clipboardData?.getData("text") ?? ""));
    });

    // Select on focus so typing into an already-filled box REPLACES its digit (no appended chars).
    box.addEventListener("focus", () => box.select());

    // …but Chrome/Safari (desktop click AND iOS tap) collapse a selection made in a focus handler
    // back to a caret via the subsequent mouseup's default action. preventDefault on mouseup is
    // the canonical counter (it stops the caret placement); re-select()ing on pointerup/mouseup is
    // the belt-and-braces so the whole digit stays selected however the events interleave
    // (TM-867 review fix — pairs with the 2-char normalisation in the input handler above).
    const keepSelection = (e) => {
      e.preventDefault();
      box.select();
    };
    box.addEventListener("pointerup", keepSelection);
    box.addEventListener("mouseup", keepSelection);
  });

  return {
    /** The live box elements — login.js disables these alongside the other controls while busy. */
    boxes,

    /** The assembled code, possibly partial (e.g. "123" with three boxes filled). */
    value: () => codeOf(values),

    /**
     * Programmatic fill: distributes `code` across the boxes and fires the SAME complete callback
     * as typing/pasting would. This is the seam TM-407 (native-shell autofill bridge) will call
     * later — the native side hands the code straight to setValue and the normal auto-verify runs.
     */
    setValue(code) {
      adopt(distribute(emptyValues(boxes.length), 0, code));
    },

    /** Empty every box (step reset / sign-out) without touching focus. */
    clear() {
      values = emptyValues(boxes.length);
      render();
    },

    /** Focus the first box — what the step-reveal calls, mirroring the old single-input focus(). */
    focus() {
      boxes[0].focus();
      boxes[0].select();
    },
  };
}
