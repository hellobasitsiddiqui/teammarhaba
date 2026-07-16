import { test, expect } from "@playwright/test";
import pg from "pg";
import { ADMIN, EVENT_GOER, dbConfig } from "../fixtures.mjs";
import { authHeadersFor, createEvent } from "../events-api.mjs";
import { readOrderForEvent, resetOrdersFor } from "../membership-webhook.mjs";

// Resume-a-PENDING per-event payment e2e (TM-744, epic group-membership) — the automated-test gate for the
// RE-PAY / resume half of the paid-ticket journey. It is the regression proof for TM-744 (bundled with
// TM-739/TM-743 in commit 74761b9): resuming a still-PENDING per-event payment used to DEAD-END — a repeat
// POST /events/{id}/checkout returned paymentRequired=true but NO token, and the client showed
// "Payment could not be initialised. Please try again." (the one thing the user could do that could never
// work). The fix makes the backend idempotency status-aware: a still-PENDING order re-mints a FRESH
// single-use provider order + token onto THE SAME row, and the client (membership-checkout.js startPayment)
// falls through to that fresh token and re-mounts the widget instead of dead-ending.
//
// This spec is a deliberate sibling of paid-rsvp.spec.mjs — it reuses the SAME harness seam (the membership
// flag flip + the stubbed Revolut widget beforeEach), the SAME seeded goer (EVENT_GOER), the SAME first-party
// admin event creation, and the SAME order/DB helpers. Where paid-rsvp proves the FIRST checkout then settles
// by webhook, this one proves what happens when the buyer ABANDONS the widget (tab closed / lost token) and
// RETURNS to pay: the second "Continue to payment" must resume, not dead-end.
//
// WHAT WOULD FAIL BEFORE THE FIX: the second (resume) checkout POST would return { paymentRequired: true,
// paymentToken: null } (CheckoutResult.existing on a PENDING repeat), so startPayment hit `if (!token)` and
// rendered "Payment could not be initialised. Please try again." — and the widget never re-mounted. This spec
// asserts the INVERSE on every one of those observables: a NON-NULL token on the resume response, a CHANGED
// provider_order_id on the same still-PENDING order row (the re-mint), the dead-end copy ABSENT, and the
// re-mounted widget's "Pay £15" button PRESENT. Each is a signal that flips exactly at the fix.
//
// WHY A PREMIUM EVENT (identical rationale to paid-rsvp): a premium event at a real price resolves to PAY for
// every tier below Diamond REGARDLESS of the first-event credit, so the seeded PAY_PER_EVENT goer PAYs on its
// very first event with no credit to burn — the checkout screen reveals a real PAY badge + "Continue to
// payment", and the order lands PENDING.
//
// THE WIDGET IS STUBBED, THE MONEY IS NOT MOCKED-AWAY (same as paid-rsvp): window.RevolutCheckout is pre-
// seeded so the SDK loader short-circuits (the strict-CSP env blocks the sandbox CDN and there is no real
// card). The stub confirms NOTHING — but that's fine here: this spec asserts the RESUME (a fresh token +
// re-mounted widget), NOT a settlement, so it never injects a settle webhook. The order stays PENDING
// throughout, which is exactly the state a resume acts on.

// Turn the WEB membership flag ON + STUB the Revolut widget before any app script runs (identical seam to
// paid-rsvp.spec.mjs / subscribe.spec.mjs — copied verbatim so this spec stays self-contained and its
// behaviour never drifts from the siblings').
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    // 1) Suppress the first-run product tour (its dimmed backdrop would cover the controls under test) —
    // the identical localStorage init-script every other spec uses.
    const orig = Storage.prototype.getItem;
    Storage.prototype.getItem = function (k) {
      return typeof k === "string" && k.startsWith("tm.tour.")
        ? JSON.stringify({ done: true })
        : orig.call(this, k);
    };

    // 2) Flip the web membership flag ON. serve.mjs freezes TEAMMARHABA_CONFIG with the flag OFF; config.js
    // (a classic <script>) then assigns its own frozen config AFTER this init-script runs. Intercept that
    // assign with an accessor whose setter always re-merges flags.membership=true (+ a payments block so the
    // widget config reads sandbox mode). If the integrator instead adds the flag to serve.mjs's injected
    // config, this merge is idempotent and still correct.
    const merge = (cfg) =>
      Object.freeze({
        ...(cfg || {}),
        flags: Object.freeze({ ...((cfg && cfg.flags) || {}), membership: true }),
        payments: Object.freeze({
          ...((cfg && cfg.payments) || {}),
          revolutMode: "sandbox",
          // A URL is still read by the loader, but our stubbed global short-circuits the load before any
          // <script> is injected, so this is never actually fetched.
          revolutScriptUrl: "about:blank",
        }),
      });
    let current = merge(window.TEAMMARHABA_CONFIG || {});
    Object.defineProperty(window, "TEAMMARHABA_CONFIG", {
      configurable: true,
      get() {
        return current;
      },
      set(next) {
        current = merge(next);
      },
    });

    // 3) Stub the Revolut checkout SDK global. loadRevolutSdk() resolves immediately when
    // window.RevolutCheckout is a function (no external script injected). The instance's createCardField
    // returns an inert card field: submit() is a no-op here — we never actually charge; this spec proves the
    // resume RE-MOUNTS the widget, it does not settle a payment.
    window.RevolutCheckout = function revolutCheckoutStub() {
      return Promise.resolve({
        createCardField: () => ({ submit: () => {}, destroy: () => {} }),
        destroy: () => {},
      });
    };
  });
});

