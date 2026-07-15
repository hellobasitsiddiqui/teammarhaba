import { test, expect } from "@playwright/test";
import { ADMIN, API_BASE_URL } from "../fixtures.mjs";
import { authHeadersFor } from "../events-api.mjs";

// Admin venues console loads on the DEFAULT (empty search) view — regression e2e for TM-707.
//
// The bug (TM-707): the admin venues console loads its inventory with an EMPTY search box, so the
// backend runs VenueRepository.search(null, …). Postgres type-resolves the whole predicate at plan
// time, so an untyped null `:q` bound inside concat()/lower() defaulted to `bytea` and the listing
// query died with `function lower(bytea) does not exist` — a 500 on the exact first view of the
// console, before the admin can do anything. The fix casts `:q` to string so the parameter is always
// typed text (`cast(:q as string)`), on both the null and non-null paths.
//
// This spec drives the REAL browser + full stack (backend + Firebase Auth emulator + Postgres, per
// web/e2e/README.md): sign in as the seeded ADMIN, open #/admin/venues, and assert the list panel
// loads WITHOUT the backend's 500 detail ("An unexpected error occurred.") surfacing in the console's
// error block, and WITH the stat cards + table rendered. A venue is created via the admin API first so
// the list has a real row to show (the empty-search path is exercised either way — the console always
// fetches with no `q` — but a seeded row makes the "it loaded" evidence unambiguous).
//
// FAIL-BEFORE / PASS-AFTER: on the fixed branch this passes. Reverting the cast in VenueRepository.java
// (back to `lower(concat('%', :q, '%'))`) makes the very first GET /api/v1/admin/venues 500, so the
// console paints its `.tm-error` block with "An unexpected error occurred." and NO stat cards — the
// assertions below fail. That is the honest before/after evidence for the fix.
//
// `screenshot: "on"` is set globally (playwright.config.mjs); we also take an explicit named shot of
// the loaded console for the evidence trail.

// Suppress the first-run product tour so its dimmed overlay can't cover the console — the identical
// localStorage init-script every other spec uses (TM-147).
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

/** Open the account nav if it's collapsed behind the hamburger (phone width); a no-op at desktop. */
async function openNav(page) {
  const toggle = page.locator("#nav-toggle");
  if (await toggle.isVisible()) {
    const nav = page.locator(".app-nav");
    if ((await nav.getAttribute("data-nav-open")) !== "true") {
      await toggle.click();
      await expect(nav).toHaveAttribute("data-nav-open", "true");
    }
  }
}

/** Create a venue via the admin API (POST /api/v1/admin/venues → 201) so the console has a real row. */
async function seedVenue(headers, name) {
  const res = await fetch(`${API_BASE_URL}/api/v1/admin/venues`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name, addressLine: `${name}, 1 Test Street`, city: "London" }),
  });
  if (res.status !== 201) {
    throw new Error(`create venue failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

test("@admin @venues admin venues console loads on the empty-search default view (TM-707)", async ({ page }, testInfo) => {
  // Seed one venue via the admin API so the list has a row to render (the empty-search fetch runs
  // regardless — the console never sends `q` — but a seeded row makes the pass-after evidence clear).
  const venueName = `E2E Venue TM707 ${Date.now()}`;
  const adminHeaders = await authHeadersFor(ADMIN);
  const venue = await seedVenue(adminHeaders, venueName);

  // ── Sign in as the seeded ADMIN (email+password under "Try another way", like the other admin specs). ─
  await page.goto("/#/login");
  await expect(page.locator("#auth-signed-out")).toBeVisible();
  await page.fill("#email", ADMIN.email);
  await page.click("#try-another-btn");
  await page.fill("#password", ADMIN.password);
  await page.click("#signin-btn");
  await openNav(page);
  await expect(page.locator("#nav-admin-venues")).toBeVisible();
  await expect(page.locator("#auth-signed-out")).toBeHidden();

  // ── Open the venues console — this is the empty-search default view that used to 500 (TM-707). ────
  await page.locator("#nav-admin-venues").click();
  await expect(page).toHaveURL(/#\/admin\/venues$/);
  await expect(page.locator("#admin-venues-view")).toBeVisible();

  // The list panel loaded successfully: the stat cards render (they only exist once the fetch resolved
  // without error) and the table is present.
  await expect(page.locator("#admin-venues-view #admin-venues-stats .tm-stat").first()).toBeVisible();
  await expect(page.locator("#admin-venues-view table")).toBeVisible();

  // It did NOT surface the backend's 500 detail — the whole point of TM-707. The console renders the
  // 500's RFC-7807 `detail` ("An unexpected error occurred.") in its .tm-error block on failure; assert
  // neither that block nor that text is present.
  await expect(page.locator("#admin-venues-view .tm-error")).toHaveCount(0);
  await expect(page.locator("#admin-venues-view")).not.toContainText("An unexpected error occurred");

  // The seeded venue row is visible — proof the null-search listing actually returned data, not a 500.
  await expect(page.locator("#admin-venues-view table")).toContainText(venueName);
  expect(venue.name).toBe(venueName);

  await page.screenshot({
    path: testInfo.outputPath("venues-console-loaded.png"),
    fullPage: true,
  });
});
