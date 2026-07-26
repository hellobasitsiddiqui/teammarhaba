import { test, expect } from "@playwright/test";
import { ADMIN } from "../fixtures.mjs";

// Unsaved-changes guard (TM-1027): edit a field on the #/profile edit form, then try to navigate away
// (via the bottom tab bar — it navigates by hash, which is the surface the restore-hash intercept
// covers). A dirty form must raise the styled "Discard changes?" confirm; "Keep editing" stays on the
// form with the edit intact, "Discard changes" proceeds. A CLEAN (untouched) form navigates freely with
// no prompt — the no-false-positive AC.
//
// Runs at the phone viewport the profile screen is designed at (the tab bar reveals ≤ 33rem), so the
// tab-bar navigation this guard protects is the real primary nav.
test.use({ viewport: { width: 390, height: 844 } });

const DIALOG = ".tm-dialog";
const KEEP_EDITING = "#tm-dialog-cancel"; // the plain "Keep editing" button
const DISCARD = "#tm-dialog-confirm"; // the destructive-styled "Discard changes" button

/** Sign in as the seeded ADMIN (a real provisioned account — role irrelevant; profile is any-user) and
 *  open #/profile the everyday way (bottom Profile tab), waiting for the form to finish loading /me. */
async function openProfile(page) {
  await page.goto("/#/login");
  await page.fill("#email", ADMIN.email);
  await page.click("#try-another-btn");
  await page.fill("#password", ADMIN.password);
  await page.click("#signin-btn");
  await expect(page.locator("#auth-signed-in")).toBeVisible({ timeout: 20_000 });

  // Arm the /me wait BEFORE the tap that mounts the profile, so the async populate has run before we
  // type (else it clobbers the field — the TM-198 timing note the edit spec documents).
  const meLoaded = page.waitForResponse(
    (r) => r.url().includes("/api/v1/me") && r.request().method() === "GET",
  );
  await expect(page.locator("#tab-profile")).toBeVisible();
  await page.click("#tab-profile");
  await expect(page.locator("#profile-form")).toBeVisible();
  await meLoaded;

  // The "Edit profile" section is a collapsible accordion, default COLLAPSED (TM-879) — its panel is
  // `hidden` while collapsed, so its fields aren't interactable until we expand it. Open it so the edit
  // fields are visible (a real user taps the section header to edit).
  await page.click("#profile-section-edit-btn");
  await expect(page.locator("#profile-firstName")).toBeVisible();
}

test("@profile a DIRTY profile prompts before leaving; Keep editing stays, the edit is intact (TM-1027)", async ({ page }) => {
  await openProfile(page);

  // Make a real change: edit the first name. (The Edit section is collapsible per TM-879 — the field is
  // in the DOM regardless of the panel's open state, and fill() targets it directly.)
  await page.fill("#profile-firstName", "GuardTest");

  // Try to leave via the bottom Home tab → the restore-hash intercept snaps back and prompts.
  await page.click("#tab-home");
  await expect(page.locator(DIALOG)).toBeVisible();
  await expect(page.locator(DIALOG)).toContainText("Discard changes?");
  await expect(page.locator(DISCARD)).toContainText("Discard changes");
  await expect(page.locator(KEEP_EDITING)).toContainText("Keep editing");

  // Keep editing → dismiss, stay on the profile form, and the typed edit survives.
  await page.click(KEEP_EDITING);
  await expect(page.locator(DIALOG)).toHaveCount(0);
  await expect(page.locator("#profile-form")).toBeVisible();
  await expect(page).toHaveURL(/#\/profile$/);
  await expect(page.locator("#profile-firstName")).toHaveValue("GuardTest");
});

test("@profile a DIRTY profile: Discard proceeds with the navigation and drops the edit (TM-1027)", async ({ page }) => {
  await openProfile(page);

  await page.fill("#profile-firstName", "ThrowawayEdit");

  await page.click("#tab-home");
  await expect(page.locator(DIALOG)).toBeVisible();

  // Discard changes → the dialog closes, the navigation completes to Home, the edit is abandoned.
  await page.click(DISCARD);
  await expect(page.locator(DIALOG)).toHaveCount(0);
  await expect(page).toHaveURL(/#\/home$/);
  await expect(page.locator("#auth-signed-in")).toBeVisible();

  // Re-entering the profile shows the SERVER value, not the discarded edit — the form re-loads fresh.
  const meLoaded = page.waitForResponse(
    (r) => r.url().includes("/api/v1/me") && r.request().method() === "GET",
  );
  await page.click("#tab-profile");
  await expect(page.locator("#profile-form")).toBeVisible();
  await meLoaded;
  await expect(page.locator("#profile-firstName")).not.toHaveValue("ThrowawayEdit");
});

test("@profile a CLEAN profile navigates freely — no prompt, no false positive (TM-1027)", async ({ page }) => {
  await openProfile(page);

  // No edits made. Leaving via a tab must go straight through — no dialog appears.
  await page.click("#tab-home");
  await expect(page).toHaveURL(/#\/home$/);
  await expect(page.locator("#auth-signed-in")).toBeVisible();
  await expect(page.locator(DIALOG)).toHaveCount(0);
});
