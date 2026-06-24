import { test, expect } from "@playwright/test";
import { ADMIN, TARGET } from "../fixtures.mjs";

// Responsive mobile-web polish (TM-229) — proves the app is usable at a phone viewport. This spec
// runs ONLY under the `mobile-chromium` Playwright project (Pixel 5 ≈ 393px wide; see
// playwright.config.mjs), so every assertion here is about the real narrow-screen layout:
//   • no horizontal PAGE scroll (the classic mobile break),
//   • the account nav collapses behind a hamburger that opens/closes,
//   • the admin users table scrolls inside its wrapper, not the whole page,
//   • primary controls stay usable (visible + in the viewport).
//
// Patterns mirror the existing specs (theme-visual / profile-edit): suppress the first-run tour via
// the localStorage init-script, wait for each view's container before asserting (TM-198 lesson), and
// navigate signed-in views by hash without a full reload to avoid the guard's sign-in bounce.
//
// It rides the existing main + manual-dispatch e2e workflow (never the PR gate), like its siblings.

// A phone viewport never wants a horizontal PAGE scrollbar — a wide child forcing one is the
// canonical responsive bug. We allow a 1px slack for sub-pixel rounding. (A scroll container INSIDE
// the page — e.g. the admin table wrapper — is fine and expected; this checks the document itself.)
async function expectNoHorizontalPageScroll(page) {
  const overflow = await page.evaluate(() => {
    const el = document.scrollingElement || document.documentElement;
    return { scrollW: el.scrollWidth, clientW: el.clientWidth };
  });
  expect(overflow.scrollW, "document should not scroll horizontally").toBeLessThanOrEqual(
    overflow.clientW + 1,
  );
}

async function expectControlUsable(page, locator) {
  await expect(locator).toBeVisible();
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeInViewport();
}

async function signInAsAdmin(page) {
  await page.fill("#email", ADMIN.email);
  await page.fill("#password", ADMIN.password);
  await page.click("#signin-btn");
  await expect(page.locator("#signout-btn")).toBeAttached();
}

// Suppress the first-run product tour (its dimmed overlay would cover the controls under test).
// Same approach as theme-visual.spec.mjs: make any `tm.tour.*` key read as completed at boot.
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

test.describe("login at a phone viewport", () => {
  test("no horizontal page scroll and the sign-in button is usable", async ({ page }) => {
    await page.goto("/#/login");
    await expect(page.locator("#auth-signed-out")).toBeVisible();
    await expectControlUsable(page, page.locator("#signin-btn"));
    await expectNoHorizontalPageScroll(page);
  });

  test("the hamburger toggle is shown at a phone viewport", async ({ page }) => {
    await page.goto("/#/login");
    await expect(page.locator("#auth-signed-out")).toBeVisible();
    // The toggle is hidden by the `hidden` attribute only when router/JS hides it; at this width the
    // CSS reveals it (display:inline-grid). It must be visible AND a real ≥44px tap target.
    const toggle = page.locator("#nav-toggle");
    await expect(toggle).toBeVisible();
    const box = await toggle.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  });
});

test.describe("the account nav collapses behind a hamburger", () => {
  test("opens to reveal nav items and closes after navigating", async ({ page }) => {
    await page.goto("/#/login");
    await expect(page.locator("#auth-signed-out")).toBeVisible();
    await signInAsAdmin(page);
    // Land on home so the signed-in nav items exist.
    await page.evaluate(() => (window.location.hash = "#/home"));
    await expect(page.locator("#auth-signed-in")).toBeVisible();

    const nav = page.locator(".app-nav");
    const toggle = page.locator("#nav-toggle");
    const profileLink = page.locator("#nav-profile");

    // Collapsed by default: the menu group is not displayed, so the Profile link isn't visible.
    await expect(profileLink).toBeHidden();
    await expect(nav).toHaveAttribute("data-nav-open", "false");

    // Open the menu → items become visible + aria-expanded reflects state.
    await toggle.click();
    await expect(nav).toHaveAttribute("data-nav-open", "true");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expectControlUsable(page, profileLink);

    // Clicking a nav item navigates AND closes the menu (TM-229 nav-toggle.js behaviour).
    await profileLink.click();
    await expect(nav).toHaveAttribute("data-nav-open", "false");
    await expect(page.locator("#profile-view")).toBeVisible();
  });
});

test.describe("admin users console at a phone viewport", () => {
  test("table renders, scrolls inside its wrapper, and the page does not scroll sideways", async ({
    page,
  }) => {
    await page.goto("/#/login");
    await expect(page.locator("#auth-signed-out")).toBeVisible();
    await signInAsAdmin(page);

    await page.evaluate(() => (window.location.hash = "#/admin"));
    await expect(page.locator("#admin-view")).toBeVisible();
    await expect(page.locator("#admin-table")).toBeVisible();

    // The seeded target row is present (the view actually populated, not an empty shell).
    const targetRow = page.locator("#admin-table tr", { hasText: TARGET.email });
    await expect(targetRow).toBeVisible();

    // The wide table is allowed to scroll WITHIN its wrapper; the wrapper is the overflow container.
    const canScrollInside = await page.evaluate(() => {
      const w = document.getElementById("admin-table");
      return w ? w.scrollWidth >= w.clientWidth : false;
    });
    expect(canScrollInside).toBeTruthy();

    // But that wide table must NOT force the whole page to scroll horizontally.
    await expectNoHorizontalPageScroll(page);

    // The row's primary action is still usable on a phone.
    await expectControlUsable(page, targetRow.getByRole("button").first());
  });
});

test.describe("edit-profile at a phone viewport", () => {
  test("the form fits and Save changes is usable", async ({ page }) => {
    await page.goto("/#/login");
    await expect(page.locator("#auth-signed-out")).toBeVisible();
    await signInAsAdmin(page);

    // Arm the /me wait BEFORE the navigation that mounts the form (TM-198 lesson).
    const meLoaded = page.waitForResponse(
      (r) => r.url().includes("/api/v1/me") && r.request().method() === "GET",
    );
    await page.evaluate(() => (window.location.hash = "#/profile"));
    await expect(page.locator("#profile-form")).toBeVisible();
    await meLoaded;

    await expectControlUsable(page, page.getByRole("button", { name: "Save changes" }));
    await expectNoHorizontalPageScroll(page);
  });
});
