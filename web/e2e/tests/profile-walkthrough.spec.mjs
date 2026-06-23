import { test, expect } from "@playwright/test";
import pg from "pg";
import { ADMIN, dbConfig } from "../fixtures.mjs";

// Browser walkthrough for the self-service edit-profile page (TM-167): sign in → open #/profile →
// edit fields → save via PATCH /api/v1/me → assert the UI reflects it AND it persists to the
// database; then prove server validation surfaces inline and a bad value is NOT written.
//
// Uses the seeded ADMIN account purely as "a signed-in user" (the page is for everyone) — its
// profile columns are independent of the admin-walkthrough spec, which only touches TARGET.enabled.

test("a user edits their profile, it persists, and invalid input is rejected", async ({ page }) => {
  // 1. Sign in (real Firebase flow against the Auth emulator).
  await page.goto("/#/login");
  await page.fill("#email", ADMIN.email);
  await page.fill("#password", ADMIN.password);
  await page.click("#signin-btn");
  await expect(page.locator("#signout-btn")).toBeVisible();

  // 2. The profile link is offered to any signed-in user; open the page.
  await expect(page.locator("#nav-profile")).toBeVisible();
  await page.click("#nav-profile");
  await expect(page.locator("#profile-view")).toBeVisible();
  await expect(page.locator("#profile-form")).toBeVisible();

  // 3. Edit a spread of field types: text, number, and the notification-preference select.
  await page.fill("#profile-firstName", "Grace");
  await page.fill("#profile-city", "London");
  await page.fill("#profile-age", "33");
  await page.selectOption("#profile-notificationPref", "BOTH");
  await page.click("#profile-save");

  // 4. The UI confirms with a success toast.
  await expect(page.locator("#tm-toasts .tm-toast-success")).toContainText("Profile saved");

  // 5. It persisted: the user's row carries the new values.
  const client = new pg.Client(dbConfig);
  await client.connect();
  try {
    const { rows } = await client.query(
      "SELECT first_name, city, age, notification_pref FROM users WHERE email = $1",
      [ADMIN.email],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].first_name).toBe("Grace");
    expect(rows[0].city).toBe("London");
    expect(rows[0].age).toBe(33);
    expect(rows[0].notification_pref).toBe("BOTH");

    // 6. Server validation surfaces inline and the bad value is NOT written: age below the
    //    allowed range (13–120) → 400 with a per-field error → the age error shows and the
    //    persisted age stays 33.
    await page.fill("#profile-age", "5");
    await page.click("#profile-save");
    const ageError = page.locator("#profile-form label", { has: page.locator("#profile-age") }).locator(".field-error");
    await expect(ageError).toBeVisible();

    const after = await client.query("SELECT age FROM users WHERE email = $1", [ADMIN.email]);
    expect(after.rows[0].age).toBe(33);
  } finally {
    await client.end();
  }

  // 7. Sign out → back to the login view.
  await page.click("#signout-btn");
  await expect(page.locator("#auth-signed-out")).toBeVisible();
});
