// Admin hub + role-visibility e2e (TM-917 / TM-918). Proves the admin layer end to end at a phone
// viewport: an ADMIN sees the fifth Admin tab (TM-916), tapping it opens the #/admin hub, and every
// console is reachable from it with the Admin tab staying active; a normal USER has NO admin
// affordance in the DOM and is bounced off the admin routes (visibility is UX-only — the server gate
// TM-133/TM-111 is the real authority). Runs at 390px, where the bottom tab bar is the primary nav.

import { test, expect } from "@playwright/test";
import { ADMIN, TARGET } from "../fixtures.mjs";

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
    // TM-1176: `#admin-hub-view` is unhidden by the router on the route match ALONE (render()), but its
    // rows are mounted only AFTER the async role resolution flips isAdmin true (enterAdminHub). On a slow
    // cold-boot the view is visible-but-empty for that window, so asserting the count off toBeVisible()
    // alone races the mount and flakes. Wait on the mount's stable readiness hook (data-ready, stamped
    // once every row is in the DOM) and on the first row painting BEFORE asserting the exact count — so
    // the count assertion runs against a settled hub, not a snapshot mid-mount.
    await expect(page.locator("#admin-hub-view[data-ready]")).toBeVisible();
    const rows = page.locator("#admin-hub-view .admin-hub-row");
    await expect(rows.first()).toBeVisible();
    // TM-972/TM-1166: the hub is now EIGHT verb-led folds, flat + in order. "Send notification" (push
    // broadcast) and "Developer tools" (the ops panel) were LIFTED out of the users console into their
    // own folds (TM-972); "Manage cities" (the city catalogue console) was added between interests and
    // messages (TM-1166). Contract mirrors ADMIN_HUB_ROWS in admin-hub-route.js (unit-tested there).
    await expect(rows).toHaveCount(8);
    await expect(rows).toHaveText([
      /Manage users/,
      /Manage events/,
      /Manage venues/,
      /Manage interests/,
      /Manage cities/,
      /Send a message/,
      /Send notification/,
      /Developer tools/,
    ]);
    // On the hub, the Admin tab is the active one (activeTab maps #/admin* → "admin").
    await expect(adminTab).toHaveAttribute("aria-current", "page");

    // The "Manage users" row opens the users console at #/admin/users; the Admin tab stays active.
    await rows.filter({ hasText: "Manage users" }).click();
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("#/admin/users");
    await expect(page.locator("#admin-view")).toBeVisible();
    await expect(page.locator("#admin-hub-view")).toBeHidden();
    await expect(adminTab).toHaveAttribute("aria-current", "page");

    // The lifted "Send notification" fold opens the notification screen at #/admin/notifications, which
    // carries its OWN recipient picker (the broadcast compose + select-all roster). Admin tab stays active.
    await adminTab.click();
    await page.locator("#admin-hub-view .admin-hub-row").filter({ hasText: "Send notification" }).click();
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("#/admin/notifications");
    await expect(page.locator("#admin-notifications-view")).toBeVisible();
    await expect(page.locator("#admin-broadcast")).toBeVisible(); // the compose panel
    await expect(page.locator("#admin-select-all")).toBeVisible(); // the recipient select-all
    await expect(adminTab).toHaveAttribute("aria-current", "page");

    // The lifted "Developer tools" fold opens the ops screen at #/admin/ops (diagnostics/consoles panel).
    await adminTab.click();
    await page.locator("#admin-hub-view .admin-hub-row").filter({ hasText: "Developer tools" }).click();
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("#/admin/ops");
    await expect(page.locator("#admin-ops-view")).toBeVisible();
    await expect(page.locator("#admin-ops")).toBeVisible();
    await expect(adminTab).toHaveAttribute("aria-current", "page");

    // The users console it left behind has NO broadcast compose and NO ops panel any more.
    await page.evaluate(() => (window.location.hash = "#/admin/users"));
    await expect(page.locator("#admin-view")).toBeVisible();
    await expect(page.locator("#admin-view #admin-broadcast")).toHaveCount(0);
    await expect(page.locator("#admin-view #admin-ops")).toHaveCount(0);

    // A deep console route still lights the Admin tab (prefix match), and tapping Admin returns to the hub.
    await page.evaluate(() => (window.location.hash = "#/admin/venues"));
    await expect(page.locator("#admin-venues-view")).toBeVisible();
    await expect(adminTab).toHaveAttribute("aria-current", "page");
    await adminTab.click();
    await expect(page.locator("#admin-hub-view")).toBeVisible();
  });

  test("USER: no admin affordance in the DOM and admin routes bounce", async ({ page }) => {
    await signIn(page, TARGET);
    // Five tabs for a non-admin: the locked four PLUS the Help tab (TM-1092). The Admin tab is never
    // injected for a non-admin; Help is the non-admin's 5th slot, pointing at #/help.
    await expect(page.locator("#app-tabbar .app-tab")).toHaveCount(5);
    await expect(page.locator("#tab-admin")).toHaveCount(0);
    const helpTab = page.locator("#tab-help");
    await expect(helpTab).toHaveCount(1);
    await expect(helpTab).toHaveAttribute("href", "#/help");

    // Deep-linking the admin routes bounces a non-admin home — the hub, the users console, and the two
    // lifted folds (TM-972) are all hard-gated (client bounce mirrors the server gate; no admin view is
    // shown). A missing bounce/PROTECTED entry on the lifted routes would be a real auth regression (TM-917).
    for (const route of ["#/admin", "#/admin/users", "#/admin/notifications", "#/admin/ops"]) {
      await page.evaluate((r) => (window.location.hash = r), route);
      await expect(page.locator("#admin-hub-view")).toBeHidden();
      await expect(page.locator("#admin-view")).toBeHidden();
      await expect(page.locator("#admin-notifications-view")).toBeHidden();
      await expect(page.locator("#admin-ops-view")).toBeHidden();
      await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("#/home");
    }
  });

  test("USER: the Help tab (5th) navigates to #/help and lights as active (TM-1092)", async ({ page }) => {
    await signIn(page, TARGET);
    const helpTab = page.locator("#tab-help");
    await expect(helpTab).toBeVisible();
    await helpTab.click();
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("#/help");
    await expect(page.locator("#help-view")).toBeVisible();
    await expect(helpTab).toHaveAttribute("aria-current", "page");
    // Only Help is active — the other tabs clear their active state.
    await expect(page.locator("#tab-home")).not.toHaveAttribute("aria-current", "page");
  });
});
