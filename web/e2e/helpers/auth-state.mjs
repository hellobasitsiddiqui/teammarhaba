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

/** TM-1097: tapping the "Sign out" row now opens a CHOOSER (ui.js modal) — "Sign out on this device"
 *  vs "Sign out everywhere" — instead of going straight to a confirm dialog. These target its buttons. */
export const SIGNOUT_CHOOSER = ".tm-signout-chooser";
export const SIGNOUT_THIS_DEVICE = "#signout-this-device";
export const SIGNOUT_EVERYWHERE = "#signout-everywhere";

/** Wait until the router has rendered a signed-IN state (any route, any viewport, gated or not). */
export async function expectSignedIn(page, opts = undefined) {
  await expect(page.locator(SIGNED_IN)).toBeAttached(opts);
}

/**
 * Expand a collapsible Profile section (TM-879) if it isn't already open, so a spec can interact with
 * content that now lives inside a default-COLLAPSED disclosure panel (edit / membership / security /
 * appearance / diagnostics). The strength + interests sections default OPEN, so a spec touching those
 * needs no call. Idempotent: clicking the header only when it reads aria-expanded="false", so calling
 * it on an already-open section is a no-op. Waits for the panel to be un-hidden before returning.
 *
 * @param {import('@playwright/test').Page} page
 * @param {"strength"|"interests"|"membership"|"edit"|"security"|"appearance"|"diagnostics"} id
 */
export async function expandProfileSection(page, id) {
  const header = page.locator(`#profile-section-${id}-btn`);
  await expect(header).toBeVisible();
  if ((await header.getAttribute("aria-expanded")) !== "true") {
    await header.click();
  }
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(`#profile-section-${id}-panel`)).toBeVisible();
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
  // TM-1097: the row opens a chooser; the this-device option is the deliberate confirmation (no second
  // dialog) and reproduces the pre-TM-1097 "sign out this session" behaviour the specs rely on.
  await expect(page.locator(SIGNOUT_CHOOSER)).toBeVisible();
  await page.locator(SIGNOUT_THIS_DEVICE).click();
  await expectSignedOut(page);
}
