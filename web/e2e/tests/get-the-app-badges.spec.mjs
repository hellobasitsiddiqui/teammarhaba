import { test, expect } from "@playwright/test";

// "Get the app" store badges (TM-276). A cosmetic, signed-out-reachable footer surface, so this
// spec needs NO auth — it exercises the real anonymous path a visitor takes:
//   • an Android badge linking to the existing /download landing page (TM-246),
//   • an iOS badge rendered as a disabled, non-clickable "Coming soon" placeholder (TM-233 parked),
//     announced unavailable to assistive tech.
//
// It rides the existing main + manual-dispatch e2e workflow (never the PR gate), like its siblings,
// and runs under the default desktop `chromium` project.
//
// Suppress the first-run product tour (TM-147) so its modal/backdrop can't overlay the controls —
// same localStorage init-script the other specs use.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const orig = Storage.prototype.getItem;
    Storage.prototype.getItem = function (k) {
      return typeof k === "string" && k.startsWith("tm.tour.")
        ? JSON.stringify({ done: true })
        : orig.call(this, k);
    };
  });
});

test.describe('@badges "Get the app" badges (TM-276)', () => {
  test("the footer shows Android + iOS badges (signed out)", async ({ page }) => {
    await page.goto("/#/login");
    await expect(page.locator("#auth-signed-out")).toBeVisible();

    const badges = page.locator(".app-store-badges");
    await expect(badges).toBeVisible();
    await expect(badges).toContainText("Get the app");
  });

  test("the Android badge links to the /download page and is reachable", async ({ page }) => {
    await page.goto("/#/login");

    // Accessible name "Download for Android"; points at the real direct-download landing page.
    const android = page.getByRole("link", { name: "Download for Android" });
    await expect(android).toBeVisible();
    await expect(android).toHaveAttribute("href", "/download");
  });

  test("the iOS badge is a disabled, non-clickable 'Coming soon' placeholder", async ({ page }) => {
    await page.goto("/#/login");

    // Accessible name "iOS app coming soon"; it's a real disabled <button>, never a dead link.
    const ios = page.getByRole("button", { name: "iOS app coming soon" });
    await expect(ios).toBeVisible();
    await expect(ios).toBeDisabled();
    await expect(ios).toHaveAttribute("aria-disabled", "true");
    await expect(ios).toContainText("Coming soon");

    // It is NOT a link, so there is no href to follow / no dead link.
    expect(await ios.evaluate((el) => el.tagName)).toBe("BUTTON");
  });
});
