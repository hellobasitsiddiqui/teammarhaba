import { test, expect } from "@playwright/test";
import { EVENT_GOER } from "../fixtures.mjs";

// TM-1095 (was TM-830) — the profile interests editor must be reachable + saveable on a phone.
//
// HISTORY: TM-830 fixed a bug where the interests picker OVERLAY (a `.tm-modal` opened from Profile →
// Interests → "+ add") grew taller than the phone viewport, stranding its Save button below the fold.
// TM-1095 RETIRED that overlay entirely: the hub's "＋ add" / "Manage" chip now navigates to a dedicated
// full-screen route (`#/profile/interests`, interests-route.js) with a SEARCH field, COLLAPSIBLE category
// sections, and a STICKY Save/Cancel bar. The old bug is now structurally impossible — Save lives in a
// position:sticky bar pinned to the viewport bottom, not inside a scroll container — so this spec asserts
// the ROUTE's mobile reachability + the new affordances instead of the retired modal geometry.
//
// SCOPE: the profile-edit interests EDITOR only. The new-user onboarding interests step is a separate
// full-page picker and is deliberately NOT exercised here.
//
// Runs under the `mobile-chromium` project (Pixel 5 ≈ 393×727 CSS px) — see playwright.config.mjs
// testMatch — so it exercises the real narrow-screen layout. Patterns mirror the prior TM-830 spec
// (tour suppression, sign-in helper, in-viewport assertion).

// Suppress the first-run product tour: its dimmed overlay would sit over the editor under test. Same
// approach as responsive-mobile.spec.mjs — make any `tm.tour.*` key read as done.
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

// Sign in as a seeded, onboarded + terms-accepted user (EVENT_GOER, provisioned by global-setup) so the
// session lands straight in the app. Email+password is behind "Try another way" (email-code is the
// default front door, TM-234).
async function signIn(page) {
  await page.goto("/#/login");
  await expect(page.locator("#auth-signed-out")).toBeVisible();
  await page.fill("#email", EVENT_GOER.email);
  await page.click("#try-another-btn");
  await page.fill("#password", EVENT_GOER.password);
  await page.click("#signin-btn");
  // The viewport-independent "signed in" signal: the signed-OUT login panel disappears.
  await expect(page.locator("#auth-signed-out")).toBeHidden();
}

// Open the interests editor from the profile hub. Arms the catalogue GETs so the sections have rendered
// before the caller asserts. Returns once #interests-view is visible.
async function openInterestsRoute(page) {
  const hubCatalogue = page.waitForResponse(
    (r) => r.url().includes("/api/v1/interests/catalogue") && r.request().method() === "GET",
  );
  await page.evaluate(() => (window.location.hash = "#/profile"));
  await expect(page.locator("#profile-view")).toBeVisible();
  await hubCatalogue;
  const routeCatalogue = page.waitForResponse(
    (r) => r.url().includes("/api/v1/interests/catalogue") && r.request().method() === "GET",
  );
  // The hub's persistent entry chip ("＋ add" under the max, "Manage" at the max — both carry
  // `.tm-pf-chip-add`) NAVIGATES to the route rather than opening a modal.
  await page.locator(".tm-pf-chip-add").click();
  await expect(page.locator("#interests-view")).toBeVisible();
  await routeCatalogue;
}

test.describe("@responsive TM-1095 profile interests full-screen route", () => {
  test("the interests route is reachable from the hub, its sticky Save is in-viewport, and it saves", async ({
    page,
  }) => {
    await signIn(page);
    await openInterestsRoute(page);

    // The dedicated route replaced the hub view (its own #interests-view; the hub is hidden).
    await expect(page.locator("#profile-view")).toBeHidden();
    expect(page.url()).toContain("#/profile/interests");

    // The route paints a search box, at least one collapsible section (Popular first), and the sticky bar.
    await expect(page.locator("#interests-search")).toBeVisible();
    await expect(page.locator(".tm-interests-section-head").first()).toBeVisible();
    const saveBtn = page.locator(".tm-interests-save");
    await expect(saveBtn).toBeVisible();

    // ── Root-cause assertion (the TM-830 legacy): Save is reachable + in the viewport. The sticky bar is
    // pinned near the viewport bottom, so Save is visible without scrolling regardless of catalogue length.
    await expect(saveBtn).toBeInViewport();

    // ── Occlusion guard (TM-1095): toBeInViewport() does NOT detect that the fixed bottom tab bar
    // (.app-tabbar, z-index:900) paints OVER the Save button. Assert Save is the TOPMOST element at its
    // own centre — i.e. a real tap lands on Save, not the tab bar sitting on top of it. This fails
    // before the sticky-bar tab-bar offset fix (the tab bar wins the centre point) and passes after.
    const saveIsTopmost = await saveBtn.evaluate((btn) => {
      const r = btn.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!hit && (btn === hit || btn.contains(hit));
    });
    expect(saveIsTopmost, "Save button is occluded by the bottom tab bar").toBe(true);

    // ── Search filters the catalogue: typing a category name can only ever REMOVE options (a robust,
    // seed-independent check).
    await page.fill("#interests-search", "sport");
    const filteredCount = await page.locator(".tm-pf-picker-opt").count();
    await page.fill("#interests-search", "");
    const fullCount = await page.locator(".tm-pf-picker-opt").count();
    expect(fullCount).toBeGreaterThan(0);
    expect(filteredCount).toBeLessThanOrEqual(fullCount);

    // ── Save is disabled until the min is met; pick the first visible option (seed-independent) to
    // enable it, then Save PATCHes /me and returns to the hub.
    await expect(saveBtn).toBeDisabled();
    await page.locator(".tm-pf-picker-opt").first().click();
    await expect(saveBtn).toBeEnabled();
    const patch = page.waitForResponse(
      (r) => r.url().includes("/api/v1/me") && r.request().method() === "PATCH",
    );
    await saveBtn.click();
    await patch;
    await expect(page.locator("#profile-view")).toBeVisible();
    await expect(page.locator("#interests-view")).toBeHidden();
  });

  test("a collapsible section folds and unfolds", async ({ page }) => {
    await signIn(page);
    await openInterestsRoute(page);

    // The first section header starts expanded (aria-expanded=true); clicking it collapses its body.
    const head = page.locator(".tm-interests-section-head").first();
    await expect(head).toHaveAttribute("aria-expanded", "true");
    const body = page.locator(".tm-interests-section-body").first();
    await expect(body).toBeVisible();
    await head.click();
    await expect(head).toHaveAttribute("aria-expanded", "false");
    await expect(body).toBeHidden();
    // Clicking again unfolds it.
    await head.click();
    await expect(head).toHaveAttribute("aria-expanded", "true");
    await expect(body).toBeVisible();
  });
});
