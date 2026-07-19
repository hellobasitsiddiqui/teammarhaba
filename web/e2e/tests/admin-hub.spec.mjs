// Admin hub + role-visibility e2e (TM-917 / TM-918). Proves the admin layer end to end at a phone
// viewport: an ADMIN sees the fifth Admin tab (TM-916), tapping it opens the #/admin hub, and every
// console is reachable from it with the Admin tab staying active; a normal USER has NO admin
// affordance in the DOM and is bounced off the admin routes (visibility is UX-only — the server gate
// TM-133/TM-111 is the real authority). Runs at 390px, where the bottom tab bar is the primary nav.

import { test, expect } from "@playwright/test";
import { ADMIN, TARGET } from "./fixtures.mjs";

test.use({ viewport: { width: 390, height: 844 } });

/** Email+password sign-in (the "Try another way" path — email-code is the default front door). */
async function signIn(page, account) {
  await page.goto("/#/login");
  await expect(page.locator("#auth-signed-out")).toBeVisible();
  await page.fill("#email", account.email);
  await page.click("#try-another-btn");
  await page.fill("#password", account.password);
  await page.click("#signin-btn");
  // Signed-in signal that holds at a phone viewport: the signed-out panel disappears (the signout
  // control lives in the collapsed nav). The tab bar then renders for the un-gated session.
  await expect(page.locator("#auth-signed-out")).toBeHidden();
  await expect(page.locator("#app-tabbar")).toBeVisible();
}

test.describe("@admin-hub admin layer + role-conditional tab (TM-917/TM-918)", () => {
  test("ADMIN: the Admin tab opens the hub and every console is reachable, Admin tab staying active", async ({ page }) => {
    await signIn(page, ADMIN);
    // The role resolves → the fifth Admin tab is injected (TM-916). Wait for it rather than racing.
    const adminTab = page.locator("#tab-admin");
    await expect(adminTab).toBeVisible();
    await expect(page.locator("#app-tabbar .app-tab")).toHaveCount(5);

    // Tapping Admin opens the hub at #/admin.
    await adminTab.click();
    await expect(page.locator("#admin-hub-view")).toBeVisible();
    const rows = page.locator("#admin-hub-view .admin-hub-row");
    await expect(rows).toHaveCount(5);
    await expect(rows).toHaveText([/Users/, /Manage events/, /Venues/, /Interests/, /Send a message/]);
    // On the hub, the Admin tab is the active one (activeTab maps #/admin* → "admin").
    await expect(adminTab).toHaveAttribute("aria-current", "page");

    // The Users row opens the moved users console at #/admin/users; the Admin tab stays active.
    await rows.filter({ hasText: "Users" }).click();
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("#/admin/users");
    await expect(page.locator("#admin-view")).toBeVisible();
    await expect(page.locator("#admin-hub-view")).toBeHidden();
    await expect(adminTab).toHaveAttribute("aria-current", "page");

    // A deep console route still lights the Admin tab (prefix match), and tapping Admin returns to the hub.
    await page.evaluate(() => (window.location.hash = "#/admin/venues"));
    await expect(page.locator("#admin-venues-view")).toBeVisible();
    await expect(adminTab).toHaveAttribute("aria-current", "page");
    await adminTab.click();
    await expect(page.locator("#admin-hub-view")).toBeVisible();
  });

  test("USER: no admin affordance in the DOM and admin routes bounce", async ({ page }) => {
    await signIn(page, TARGET);
    // Exactly the locked four tabs — the Admin tab is never injected for a non-admin.
    await expect(page.locator("#app-tabbar .app-tab")).toHaveCount(4);
    await expect(page.locator("#tab-admin")).toHaveCount(0);
    // The top-nav admin link stays hidden too (same verified-role gate).
    await expect(page.locator("#nav-admin")).toHaveAttribute("hidden", /.*/);

    // Deep-linking the admin routes bounces a non-admin home — the hub and the moved users console
    // are both hard-gated (client bounce mirrors the server gate; no admin view is shown).
    for (const route of ["#/admin", "#/admin/users"]) {
      await page.evaluate((r) => (window.location.hash = r), route);
      await expect(page.locator("#admin-hub-view")).toBeHidden();
      await expect(page.locator("#admin-view")).toBeHidden();
      await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("#/home");
    }
  });
});
