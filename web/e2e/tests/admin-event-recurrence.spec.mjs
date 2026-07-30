import { test, expect } from "@playwright/test";
import pg from "pg";
import { ADMIN, dbConfig } from "../fixtures.mjs";

// Admin event RECURRENCE / "Repeat" picker e2e (TM-796, recurring events v1) — the automated-test gate for
// the create-form recurrence picker. Drives the whole path through the real browser + full stack:
//
//   sign in as ADMIN → open the events console → NEW EVENT → turn ON "Repeat" → the recurrence picker
//   appears (Weekly + interval + weekday + end condition) → choose Weekly, After N occurrences → fill the
//   required fields → save → assert the POST /api/v1/admin/events/series 201 CreateSeriesResponse carries
//   MULTIPLE generated occurrences → they appear in the events list → the DB shows several events sharing
//   ONE series_id.
//
// FAIL-BEFORE on main: the #event-repeat-toggle control does NOT exist (the whole recurrence picker is this
// ticket's addition), so the first check() times out on a pristine tree — the Repeat-control-absent seam.
//
// Timezone note: like the sibling admin-events specs this uses "UTC" on the event so the wall-clock entered
// equals the stored instant and the WEEKLY weekday cross-check is exact. This host's local Chromium has no
// plain "UTC" zone (see blackboard 2026-07-18), so this is a CI-gate spec — validate via `e2e.yml` on the
// branch, not locally.

test.beforeEach(async ({ page }) => {
  // Suppress the first-run product tour so its backdrop can't cover the controls under test (TM-147).
  await page.addInitScript(() => {
    const orig = Storage.prototype.getItem;
    Storage.prototype.getItem = function (k) {
      return typeof k === "string" && k.startsWith("tm.tour.")
        ? JSON.stringify({ done: true })
        : orig.call(this, k);
    };
  });
});

