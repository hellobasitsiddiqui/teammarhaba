import { test, expect } from "@playwright/test";
import { ADMIN, TARGET, EVENT_GOER, EVENT_WAITER } from "../fixtures.mjs";
import { authHeadersFor, createEvent, apiRsvp, resetAttendanceFor } from "../events-api.mjs";

// Admin event roster PAGE e2e (TM-1115) — the automated-test gate for the roster front end (the FE half
// of TM-1088; backend TM-1114 supplies the entries + pastEntries payload). Drives the whole flow through
// the real browser + full stack at a 390px phone viewport:
//
//   ADMIN signs in → opens the events console → the row's "Roster" button NAVIGATES to the roster PAGE
//   (#/admin/events/{id}/roster; the inline expando is GONE) → the 4-state attendee list shows a Going
//   + a Waitlist badge → toggling the include/exclude chips filters the ALREADY-FETCHED set (no refetch)
//   → EVICT the going attendee → an "Evicted" past-entry row appears once the Evicted chip is enabled.
//
// PLUS the auth-bounce pair that regression-locks all four router legs (the TM-917 class of bug):
//   • signed-out deep-link to the roster route → remembered + bounced to #/login (not flashed then home);
//   • a non-admin (TARGET) deep-link to the roster route → bounced to #/home, the roster view hidden.
//
// The event + its two attendees are SEEDED via the first-party API (createEvent + apiRsvp — the same
// no-UI seeding the events journey uses), so this spec never touches the timezone <select> (which stalls
// on this host's Chromium ICU — see blackboard) and lands with a deterministic Going + Waitlist roster.
//
// `screenshot: "on"` is set globally (playwright.config.mjs); we ALSO take explicit named shots at each
// major step so the run yields a step-by-step visual trail for the sprint evidence ticket.

test.use({ viewport: { width: 390, height: 844 } });

// Suppress the first-run product tour so its dimmed overlay can't cover the controls under test (TM-147).
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const orig = Storage.prototype.getItem;
    Storage.prototype.getItem = function (k) {
      return typeof k === "string" && k.startsWith("tm.tour.") ? JSON.stringify({ done: true }) : orig.call(this, k);
    };
  });
});

/** Email+password sign-in (the "Try another way" path — email-code is the default front door). */
async function signIn(page, account) {
  await page.goto("/#/login");
  await expect(page.locator("#auth-signed-out")).toBeVisible();
  await page.fill("#email", account.email);
  await page.click("#try-another-btn");
  await page.fill("#password", account.password);
  await page.click("#signin-btn");
  await expect(page.locator("#auth-signed-out")).toBeHidden();
  await expect(page.locator("#app-tabbar")).toBeVisible();
}

