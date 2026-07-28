import { test, expect } from "@playwright/test";
import pg from "pg";
import { ADMIN, dbConfig } from "../fixtures.mjs";

// Admin events console create → edit → cancel e2e (TM-395, epic TM-390) — the automated-test gate for
// the admin events UI. Drives the whole admin flow through the real browser + full stack and asserts
// the honest backend result + persisted row:
//
//   sign in as ADMIN → open the events console → NEW EVENT (tap a "Coffee & X" chip, fill the form
//   incl. city + per-event reveal-hours + an age band) → assert the 201 EventResponse → the event
//   appears in the list with its derived status → EDIT the heading → assert the 200 → CANCEL it via
//   the styled confirm → assert the CANCELLED status → assert the events row persisted in Postgres.
//
// Built on the blocker task: the admin events API (TM-392, POST/PATCH/POST-cancel /api/v1/admin/events).
// Reuses the harness's seeded ADMIN (global-setup.mjs) + the DB seam. No image is uploaded here — the
// image path is a separate Storage-emulator concern; this gate proves the create/edit/cancel lifecycle
// + persistence + the screenshot trail. Dates are computed relative to now (UTC timezone on the event)
// so the derived "Visible" status is stable regardless of when CI runs.
//
// The create/edit form is a full-page admin route now (TM-426): "New event" navigates to
// #/admin/events/new and a row's "Edit" to #/admin/events/{id}/edit — it used to be a modal that
// overflowed short viewports and hid the submit button (TM-421). So this spec also asserts the route
// and that the console list view is replaced by the form page (not overlaid by a modal).
//
// `screenshot: "on"` is set globally (playwright.config.mjs); we ALSO take an explicit named shot at
// each major step (console / form / created / edited / cancelled) so the run yields a step-by-step
// visual trail to attach to the sprint evidence ticket.

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

/** Click a primary destination by its bottom-tab id. TM-1043 removed the top .app-nav and its
 *  hamburger, so the bottom tab bar (#app-tabbar) is the single nav at every width — a tab click
 *  works from any route, with no hamburger to open. */
async function clickNav(page, tabSelector) {
  const tab = page.locator(tabSelector);
  await expect(tab).toBeVisible();
  await tab.click();
}

/** Open the #/admin hub. The top nav is gone entirely (TM-1043); the admin affordance is the bottom
 *  #tab-admin tab, which tabbar.js injects once the ADMIN role resolves — racing it flakes. So
 *  deep-link straight to the hub, the same reload-onto-#/admin pattern nav-render-races.spec relies on. */
