import { test, expect } from "@playwright/test";

// Hide the "Get the app" store badges inside the Android WebView (TM-330). The badges are a WEB-only
// install CTA (TM-276) — "Download for Android" is nonsensical INSIDE the installed Android app
// (the Capacitor WebView shell). app-badges.js sets the footer block `hidden` when `isWebViewEnv()`
// is true (the native shell sets `window.TEAMMARHABA_WEBVIEW`); everywhere else (desktop / mobile
// browser) it stays. These two tests pin both halves of that contract — same shape and the same
// flag-injection as webview-google-hidden.spec.mjs (TM-275).
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

test('the "Get the app" badges are hidden inside the WebView (TEAMMARHABA_WEBVIEW flag set)', async ({ page }) => {
  // Simulate the native Android shell signalling the WebView env BEFORE the app loads.
  await page.addInitScript(() => {
    window.TEAMMARHABA_WEBVIEW = true;
  });

  await page.goto("/#/login");
  await expect(page.locator("#auth-signed-out")).toBeVisible();

  // The whole badge block is hidden — not just visually, the element carries `hidden`.
  await expect(page.locator("#app-store-badges")).toBeHidden();
});

test('the "Get the app" badges are shown in a normal browser (no WebView flag)', async ({ page }) => {
  await page.goto("/#/login");
  await expect(page.locator("#auth-signed-out")).toBeVisible();

  const badges = page.locator("#app-store-badges");
  await expect(badges).toBeVisible();
  await expect(badges).toContainText("Get the app");
});
