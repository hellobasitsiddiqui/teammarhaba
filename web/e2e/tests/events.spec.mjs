import { test, expect } from "@playwright/test";
import pg from "pg";
import { ADMIN, EVENT_GOER, EVENT_WAITER, EVENT_FILLER, dbConfig } from "../fixtures.mjs";
import { authHeadersFor, createEvent, apiRsvp, apiCancelRsvp, resetAttendanceFor } from "../events-api.mjs";

// Events e2e — the @events feature suite (TM-400, epic TM-390), surfaces 2–3 of 4 (web + mobile-web).
// Drives the whole user events journey through the real browser + full stack against the events UI
// merged in TM-396 (events.js / events-core.js), reusing its `data-testid` selectors:
//
//   TEST 1 (@events)            browse the list → open a detail → RSVP (confirm dialog → GOING) →
//                               persisted GOING row in Postgres → un-RSVP (leave) → back to NONE.
//   TEST 2 (@events @waitlist)  a capacity-1 event a filler has taken → the browser user joins the
//                               WAITLIST → the filler cancels (the "un-RSVP promotes" trigger) → the
//                               offer cascade (TM-397) offers the freed spot → the user CLAIMS it →
//                               GOING → persisted.
//
// ADMIN-CREATE IS AN API CALL (no admin web form is merged): "admin creates (chips, image, visibility
// window)" is POST /api/v1/admin/events (TM-392) via events-api.mjs — the browser drives only the USER
// journey. The my-state CHIPS (✓ Going / Waitlisted), the event IMAGE (a stored `imagePath`) and the
// VISIBILITY WINDOW are all exercised: the chips are asserted in the UI, the image + window round-trip
// on the created record. See the PR notes for this interpretation.
//
// OFFER CASCADE (the claim path): cancelling a GOING spot does NOT auto-promote — a freed spot is
// recorded and the scheduled WaitlistOfferCascade sweep (TM-397) later offers it, stamping
// `spotAvailableToClaim` for the FIFO-head waitlister. The e2e stack runs a FAST sweep (OFFER_CASCADE_*
// env in e2e.yml / test-suite.yml) so the offer lands within a few seconds; STEP 4 of test 2 re-reads
// the detail on a BOUNDED poll until the claim affordance appears (never an unbounded wait).
//
// CALENDAR: "add-to-calendar links present" is TM-398, now MERGED. The detail renders a
// <details data-testid="event-add-to-calendar"> disclosure whose Google/Outlook options are real
// outbound <a> links (the .ics option is a JS blob-download <button>, so it has no href). We assert the
// wrapper is present and that those two links carry a Google Calendar / Outlook deep-link.
//
// Project-agnostic (like golden-path TM-341 / broadcast-admin TM-366): runs under BOTH the desktop
// `chromium` and the phone `mobile-chromium` Playwright projects (see playwright.config.mjs testMatch),
// so web + mobile-web coverage come from ONE spec. Every nav interaction goes through openNav()/
// clickNav(). `screenshot: "on"` is global; we ALSO take an explicit named shot per major step so the
// run yields a step-by-step visual trail to attach to the events evidence ticket (TM-402).

// Suppress the first-run product tour (TM-147) so its dimmed backdrop can't cover the controls under
// test — the identical localStorage init-script every other spec uses.
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

/** True when we're on the phone project rather than desktop. Detected off the BOTTOM TAB BAR
 *  (#app-tabbar), NOT the hamburger toggle — a visible tab bar means "phone viewport + signed in"
 *  (router un-hides it for a signed-in un-gated session; CSS reveals it only ≤528px). Copied from
 *  golden-path (TM-341) so the spec is project-agnostic across chromium + mobile-chromium.
 *
 *  Why not `#nav-toggle.isVisible()`? TM-908 made Home content-first: corner-bell.js now HIDES
 *  #nav-toggle on the corner-bell routes (#/home, #/profile), so the toggle is invisible there even on
 *  a phone — a false "desktop" reading. The tab bar stays visible on those routes, so it's the mobile
 *  signal that survives TM-908. */
