import { test, expect } from "@playwright/test";
import pg from "pg";
import { ADMIN, dbConfig, lettersOnlyStamp } from "../fixtures.mjs";

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
  // Email-code is the default front door (TM-234); the email+password form is under "Try another way".
  await page.fill("#email", ADMIN.email);
  await page.click("#try-another-btn");
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

test("@profile a user edits their profile via #/profile and the change persists", async ({ page }) => {
  // TM-877: city is a DROPDOWN now (London / Milton Keynes / Sharjah / Karachi), so the run-unique
  // free-text city is gone. Uniqueness for the persistence assertion moves to firstName
  // (letters-only, TM-771); the city pick pins the new select round-trip.
  const first = `Testville${lettersOnlyStamp()}`;

  await openProfile(page);

  // Edit three fields: a free-text one (firstName), the new city dropdown, and the enum.
  await page.fill("#profile-firstName", first);
  await page.selectOption("#profile-city", "Karachi");
  await page.selectOption("#profile-notificationPref", "BOTH");

  // Save → success toast.
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator("#tm-toasts .tm-toast-success")).toContainText("Profile saved");

  // It persisted: the users row now carries the new name, city + preference.
  const client = new pg.Client(dbConfig);
  await client.connect();
  try {
    const { rows } = await client.query(
      "SELECT first_name, city, notification_pref FROM users WHERE lower(email) = lower($1)",
      [ADMIN.email],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].first_name).toBe(first);
    expect(rows[0].city).toBe("Karachi");
    expect(rows[0].notification_pref).toBe("BOTH");
  } finally {
    await client.end();
  }
});

test("@profile the city dropdown offers exactly the allowed cities (TM-877)", async ({ page }) => {
  await openProfile(page);

  // The select exists (no more free-text input) and offers the placeholder + the four cities.
  const options = page.locator("#profile-city option");
  await expect(options).toHaveText(["Choose a city…", "London", "Milton Keynes", "Sharjah", "Karachi"]);

  // The phone country soft-default keeps resolving for a picked city: with no user-picked country,
  // the stored-phone country wins (the seeded account has a +44 phone), so just assert the picker
  // holds a concrete selection — the pure mapping (London/MK→GB, Sharjah→AE, Karachi→PK) is pinned
  // by web/tools/countries.test.mjs.
  await expect(page.locator("#profile-phone-country")).not.toHaveValue("");
});

test("@profile a user with a blank phone can save their profile (TM-188)", async ({ page }) => {
  // Regression for TM-188: a blank phone field used to be sent as "" and rejected (400). Saving
  // with the phone left empty must now succeed.
  await openProfile(page);

  // Explicitly clear the phone field, then save — no inline error, success toast.
  await page.fill("#profile-phone", "");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator("#tm-toasts .tm-toast-success")).toContainText("Profile saved");
});

test("@profile client-side validation blocks an out-of-range age before any save", async ({ page }) => {
  await openProfile(page);

  // 17 is outside the allowed 18–99 band (TM-884; it was legal under the old 13–120 range) — the
  // inline error shows and the save is rejected.
  await page.fill("#profile-age", "17");
  await page.getByRole("button", { name: "Save changes" }).click();

  await expect(page.locator("#profile-age-error")).toBeVisible();
  await expect(page.locator("#profile-age-error")).toContainText("18 or more");
  await expect(page.locator("#tm-toasts .tm-toast-error")).toBeVisible();

  // The upper bound moved too: 100 (legal under 13–120) is now rejected.
  await page.fill("#profile-age", "100");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator("#profile-age-error")).toContainText("99 or less");
});
