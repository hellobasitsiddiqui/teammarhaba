import { test, expect } from "@playwright/test";
import pg from "pg";
import { ADMIN, dbConfig } from "../fixtures.mjs";

// Edit-profile round-trip (TM-167): sign in → open the self-service #/profile view → edit a couple
// of fields → save → assert the UI reflects success AND the change persists to the database via
// PATCH /api/v1/me. Mirrors the admin-walkthrough spec's shape (UI assertion + DB persistence).
//
// We sign in as the seeded ADMIN purely because it's a real, provisioned account; the profile page
// is available to any signed-in user (it edits the caller's OWN record), so the role is irrelevant
// here. We assert on users.city + users.notification_pref, the two fields we change.

test("a user edits their profile via #/profile and the change persists", async ({ page }) => {
  // A value unique to this run so the assertion can't pass on stale data.
  const city = `Testville-${Date.now()}`;

  // 1. Sign in (real Firebase flow against the Auth emulator).
  await page.goto("/#/login");
  await page.fill("#email", ADMIN.email);
  await page.fill("#password", ADMIN.password);
  await page.click("#signin-btn");
  await expect(page.locator("#signout-btn")).toBeVisible();

  // 2. The profile link appears for a signed-in user; open it.
  await expect(page.locator("#nav-profile")).toBeVisible();
  await page.click("#nav-profile");
  await expect(page.locator("#profile-view")).toBeVisible();

  // 3. The form loaded with the caller's current values from GET /api/v1/me.
  await expect(page.locator("#profile-form")).toBeVisible();

  // 4. Edit two fields: a free-text one (city) and the enum (notificationPref).
  await page.fill("#profile-city", city);
  await page.selectOption("#profile-notificationPref", "BOTH");

  // 5. Save → success toast.
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator("#tm-toasts .tm-toast-success")).toContainText("Profile saved");

  // 6. It persisted: the users row now carries the new city + preference.
  const client = new pg.Client(dbConfig);
  await client.connect();
  try {
    const { rows } = await client.query(
      "SELECT city, notification_pref FROM users WHERE lower(email) = lower($1)",
      [ADMIN.email],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].city).toBe(city);
    expect(rows[0].notification_pref).toBe("BOTH");
  } finally {
    await client.end();
  }
});

test("client-side validation blocks an out-of-range age before any save", async ({ page }) => {
  await page.goto("/#/login");
  await page.fill("#email", ADMIN.email);
  await page.fill("#password", ADMIN.password);
  await page.click("#signin-btn");
  await expect(page.locator("#signout-btn")).toBeVisible();

  await page.click("#nav-profile");
  await expect(page.locator("#profile-form")).toBeVisible();

  // 200 is outside the allowed 13–120 range — the inline error shows and the save is rejected.
  await page.fill("#profile-age", "200");
  await page.getByRole("button", { name: "Save changes" }).click();

  await expect(page.locator("#profile-age-error")).toBeVisible();
  await expect(page.locator("#tm-toasts .tm-toast-error")).toBeVisible();
});