async function isMobileViewport(page) {
  return page.locator("#app-tabbar").isVisible();
}

/** Open the account nav if it's collapsed behind the hamburger (phone width); a no-op at desktop
 *  width. Copied from golden-path (TM-341) so the spec is project-agnostic across chromium +
 *  mobile-chromium.
 *
 *  TM-908 wrinkle: on a corner-bell route (#/home, #/profile) the hamburger is HIDDEN, so its utility
 *  links aren't reachable. When we're on mobile and the toggle isn't present, hop to #/notifications (a
 *  signed-in route that keeps the normal nav row) so the hamburger + its collapsed menu exist. */
async function openNav(page) {
  const toggle = page.locator("#nav-toggle");
  if (!(await toggle.isVisible()) && (await isMobileViewport(page))) {
    await page.evaluate(() => (window.location.hash = "#/notifications"));
    await expect(page.locator("#notifications-view")).toBeVisible();
  }
  if (await toggle.isVisible()) {
    const nav = page.locator(".app-nav");
    if ((await nav.getAttribute("data-nav-open")) !== "true") {
      await toggle.click();
      await expect(nav).toHaveAttribute("data-nav-open", "true");
    }
  }
}

// Primary destinations that moved to the bottom tab bar on mobile (TM-434): on a phone the tab bar is
// the primary nav (its Events/Profile links are hidden inside the hamburger), so navigate via the tab;
// on desktop the tab bar is display:none and the top-nav link is used as before.
const NAV_TO_TAB = { "#nav-events": "#tab-events", "#nav-profile": "#tab-profile" };

/** Click a nav destination by its top-nav id. Mobile → bottom tab (TM-434) for a tab-bar destination
 *  (works from any route, incl. corner-bell Home where the hamburger is hidden), else the hamburger;
 *  desktop → the top-nav link directly. Works under both Playwright projects. */
async function clickNav(page, selector) {
  const onMobile = await isMobileViewport(page);
  const tabSelector = NAV_TO_TAB[selector];
  if (onMobile && tabSelector) {
    const tab = page.locator(tabSelector);
    await expect(tab).toBeVisible();
    await tab.click();
    return;
  }
  await openNav(page);
  const item = page.locator(selector);
  await expect(item).toBeVisible();
  await item.click();
}

/** Sign in a seeded, un-gated account via the email+password ("Try another way") flow — the same path
 *  broadcast-admin (TM-366) uses for ADMIN. These accounts are provisioned onboarded + terms-accepted
 *  in global-setup, so they land straight in the app (no first-run gate). */
async function signIn(page, account) {
  await page.goto("/#/login");
  await expect(page.locator("#auth-signed-out")).toBeVisible();
  await page.fill("#email", account.email);
  await page.click("#try-another-btn");
  await page.fill("#password", account.password);
  await page.click("#signin-btn");
  await expect(page.locator("#auth-signed-out")).toBeHidden();
  await expect(page.locator("#auth-signed-in")).toBeVisible();
}

/** Browse to #/events via the nav and open one event's detail by id — proving the list → detail nav. */
async function browseToEvent(page, id) {
  await clickNav(page, "#nav-events");
  await expect(page.locator("#events-view")).toBeVisible();
  await expect(page.locator('[data-testid="events-list"]')).toBeVisible();
  const card = page.locator(`[data-testid="event-card"][data-event-id="${id}"]`);
  await expect(card).toBeVisible();
  await card.click();
  const detail = page.locator('[data-testid="event-detail"]');
  await expect(detail).toBeVisible();
  await expect(detail).toHaveAttribute("data-event-id", String(id));
  return detail;
}

/** A named step-screenshot helper (on top of the global screenshot:"on") — a step-by-step trail. */
function stepShot(page, testInfo, prefix) {
  let n = 0;
  return (name) =>
    page.screenshot({
      path: testInfo.outputPath(`${prefix}-${String(++n).padStart(2, "0")}-${name}.png`),
      fullPage: true,
    });
}

