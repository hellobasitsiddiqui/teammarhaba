import { test, expect } from "@playwright/test";

// Hide Google sign-in inside the Android WebView (TM-275). Google blocks its OAuth flow inside
// embedded WebViews ("disallowed_useragent"), so the button can only ever error there. login.js
// removes it when `isWebViewEnv()` is true (the native shell sets `window.TEAMMARHABA_WEBVIEW`);
// everywhere else (desktop / mobile browser) it stays. These two tests pin both halves of that
// contract. The button lives under "Try another way", so each test reveals the alternatives first.
//
// Suppress the first-run product tour (TM-147) so its modal can't overlay the controls.
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

test("@webview Google sign-in is hidden inside the WebView (TEAMMARHABA_WEBVIEW flag set)", async ({ page }) => {
  // Simulate the native Android shell signalling the WebView env BEFORE the app loads.
  await page.addInitScript(() => {
    window.TEAMMARHABA_WEBVIEW = true;
  });

  await page.goto("/#/login");
  await expect(page.locator("#auth-signed-out")).toBeVisible();

  // Reveal the alternatives where Google would live.
  await page.click("#try-another-btn");
  await expect(page.locator("#auth-alternatives")).toBeVisible();

  // The other alternatives are still offered — only Google is removed.
  await expect(page.locator("#sms-send-btn")).toBeVisible();
  await expect(page.locator("#password")).toBeVisible();
  await expect(page.locator("#google-btn")).toHaveCount(0);
});

test("@webview Google sign-in is shown in a normal browser (no WebView flag)", async ({ page }) => {
  await page.goto("/#/login");
  await expect(page.locator("#auth-signed-out")).toBeVisible();

  await page.click("#try-another-btn");
  await expect(page.locator("#auth-alternatives")).toBeVisible();
  await expect(page.locator("#google-btn")).toBeVisible();
});
