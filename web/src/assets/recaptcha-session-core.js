// Shared invisible-reCAPTCHA verifier lifecycle (TM-1007) — pure, dependency-free, node-testable.
//
// WHY THIS EXISTS: the phone flows (login.js SMS sign-in + the onboarding gate's verify-and-link)
// used to build a FRESH RecaptchaVerifier on every send — `old.clear()` then `new RecaptchaVerifier`
// on the same container element. That killed every RESEND: in the Firebase modular SDK, `clear()`
// on an *invisible* verifier does NOT remove the already-rendered widget DOM from the container
// (recaptcha_verifier.ts only strips childNodes for visible widgets), so the second construction
// dies in grecaptcha.render with "reCAPTCHA has already been rendered in this element". First send
// = clean container = fine; resend = dirty container = the generic "Couldn't verify that number".
//
// THE CONTRACT (Firebase-idiomatic): an invisible verifier is created ONCE per verify session and
// REUSED across sends. That's how the SDK is designed — `_verifyPhoneNumber` calls
// `verifier._reset()` in a finally block after every send, re-arming the widget for the next one.
// A NEW verifier is only built for a genuinely new session: a different/remounted container, or a
// retry after the caller discarded a failed verifier. And whenever we DO build fresh, the container
// is fully emptied first, so a leftover widget can never re-trigger the dirty-container throw.
//
// The caller (auth.js) owns a mutable `session` slot object `{ verifier, container }` and passes a
// `create(containerEl)` factory (the actual `new RecaptchaVerifier(...)`) — keeping this module
// free of the `https:` gstatic imports so it runs under `node --test` (see
// web/tools/recaptcha-session-core.test.mjs, the TM-1007 regression suite).

/**
 * Get the verifier for a phone-code send: reuse the live one when it is bound to this exact,
 * still-attached container (the RESEND case), otherwise retire it and build a fresh one into a
 * fully-emptied container (the new-session case).
 *
 * @param {{verifier: object|null, container: object|null}} session the caller-owned mutable slot.
 * @param {HTMLElement} containerEl the invisible-reCAPTCHA host for THIS send.
 * @param {(containerEl: HTMLElement) => object} create factory that constructs a new verifier.
 * @returns {object} the verifier to pass to the Firebase phone API.
 */
export function obtainRecaptchaVerifier(session, containerEl, create) {
  // RESEND: same host element, still in the document → the widget is live; reuse it. (The
  // `!== false` form treats fake test elements without `isConnected` as attached.)
  if (session.verifier && session.container === containerEl && containerEl.isConnected !== false) {
    return session.verifier;
  }

  // New session — retire whatever verifier was left behind (other flow / unmounted view).
  // clear() throws if it was never rendered or was already cleared; both are non-fatal here.
  if (session.verifier) {
    try {
      session.verifier.clear();
    } catch {
      /* already cleared / never rendered — non-fatal. */
    }
  }

  // Fully empty the host BEFORE constructing: clear() leaves an invisible widget's DOM in place
  // (see header), and grecaptcha.render throws on a non-empty host. replaceChildren() is the
  // one-call reset; the loop covers ancient WebViews without it.
  if (typeof containerEl.replaceChildren === "function") {
    containerEl.replaceChildren();
  } else {
    while (containerEl.firstChild) {
      containerEl.removeChild(containerEl.firstChild);
    }
  }

  session.verifier = create(containerEl);
  session.container = containerEl;
  return session.verifier;
}

/**
 * Drop the live verifier (best-effort clear) so the NEXT send builds fresh. Called by auth.js when
 * a send FAILS — a verifier that just errored may hold a consumed/expired token or a wedged widget,
 * and reusing it would strand the user; the next obtain resets the container and starts clean.
 *
 * @param {{verifier: object|null, container: object|null}} session the caller-owned mutable slot.
 */
export function discardRecaptchaVerifier(session) {
  if (session.verifier) {
    try {
      session.verifier.clear();
    } catch {
      /* already cleared / never rendered — non-fatal. */
    }
  }
  session.verifier = null;
  session.container = null;
}
