// Shared e2e auth-state helper (TM-906) — THE one place specs read "am I signed in?" from, and the
// one way specs sign out.
//
// WHY THIS EXISTS
// ---------------
// TM-906 removed the top-nav sign-out button entirely: sign-out now lives ONLY on the Profile hub's
// "Sign out" menu row (#profile-signout-row, profile.js), behind the styled ui.js confirmDialog.
// ~20 specs used that nav button's visibility as their "signed in" signal — a poor signal even
// before its removal, because a top-nav element:
//   • collapses into the hamburger at phone widths (toBeVisible() never holds — see the old
//     golden-path/responsive-mobile workarounds that asserted the `hidden` ATTRIBUTE instead);
//   • gets reshuffled whenever the nav changes (this migration is exactly that bill coming due).
//
// THE NEW SIGNAL: `body[data-auth]`, written by router.js render() on every hashchange + auth
// change: "signed-in" | "signed-out" (absent only before the first render). It is:
//   • viewport-independent (an attribute on <body> — no CSS collapse),
//   • route-independent (render() runs for every route),
//   • gate-independent (set while the TM-250 onboarding / TM-170 terms / TM-880 phone gates are up,
//     which HIDE the tab bar and most nav — so don't use #app-tabbar as a signed-in signal),
//   • timing-equivalent to the old button (the same render() used to flip the button's hidden flag).
//
// USE THESE, don't hand-roll: future specs import from here so the next reshuffle is a one-file fix.

import { expect } from "@playwright/test";

/** Selector matching <body> once the router has rendered a signed-IN auth state. */
export const SIGNED_IN = 'body[data-auth="signed-in"]';

/** Selector matching <body> once the router has rendered a signed-OUT auth state. */
export const SIGNED_OUT = 'body[data-auth="signed-out"]';

/** The Profile hub's "Sign out" menu row — the ONLY sign-out entry in the app (TM-906). */
export const SIGNOUT_ROW = "#profile-signout-row";

/** The styled confirm dialog (ui.js confirmDialog) and its two buttons. The confirm button is the
 *  destructive-styled one; the cancel button is the plain sibling in the same actions strip. */
export const CONFIRM_DIALOG = ".tm-dialog";
export const CONFIRM_BUTTON = ".tm-dialog .tm-btn-danger";
export const CANCEL_BUTTON = ".tm-dialog .tm-dialog-actions .tm-btn:not(.tm-btn-danger)";

/** Wait until the router has rendered a signed-IN state (any route, any viewport, gated or not). */
export async function expectSignedIn(page, opts = undefined) {
  await expect(page.locator(SIGNED_IN)).toBeAttached(opts);
}

/** Wait until the router has rendered a signed-OUT state (stronger than "not signed in": it also
 *  proves the router ran, so it can't pass vacuously before the first render). */
export async function expectSignedOut(page, opts = undefined) {
  await expect(page.locator(SIGNED_OUT)).toBeAttached(opts);
}

/**
 * Sign out the signed-in user the way a real user now must (TM-906): Profile hub → "Sign out" row →
 * styled confirm dialog → destructive confirm. Waits for the router to reflect the signed-out state
 * before returning (so the TM-720 onSignedOut reset chain has fired by then).
 *
 * Navigates by hash (no full reload) so it works from any in-app screen. Only callable for an
 * ONBOARDED user — the first-run gates block #/profile (and deliberately have no sign-out).
 */
export async function signOutViaProfile(page) {
  await page.evaluate(() => {
    window.location.hash = "#/profile";
  });
  const row = page.locator(SIGNOUT_ROW);
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.locator(CONFIRM_DIALOG)).toBeVisible();
  await page.locator(CONFIRM_BUTTON).click();
  await expectSignedOut(page);
}
