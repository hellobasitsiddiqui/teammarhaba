import { test, expect } from "@playwright/test";

// Help section (TM-255) + attribution byline (TM-254). Both are static, signed-out-reachable
// surfaces, so this spec needs NO auth — it exercises the real anonymous path a visitor takes:
//   • the #/help route renders its guide and is reachable by clicking the nav link,
//   • the footer carries the "A product of 10xAI" byline linking to 10xai.co.uk (new tab + noopener).
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

test.describe("@help Help section (TM-255)", () => {
  test("the #/help route renders the guide directly", async ({ page }) => {
    await page.goto("/#/help");
    const help = page.locator("#help-view");
    await expect(help).toBeVisible();

    // The guide covers the basics (AC): what TeamMarhaba is, signing in, editing your profile, support.
    await expect(help.getByRole("heading", { name: "Help" })).toBeVisible();
    await expect(help.getByRole("heading", { name: "What is Circle?" })).toBeVisible();
    await expect(help.getByRole("heading", { name: "Signing in" })).toBeVisible();
    await expect(help.getByRole("heading", { name: "Editing your profile" })).toBeVisible();
    await expect(help.getByRole("heading", { name: "Get support" })).toBeVisible();

    // A support contact line — a mailto: the user can actually click.
    const support = help.locator("a[href^='mailto:']");
    await expect(support).toBeVisible();
  });

  test("the annotated visual guide renders inside the Help page (TM-178)", async ({ page }) => {
    await page.goto("/#/help");
    const help = page.locator("#help-view");
    await expect(help).toBeVisible();

    // The static annotated-screenshot guide section (AC1/AC2): a "Visual guide" heading, a drawn
    // mock stage with accessible alt text, at least one positioned callout, and the linear notes list.
    await expect(help.getByRole("heading", { name: "Visual guide" })).toBeVisible();

    const stage = help.locator(".tm-guide-stage").first();
    await expect(stage).toBeVisible();
    // The mock exposes the whole picture to assistive tech via role=img + a descriptive alt (AC4).
    await expect(stage).toHaveAttribute("aria-label", /mock of the Circle home screen/i);

    // At least one callout note with an arrow is drawn over the mock (AC1).
    await expect(help.locator(".tm-guide-callout").first()).toBeVisible();
    // And the accessible linear restatement of the callouts is present (AC4).
    await expect(help.locator(".tm-guide-notes li").first()).toBeVisible();
  });

  test("Help stays reachable by route for a signed-out visitor (TM-1024)", async ({ page }) => {
    // TM-1024: the desktop top nav became exactly the four tabs, so the Help *nav link* (#nav-help-link)
    // was removed — but the #/help page/route deliberately stays reachable for anyone, signed in or out.
    // This test used to click the nav link; it now proves the route still resolves from a signed-out
    // start (a hash goto is what a bookmark / footer link / in-page link into Help exercises).
    await page.goto("/#/login");
    await expect(page.locator("#auth-signed-out")).toBeVisible();

    await page.evaluate(() => (window.location.hash = "#/help"));

    await expect(page.locator("#help-view")).toBeVisible();
    expect(page.url()).toContain("#/help");
  });
});

test.describe("@help Attribution byline (TM-254)", () => {
  test("the footer carries the 10xAI byline linking out in a new tab", async ({ page }) => {
    await page.goto("/#/login");
    await expect(page.locator("#auth-signed-out")).toBeVisible();

    const byline = page.locator(".app-byline");
    await expect(byline).toBeVisible();
    await expect(byline).toContainText("A product of");

    const link = byline.locator("a");
    await expect(link).toHaveText("10xAI");
    await expect(link).toHaveAttribute("href", "https://10xai.co.uk");
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", /noopener/);
  });
});