async function openAdminHub(page) {
  await page.goto("/#/admin");
  await expect(page).toHaveURL(/#\/admin$/);
}

/** A `<input type="datetime-local">` value ("YYYY-MM-DDTHH:mm") from a Date's UTC parts — paired with
 *  the UTC timezone on the event, so the wall-clock entered equals the UTC instant stored (predictable
 *  assertions), and the derived lifecycle is unambiguous. */
function localValue(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${p(date.getUTCMonth() + 1)}-${p(date.getUTCDate())}T${p(date.getUTCHours())}:${p(date.getUTCMinutes())}`;
}

// A unique heading per run so the DB assertion + the list row are unambiguous across shared-DB runs.
const HEADING = `E2E Coffee & Code ${Date.now()}`;
const EDITED_HEADING = `${HEADING} (edited)`;

test("@admin @admin-events admin creates, edits and cancels an event; it persists honestly", async ({ page }, testInfo) => {
  let stepNo = 0;
  const shot = async (name) =>
    page.screenshot({
      path: testInfo.outputPath(`admin-events-${String(++stepNo).padStart(2, "0")}-${name}.png`),
      fullPage: true,
    });

  // Dates relative to now so the derived status is stable: visible window already open, start in the
  // future ⇒ the list shows "Visible". Event timezone = UTC so wall-clock == instant.
  const now = Date.now();
  const start = new Date(now + 30 * 864e5);
  const end = new Date(now + 30 * 864e5 + 2 * 36e5);
  const visStart = new Date(now - 864e5);
  const visEnd = new Date(now + 60 * 864e5);

  // ── STEP 1: sign in as the seeded ADMIN (email+password under "Try another way", like broadcast). ─
  await page.goto("/#/login");
  await expect(page.locator("#auth-signed-out")).toBeVisible();
  await page.fill("#email", ADMIN.email);
  await page.click("#try-another-btn");
  await page.fill("#password", ADMIN.password);
  await page.click("#signin-btn");
  // Signed in. Home is content-first post-TM-908 (no top nav on phone Home); reach admin width-aware below.
  await expect(page.locator("#auth-signed-out")).toBeHidden();

  // ── STEP 2: open the events console via the hub (TM-937: the per-console top-nav links are gone;
  //    the #/admin hub is opened width-aware and the console is reached from its Events row). ──────
  await openAdminHub(page);
  await page.click('.admin-hub-row[href="#/admin/events"]');
  await expect(page.locator("#admin-events-view")).toBeVisible();
  await expect(page.locator("#admin-events-table")).toBeVisible();
  await shot("console");

  // ── STEP 3: open the New event form + fill it (chip prefill, city, reveal hours, age band). ──────
  await page.click("#admin-events-new");
  // The form is its own full page now (TM-426), not a modal: the URL is the create route, the console
  // list view is replaced by the form view, and a "← Events" back link is present.
  await expect(page).toHaveURL(/#\/admin\/events\/new$/);
  await expect(page.locator("#admin-event-form-view")).toBeVisible();
  await expect(page.locator("#admin-events-view")).toBeHidden();
  await expect(page.locator("#admin-event-form-back")).toBeVisible();
  const form = page.locator("#event-form");
  await expect(form).toBeVisible();
  // Tap a Coffee & X suggestion chip — it prefills the heading, still editable (TM-382).
  await page.click('.tm-chip[data-chip="Coffee & Code"]');
  await expect(page.locator("#event-heading")).toHaveValue("Coffee & Code");
  // Overwrite with a unique heading so the row + DB row are findable.
  await page.fill("#event-heading", HEADING);
  // Description templates (TM-1113): a tap-to-insert chip above the Description textarea prefills it
  // (free text after — the same seeding contract as the Coffee & X heading chips). Scope to the
  // description templates group (aria-label) so it doesn't collide with the opening-message templates.
  const descTemplates = page.locator('[aria-label="Description templates"] .tm-chip').first();
  await expect(descTemplates).toBeVisible();
  await descTemplates.click();
  await expect(page.locator("#event-description")).not.toHaveValue("");
  // Overwrite with the test's own copy (the prefill is only a starter, still fully editable).
  await page.fill("#event-description", "Bring a laptop and a mug — we pair on the app.");
  await page.fill("#event-location", "Marhaba Cafe, 12 High St");
  await page.locator("#event-city").selectOption("London"); // City is now a dropdown (TM-1063)
  // TM-1066: the timezone selector moved under a collapsed "More options" <details>; open it first so
  // the select is interactable (an override — the derived venue-timezone case doesn't need this).
  await page.locator("#event-more-options-toggle").click();
  await page.locator("#event-timezone").selectOption("UTC");
  await page.fill("#event-start", localValue(start));
  await page.fill("#event-end", localValue(end));
  await page.fill("#event-visibility-start", localValue(visStart));
  await page.fill("#event-visibility-end", localValue(visEnd));
  await page.fill("#event-capacity", "20");
  await page.fill("#event-reveal-hours", "24"); // per-event location-reveal override (TM-408)
  // Age band (TM-1065): the two number inputs are behind a "Custom" chip now. 21-40 is a NON-preset band,
  // so tap Custom to reveal + fill them (a preset chip would set fixed numbers instead). The inputs are
  // hidden until Custom is chosen, so this click is REQUIRED before the fills. NOTE (TM-1076): the price
  // control ALSO has a "Custom" chip, so scope the selector to the age band's own control (`.tm-age-band`)
  // to avoid a strict-mode collision with the price Custom chip.
  await page.click('.tm-age-band .tm-chip[data-chip="Custom"]');
  await expect(page.locator("#event-age-min")).toBeVisible();
  await page.fill("#event-age-min", "21"); // age band (TM-415 / TM-1065 Custom)
  await page.fill("#event-age-max", "40");
  // Price (TM-1076): the control DEFAULTS to Free, so we leave it untouched here — the assertion in STEP 4
  // that created.pricePence === 0 proves the untouched control produces a FREE event (not the old silent
  // £5 fallback). The Custom-price path is exercised by the dedicated STEP 4b below.
  await shot("form");

  // ── STEP 4: save → assert the 201 EventResponse (the honest server result). ──────────────────────
  const createResponse = page.waitForResponse(
    (r) => r.url().includes("/api/v1/admin/events") && r.request().method() === "POST",
  );
  await page.click("#event-save");
  const createResp = await createResponse;
  // TM-1076: the POST body MUST carry an explicit pricePence:0 — an omitted price is exactly what made the
  // backend fall back to £5 (Event.DEFAULT_PRICE_PENCE). Assert the wire body, not just the response.
  expect(createResp.request().postDataJSON().pricePence).toBe(0);
  const created = await createResp.json();
  expect(created.heading).toBe(HEADING);
  expect(created.city).toBe("London");
  expect(created.timezone).toBe("UTC");
  expect(created.capacity).toBe(20);
  expect(created.status).toBe("PUBLISHED");
  // TM-1076: the untouched Price control defaulted to Free → the event is genuinely free, NOT the old
  // silent £5. This is the load-bearing assertion of the ticket.
  expect(created.pricePence).toBe(0);
  // The per-event reveal override rode through, and the API resolved an effective window (TM-408).
  expect(created.locationRevealHours).toBe(24);
  expect(typeof created.effectiveLocationRevealHours).toBe("number");

  // ── STEP 5: saving navigated back to the list (TM-426); it lands there with its derived status. ───
  await expect(page).toHaveURL(/#\/admin\/events$/);
  await expect(page.locator("#admin-events-view")).toBeVisible();
  // TM-1096: the list defaults to the "Happening now" lifecycle chip, so a future-start ("Visible")
  // event is filtered OUT of the default view. Click "All" (the All/Clear affordance) to show every
  // bucket so the created row is present for the assertions in steps 5-8.
  await page.locator("#admin-events-lifecycle-all").click();
  const row = page.locator(`tr[data-event-id="${created.id}"]`);
  await expect(row).toBeVisible();
  await expect(row).toContainText(HEADING);
  await expect(row).toContainText("Visible"); // window open + start in the future (event-form lifecycle)
  await shot("created");

  // ── STEP 6: edit the heading → assert the 200. The row's Edit navigates to the full-page edit route. ─
  await row.getByRole("button", { name: `Edit ${HEADING}` }).click();
  await expect(page).toHaveURL(new RegExp(`#/admin/events/${created.id}/edit$`));
  await expect(page.locator("#event-form")).toBeVisible();
  await expect(page.locator("#event-heading")).toHaveValue(HEADING); // prefilled from the event
  await page.fill("#event-heading", EDITED_HEADING);
  const patchResponse = page.waitForResponse(
    (r) => r.url().includes(`/api/v1/admin/events/${created.id}`) && r.request().method() === "PATCH",
  );
  await page.click("#event-save");
  const edited = await (await patchResponse).json();
  expect(edited.heading).toBe(EDITED_HEADING);
  await expect(page.locator(`tr[data-event-id="${created.id}"]`)).toContainText(EDITED_HEADING);
  await shot("edited");

  // ── STEP 7: cancel via the styled confirm (attendees will be notified; the record survives). ─────
  await page.locator(`tr[data-event-id="${created.id}"]`).getByRole("button", { name: `Cancel ${EDITED_HEADING}` }).click();
  const dialog = page.locator(".tm-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Cancel this event?");
  const cancelResponse = page.waitForResponse(
    (r) => r.url().includes(`/api/v1/admin/events/${created.id}/cancel`) && r.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Cancel event" }).click();
  const cancelled = await (await cancelResponse).json();
  expect(cancelled.status).toBe("CANCELLED");
  await expect(page.locator(`tr[data-event-id="${created.id}"]`)).toContainText("Cancelled");
  await shot("cancelled");

  // ── STEP 8: it PERSISTED — one events row for this heading, cancelled, with the fields we set. ────
  const client = new pg.Client(dbConfig);
  await client.connect();
  try {
    const { rows } = await client.query(
      "SELECT heading, status, timezone, city, capacity, price_pence FROM events WHERE heading = $1",
      [EDITED_HEADING],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("CANCELLED");
    expect(rows[0].timezone).toBe("UTC");
    expect(rows[0].city).toBe("London");
    expect(rows[0].capacity).toBe(20);
    // TM-1076: the untouched Price control defaulted to Free → the PERSISTED row is 0 pence, NOT the old
    // silent £5 (500) default. Proven at the DB, not just the response.
    expect(rows[0].price_pence).toBe(0);
  } finally {
    await client.end();
  }
});

// TM-1076: a dedicated price-persist + edit-reopen path. A preset (£10) and a Custom amount (£7.50) each
// persist as their pence, and re-opening the edit form lands on the SAVED price (the chip reflects it, and
// the Custom amount is prefilled). Reuses the same sign-in + hub nav as the lifecycle test above.
test("@admin @admin-events event price: presets + a custom amount persist and re-open on edit (TM-1076)", async ({ page }) => {
  const HEADING_PRICE = `E2E Priced Event ${Date.now()}`;
  const now = Date.now();
  const start = new Date(now + 30 * 864e5);
  const visStart = new Date(now - 864e5);
  const visEnd = new Date(now + 60 * 864e5);

  // Sign in as ADMIN + open the events console (same path as the lifecycle test).
  await page.goto("/#/login");
  await expect(page.locator("#auth-signed-out")).toBeVisible();
  await page.fill("#email", ADMIN.email);
  await page.click("#try-another-btn");
  await page.fill("#password", ADMIN.password);
  await page.click("#signin-btn");
  await expect(page.locator("#auth-signed-out")).toBeHidden();
  await openAdminHub(page);
  await page.click('.admin-hub-row[href="#/admin/events"]');
  await expect(page.locator("#admin-events-view")).toBeVisible();

  // New event — fill the minimum required fields + pick the £10 price preset.
  await page.click("#admin-events-new");
  await expect(page.locator("#event-form")).toBeVisible();
  await page.fill("#event-heading", HEADING_PRICE);
  await page.fill("#event-description", "Priced event for the TM-1076 e2e.");
  await page.fill("#event-location", "Marhaba Cafe, 12 High St");
  await page.locator("#event-more-options-toggle").click();
  await page.locator("#event-timezone").selectOption("UTC");
  await page.fill("#event-start", localValue(start));
  await page.fill("#event-visibility-start", localValue(visStart));
  await page.fill("#event-visibility-end", localValue(visEnd));
  // Pick the £10 preset — scope to the price control so it can't collide with the age Custom chip.
  await page.click('.tm-price-band .tm-chip[data-chip="£10"]');
  const createResponse = page.waitForResponse(
    (r) => r.url().includes("/api/v1/admin/events") && r.request().method() === "POST",
  );
  await page.click("#event-save");
  const createResp = await createResponse;
  expect(createResp.request().postDataJSON().pricePence).toBe(1000); // £10 on the wire
  const created = await createResp.json();
  expect(created.pricePence).toBe(1000);

  // Re-open the edit form → the £10 chip is reflected as active (the saved price re-opens).
  await page.goto(`/#/admin/events/${created.id}/edit`);
  await expect(page.locator("#event-form")).toBeVisible();
  await expect(page.locator('.tm-price-band .tm-chip[data-chip="£10"]')).toHaveAttribute("aria-pressed", "true");

  // Change to a Custom £7.50 → save → assert 750 pence persisted.
  await page.click('.tm-price-band .tm-chip[data-chip="Custom"]');
  await expect(page.locator("#event-price")).toBeVisible();
  await page.fill("#event-price", "7.50");
  const patchResponse = page.waitForResponse(
    (r) => r.url().includes(`/api/v1/admin/events/${created.id}`) && r.request().method() === "PATCH",
  );
  await page.click("#event-save");
  const patchResp = await patchResponse;
  expect(patchResp.request().postDataJSON().pricePence).toBe(750); // £7.50 → 750 pence
  const edited = await patchResp.json();
  expect(edited.pricePence).toBe(750);

  // Re-open once more → a non-preset amount opens on Custom with the exact £ value prefilled.
  await page.goto(`/#/admin/events/${created.id}/edit`);
  await expect(page.locator("#event-form")).toBeVisible();
  await expect(page.locator('.tm-price-band .tm-chip[data-chip="Custom"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#event-price")).toHaveValue("7.50");

  // DB check: the persisted row carries 750 pence (the custom amount), not the £5 default.
  const client = new pg.Client(dbConfig);
  await client.connect();
  try {
    const { rows } = await client.query("SELECT price_pence FROM events WHERE heading = $1", [HEADING_PRICE]);
    expect(rows).toHaveLength(1);
    expect(rows[0].price_pence).toBe(750);
  } finally {
    await client.end();
  }
});
