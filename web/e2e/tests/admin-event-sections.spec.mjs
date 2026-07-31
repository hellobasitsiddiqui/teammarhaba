import { test, expect } from "@playwright/test";
import { ADMIN } from "../fixtures.mjs";
import { authHeadersFor, createEvent } from "../events-api.mjs";

// Admin event-form collapsible sections e2e (TM-1198, wave-admin-events-4) — the automated-test closer for
// the TM-1185 collapsible-intent-sections feature. The create/edit form (TM-395) was regrouped into 5
// labelled <details> sections (TM-1195: Basics · When · Where OPEN, "Who can join" · "Booking rules"
// COLLAPSED), with live collapsed-header value summaries (TM-1196) and a generalised
// error-force-open-scroll-focus on a failed Save (TM-1197). This spec proves the four behaviours on BOTH
// create AND edit against the REAL form driven through the real router + full stack:
//
//   1. Sections render — Basics/When/Where OPEN, Who-can-join/Booking-rules COLLAPSED by default.
//   2. Error auto-reveal — a submit with an error in a COLLAPSED section auto-opens + scrolls + focuses the
//      first invalid field (Capacity=0 in "Who can join", the TM-1197 behaviour).
//   3. Value round-trip — a field's value survives a collapse→expand round-trip with no loss (native
//      <details> keeps the body in the DOM, just display:none — nothing is re-mounted).
//   4. Live summaries — the collapsed-header value summaries update on field change (TM-1196), asserted
//      against the SAME strings whoCanJoinSummary / bookingRulesSummary produce (event-form.js).
//
// HARNESS: mirrors the sibling tests/admin-events.spec.mjs — the same tour-suppression init-script, the same
// email+password ADMIN sign-in ("Try another way"), and the same #/admin hub → Events console navigation. It
// does NOT drive the create/edit form's timezone select: on this host the local Playwright Chromium has no
// plain "UTC" zone (blackboard), so we NEVER `selectOption("#event-timezone", …)`. The create-path scenarios
// never Save (they exercise the folds/summaries/error-reveal on the open form, no POST needed, so the
// prefilled timezone is irrelevant), and the edit-path scenarios open an event SEEDED via the admin API
// (events-api.createEvent, which uses timezone Europe/London) — so no UTC option is ever touched. Green on
// CI's Linux Chromium; trust the dispatched CI e2e over a local run for anything timezone-adjacent.

// Suppress the first-run product tour so its dimmed overlay/backdrop can't cover the controls under test —
// the identical localStorage init-script every other admin spec uses (TM-147).
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

/** Open the #/admin hub. The top nav is gone (TM-1043); deep-link straight to the hub (the reload-onto-#/admin
 *  pattern the sibling admin-events spec uses — racing the injected #tab-admin tab flakes). */
