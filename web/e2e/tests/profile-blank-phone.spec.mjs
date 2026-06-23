import { test, expect } from "@playwright/test";
import pg from "pg";
import { ADMIN, dbConfig } from "../fixtures.mjs";

// Blank-phone save regression (TM-188): a user with NO phone number edits an unrelated field and
// saves — this MUST succeed (no 400). The original bug rejected the whole PATCH /api/v1/me when the
// phone was absent/empty. Mirrors profile-edit.spec's shape (UI success toast + DB persistence).
//
// We sign in as the seeded ADMIN purely because it's a real, provisioned account; the profile page
// edits the caller's OWN record, so the role is irrelevant. The earlier profile specs never set a
// phone, so ADMIN's phone is null/empty going in; we also clear the field explicitly to be sure.

test("saving the profile with a blank phone succeeds (TM-188 regression)", async ({ page }) => {
  // A value unique to this run so the assertion can't pass on stale data.
  const city = `Phoneless-${Date.now()}`;

  // 1. Sign in (real Firebase flow against the Auth emulator).
  await page.goto("/#/login");
  await page.fill("#email", ADMIN.email);
  await page.fill("#password", ADMIN.password);
  await page.click("#signin-btn");
  await expect(page.locator("#signout-btn")).toBeVisible();

  // 2. Open the self-service profile form.
  await page.click("#nav-profile");
  await expect(page.locator("#profile-form")).toBeVisible();

  // 3. The regression condition: phone empty, change only an unrelated field, save.
  await page.fill("#profile-phone", "");
  await page.fill("#profile-city", city);
  await page.getByRole("button", { name: "Save changes" }).click();

  // 4. Save succeeds — no 400 — the success toast shows (the bug surfaced as an error toast here).
  await expect(page.locator("#tm-toasts .tm-toast-success")).toContainText("Profile saved");

  // 5. It persisted, and phone stayed blank (null or empty string).
  const client = new pg.Client(dbConfig);
  await client.connect();
  try {
    const { rows } = await client.query(
      "SELECT city, phone FROM users WHERE lower(email) = lower($1)",
      [ADMIN.email],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].city).toBe(city);
    expect(rows[0].phone === null || rows[0].phone === "").toBeTruthy();
  } finally {
    await client.end();
  }
});