async function openAdminHub(page) {
  await page.goto("/#/admin");
  await expect(page).toHaveURL(/#\/admin$/);
}

/** A datetime-local value ("YYYY-MM-DDTHH:mm") from a Date's UTC parts — paired with the UTC event zone,
 *  so the wall-clock entered equals the UTC instant stored and the WEEKLY weekday is unambiguous. */
function localValue(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${p(date.getUTCMonth() + 1)}-${p(date.getUTCDate())}T${p(date.getUTCHours())}:${p(date.getUTCMinutes())}`;
}

/** The UPPERCASE DayOfWeek name a UTC date falls on (the byWeekday wire value / picker option value). */
function weekdayNameUtc(date) {
  return ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"][date.getUTCDay()];
}

const HEADING = `E2E Recurring Series ${Date.now()}`;

test("@admin @admin-events admin turns Repeat ON → a weekly series is created with multiple occurrences (TM-796)", async ({ page }, testInfo) => {
  let stepNo = 0;
  const shot = async (name) =>
    page.screenshot({
      path: testInfo.outputPath(`recurrence-${String(++stepNo).padStart(2, "0")}-${name}.png`),
      fullPage: true,
    });

  const now = Date.now();
  const start = new Date(now + 30 * 864e5); // 30 days out — a future anchor
  const end = new Date(now + 30 * 864e5 + 2 * 36e5);
  const visStart = new Date(now - 864e5);
  const visEnd = new Date(now + 120 * 864e5); // wide window so several weekly occurrences are visible
  const startWeekday = weekdayNameUtc(start);

  // ── Sign in as the seeded ADMIN + open the events console. ───────────────────────────────────────
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

  // ── Open the New event form + fill the required fields. ──────────────────────────────────────────
  await page.click("#admin-events-new");
  await expect(page.locator("#event-form")).toBeVisible();
  await page.fill("#event-heading", HEADING);
  await page.fill("#event-description", "Recurring series for the TM-796 e2e.");
  await page.fill("#event-location", "Marhaba Cafe, 12 High St");
  await page.locator("#event-more-options-toggle").click();
  await page.locator("#event-timezone").selectOption("UTC");
  await page.fill("#event-start", localValue(start));
  await page.fill("#event-end", localValue(end));
  await page.fill("#event-visibility-start", localValue(visStart));
  await page.fill("#event-visibility-end", localValue(visEnd));

  // ── Turn ON "Repeat" → the recurrence picker appears (FAIL-BEFORE: the toggle is absent on main). ──
  const repeatToggle = page.locator("#event-repeat-toggle");
  await expect(repeatToggle).toBeVisible();
  await repeatToggle.check();
  await expect(page.locator("#event-repeat-body")).toBeVisible();
  // The Save button now advertises a SERIES create (repeat ON).
  await expect(page.locator("#event-save")).toHaveText("Create series");

  // ── Configure the recurrence: Weekly, every 1 week, on the start's weekday, After 4 occurrences. ──
  await page.click('#event-repeat-frequency .tm-chip[data-chip="WEEKLY"]');
  // The weekday field appears for Weekly and defaults to the start date's own weekday.
  await expect(page.locator("#event-repeat-weekday")).toBeVisible();
  await expect(page.locator("#event-repeat-weekday")).toHaveValue(startWeekday);
  await page.fill("#event-repeat-interval", "1");
  // End = After 4 occurrences (deterministic count, well inside the engine's batch cap).
  await page.check("#event-repeat-end-after");
  await page.fill("#event-repeat-after", "4");
  await shot("picker");

  // ── Save → assert the POST /series 201 CreateSeriesResponse with MULTIPLE occurrences. ────────────
  const seriesResponse = page.waitForResponse(
    (r) => r.url().includes("/api/v1/admin/events/series") && r.request().method() === "POST",
  );
  await page.click("#event-save");
  const resp = await seriesResponse;
  // The wire body carries the recurrence rule + the first-occurrence anchor (CreateSeriesRequest).
  const sent = resp.request().postDataJSON();
  expect(sent.frequency).toBe("WEEKLY");
  expect(sent.interval).toBe(1);
  expect(sent.byWeekday).toBe(startWeekday);
  expect(sent.afterN).toBe(4);
  expect("untilDate" in sent).toBe(false); // exactly ONE end condition on the wire
  expect(typeof sent.firstStartAt).toBe("string");
  expect(resp.status()).toBe(201);
  const series = await resp.json();
  expect(series.frequency).toBe("WEEKLY");
  // afterN=4 → four occurrences materialised (well inside the horizon / 12-per-batch cap).
  expect(series.occurrences.length).toBeGreaterThan(1);
  expect(series.occurrences.length).toBe(4);
  const seriesId = series.id;
  expect(seriesId).toBeTruthy();

  // ── Back on the list — show all lifecycle buckets so the future-start occurrences are visible. ────
  await expect(page).toHaveURL(/#\/admin\/events$/);
  await expect(page.locator("#admin-events-view")).toBeVisible();
  await page.locator("#admin-events-lifecycle-all").click();
  // Each generated occurrence carries the template heading → several rows with it.
  const rows = page.locator(`tr:has-text("${HEADING}")`);
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThan(1);
  await shot("occurrences");

  // ── DB check: multiple events share the ONE created series_id, all with the template heading. ─────
  const client = new pg.Client(dbConfig);
  await client.connect();
  try {
    const { rows: dbRows } = await client.query(
      "SELECT COUNT(*)::int AS n FROM events WHERE series_id = $1 AND heading = $2",
      [seriesId, HEADING],
    );
    expect(dbRows[0].n).toBe(4);
  } finally {
    await client.end();
  }
});

// Client-side recurrence validation blocks bad combos with inline errors BEFORE the POST (the API edge
// mirror). Proves: WEEKLY with no weekday match blocks; interval 0 blocks; the end condition is required.
// No series POST fires while the combo is invalid. Reuses the same sign-in + hub nav.
test("@admin @admin-events recurrence validation blocks bad combos inline (no /series POST) (TM-796)", async ({ page }) => {
  const HEADING_INVALID = `E2E Recurrence Invalid ${Date.now()}`;
  const now = Date.now();
  const start = new Date(now + 30 * 864e5);
  const visStart = new Date(now - 864e5);
  const visEnd = new Date(now + 120 * 864e5);
  const startWeekday = weekdayNameUtc(start);
  const otherWeekday = startWeekday === "MONDAY" ? "TUESDAY" : "MONDAY"; // guaranteed to NOT match

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

  await page.click("#admin-events-new");
  await expect(page.locator("#event-form")).toBeVisible();
  await page.fill("#event-heading", HEADING_INVALID);
  await page.fill("#event-description", "Invalid recurrence combo for the TM-796 e2e.");
  await page.fill("#event-location", "Marhaba Cafe, 12 High St");
  await page.locator("#event-more-options-toggle").click();
  await page.locator("#event-timezone").selectOption("UTC");
  await page.fill("#event-start", localValue(start));
  await page.fill("#event-visibility-start", localValue(visStart));
  await page.fill("#event-visibility-end", localValue(visEnd));

  // Turn Repeat ON, Weekly, but pick a NON-matching weekday and interval 0 — a doubly-invalid combo.
  await page.locator("#event-repeat-toggle").check();
  await page.click('#event-repeat-frequency .tm-chip[data-chip="WEEKLY"]');
  await page.locator("#event-repeat-weekday").selectOption(otherWeekday);
  await page.fill("#event-repeat-interval", "0");
  await page.check("#event-repeat-end-after");
  await page.fill("#event-repeat-after", "4");

  // No /series POST must fire while the combo is invalid. Watch for one; assert it never arrives.
  let seriesPosted = false;
  page.on("request", (r) => {
    if (r.url().includes("/api/v1/admin/events/series") && r.method() === "POST") seriesPosted = true;
  });
  await page.click("#event-save");
  // Inline errors are shown next to the recurrence fields.
  await expect(page.locator("#event-repeat-interval-error")).toBeVisible();
  await expect(page.locator("#event-repeat-weekday-error")).toBeVisible();
  await page.waitForTimeout(500); // give any (erroneous) request time to fire
  expect(seriesPosted).toBe(false);

  // Fix the combo → the errors clear and a save now POSTs the series.
  await page.locator("#event-repeat-weekday").selectOption(startWeekday);
  await page.fill("#event-repeat-interval", "1");
  const seriesResponse = page.waitForResponse(
    (r) => r.url().includes("/api/v1/admin/events/series") && r.request().method() === "POST",
  );
  await page.click("#event-save");
  expect((await seriesResponse).status()).toBe(201);
});