async function openAdminHub(page) {
  await page.goto("/#/admin");
  await expect(page).toHaveURL(/#\/admin$/);
}

/** Sign in as the seeded ADMIN (email+password under "Try another way", like the sibling spec) + open the
 *  events console via the hub. Leaves the page on the console list view. */
async function signInAdminAndOpenConsole(page) {
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
}

/** Open the New event form (create route) and wait for it to render. */
async function openCreateForm(page) {
  await page.click("#admin-events-new");
  await expect(page).toHaveURL(/#\/admin\/events\/new$/);
  await expect(page.locator("#event-form")).toBeVisible();
}

/** Open an existing event's edit form (deep-link to the edit route) and wait for it to render + prefill. */
async function openEditForm(page, eventId) {
  await page.goto(`/#/admin/events/${eventId}/edit`);
  await expect(page).toHaveURL(new RegExp(`#/admin/events/${eventId}/edit$`));
  await expect(page.locator("#event-form")).toBeVisible();
}

// The five section <details> ids (admin-events.js sectionHandles). `.open` on the native <details> reflects
// the fold state — the property toBeVisible()/`open` attribute both track it.
const SECTIONS = {
  basics: "#event-section-basics",
  when: "#event-section-when",
  where: "#event-section-where",
  who: "#event-section-who",
  booking: "#event-section-booking",
};

/** Assert the default fold state: Basics/When/Where OPEN, Who-can-join/Booking-rules COLLAPSED. Reads the
 *  native <details>.open property (source of truth for a fold) via each id. */
async function expectDefaultFolds(page) {
  const openState = await page.evaluate((sel) => {
    const get = (id) => document.querySelector(id)?.open;
    return {
      basics: get(sel.basics),
      when: get(sel.when),
      where: get(sel.where),
      who: get(sel.who),
      booking: get(sel.booking),
    };
  }, SECTIONS);
  expect(openState).toEqual({ basics: true, when: true, where: true, who: false, booking: false });
  // The collapsed sections' BODIES are display:none, so a field inside is not visible until expanded — the
  // load-bearing consequence of the fold (a capacity/cutoff field is hidden behind a closed section).
  await expect(page.locator("#event-capacity")).toBeHidden();
  await expect(page.locator("#event-booking-cutoff-hours")).toBeHidden();
}

// ── SCENARIO 1: sections render with the correct default open/collapsed state ─────────────────────────────

test("@admin @admin-events create form: sections render with Basics/When/Where open, Who-can-join/Booking-rules collapsed (TM-1198)", async ({ page }) => {
  await signInAdminAndOpenConsole(page);
  await openCreateForm(page);
  await expectDefaultFolds(page);
});

test("@admin @admin-events edit form: sections render with Basics/When/Where open, Who-can-join/Booking-rules collapsed (TM-1198)", async ({ page }) => {
  // Seed a real event via the admin API (Europe/London zone — no UTC select touched), then open its edit form.
  const headers = await authHeadersFor(ADMIN);
  const event = await createEvent(headers, { heading: `E2E Sections Edit Render ${Date.now()}` });
  await signInAdminAndOpenConsole(page);
  await openEditForm(page, event.id);
  // On edit the sections open/collapsed default is the SAME as create (fold state is layout, not data-driven).
  await expectDefaultFolds(page);
});

// ── SCENARIO 2: error auto-reveal — a Save with an error in a COLLAPSED section opens + scrolls + focuses it ─
//
// Capacity=0 (@Min 1) inside the collapsed "Who can join" section. On Save, TM-1197's revealFirstError opens
// #event-section-who, scrolls it into view, and focuses #event-capacity (document.activeElement === it). We
// assert the fold opened, the error is shown, and focus landed on the invalid field — the deterministic
// signals the capture-tm1197 script reports.

/** Fill the required fields (leaving Capacity invalid at 0) then Save, and assert the collapsed "Who can join"
 *  section auto-opened + the Capacity field is focused + its error is shown. Shared by create + edit. */
async function expectCapacityErrorAutoReveals(page) {
  // Expand "Who can join" so we can set the (normally hidden) Capacity field to the invalid 0…
  await page.evaluate((sel) => {
    const who = document.querySelector(sel.who);
    if (who) who.open = true;
  }, SECTIONS);
  await expect(page.locator("#event-capacity")).toBeVisible();
  await page.fill("#event-capacity", "0"); // invalid: @Min(1)
  // …then re-collapse it so the blocking error starts hidden behind the fold (the whole point of TM-1197).
  await page.evaluate((sel) => {
    const who = document.querySelector(sel.who);
    if (who) who.open = false;
  }, SECTIONS);
  await expect(page.locator("#event-capacity")).toBeHidden();

  // Save. Client validation fails (capacity < 1) → no POST; revealFirstError opens the fold, scrolls, focuses.
  await page.click("#event-save");

  // The collapsed section auto-opened and the invalid Capacity field is now visible with its error shown.
  await expect(page.locator(SECTIONS.who)).toHaveAttribute("open", "");
  await expect(page.locator("#event-capacity")).toBeVisible();
  await expect(page.locator("#event-capacity")).toHaveAttribute("aria-invalid", "true");
  // Focus landed on the first invalid field (DOM order) — the TM-1197 differentiator. Await it via a poll so
  // the smooth-scroll + focus have settled (no arbitrary sleep).
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.id))
    .toBe("event-capacity");
}

