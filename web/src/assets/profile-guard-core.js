// Unsaved-changes guard for the profile edit form — pure logic core (TM-1027).
//
// The Profile hub (#/profile) hosts a live inline edit form. If a user has typed unsaved edits (or an
// avatar upload / phone-verify is mid-flight) and then tries to leave — via the bottom tab bar, any
// in-app hash link, or a browser unload — they should be WARNED so they don't lose the edits silently.
//
// Like the other Profile logic (profile-core.js), the pure DECISIONS live HERE so they're unit-testable
// in plain Node (`node --test`) with no DOM, no router, and no Firebase. Two seams are involved and both
// resolve to these functions:
//   • profile.js exposes whether the form is DIRTY (see isProfileDirty) — collectPatch() non-empty OR a
//     pending avatar upload OR an in-flight phone verify;
//   • router.js consults navGuardDecision() on every attempted hash navigation (the restore-hash
//     intercept) AND wires the native `beforeunload` off the same dirty signal.
//
// NONE of these functions touch the DOM, the router, or the network — they take plain booleans/strings
// and return plain data the callers act on.

// The 2-button confirm copy (locked TM-1027 decision — reuse ui.js confirmDialog as-is, no third
// "Save" button). Exported so profile.js/router.js and the tests share ONE definition and can never
// drift on the wording. `confirm` (the destructive button) is the Discard action; `cancel` keeps
// the user on the form. `danger:true` — leaving loses data, so the confirm button reads as destructive.
export const UNSAVED_GUARD_DIALOG = Object.freeze({
  title: "Discard changes?",
  message: "You have unsaved changes to your profile. If you leave now they'll be lost.",
  confirmLabel: "Discard changes",
  cancelLabel: "Keep editing",
  danger: true,
});

// The native `beforeunload` prompt text. Modern browsers IGNORE any custom string and show their own
// generic "Leave site?" wording, but a NON-EMPTY returnValue is still required to trigger the prompt at
// all — so this is set purely to arm the native dialog. Kept here so the one call site reads clearly.
export const BEFOREUNLOAD_PROMPT = "You have unsaved changes to your profile.";

/**
 * Is the profile edit form DIRTY — i.e. does leaving it now risk losing work? (TM-1027)
 *
 * DIRTY when ANY of the three edit signals is live:
 *   • `patchNonEmpty` — collectPatch() would send at least one changed field (the primary "typed an
 *     edit" signal; collectPatch already omits unchanged/blank fields, so a non-empty patch == a real
 *     change). A successful save re-fills the form from the server response, which empties the patch —
 *     so this naturally goes false after save, clearing the dirty state per the AC.
 *   • `pendingAvatar` — an avatar upload is currently transferring bytes (navigating away would abort
 *     it). Avatar uploads persist immediately to Firebase, so this is ONLY the in-flight window.
 *   • `phoneVerifyInFlight` — a phone OTP verify is between "send code" and confirm (TM-982); leaving
 *     drops the stale verification the same way editing the number does.
 *
 * All three inputs are coerced to booleans so a caller passing a truthy/falsy non-boolean (e.g. a
 * verificationId string, or `undefined` before the form mounts) still yields a clean boolean verdict.
 *
 * @param {{patchNonEmpty?: any, pendingAvatar?: any, phoneVerifyInFlight?: any}} [signals]
 * @returns {boolean} true when leaving should be guarded.
 */
export function isProfileDirty({ patchNonEmpty, pendingAvatar, phoneVerifyInFlight } = {}) {
  return Boolean(patchNonEmpty) || Boolean(pendingAvatar) || Boolean(phoneVerifyInFlight);
}

/**
 * The in-app navigation guard decision (TM-1027) — should an attempted hash navigation be intercepted
 * with the "Discard changes?" prompt, or allowed through untouched?
 *
 * We only ever guard a navigation that LEAVES the profile edit form while it's dirty. Staying on the
 * profile hub, or moving anywhere while the form is clean, is always free (no false prompt — the AC).
 * The renderer/router owns HOW to prompt (confirmDialog + restore-hash); this only decides WHETHER to.
 *
 *   • not leaving the profile (`isLeavingProfile` false) → "allow" — a same-view re-render, or a nav
 *     that doesn't originate from the edit form, never prompts;
 *   • leaving, but the form is clean (`dirty` false) → "allow" — no work to lose;
 *   • leaving while dirty → "prompt" — surface the discard confirm before committing the nav.
 *
 * @param {{dirty?: boolean, isLeavingProfile?: boolean}} [ctx]
 * @returns {"prompt"|"allow"}
 */
export function navGuardDecision({ dirty, isLeavingProfile } = {}) {
  if (!isLeavingProfile) return "allow";
  return dirty ? "prompt" : "allow";
}

/**
 * Is this hash navigation LEAVING the profile edit form? (TM-1027)
 *
 * True only when the FROM hash is the editable Profile hub (`#/profile`) and the TO hash is something
 * else. Two deliberate carve-outs:
 *   • the public-profile preview (`#/profile/public`) is NOT the edit form, so leaving it never guards
 *     — and re-entering the hub isn't "leaving" either;
 *   • navigating hub → hub (identical hash, e.g. a re-render) is not a departure, so it never prompts.
 *
 * The interests "Manage" CTA opens an in-place picker (NOT a navigation), so it never reaches this
 * function at all — no guard needed there (the locked TM-1027 decision), nothing to special-case here.
 *
 * @param {string|null|undefined} fromHash the hash being left.
 * @param {string|null|undefined} toHash the hash being navigated to.
 * @param {string} [editRoute] the editable Profile hub route (default "#/profile").
 * @returns {boolean} true when the nav leaves the edit form.
 */
export function isLeavingProfileEdit(fromHash, toHash, editRoute = "#/profile") {
  return fromHash === editRoute && toHash !== editRoute;
}