/** Assert (via Postgres, the house DB seam) that this account holds exactly one attendance row on the
 *  event, in the expected state — the "it persisted" proof used by golden-path / broadcast-admin. */
async function assertAttendanceState(eventId, email, expectedState) {
  const client = new pg.Client(dbConfig);
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT ea.state
         FROM event_attendance ea
         JOIN users u ON u.id = ea.user_id
        WHERE ea.event_id = $1 AND lower(u.email) = lower($2)`,
      [eventId, email],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe(expectedState);
  } finally {
    await client.end();
  }
}

/** Add-to-calendar assertion (TM-398, merged). The detail renders a <details
 *  data-testid="event-add-to-calendar"> disclosure holding three options; the Google and Outlook
 *  options are real outbound <a> links, while the .ics option is a JS blob-download <button> (no href).
 *  Assert the wrapper is present, then read the calendar deep-links off the Google/Outlook anchors.
 *  Those anchors live inside the collapsed <details>, so they're attached but not visible — `toHaveAttribute`
 *  polls the DOM without requiring visibility, so we read the href off them rather than asserting visibility. */
async function assertCalendarLinks(page, testInfo) {
  const cal = page.locator('[data-testid="event-add-to-calendar"]');
  await expect(cal).toBeVisible();

  const google = cal.locator('[data-testid="calendar-google"]');
  const outlook = cal.locator('[data-testid="calendar-outlook"]');
  await expect(google).toHaveAttribute("href", /calendar\.google\.com/i);
  await expect(outlook).toHaveAttribute("href", /outlook\.(live|office)\.com/i);

  testInfo.annotations.push({
    type: "calendar",
    description:
      `add-to-calendar links present — google: ${await google.getAttribute("href")} · ` +
      `outlook: ${await outlook.getAttribute("href")}`,
  });
}

/** Re-read the detail (hop list → detail so the router re-enters + re-GETs, the no-reload hash nav the
 *  golden-path uses) on a BOUNDED poll until the claim affordance appears — never an unbounded wait.
 *  The stack runs a fast offer-cascade sweep, so in practice this resolves in a few seconds. */
async function waitForClaimAffordance(page, id) {
  await expect(async () => {
    await page.evaluate(() => {
      window.location.hash = "#/events";
    });
    await page.evaluate((eid) => {
      window.location.hash = `#/events/${eid}`;
    }, id);
    await expect(page.locator('[data-testid="event-detail"]')).toBeVisible({ timeout: 4000 });
    await expect(page.locator('[data-testid="event-primary-action"]')).toHaveAttribute(
      "data-kind",
      "claim",
      { timeout: 2500 },
    );
  }).toPass({ timeout: 90_000, intervals: [1500] });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// TEST 1 — browse → detail → RSVP (going) → un-RSVP.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