test("@admin @admin-events create form: a Save with Capacity=0 in the collapsed 'Who can join' auto-opens, scrolls and focuses it (TM-1198)", async ({ page }) => {
  await signInAdminAndOpenConsole(page);
  await openCreateForm(page);
  // Fill the required Basics/When/Where fields so ONLY capacity is invalid (timezone prefilled — not touched).
  await page.fill("#event-heading", `E2E Error Reveal Create ${Date.now()}`);
  await page.fill("#event-description", "A relaxed weekly meetup for the circle.");
  await page.fill("#event-location", "Community Hall, 12 High St");
  const now = Date.now();
  const local = (ms) => {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  };
  await page.fill("#event-start", local(now + 30 * 864e5));
  // Visibility window lives in "Who can join" (collapsed) — expand momentarily to fill the two required bounds.
  await page.evaluate((sel) => {
    const who = document.querySelector(sel.who);
    if (who) who.open = true;
  }, SECTIONS);
  await page.fill("#event-visibility-start", local(now - 864e5));
  await page.fill("#event-visibility-end", local(now + 60 * 864e5));
  await expectCapacityErrorAutoReveals(page);
});

test("@admin @admin-events edit form: a Save with Capacity=0 in the collapsed 'Who can join' auto-opens, scrolls and focuses it (TM-1198)", async ({ page }) => {
  const headers = await authHeadersFor(ADMIN);
  const event = await createEvent(headers, { heading: `E2E Error Reveal Edit ${Date.now()}` });
  await signInAdminAndOpenConsole(page);
  await openEditForm(page, event.id);
  // The edit form is prefilled from the seeded event, so every required field is already satisfied — we only
  // need to inject the one invalid Capacity in the collapsed section and Save.
  await expectCapacityErrorAutoReveals(page);
});

// ── SCENARIO 3: value round-trip — a field's value survives a collapse→expand round-trip with no loss ──────
//
// Native <details> keeps its body in the DOM (display:none when closed), so a value typed while open must
// still be there after closing + reopening — nothing is re-mounted. We type into "Who can join" (Capacity)
// and "Booking rules" (booking-cutoff), fold both shut, reopen, and assert the values are intact.

async function expectValuesSurviveFoldRoundTrip(page) {
  // Open both collapsed sections and enter distinctive values.
  await page.evaluate((sel) => {
    for (const id of [sel.who, sel.booking]) {
      const d = document.querySelector(id);
      if (d) d.open = true;
    }
  }, SECTIONS);
  await expect(page.locator("#event-capacity")).toBeVisible();
  await expect(page.locator("#event-booking-cutoff-hours")).toBeVisible();
  await page.fill("#event-capacity", "42");
  await page.fill("#event-booking-cutoff-hours", "6");

  // Collapse both, assert the bodies are hidden, then reopen.
  await page.evaluate((sel) => {
    for (const id of [sel.who, sel.booking]) {
      const d = document.querySelector(id);
      if (d) d.open = false;
    }
  }, SECTIONS);
  await expect(page.locator("#event-capacity")).toBeHidden();
  await expect(page.locator("#event-booking-cutoff-hours")).toBeHidden();
  await page.evaluate((sel) => {
    for (const id of [sel.who, sel.booking]) {
      const d = document.querySelector(id);
      if (d) d.open = true;
    }
  }, SECTIONS);

  // The values survived the round-trip (same DOM nodes, never re-mounted).
  await expect(page.locator("#event-capacity")).toHaveValue("42");
  await expect(page.locator("#event-booking-cutoff-hours")).toHaveValue("6");
}

test("@admin @admin-events create form: field values survive a collapse→expand round-trip (TM-1198)", async ({ page }) => {
  await signInAdminAndOpenConsole(page);
  await openCreateForm(page);
  await expectValuesSurviveFoldRoundTrip(page);
});

