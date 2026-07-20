import { test, expect } from "@playwright/test";
import { EVENT_GOER } from "../fixtures.mjs";
import { CONFIRM_DIALOG, CONFIRM_BUTTON, CANCEL_BUTTON } from "../helpers/auth-state.mjs";

// TM-906 confirm-gate regression — proves sign-out is GATED behind the styled confirm dialog:
//
//   1. clicking the Profile hub's "Sign out" row does NOT sign out by itself — the confirm dialog
//      opens and the session stays live;
//   2. CANCEL is a genuine no-op — dialog gone, session intact, still on the Profile hub;
//   3. CONFIRM really signs out — Firebase signOut → onAuthChanged(null) (which is what fires the
//      TM-720 onSignedOut reset chain, covered in depth by signout-state-leak.spec.mjs).
//
// FAIL-BEFORE / PASS-AFTER: on the pre-TM-906 tree the hub row called signOut() directly — no
// dialog, session gone on the first click — so test 1 fails RED there (dialog never appears; the
// signed-out login panel shows instead). On the TM-906 tree all three pass. The row is located by
// its visible label inside the hub menu (not the new #profile-signout-row id) precisely so the spec
// RESOLVES the row on both trees and the red run fails on the missing BEHAVIOUR, not a missing id.
//
// Signed-in/-out signals are tree-agnostic for the same reason: the login panel's visibility
// (#auth-signed-out), which predates TM-906, rather than the new body[data-auth] attribute.

// Suppress the first-run product tour (TM-147) so its backdrop can't overlay the controls under
// test — the identical localStorage init-script every other auth spec uses.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const orig = Storage.prototype.getItem;
    Storage.prototype.getItem = function (k) {
      return typeof k === "string" && k.startsWith("tm.tour.")
        ? JSON.stringify({ done: true })
        : orig.call(this, k);
    };
  });
});

/** Sign in the seeded, already-onboarded EVENT_GOER and land on the Profile hub with the menu
 *  rendered. Email-code is the default front door; the password form is under "Try another way". */
async function openProfileSignedIn(page) {
  await page.goto("/#/login");
  await expect(page.locator("#auth-signed-out")).toBeVisible();
  await page.fill("#email", EVENT_GOER.email);
  await page.click("#try-another-btn");
  await page.fill("#password", EVENT_GOER.password);
  await page.click("#signin-btn");
  await expect(page.locator("#auth-signed-out")).toBeHidden();
  await page.evaluate(() => {
    window.location.hash = "#/profile";
  });
  const row = page.locator(".tm-pf-menu-row", { hasText: "Sign out" });
  await expect(row).toBeVisible();
  return row;
}

test("@auth TM-906: clicking Sign out opens the confirm dialog and does NOT sign out by itself", async ({ page }) => {
  const row = await openProfileSignedIn(page);
  await row.click();

  // THE CRUX: the styled confirm dialog (ui.js confirmDialog — never native confirm()) is up, with
  // the agreed copy and a destructive-styled confirm button...
  const dialog = page.locator(CONFIRM_DIALOG);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Sign out?");
  await expect(dialog).toContainText("You'll need your code to sign back in.");
  await expect(page.locator(CONFIRM_BUTTON)).toHaveText("Sign out");

  // ...and the click alone did NOT end the session: the signed-out login panel has not returned.
  // (Pre-TM-906 the row signed out immediately — no dialog, panel back — so this test failed RED.)
  await expect(page.locator("#auth-signed-out")).toBeHidden();
});

test("@auth TM-906: cancelling the confirm keeps the session intact", async ({ page }) => {
  const row = await openProfileSignedIn(page);
  await row.click();
  await expect(page.locator(CONFIRM_DIALOG)).toBeVisible();

  await page.locator(CANCEL_BUTTON).click();
  await expect(page.locator(CONFIRM_DIALOG)).toBeHidden();

  // Session intact: still on the Profile hub with its menu (the guard would bounce a signed-out
  // user off this protected route), and the signed-out login panel never returned.
  await expect(page.locator(".tm-pf-menu-row", { hasText: "Sign out" })).toBeVisible();
  await expect(page.locator("#auth-signed-out")).toBeHidden();
  // Belt-and-braces: a fresh navigation to the protected profile still renders it (no re-login).
  await page.evaluate(() => {
    window.location.hash = "#/home";
  });
  await page.evaluate(() => {
    window.location.hash = "#/profile";
  });
  await expect(page.locator(".tm-pf-menu-row", { hasText: "Sign out" })).toBeVisible();
});

test("@auth TM-906: confirming really signs out", async ({ page }) => {
  const row = await openProfileSignedIn(page);
  await row.click();
  await expect(page.locator(CONFIRM_DIALOG)).toBeVisible();

  await page.locator(CONFIRM_BUTTON).click();

  // Signed out for real: #/profile is protected, so the guard bounces to #/login and the signed-out
  // panel renders. (Firebase signOut → onAuthChanged(null) is the same event that fires the TM-720
  // onSignedOut reset chain — its depth is covered by signout-state-leak.spec.mjs.)
  await expect(page.locator("#auth-signed-out")).toBeVisible();
});
