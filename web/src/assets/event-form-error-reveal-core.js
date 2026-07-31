// event-form-error-reveal-core.js — TM-1197
//
// The generalised "no error may hide behind a collapsed section" mechanism for the admin event form,
// generalising the retired TM-1066 More-options force-open and TM-1195's per-key (timezone / booking-cutoff)
// section force-open to EVERY collapsible section, on create AND edit, for client (validate) AND server
// (RFC-7807) errors.
//
// It is DISPLAY-ONLY: it reads the ALREADY-PAINTED DOM — the form's error state is expressed as
// `aria-invalid="true"` on each errored input (set by admin-events.js `setFieldError`) — and never touches
// readDraft / validateEventDraft / buildEventPayload / toFormModel / the server-error routing. So it lives in
// its own pure core (the codebase's `*-core.js` idiom) and is unit-testable against a minimal fake DOM without
// importing the Firebase-tainted admin-events.js module.
//
// On a failed submit it:
//   1. opens EVERY native <details> (a collapsible SECTION or a nested reveal, e.g. the age-band / price
//      Custom reveal) that CONTAINS an invalid field — walking up the ancestor <details> chain so a field
//      nested two folds deep surfaces fully. No per-field→section map is needed: membership is read live off
//      the DOM, so it can never drift from the actual layout.
//   2. scrolls the FIRST errored field's section into view (block:"center"), and
//   3. focuses the FIRST invalid field.
// "First" = DOM order — `querySelectorAll` returns document order, which is the on-screen reading order across
// all sections. scrollIntoView / focus are feature-detected (jsdom / the CI fake DOM may not implement them).

/**
 * Reveal + scroll-to + focus the first errored field on a failed submit. Pure w.r.t. app state — it only
 * reads/opens DOM nodes already marked invalid.
 *
 * @param {ParentNode|null|undefined} formEl the event <form> (or any container holding the fields + sections)
 * @param {{sectionSelector?: string}} [opts] `sectionSelector` = the class that identifies a top-level
 *        collapsible section (default the buildFormSection class) — the node scrolled into view; falls back to
 *        the nearest <details>, then the field itself, if absent.
 * @returns {HTMLElement|null} the first invalid field that was focused/scrolled to, or null if none.
 */
export function revealFirstError(formEl, opts = {}) {
  if (!formEl || typeof formEl.querySelectorAll !== "function") return null;
  const sectionSelector = opts.sectionSelector || ".tm-form-section";
  const invalids = formEl.querySelectorAll('[aria-invalid="true"]');
  if (!invalids || !invalids.length) return null;

  // (1) Open every <details> ancestor of every invalid field — sections AND nested reveals.
  for (const input of invalids) {
    let node = typeof input.closest === "function" ? input.closest("details") : null;
    while (node) {
      node.open = true;
      const parent = node.parentElement;
      node = parent && typeof parent.closest === "function" ? parent.closest("details") : null;
    }
  }

  // (2)+(3) Scroll the first errored field's section into view + focus the field.
  const first = invalids[0];
  const closest = typeof first.closest === "function" ? first.closest.bind(first) : () => null;
  const target = closest(sectionSelector) || closest("details") || first;
  if (target && typeof target.scrollIntoView === "function") {
    target.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  if (typeof first.focus === "function") first.focus();
  return first;
}