test("@admin @admin-events edit form: field values survive a collapse→expand round-trip (TM-1198)", async ({ page }) => {
  const headers = await authHeadersFor(ADMIN);
  const event = await createEvent(headers, { heading: `E2E Roundtrip Edit ${Date.now()}` });
  await signInAdminAndOpenConsole(page);
  await openEditForm(page, event.id);
  await expectValuesSurviveFoldRoundTrip(page);
});

// ── SCENARIO 4: live summaries — the collapsed-header value lines update on field change (TM-1196) ─────────
//
// Each collapsed section's summary node is `#<section> > summary .tm-form-section-value`. whoCanJoinSummary /
// bookingRulesSummary (event-form.js) produce the exact strings we assert:
//   • "Who can join"  → visibility · capacity · age band. With NO visibility window set → "public"; cap 20 →
//     "cap 20"; age 18-30 (both bounds) → "18-30". So: "public · cap 20 · 18-30".
//   • "Booking rules" → cutoff · reveal · price. cutoff 1 → "cutoff 1h"; reveal 24 → "reveal 24h"; a Custom
//     £5 → "£5". So: "cutoff 1h · reveal 24h · £5".
// We set exactly those fields (leaving visibility blank so "public" is the deterministic read) and assert the
// header summaries update live — the summaries recompute on every field change (revalidate → recomputeSummaries).

/** The live summary text for a section's collapsed header value node. */
function summaryText(page, sectionSel) {
  return page.locator(`${sectionSel} > summary .tm-form-section-value`);
}

async function expectLiveSummariesUpdate(page) {
  // "Who can join": leave visibility blank (→ "public"), set capacity + a Custom 18-30 age band.
  await page.evaluate((sel) => {
    const who = document.querySelector(sel.who);
    if (who) who.open = true;
  }, SECTIONS);
  // Clear any prefilled visibility bounds so the visibility read is the deterministic "public" (an edit-open
  // event carries a saved window → "scheduled"; blanking both makes the assertion identical on create + edit).
  await page.fill("#event-visibility-start", "");
  await page.fill("#event-visibility-end", "");
  await page.fill("#event-capacity", "20");
  // Age band: tap Custom to reveal the two number inputs, then set 18-30 (a non-preset combo → stays Custom).
  await page.click('.tm-age-band .tm-chip[data-chip="Custom"]');
  await expect(page.locator("#event-age-min")).toBeVisible();
  await page.fill("#event-age-min", "18");
  await page.fill("#event-age-max", "30");
  // whoCanJoinSummary(draft) === "public · cap 20 · 18-30" — the live header summary.
  await expect(summaryText(page, SECTIONS.who)).toHaveText("public · cap 20 · 18-30");

  // "Booking rules": cutoff 1h, reveal 24h, a Custom £5 price.
  await page.evaluate((sel) => {
    const booking = document.querySelector(sel.booking);
    if (booking) booking.open = true;
  }, SECTIONS);
  await page.fill("#event-booking-cutoff-hours", "1");
  await page.fill("#event-reveal-hours", "24");
  await page.click('.tm-price-band .tm-chip[data-chip="Custom"]');
  await expect(page.locator("#event-price")).toBeVisible();
  await page.fill("#event-price", "5");
  // Nudge a recompute (price input already fired input; belt-and-braces blur to flush any change listener).
  await page.locator("#event-price").blur();
  // bookingRulesSummary(draft) === "cutoff 1h · reveal 24h · £5" — the live header summary.
  await expect(summaryText(page, SECTIONS.booking)).toHaveText("cutoff 1h · reveal 24h · £5");
}

test("@admin @admin-events create form: collapsed-section header summaries update live on field change (TM-1198)", async ({ page }) => {
  await signInAdminAndOpenConsole(page);
  await openCreateForm(page);
  await expectLiveSummariesUpdate(page);
});

test("@admin @admin-events edit form: collapsed-section header summaries update live on field change (TM-1198)", async ({ page }) => {
  const headers = await authHeadersFor(ADMIN);
  const event = await createEvent(headers, { heading: `E2E Summaries Edit ${Date.now()}` });
  await signInAdminAndOpenConsole(page);
  await openEditForm(page, event.id);
  await expectLiveSummariesUpdate(page);
});