/** Open the account nav if it's collapsed behind the hamburger (phone width); a no-op at desktop width.
 *  Copied from the sibling specs so this stays project-agnostic if it's ever opted into mobile-chromium. */
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

/** Click a nav link/button by id, opening the hamburger first when needed. */
async function clickNav(page, selector) {
  await openNav(page);
  const item = page.locator(selector);
  await expect(item).toBeVisible();
  await item.click();
}

/** Sign in a seeded, un-gated account via the email+password ("Try another way") flow — the same path
 *  broadcast-admin / events / paid-rsvp use. These accounts are provisioned onboarded + terms-accepted in
 *  global-setup, so they land straight in the app (no first-run gate). */
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

/** A named step-screenshot helper (on top of the global screenshot:"on") — a step-by-step trail. */
function stepShot(page, testInfo, prefix) {
  let n = 0;
  return (name) =>
    page.screenshot({
      path: testInfo.outputPath(`${prefix}-${String(++n).padStart(2, "0")}-${name}.png`),
      fullPage: true,
    });
}

/** Assert (via Postgres) the caller holds NO attendance row on the event — the RSVP is genuinely held back
 *  while the order is PENDING (unchanged before AND after the resume; a resume never confirms attendance). */
async function assertNoAttendance(eventId, email) {
  const client = new pg.Client(dbConfig);
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT count(*)::int AS n
         FROM event_attendance ea
         JOIN users u ON u.id = ea.user_id
        WHERE ea.event_id = $1 AND lower(u.email) = lower($2)`,
      [eventId, email],
    );
    expect(rows[0].n).toBe(0);
  } finally {
    await client.end();
  }
}

// TM-759 wired: MEMBERSHIP_ENABLED + the loopback Revolut stub are set in e2e.yml, so this runs live.
test("@membership @payments resume a PENDING per-event payment: re-checkout re-mints a fresh token + re-mounts the widget (no dead-end)", async ({
  page,
}, testInfo) => {
  const shot = stepShot(page, testInfo, "payment-resume");
  const stamp = Date.now();

  // ── SETUP: the ADMIN creates a PREMIUM (£15) event via the first-party admin API — the same seam paid-rsvp
  // uses. A premium event at a real price is a PAY event for the PAY_PER_EVENT goer regardless of credit. ──
  const adminHeaders = await authHeadersFor(ADMIN);
  const event = await createEvent(adminHeaders, {
    heading: `e2e resume meetup ${stamp}`,
    capacity: 10,
    premium: true,
    pricePence: 1500, // £15 — a real premium price → the resolver decides PAY (not FREE)
  });
  expect(event.id).toBeTruthy();
  // Clean slate → idempotent across CI retries / re-runs. A lingering order for this (user, event) would
  // change what a checkout does (a CONFIRMED one makes it a true no-op; a terminal one re-opens rather than
  // resumes), so start from no order at all: the first checkout below opens a fresh PENDING order.
  await resetOrdersFor(EVENT_GOER.email);

  // ── STEP 1: sign in as the seeded goer and open the premium event's detail. ─────────────────────────────
  await signIn(page, EVENT_GOER);
  await shot("signed-in");
  await clickNav(page, "#nav-events");
  await expect(page.locator("#events-view")).toBeVisible();
  const card = page.locator(`[data-testid="event-card"][data-event-id="${event.id}"]`);
  await expect(card).toBeVisible();
  await card.click();
  const detail = page.locator('[data-testid="event-detail"]');
  await expect(detail).toBeVisible();
  await expect(detail).toHaveAttribute("data-event-id", String(event.id));
  await shot("detail");

  // ── STEP 2: RSVP → the paid-checkout detour opens the membership checkout screen (TM-624): the £15 PAY
  // badge + a "Continue to payment" action. ──────────────────────────────────────────────────────────────
  const primary = page.locator('[data-testid="event-primary-action"]');
  await expect(primary).toHaveAttribute("data-kind", "rsvp");
  await primary.click();

  const checkoutScreen = page.locator("#membership-checkout-screen");
  await expect(checkoutScreen).toBeVisible();
  await expect(checkoutScreen.locator(".tm-checkout-badge-pay")).toBeVisible();
  const payAction = checkoutScreen.locator(".tm-checkout-action");
  await expect(payAction).toHaveText("Continue to payment");
  await shot("checkout-open");

  // ── STEP 3: FIRST "Continue to payment" — the checkout POST records a PENDING order server-side with a
  // provider order id + token (the stubbed widget then mounts). Capture the first response and remember the
  // provider order id from the DB (the client response never exposes it) so we can prove the RESUME mints a
  // DIFFERENT one onto the SAME row. This is the state the buyer then ABANDONS. ──────────────────────────
  const firstCheckout = page.waitForResponse(
    (r) => r.url().includes(`/api/v1/events/${event.id}/checkout`) && r.request().method() === "POST",
  );
  await payAction.click();
  const firstRes = await firstCheckout;
  expect(firstRes.status()).toBe(200);
  const firstBody = await firstRes.json();
  expect(firstBody.paymentRequired).toBe(true);
  expect(firstBody.order.status).toBe("PENDING");
  expect(typeof firstBody.paymentToken).toBe("string"); // a real widget token on the first PAY

  // The order committed as PENDING with a provider order id — read it from Postgres (the webhook/match key).
  let firstProviderOrderId;
  await expect(async () => {
    const order = await readOrderForEvent(event.id, EVENT_GOER.email);
    expect(order).not.toBeNull();
    expect(order.status).toBe("PENDING");
    expect(order.providerOrderId).toBeTruthy();
    firstProviderOrderId = order.providerOrderId;
  }).toPass({ timeout: 10_000, intervals: [500] });
  // The RSVP is HELD BACK while the order is PENDING (no attendance) — the money-first invariant.
  await assertNoAttendance(event.id, EVENT_GOER.email);
  await shot("first-pending");

  // ── STEP 4: THE RESUME (the TM-744 fix). The buyer abandoned the widget (tab closed / token lost) and
  // returns to pay. Clicking "Continue to payment" AGAIN re-runs startPayment → a SECOND checkout POST over
  // the SAME still-PENDING (user, event) order. Before the fix this returned paymentRequired=true with NO
  // token and the client dead-ended on "Payment could not be initialised. Please try again."; after the fix
  // the backend re-mints a FRESH provider order + token onto the same row and startPayment resumes. ───────
  const resumeCheckout = page.waitForResponse(
    (r) => r.url().includes(`/api/v1/events/${event.id}/checkout`) && r.request().method() === "POST",
  );
  await payAction.click();
  const resumeRes = await resumeCheckout;
  expect(resumeRes.status()).toBe(200);
  const resumeBody = await resumeRes.json();

  // (a) THE FIX: the resume returns a FRESH, NON-NULL token (before the fix this was null → the dead-end).
  expect(resumeBody.paymentRequired).toBe(true);
  expect(resumeBody.order.status).toBe("PENDING");
  expect(typeof resumeBody.paymentToken).toBe("string");
  expect(resumeBody.paymentToken.length).toBeGreaterThan(0);
  // Same order row (idempotency key UNIQUE(user_id, event_id)), so its id is unchanged — the resume acts on
  // the existing order, it does not open a second one.
  expect(resumeBody.order.id).toBe(firstBody.order.id);
  await shot("resume-response");

  // (b) THE RE-MINT: a FRESH provider order id was minted onto the SAME row — the DB provider_order_id
  // CHANGED from the first checkout's (the stub's monotonic counter makes each mint unique). Before the fix
  // the PENDING repeat was a pure no-op (existing()), so this id would be UNCHANGED. The order is STILL
  // PENDING and attendance is STILL held back — a resume never settles.
  let resumeProviderOrderId;
  await expect(async () => {
    const order = await readOrderForEvent(event.id, EVENT_GOER.email);
    expect(order).not.toBeNull();
    expect(order.status).toBe("PENDING");
    expect(order.providerOrderId).toBeTruthy();
    resumeProviderOrderId = order.providerOrderId;
    expect(resumeProviderOrderId).not.toBe(firstProviderOrderId); // re-minted onto the same row
  }).toPass({ timeout: 10_000, intervals: [500] });
  await assertNoAttendance(event.id, EVENT_GOER.email);

  // (c) THE UI: no dead-end. This is resume-SPECIFIC, not merely "a widget exists": the SECOND click drives
  // startPayment fresh, which first sets the status to "Starting secure card payment…". Under the PRE-FIX
  // code the null token then made it settle on "Payment could not be initialised. Please try again." (the
  // dead-end) and NO widget re-mounted. Under the fix the fresh token makes mountRevolutCard run and settle
  // the status on the card-entry prompt — so asserting the status ENDS on that prompt (never the dead-end
  // copy) flips exactly at the fix. Playwright auto-retries toHaveText, so it waits out the transient
  // "Starting…" line and pins the final resolved state.
  const payMount = checkoutScreen.locator("#membership-checkout-pay-mount");
  await expect(payMount).toBeVisible();
  const status = payMount.locator(".tm-checkout-pay-status");
  await expect(status).toHaveText("Enter your card details to pay."); // fails-before (dead-end copy), passes-after
  const payBtn = payMount.locator(".tm-checkout-pay-btn");
  await expect(payBtn).toBeVisible();
  await expect(payBtn).toHaveText("Pay £15"); // the re-mounted widget's charge button
  // Belt-and-suspenders: the exact pre-fix dead-end string is nowhere on the checkout screen.
  await expect(
    checkoutScreen.getByText("Payment could not be initialised. Please try again."),
  ).toHaveCount(0);
  await shot("resume-widget-remounted");
});
