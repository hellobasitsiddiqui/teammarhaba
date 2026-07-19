import { test, expect } from "@playwright/test";
import pg from "pg";
import { ADMIN, TARGET, dbConfig } from "../fixtures.mjs";

// First real browser walkthrough (TM-134): anonymous → sign in as ADMIN → open the users console
// → disable a user → assert it reflects in the UI AND persists to the database → sign out.
//
// The "appears in the audit log" step from the ticket is deferred on purpose: admin actions aren't
// wired to the audit log yet (UserAdminService doesn't call AuditService) and there's no audit READ
// endpoint — see the finding on the ticket. We assert persisted state (users.enabled = false)
// instead, which is the real end-to-end effect; the same DB seam will assert the audit row later.

test("@admin admin signs in, disables a user via the console, and the change persists", async ({ page }) => {
  // 1. Anonymous lands on the login view.
  await page.goto("/#/login");
  await expect(page.locator("#auth-signed-out")).toBeVisible();

  // 2. Sign in as the seeded ADMIN (real Firebase flow against the Auth emulator). Email-code is the
  // default front door now (TM-234); the email+password form lives under "Try another way".
  await page.fill("#email", ADMIN.email);
  await page.click("#try-another-btn");
  await page.fill("#password", ADMIN.password);
  await page.click("#signin-btn");

  // 3. Authenticated: sign-out + admin nav appear (admin nav only shows for ROLE_ADMIN).
  await expect(page.locator("#signout-btn")).toBeVisible();
  await expect(page.locator("#nav-admin")).toBeVisible();
  // ...and the sign-in form is actually gone — guards TM-141: the `hidden` attribute the router
  // sets must really hide it (a class `display` rule used to override `[hidden]`, leaving it shown).
  await expect(page.locator("#auth-signed-out")).toBeHidden();

  // 4. Open the admin layer, then the users console via the hub (TM-917: #nav-admin now opens the
  //    #/admin hub; the users console moved to #/admin/users, reached by the hub's Users row).
  await page.click("#nav-admin");
  await page.click('.admin-hub-row[href="#/admin/users"]');
  await expect(page.locator("#admin-view")).toBeVisible();
  const targetRow = page.locator("#admin-table tr", { hasText: TARGET.email });
  await expect(targetRow).toBeVisible();
  // Scope to the account-state badge by text: the push-eligibility badge (TM-427) shares the
  // .tm-badge-ok/.tm-badge-off classes, so an unscoped selector is ambiguous ("Enabled" + "Push").
  await expect(targetRow.locator(".tm-badge-ok", { hasText: "Enabled" })).toHaveText("Enabled");

  // The ID column (the row's only muted cell) carries the DB id — used for the DB assertion.
  const targetId = Number((await targetRow.locator("td.tm-muted").first().innerText()).trim());
  expect(Number.isInteger(targetId)).toBe(true);

  // 5. Disable the account, confirming through the styled confirm dialog (not native confirm()).
  await targetRow.getByRole("button", { name: "Disable", exact: true }).click();
  const dialog = page.locator(".tm-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Disable", exact: true }).click();

  // 6. The UI reflects it: success toast + the row's status flips to Disabled.
  await expect(page.locator("#tm-toasts .tm-toast-success")).toContainText("Account disabled");
  // Scope by text — a disabled + no-push row has two .tm-badge-off spans ("Disabled" + "No push").
  await expect(targetRow.locator(".tm-badge-off", { hasText: "Disabled" })).toHaveText("Disabled");

  // 7. It persisted: the users row is now disabled in the database.
  const client = new pg.Client(dbConfig);
  await client.connect();
  try {
    const { rows } = await client.query("SELECT enabled FROM users WHERE id = $1", [targetId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].enabled).toBe(false);
  } finally {
    await client.end();
  }

  // 8. Sign out → back to the login view.
  await page.click("#signout-btn");
  await expect(page.locator("#auth-signed-out")).toBeVisible();
});
