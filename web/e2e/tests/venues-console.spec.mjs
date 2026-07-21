import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { ADMIN, API_BASE_URL } from "../fixtures.mjs";
import { authHeadersFor } from "../events-api.mjs";

// ── Admin venues console — two e2e specs against the REAL browser + full stack (backend + Firebase
// Auth emulator + Postgres, per web/e2e/README.md), signed in as the seeded ADMIN:
//
//   1. TM-707 (regression): the console loads on the EMPTY-search default view WITHOUT the backend
//      500 that an untyped null `:q` bind used to throw — a narrow guard on the very first fetch.
//   2. TM-738 (P0 journey): the admin CRUD lifecycle end-to-end THROUGH THE CONSOLE UI —
//      create → see it in the list → edit a field → deactivate → confirm it drops from the active list.
//
// Both reuse the harness's seeded ADMIN (global-setup.mjs, which grants the role=ADMIN custom claim so
// #nav-admin appears and the /api/v1/admin/venues routes authorize). `screenshot: "on"` is set
// globally (playwright.config.mjs); each spec also takes explicit named shots for the evidence trail.

// Suppress the first-run product tour so its dimmed overlay/backdrop can't cover the controls under
// test — the identical localStorage init-script every other spec uses (TM-147).
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

/** Sign in as the seeded ADMIN via the email+password path under "Try another way" (the flow every
 *  admin spec uses), then wait until the admin nav resolves. Leaves the browser on the home view. */
async function signInAsAdmin(page) {
  await page.goto("/#/login");
  await expect(page.locator("#auth-signed-out")).toBeVisible();
  await page.fill("#email", ADMIN.email);
  await page.click("#try-another-btn");
  await page.fill("#password", ADMIN.password);
  await page.click("#signin-btn");
  await openNav(page); // phone: the admin nav link lives behind the hamburger — open it before asserting
  await expect(page.locator("#nav-admin")).toBeVisible();
  await expect(page.locator("#auth-signed-out")).toBeHidden();
}

/** Open the venues console via the #/admin hub's Venues row (TM-937: the per-console top-nav link
 *  is gone; #nav-admin opens the hub) and wait for the list panel + a row to render. */