test("@events browse an event, RSVP to it (going), then un-RSVP", async ({ page }, testInfo) => {
  const shot = stepShot(page, testInfo, "events");
  const stamp = Date.now();

  // ── SETUP: the ADMIN creates the event (image + explicit visibility window). No admin web form is
  // merged (TM-392 is API-only), so this is the first-party admin API — the journey's "admin creates". ─
  const adminHeaders = await authHeadersFor(ADMIN);
  const event = await createEvent(adminHeaders, {
    heading: `e2e RSVP meetup ${stamp}`,
    capacity: 10, // room to spare → a fresh RSVP lands GOING
  });
  expect(event.id).toBeTruthy();
  expect(event.imagePath).toBe("event-images/e2e-tm400"); // the image round-tripped onto the record
  expect(new Date(event.visibilityStart).getTime()).toBeLessThan(Date.now()); // visible-now window
  await resetAttendanceFor(EVENT_GOER); // clean slate → idempotent across CI retries / re-runs

  // ── STEP 1: sign in as the seeded goer + BROWSE list → the event's detail. ─────────────────────
  await signIn(page, EVENT_GOER);
  await shot("signed-in");
  const detail = await browseToEvent(page, event.id);
  await expect(detail.locator('[data-testid="event-when"]')).toBeVisible();
  await expect(detail.locator('[data-testid="event-location"]')).toBeVisible();
  await expect(page.locator(".tm-event-hero")).toBeVisible(); // the event image/placeholder hero
  await shot("detail");

  // ── STEP 2: RSVP → the confirm dialog → land GOING. ───────────────────────────────────────────
  const primary = page.locator('[data-testid="event-primary-action"]');
  await expect(primary).toBeVisible();
  await expect(primary).toHaveAttribute("data-kind", "rsvp");
  await expect(primary).toContainText("RSVP");
  const rsvpResponse = page.waitForResponse(
    (r) => r.url().includes(`/api/v1/events/${event.id}/rsvp`) && r.request().method() === "POST",
  );
  await primary.click();
  const confirm = page.locator(".tm-dialog");
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("RSVP to this event?");
  await shot("rsvp-confirm");
  await confirm.getByRole("button", { name: "I'm going" }).click();

  const rsvp = await rsvpResponse;
  expect(rsvp.status()).toBe(200);
  expect((await rsvp.json()).state).toBe("GOING");

  // The detail reflects GOING: the ✓ Going chip, the "1 going" badge, a Cancel-RSVP primary, the toast.
  await expect(page.locator('[data-testid="event-mystate"]')).toContainText("Going");
  await expect(page.locator('[data-testid="event-going-count"]')).toContainText("1 going");
  await expect(page.locator('[data-testid="event-primary-action"]')).toHaveAttribute("data-kind", "leave");
  await expect(page.locator("#tm-toasts .tm-toast-success").last()).toContainText("You're going");
  await shot("rsvp-going");

  // It persisted: a GOING event_attendance row for this user + event.
  await assertAttendanceState(event.id, EVENT_GOER.email, "GOING");

  // Add-to-calendar links (TM-398, merged): the disclosure is present and its Google/Outlook options
  // carry real calendar deep-links.
  await assertCalendarLinks(page, testInfo);

  // ── STEP 3: un-RSVP (leave) → confirm → back to NONE. ─────────────────────────────────────────
  const leave = page.locator('[data-testid="event-primary-action"]');
  await expect(leave).toHaveAttribute("data-kind", "leave");
  const cancelResponse = page.waitForResponse(
    (r) => r.url().includes(`/api/v1/events/${event.id}/rsvp`) && r.request().method() === "DELETE",
  );
  await leave.click();
  const leaveDialog = page.locator(".tm-dialog");
  await expect(leaveDialog).toBeVisible();
  await expect(leaveDialog).toContainText("Cancel your RSVP?");
  await leaveDialog.getByRole("button", { name: "Cancel RSVP" }).click();
  // Leaving returns 200 with the CancelResult body (TM-414's late-cancel outcome), not 204 No Content.
  expect((await cancelResponse).status()).toBe(200);

  // No chip, the primary is a fresh RSVP again, and the info toast confirms removal.
  await expect(page.locator('[data-testid="event-mystate"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="event-primary-action"]')).toHaveAttribute("data-kind", "rsvp");
  await expect(page.locator("#tm-toasts .tm-toast-info").last()).toContainText("removed");
  await shot("un-rsvp");
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// TEST 2 — waitlist path (capacity 1) → un-RSVP promotes → claim.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
test("@events @waitlist join the waitlist on a full event, then claim the promoted spot", async ({
  page,
}, testInfo) => {
  const shot = stepShot(page, testInfo, "waitlist");
  const stamp = Date.now();

  // ── SETUP: admin creates a CAPACITY-1 event; the API-only FILLER takes the single GOING spot so the
  // browser user will land on the waitlist. ────────────────────────────────────────────────────────
  const adminHeaders = await authHeadersFor(ADMIN);
  const event = await createEvent(adminHeaders, {
    heading: `e2e waitlist meetup ${stamp}`,
    capacity: 1,
  });
  expect(event.capacity).toBe(1);
  // Clean slate for both actors → idempotent across CI retries / re-runs (avoids a stale GOING tripping
  // the one-active-event guard when the filler fills, or the waiter claims).
  await resetAttendanceFor(EVENT_WAITER);
  const fillerHeaders = await resetAttendanceFor(EVENT_FILLER);
  const fill = await apiRsvp(fillerHeaders, event.id);
  expect(fill.state).toBe("GOING"); // the one spot is taken → the event is now full

  // ── STEP 1: sign in as the waiter + browse to the (now full) event. ───────────────────────────
  await signIn(page, EVENT_WAITER);
  await shot("signed-in");
  await browseToEvent(page, event.id);
  await expect(page.locator('[data-testid="event-going-count"]')).toContainText("1 going");
  // Full → the join control is a WAITLIST join (not a GOING RSVP), and it says so.
  const primary = page.locator('[data-testid="event-primary-action"]');
  await expect(primary).toHaveAttribute("data-kind", "waitlist");
  await expect(primary).toContainText("waiting list");
  await shot("full-event");

  // ── STEP 2: join the waiting list (no confirm dialog for a waitlist join) → land WAITLISTED. ───
  const joinResponse = page.waitForResponse(
    (r) => r.url().includes(`/api/v1/events/${event.id}/rsvp`) && r.request().method() === "POST",
  );
  await primary.click();
  const join = await joinResponse;
  expect(join.status()).toBe(200);
  expect((await join.json()).state).toBe("WAITLISTED");

  await expect(page.locator('[data-testid="event-mystate"]')).toContainText("Waitlisted");
  await expect(page.locator('[data-testid="event-waitlist-count"]')).toContainText("1 on the waitlist");
  await expect(page.locator('[data-testid="event-primary-action"]')).toHaveAttribute("data-kind", "leave");
  await expect(page.locator("#tm-toasts .tm-toast-success").last()).toContainText("waiting list");
  await shot("waitlisted");
  await assertAttendanceState(event.id, EVENT_WAITER.email, "WAITLISTED");

  // ── STEP 3: the "un-RSVP promotes" trigger — the filler cancels, freeing the spot. There is NO
  // auto-promotion: the offer cascade (TM-397) offers the freed spot to the waitlist FIFO head (our
  // waiter) on its next sweep; the e2e stack runs a fast sweep so this lands within a few seconds. ──
  await apiCancelRsvp(fillerHeaders, event.id);

  // ── STEP 4: wait (bounded) for the claim affordance to appear, re-reading the detail each poll. ─
  await waitForClaimAffordance(page, event.id);
  await expect(page.locator('[data-testid="event-mystate"]')).toContainText("Waitlisted"); // still queued until claimed
  const claim = page.locator('[data-testid="event-primary-action"]');
  await expect(claim).toHaveAttribute("data-kind", "claim");
  await expect(claim).toContainText("claim");
  await shot("claim-offered");

  // ── STEP 5: claim the spot → GOING. ───────────────────────────────────────────────────────────
  const claimResponse = page.waitForResponse(
    (r) => r.url().includes(`/api/v1/events/${event.id}/claim`) && r.request().method() === "POST",
  );
  await claim.click();
  const claimed = await claimResponse;
  expect(claimed.status()).toBe(200);
  expect((await claimed.json()).state).toBe("GOING");

  await expect(page.locator('[data-testid="event-mystate"]')).toContainText("Going");
  await expect(page.locator('[data-testid="event-going-count"]')).toContainText("1 going");
  await expect(page.locator('[data-testid="event-waitlist-count"]')).toHaveCount(0); // waitlist emptied
  await expect(page.locator("#tm-toasts .tm-toast-success").last()).toContainText("You're in");
  await shot("claimed-going");

  // It persisted: the waiter now holds a GOING row (promoted off the waitlist by claiming).
  await assertAttendanceState(event.id, EVENT_WAITER.email, "GOING");
});
