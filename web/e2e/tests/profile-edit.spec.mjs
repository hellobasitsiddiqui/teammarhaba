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

// Sign in and open #/profile, WAITING for the form to finish loading from GET /api/v1/me before
// returning. The form mounts empty and is populated asynchronously from that GET; if the test types
// before the response lands, the async populate clobbers the input (TM-198 — the form was found
// reset to empty in the failure screenshots). Waiting for the GET /me response settles the load so
// subsequent fills stick. A real user types after the form has loaded, so this is purely test timing.
async function openProfile(page) {
  await page.goto("/#/login");
  await page.fill("#email", ADMIN.email);
  await page.fill("#password", ADMIN.password);
  await page.click("#signin-btn");
  await expect(page.locator("#signout-btn")).toBeVisible();

  // Arm the wait BEFORE the click that triggers the profile-mount GET /me.
  const meLoaded = page.waitForResponse(
    (r) => r.url().includes("/api/v1/me") && r.request().method() === "GET",
  );
  await expect(page.locator("#nav-profile")).toBeVisible();
  await page.click("#nav-profile");
  await expect(page.locator("#profile-form")).toBeVisible();
  await meLoaded; // populate has run — the form won't clobber what we type next
}

test("a user edits their profile via #/profile and the change persists", async ({ page }) => {
  // A value unique to this run so the assertion can't pass on stale data.
  const city = `Testville-${Date.now()}`;

  await openProfile(page);

  // Edit two fields: a free-text one (city) and the enum (notificationPref).
  await page.fill("#profile-city", city);
  await page.selectOption("#profile-notificationPref", "BOTH");

  // Save → success toast.
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator("#tm-toasts .tm-toast-success")).toContainText("Profile saved");

  // It persisted: the users row now carries the new city + preference.
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

test("a user with a blank phone can save their profile (TM-188)", async ({ page }) => {
  // Regression for TM-188: a blank phone field used to be sent as "" and rejected (400). Saving
  // with the phone left empty must now succeed.
  await openProfile(page);

  // Explicitly clear the phone field, then save — no inline error, success toast.
  await page.fill("#profile-phone", "");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator("#tm-toasts .tm-toast-success")).toContainText("Profile saved");
});

test("client-side validation blocks an out-of-range age before any save", async ({ page }) => {
  await openProfile(page);

  // 200 is outside the allowed 13–120 range — the inline error shows and the save is rejected.
  await page.fill("#profile-age", "200");
  await page.getByRole("button", { name: "Save changes" }).click();

  await expect(page.locator("#profile-age-error")).toBeVisible();
  await expect(page.locator("#tm-toasts .tm-toast-error")).toBeVisible();
});
