import { test, expect } from "@playwright/test";
import { EVENT_GOER } from "../fixtures.mjs";
import { CANCEL_BUTTON, SIGNOUT_CHOOSER, SIGNOUT_THIS_DEVICE, SIGNOUT_EVERYWHERE } from "../helpers/auth-state.mjs";

// TM-906 + TM-1097 sign-out-gate regression — proves sign-out is GATED behind a deliberate choice and
// never fires on an accidental tap:
//
//   1. clicking the Profile hub's "Sign out" row does NOT sign out by itself — it opens the TM-1097
//      CHOOSER ("Sign out on this device" vs "Sign out everywhere") and the session stays live;
//   2. the chooser CANCEL is a genuine no-op — chooser gone, session intact, still on the Profile hub;
//   3. the chooser traps focus + inerts the background (aria-modal for real);
//   4. "Sign out on this device" really signs out (Firebase signOut → onAuthChanged(null), which fires
//      the TM-720 onSignedOut reset chain — covered in depth by signout-state-leak.spec.mjs);
//   5. "Sign out everywhere" (TM-1097 surfaced it on the button, not just Security) opens its own
//      destructive confirm with the everywhere copy — the entry point the Security section already has.
//
// FAIL-BEFORE / PASS-AFTER: on the pre-TM-1097 tree the row opened a plain confirm dialog (no
// `.tm-signout-chooser`), so test 1 fails RED there (the chooser never appears). On the TM-1097 tree
// all pass. The row is located by its stable id (#profile-signout-row).

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
  const row = page.locator("#profile-signout-row");
  await expect(row).toBeVisible();
  return row;
}

test("@auth TM-1097: clicking Sign out opens the CHOOSER and does NOT sign out by itself", async ({ page }) => {
  const row = await openProfileSignedIn(page);
  await row.click();

  // THE CRUX: the styled chooser (ui.js modal — never native confirm()) is up, offering BOTH paths...
  const chooser = page.locator(SIGNOUT_CHOOSER);
  await expect(chooser).toBeVisible();
  await expect(page.locator(SIGNOUT_THIS_DEVICE)).toHaveText("Sign out on this device");
  await expect(page.locator(SIGNOUT_EVERYWHERE)).toHaveText("Sign out everywhere");

  // ...and the click alone did NOT end the session: the signed-out login panel has not returned.
  // (Pre-TM-1097 the row opened a plain confirm dialog with no chooser — so this test fails RED there.)
  await expect(page.locator("#auth-signed-out")).toBeHidden();
});

test("@auth TM-1097: cancelling the chooser keeps the session intact", async ({ page }) => {
  const row = await openProfileSignedIn(page);
  await row.click();
  await expect(page.locator(SIGNOUT_CHOOSER)).toBeVisible();

  await page.locator("#signout-cancel").click();
  await expect(page.locator(SIGNOUT_CHOOSER)).toBeHidden();

  // Session intact: still on the Profile hub with its menu, and the signed-out login panel never
  // returned. Belt-and-braces: re-navigating to the protected profile still renders it (no re-login).
  await expect(page.locator("#profile-signout-row")).toBeVisible();
  await expect(page.locator("#auth-signed-out")).toBeHidden();
  await page.evaluate(() => {
    window.location.hash = "#/home";
  });
  await page.evaluate(() => {
    window.location.hash = "#/profile";
  });
  await expect(page.locator("#profile-signout-row")).toBeVisible();
});

test("@auth TM-1097: the chooser traps focus and inerts the background (aria-modal for real)", async ({ page }) => {
  const row = await openProfileSignedIn(page);
  await row.click();
  await expect(page.locator(SIGNOUT_CHOOSER)).toBeVisible();

  // Focus is seated INSIDE the modal on open (modal() seats it on the close control).
  expect(
    await page.evaluate(() => !!(document.activeElement && document.activeElement.closest(".tm-modal"))),
  ).toBe(true);

  // THE CRUX: Tab must CYCLE within the modal — focus must never escape onto page content behind the
  // backdrop, where Enter could activate a background control while the chooser is up.
  for (let i = 0; i < 4; i += 1) {
    await page.keyboard.press(i % 2 === 0 ? "Tab" : "Shift+Tab");
    const insideDialog = await page.evaluate(
      () => !!(document.activeElement && document.activeElement.closest(".tm-modal")),
    );
    expect(insideDialog, `focus escaped the chooser on key press ${i + 1}`).toBe(true);
  }

  // The page behind the backdrop is inert + aria-hidden while the chooser is open (aria-modal).
  expect(
    await page.evaluate(() => {
      const main = document.querySelector("main.app");
      return main.inert === true && main.getAttribute("aria-hidden") === "true";
    }),
  ).toBe(true);

  // Escape closes the chooser, restores the background, and hands focus back to the opening row.
  await page.keyboard.press("Escape");
  await expect(page.locator(SIGNOUT_CHOOSER)).toBeHidden();
  expect(
    await page.evaluate(() => {
      const main = document.querySelector("main.app");
      return main.inert === false && !main.hasAttribute("aria-hidden");
    }),
  ).toBe(true);
  await expect(page.locator("#profile-signout-row")).toBeFocused();
  await expect(page.locator("#auth-signed-out")).toBeHidden();
});

test("@auth TM-1097: 'Sign out on this device' really signs out", async ({ page }) => {
  const row = await openProfileSignedIn(page);
  await row.click();
  await expect(page.locator(SIGNOUT_CHOOSER)).toBeVisible();

  await page.locator(SIGNOUT_THIS_DEVICE).click();

  // Signed out for real: #/profile is protected, so the guard bounces to #/login and the signed-out
  // panel renders. (Firebase signOut → onAuthChanged(null) fires the TM-720 onSignedOut reset chain.)
  await expect(page.locator("#auth-signed-out")).toBeVisible();
});

test("@auth TM-1097: 'Sign out everywhere' opens the destructive confirm with the everywhere copy", async ({ page }) => {
  const row = await openProfileSignedIn(page);
  await row.click();
  await expect(page.locator(SIGNOUT_CHOOSER)).toBeVisible();

  await page.locator(SIGNOUT_EVERYWHERE).click();

  // The chooser hands off to the destructive confirm (a plain confirmDialog, NOT the modal chooser),
  // with the agreed everywhere copy + a destructive-styled confirm button — the same gate the Security
  // section uses. Cancelling here is a no-op (no refresh-token revoke happens), session intact.
  const confirm = page.locator(".tm-dialog:not(.tm-modal)");
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("Sign out everywhere?");
  await expect(confirm).toContainText("This signs you out on every device, including this one.");
  await expect(page.locator(".tm-dialog:not(.tm-modal) .tm-btn-danger")).toHaveText("Sign out everywhere");

  await page.locator(CANCEL_BUTTON).click();
  await expect(confirm).toBeHidden();
  await expect(page.locator("#auth-signed-out")).toBeHidden();
});