test("@admin @admin-events admin manages a roster on its own page: 4-state badges, chip filter, evict", async ({ page }, testInfo) => {
  let stepNo = 0;
  const shot = (name) =>
    page.screenshot({ path: testInfo.outputPath(`admin-roster-${String(++stepNo).padStart(2, "0")}-${name}.png`), fullPage: true });

  // ── SEED via the first-party API: a capacity-1 event, a GOING attendee + a WAITLISTED one. ────────
  const adminHeaders = await authHeadersFor({ email: ADMIN.email, password: ADMIN.password });
  const heading = `E2E Roster ${Date.now()}`;
  const event = await createEvent(adminHeaders, { heading, capacity: 1 });
  // Clean any lingering attendance (shared CI DB / retries) then RSVP: first lands GOING, second WAITLISTED.
  const goerHeaders = await resetAttendanceFor(EVENT_GOER);
  const waiterHeaders = await resetAttendanceFor(EVENT_WAITER);
  const goerRes = await apiRsvp(goerHeaders, event.id);
  const waiterRes = await apiRsvp(waiterHeaders, event.id);
  expect(goerRes.state).toBe("GOING");
  expect(waiterRes.state).toBe("WAITLISTED");

  // ── STEP 1: sign in as the seeded ADMIN and open the events console via the hub. ──────────────────
  await signIn(page, ADMIN);
  await page.goto("/#/admin/events");
  await expect(page.locator("#admin-events-view")).toBeVisible();
  await expect(page.locator("#admin-events-table")).toBeVisible();
  // The console lands on the "Happening now" lifecycle chip (TM-1096), which filters OUT a freshly-seeded
  // Upcoming/Scheduled event — so click "All" to show every bucket before locating the row (the same
  // step admin-events.spec.mjs / admin-event-clone.spec.mjs do).
  await page.locator("#admin-events-lifecycle-all").click();
  // The just-seeded event is in the list (search to be robust against pagination / other events).
  await page.fill("#admin-events-search", heading);
  const row = page.locator(`#admin-events-table tr[data-event-id="${event.id}"]`);
  await expect(row).toBeVisible();
  await shot("console");

  // ── STEP 2: the Roster button NAVIGATES to the roster page (inline expando retired, TM-1115). ─────
  await row.getByRole("button", { name: /Manage roster/ }).click();
  await expect(page).toHaveURL(new RegExp(`#/admin/events/${event.id}/roster$`));
  await expect(page.locator("#admin-event-roster-view")).toBeVisible();
  await expect(page.locator("#admin-events-view")).toBeHidden(); // the list view is replaced, not overlaid
  await expect(page.locator("#admin-event-roster-back")).toBeVisible();
  await expect(page.locator('[data-testid="admin-event-roster-panel"]')).toBeVisible();

  // ── STEP 3: the 4-state badges — a Going + a Waitlist row are shown (chips default: waitlist on). ─
  const badges = page.locator('[data-testid="admin-roster-badge"]');
  await expect(badges).toHaveText([/Going/, /Waitlist/]);
  await shot("roster");

  // ── STEP 4: chip filter is CLIENT-SIDE (no refetch). Turning Waitlist OFF hides the waitlist row. ─
  const waitlistChip = page.locator('#admin-roster-filter-chips .tm-chip[data-roster-state="WAITLISTED"]');
  await expect(waitlistChip).toHaveAttribute("aria-pressed", "true"); // on by default
  await waitlistChip.click();
  await expect(waitlistChip).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator('[data-testid="admin-roster-badge"]')).toHaveText([/Going/]); // waitlist filtered out
  // Turn it back on — the row returns from the already-fetched set (no reload).
  await waitlistChip.click();
  await expect(page.locator('[data-testid="admin-roster-badge"]')).toHaveText([/Going/, /Waitlist/]);
  await shot("chip-toggle");

  // ── STEP 5: EVICT the going attendee via the danger confirm → the freed spot promotes the waitlist.
  const goingLi = page.locator(`.tm-roster-attendee[data-user-id][data-roster-state="GOING"]`).first();
  await goingLi.getByRole("button", { name: /Evict/ }).click();
  await page.click("#tm-dialog-confirm");
  // After the evict + roster reload: the evicted user is now a PAST entry. It's hidden by default
  // (Evicted chip off) — enable the Evicted chip to reveal it.
  const evictedChip = page.locator('#admin-roster-filter-chips .tm-chip[data-roster-state="EVICTED"]');
  await expect(evictedChip).toHaveAttribute("aria-pressed", "false"); // off by default
  await evictedChip.click();
  await expect(evictedChip).toHaveAttribute("aria-pressed", "true");
  // An "Evicted" badge now appears in the list (the evicted going attendee's past-entry row).
  await expect(page.locator('[data-testid="admin-roster-badge"]').filter({ hasText: /Evicted/ })).toHaveCount(1);
  await shot("evicted");

  // Clean up so a CI retry / re-run starts fresh (best-effort).
  try {
    await resetAttendanceFor(EVENT_GOER);
    await resetAttendanceFor(EVENT_WAITER);
  } catch {
    /* best-effort */
  }
});

test.describe("@admin @admin-events roster route auth-bounce (regression-locks the four router legs)", () => {
  test("signed-out: a deep-link to the roster route is bounced to login", async ({ page }) => {
    // No sign-in. A protected deep-link is remembered + bounced to #/login (isProtected leg, TM-917 class).
    await page.goto("/#/admin/events/1/roster");
    await expect(page.locator("#auth-signed-out")).toBeVisible();
    await expect(page.locator("#admin-event-roster-view")).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("#/login");
  });

  test("non-admin: a USER deep-linking the roster route is bounced home, the roster view hidden", async ({ page }) => {
    await signIn(page, TARGET); // a normal (non-admin) user
    await page.evaluate(() => (window.location.hash = "#/admin/events/1/roster"));
    // The shouldBounceNonAdmin leg fires once the role resolves: bounced to #/home, roster view hidden.
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("#/home");
    await expect(page.locator("#admin-event-roster-view")).toBeHidden();
  });
});
