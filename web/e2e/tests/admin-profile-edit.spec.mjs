import { test, expect } from "@playwright/test";
import { expectSignedIn, signOutViaProfile } from "../helpers/auth-state.mjs";
import pg from "pg";
import { ADMIN, TARGET, dbConfig } from "../fixtures.mjs";

// TM-172: an admin edits ANOTHER user's admin-editable PROFILE fields via the user-detail modal, the
// UI reflects it, and it persists to the database. Complements admin-walkthrough (enable/disable) and
// admin-suspend (role/enabled) — this exercises the SEPARATE profile-edit surface added in TM-172,
// which reuses the same validation as the user's own PATCH /me and audits every edit.
//
// It edits `city` (a dropdown allow-list value) + `firstName`, deliberately NOT enabled/role — so it
// doesn't collide with the sibling admin specs that toggle e2e-target's enabled/role state.

test("@admin admin edits another user's profile fields via the console, and it persists", async ({ page }) => {
  // 1. Sign in as the seeded ADMIN (real Firebase flow against the Auth emulator).
  await page.goto("/#/login");
  await expect(page.locator("#auth-signed-out")).toBeVisible();
  await page.fill("#email", ADMIN.email);
  await page.click("#try-another-btn");
  await page.fill("#password", ADMIN.password);
  await page.click("#signin-btn");
  await expectSignedIn(page);

  // 2. Open the users console via the hub (TM-917).
  await page.click("#nav-admin");
  await page.click('.admin-hub-row[href="#/admin/users"]');
  await expect(page.locator("#admin-view")).toBeVisible();
  const targetRow = page.locator("#admin-table tr", { hasText: TARGET.email });
  await expect(targetRow).toBeVisible();
  const targetId = Number((await targetRow.locator("td.tm-muted").first().innerText()).trim());
  expect(Number.isInteger(targetId)).toBe(true);

  // 3. Open the user-detail modal, then reveal the profile edit form.
  await targetRow.getByRole("button", { name: "View", exact: true }).click();
  const dialog = page.locator(".tm-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".tm-detail-h", { hasText: "Profile" })).toBeVisible();
  await dialog.getByRole("button", { name: "Edit profile", exact: true }).click();

  // 4. Edit the profile fields — a unique first name (so the assertion is unambiguous across reruns)
  //    and an allow-list city (TM-877). The form reuses the shared self-edit validation.
  const stamp = String(Date.now()).slice(-6);
  const newFirst = `Edited${stamp}`;
  await dialog.locator("#admin-profile-firstName-" + targetId).fill(newFirst);
  await dialog.locator("#admin-profile-city-" + targetId).selectOption("Milton Keynes");
  await dialog.getByRole("button", { name: "Save profile", exact: true }).click();

  // 5. UI reflects it: success toast, and the read-only summary now shows the new values.
  await expect(page.locator("#tm-toasts .tm-toast-success")).toContainText("Profile updated");
  await expect(dialog.locator(".tm-admin-profile-summary")).toContainText(newFirst);
  await expect(dialog.locator(".tm-admin-profile-summary")).toContainText("Milton Keynes");

  // 6. It persisted: the target's profile row carries the new values in the database.
  const client = new pg.Client(dbConfig);
  await client.connect();
  try {
    const { rows } = await client.query(
      "SELECT first_name, city FROM users WHERE id = $1",
      [targetId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].first_name).toBe(newFirst);
    expect(rows[0].city).toBe("Milton Keynes");
  } finally {
    await client.end();
  }

  // 7. And the edit was audited (TM-172): an ADMIN_USER_PROFILE_EDITED row targets the account.
  const auditClient = new pg.Client(dbConfig);
  await auditClient.connect();
  try {
    const { rows } = await auditClient.query(
      "SELECT COUNT(*)::int AS n FROM audit_events e "
        + "JOIN users u ON u.firebase_uid = e.target_id "
        + "WHERE u.id = $1 AND e.action = 'ADMIN_USER_PROFILE_EDITED'",
      [targetId],
    );
    expect(rows[0].n).toBeGreaterThanOrEqual(1);
  } finally {
    await auditClient.end();
  }

  await signOutViaProfile(page);
  await expect(page.locator("#auth-signed-out")).toBeVisible();
});