async function openVenuesConsole(page) {
  await openNav(page);
  await page.locator("#nav-admin").click();
  await page.click('.admin-hub-row[href="#/admin/venues"]');
  await expect(page).toHaveURL(/#\/admin\/venues$/);
  await expect(page.locator("#admin-venues-view")).toBeVisible();
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

// ────────────────────────────────────────────────────────────────────────
// SPEC 1 — TM-707: the console loads on the empty-search default view (regression).
// ────────────────────────────────────────────────────────────────────────
//
// The bug (TM-707): the admin venues console loads its inventory with an EMPTY search box, so the
// backend runs VenueRepository.search(null, …). Postgres type-resolves the whole predicate at plan
// time, so an untyped null `:q` bound inside concat()/lower() defaulted to `bytea` and the listing
// query died with `function lower(bytea) does not exist` — a 500 on the exact first view of the
// console, before the admin can do anything. The fix casts `:q` to string so the parameter is always
// typed text (`cast(:q as string)`), on both the null and non-null paths.
//
// FAIL-BEFORE / PASS-AFTER: on the fixed branch this passes. Reverting the cast in VenueRepository.java
// (back to `lower(concat('%', :q, '%'))`) makes the very first GET /api/v1/admin/venues 500, so the
// console paints its `.tm-error` block with "An unexpected error occurred." and NO stat cards — the
// assertions below fail. That is the honest before/after evidence for the fix.
test("@admin @venues admin venues console loads on the empty-search default view (TM-707)", async ({ page }, testInfo) => {
  // Seed one venue via the admin API so the list has a row to render (the empty-search fetch runs
  // regardless — the console never sends `q` — but a seeded row makes the pass-after evidence clear).
  // Uniqueness is derived from a fresh UUID (not Date.now) so parallel/shared-DB runs never collide.
  const venueName = `E2E Venue TM707 ${randomUUID().slice(0, 8)}`;
  const adminHeaders = await authHeadersFor(ADMIN);
  const venue = await seedVenue(adminHeaders, venueName);

  await signInAsAdmin(page);

  // ── Open the venues console — this is the empty-search default view that used to 500 (TM-707). ────
  await openVenuesConsole(page);

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

// ────────────────────────────────────────────────────────────────────────
// SPEC 2 — TM-738 (P0): admin creates, edits and deactivates a venue end-to-end THROUGH THE UI.
// ────────────────────────────────────────────────────────────────────────
//
// The P0 journey for the admin venues surface — driven entirely through the console UI (no API
// short-cuts for the CRUD steps; the only non-UI setup is the emulator sign-in):
//
//   sign in as ADMIN → open the venues console → NEW VENUE (fill the full-page form: name, address,
//   city, capacity) → assert the 201 VenueResponse → it appears in the list, Active → EDIT the name via
//   the row's Edit → assert the 200 PATCH + the list row updates → DEACTIVATE it via the styled confirm
//   → assert the 200 deactivate response (active=false) → filter the list to ACTIVE-only and confirm the
//   venue has DROPPED OUT of the active list (while still present under "All venues" as Deactivated —
//   it's a retire, not a delete).
//
// Uniqueness: a fresh UUID suffix (NOT Date.now — unavailable per the harness contract) so the row +
// the response assertions are unambiguous across shared-DB runs / CI retries. Named step screenshots
// (console / form / created / edited / deactivated / active-filtered) give a step-by-step visual trail.
test("@admin @venues admin creates, edits and deactivates a venue; it drops from the active list (TM-738)", async ({ page }, testInfo) => {
  let stepNo = 0;
  const shot = async (name) =>
    page.screenshot({
      path: testInfo.outputPath(`venues-crud-${String(++stepNo).padStart(2, "0")}-${name}.png`),
      fullPage: true,
    });

  // A unique name per run so the list row + the API-response assertions are unambiguous.
  const suffix = randomUUID().slice(0, 8);
  const NAME = `E2E Venue TM738 ${suffix}`;
  const EDITED_NAME = `${NAME} (edited)`;
  const CITY = "London";
  const CAPACITY = 42;

  // ── STEP 1: sign in as the seeded ADMIN. ───────────────────────────────────────────────
  await signInAsAdmin(page);

  // ── STEP 2: open the venues console (empty-search default view). ─────────────────────────────
  await openVenuesConsole(page);
  await expect(page.locator("#admin-venues-stats .tm-stat").first()).toBeVisible();
  await shot("console");

  // ── STEP 3: open the full-page New-venue form + fill it. ──────────────────────────────────
  // "New venue" navigates to its OWN full-page route (TM-519) — the console list is replaced by the
  // form view, not overlaid by a modal (mirrors admin-events TM-426). Assert the route + the swap.
  await page.click("#admin-venues-new");
  await expect(page).toHaveURL(/#\/admin\/venues\/new$/);
  await expect(page.locator("#admin-venue-form-view")).toBeVisible();
  await expect(page.locator("#admin-venues-view")).toBeHidden();
  await expect(page.locator("#admin-venue-form-back")).toBeVisible();
  const form = page.locator("#venue-form");
  await expect(form).toBeVisible();
  await page.fill("#venue-name", NAME);
  await page.fill("#venue-address", `${NAME}, 1 Test Street`);
  await page.fill("#venue-city", CITY);
  await page.fill("#venue-capacity", String(CAPACITY));
  await shot("form");

  // ── STEP 4: create → assert the 201 VenueResponse (the honest server result). ──────────────────
  const createResponse = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/v1/admin/venues") &&
      r.request().method() === "POST",
  );
  await page.click("#venue-save");
  const createRes = await createResponse;
  expect(createRes.status()).toBe(201);
  const created = await createRes.json();
  expect(created.name).toBe(NAME);
  expect(created.city).toBe(CITY);
  expect(created.capacity).toBe(CAPACITY);
  expect(created.active).toBe(true); // a new venue is offered in the picker by default

  // ── STEP 5: saving returned to the list (TM-519); the venue is there, Active. ──────────────────
  await expect(page).toHaveURL(/#\/admin\/venues$/);
  await expect(page.locator("#admin-venues-view")).toBeVisible();
  const row = page.locator(`tr[data-venue-id="${created.id}"]`);
  await expect(row).toBeVisible();
  await expect(row).toContainText(NAME);
  await expect(row).toContainText(CITY);
  await expect(row.locator(".tm-badge-ok")).toHaveText("Active");
  await shot("created");

  // ── STEP 6: edit the name via the row's Edit → assert the 200 PATCH + the list row updates. ──────
  // The row's Edit navigates to the full-page edit route; the form is prefilled from the existing venue.
  await row.getByRole("button", { name: `Edit ${NAME}` }).click();
  await expect(page).toHaveURL(new RegExp(`#/admin/venues/${created.id}/edit$`));
  await expect(page.locator("#venue-form")).toBeVisible();
  await expect(page.locator("#venue-name")).toHaveValue(NAME); // prefilled from the venue
  await page.fill("#venue-name", EDITED_NAME);
  const patchResponse = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/api/v1/admin/venues/${created.id}`) &&
      r.request().method() === "PATCH",
  );
  await page.click("#venue-save");
  const patchRes = await patchResponse;
  expect(patchRes.status()).toBe(200);
  const edited = await patchRes.json();
  expect(edited.name).toBe(EDITED_NAME);
  // Back on the list, the same row now shows the edited name (still Active).
  await expect(page).toHaveURL(/#\/admin\/venues$/);
  const editedRow = page.locator(`tr[data-venue-id="${created.id}"]`);
  await expect(editedRow).toContainText(EDITED_NAME);
  await expect(editedRow.locator(".tm-badge-ok")).toHaveText("Active");
  await shot("edited");

  // ── STEP 7: deactivate via the styled confirm → assert the 200 deactivate (active=false). ────────
  // Deactivate is a retire, not a delete — it sits behind a confirm dialog (the record survives).
  await editedRow.getByRole("button", { name: `Deactivate ${EDITED_NAME}` }).click();
  const dialog = page.locator(".tm-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Deactivate this venue?");
  const deactivateResponse = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/api/v1/admin/venues/${created.id}/deactivate`) &&
      r.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Deactivate" }).click();
  const deactivateRes = await deactivateResponse;
  expect(deactivateRes.status()).toBe(200);
  const deactivated = await deactivateRes.json();
  expect(deactivated.active).toBe(false);
  // The row stays in the (default "All venues") view but now reads Deactivated.
  await expect(editedRow.locator(".tm-badge-off")).toHaveText("Deactivated");
  await shot("deactivated");

  // ── STEP 8: filter to ACTIVE-only → the venue has DROPPED from the active list. ────────────────
  // The heart of the P0: after deactivation the venue must no longer appear when the console is filtered
  // to the active inventory (the exact set the event-create picker offers). It is NOT gone — switching
  // back to "All venues" shows it again as Deactivated — proving deactivate retired it, not deleted it.
  await page.locator("#admin-venues-status-filter").selectOption("ACTIVE");
  await expect(page.locator(`tr[data-venue-id="${created.id}"]`)).toHaveCount(0);
  await expect(page.locator("#admin-venues-view")).not.toContainText(EDITED_NAME);
  await shot("active-filtered");

  // Sanity: back on "All venues" the venue is still there, Deactivated — a retire, not a delete.
  await page.locator("#admin-venues-status-filter").selectOption("ALL");
  const finalRow = page.locator(`tr[data-venue-id="${created.id}"]`);
  await expect(finalRow).toBeVisible();
  await expect(finalRow).toContainText(EDITED_NAME);
  await expect(finalRow.locator(".tm-badge-off")).toHaveText("Deactivated");
});
