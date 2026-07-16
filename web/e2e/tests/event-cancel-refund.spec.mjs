import { test, expect } from "@playwright/test";
import { ADMIN, EVENT_GOER } from "../fixtures.mjs";
import { authHeadersFor, createEvent } from "../events-api.mjs";
import { injectSettleWebhook, readOrderForEvent, resetOrdersFor } from "../membership-webhook.mjs";

// Admin-cancel money-reversal e2e (TM-740, epic group-membership) — the browser gate for the money-safety
// HIGH the TM-655 re-review found (finding H3). Proves the fix in commit 78165aa end to end against the
// full stack:
//
//   an ADMIN creates a PREMIUM (£15) event → the goer PAYS through the real checkout → settle webhook →
//   a CONFIRMED, money-bearing order + a GOING attendance (captured money at the provider) → the ADMIN
//   later CANCELS that event through the admin-events console (the same UI cancel admin-events.spec drives)
//   → the paid attendee's captured money is REVERSED: the order leaves CONFIRMED and lands REFUNDED (the
//   admin cancel now enumerates CONFIRMED orders and drives each to REFUND_DUE + provider refund).
//
// WHAT WOULD FAIL BEFORE THE FIX: before 78165aa, EventAdminService.cancel only audited + published a
// "CANCELLED" lifecycle notification — it reversed NO money. The goer's order would stay CONFIRMED forever
// (captured funds stranded), and because a cancelled event reads as "not found", the attendee could not even
// self-serve their own refund (POST /events/{id}/checkout/cancel 404s). So the load-bearing assertion below
// — the order transitions OUT of CONFIRMED to REFUNDED after the admin cancel — is exactly the behaviour the
// fix introduced: it fails on origin/main-before-fix and passes after.
//
// WHY REFUNDED (not REFUND_DUE): the fix calls tryRefund, which issues the provider refund inline. In this
// hermetic harness the loopback Revolut stub (web/e2e/revolut-stub.mjs) answers POST /api/orders/{id}/refund
// with 200 {state:"completed"}, so tryRefund succeeds → order.markRefunded → OrderStatus.REFUNDED (terminal).
// A failed provider refund would leave the row REFUND_DUE for the RefundSweepService; here the stub always
// succeeds, so REFUNDED is deterministic. Either way the row leaves CONFIRMED — the money-reversal proof.
//
// SEEDING: the paid CONFIRMED order is produced by the SAME honest checkout→settle-webhook path
// paid-rsvp.spec.mjs proves (never a client "I paid") — the order is CONFIRMED only by a VERIFIED settle
// webhook whose signature the REAL RevolutPaymentProvider checks. The admin cancel is then driven through the
// admin-events UI (console → row "Cancel" → styled confirm → POST /admin/events/{id}/cancel), reusing the
// exact flow admin-events.spec.mjs already exercises. No new seed endpoint, no shared-file change.
//
// HARNESS (TM-759 wired, same as paid-rsvp): the membership money paths are ON and a loopback Revolut stub
// answers the provider's create-order + refund calls on the backend — .github/workflows/e2e.yml sets
// MEMBERSHIP_ENABLED=true, REVOLUT_API_BASE at the stub, a non-blank REVOLUT_SECRET_KEY, and
// REVOLUT_WEBHOOK_SIGNING_SECRET matching the value membership-webhook.mjs signs with. The WEB membership flag
// is forced ON per-spec below (defence in depth) and the Revolut widget is stubbed, IDENTICAL to paid-rsvp.

// Turn the WEB membership flag ON for this spec (serve.mjs ships it OFF, matching prod) and STUB the Revolut
// widget BEFORE any app script runs. Copied verbatim from paid-rsvp.spec.mjs so the goer's PAY checkout detour
// + screen are live and loadRevolutSdk() finds a ready global instead of the blocked CDN script.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    // 1) Suppress the first-run product tour (its dimmed backdrop would cover the controls under test) — the
    // identical localStorage init-script every other spec uses.
    const orig = Storage.prototype.getItem;
    Storage.prototype.getItem = function (k) {
      return typeof k === "string" && k.startsWith("tm.tour.")
        ? JSON.stringify({ done: true })
        : orig.call(this, k);
    };

    // 2) Flip the web membership flag ON. serve.mjs freezes TEAMMARHABA_CONFIG with the flag OFF; config.js (a
    // classic <script>) then assigns its own frozen config AFTER this init-script runs. Intercept that assign
    // with an accessor whose setter always re-merges flags.membership=true (+ a payments block so the widget
    // config reads sandbox mode). Idempotent if the integrator instead adds the flag to serve.mjs's config.
    const merge = (cfg) =>
      Object.freeze({
        ...(cfg || {}),
        flags: Object.freeze({ ...((cfg && cfg.flags) || {}), membership: true }),
        payments: Object.freeze({
          ...((cfg && cfg.payments) || {}),
          revolutMode: "sandbox",
          // Read by the loader, but our stubbed global short-circuits the load before any <script> is
          // injected, so this is never actually fetched.
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
    // window.RevolutCheckout is a function (no external script injected). The card field is inert: submit() is
    // a no-op because the ORDER is confirmed by the injected settle webhook, not by any widget callback.
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

/** Sign in a seeded, un-gated account via the email+password ("Try another way") flow — the same path the
 *  admin-events / broadcast-admin / paid-rsvp specs use. These accounts are provisioned onboarded +
 *  terms-accepted in global-setup, so they land straight in the app (no first-run gate). */
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

/** Sign the current session OUT so we can re-enter as a different account (goer → admin). Opens the nav and
 *  clicks the sign-out control, then waits for the signed-out shell — the same nav seam the specs use. */
async function signOut(page) {
  await clickNav(page, "#signout-btn");
  await expect(page.locator("#auth-signed-out")).toBeVisible();
}

/** A named step-screenshot helper (on top of the global screenshot:"on") — a step-by-step visual trail. */
function stepShot(page, testInfo, prefix) {
  let n = 0;
  return (name) =>
    page.screenshot({
      path: testInfo.outputPath(`${prefix}-${String(++n).padStart(2, "0")}-${name}.png`),
      fullPage: true,
    });
}

// TM-759 wired: MEMBERSHIP_ENABLED + the loopback Revolut stub (create-order + refund) are set in e2e.yml,
// so this runs the real money path live.
test("@membership @payments admin cancel of a paid event refunds the paid attendee (money is not stranded)", async ({
  page,
}, testInfo) => {
  const shot = stepShot(page, testInfo, "event-cancel-refund");
  const stamp = Date.now();

  // ── SETUP: the ADMIN creates a PREMIUM (£15) event. No admin web form is needed for creation here (the
  // admin API is the seam paid-rsvp/events use); the admin UI is only exercised for the CANCEL under test.
  // A premium event at a real price resolves to PAY for the PAY_PER_EVENT goer regardless of its first-event
  // credit, so the goer PAYs — producing the money-bearing CONFIRMED order this test reverses. ────────────
  const adminHeaders = await authHeadersFor(ADMIN);
  const heading = `e2e cancel-refund meetup ${stamp}`;
  // Schedule the event FAR in the future so it sits at (or very near) the TOP of the admin console's default
  // `startAt DESC` server ordering — so it lands in the console's first fetched page even against a populated
  // shared CI DB. Its visibility window is open now (visible in the public list for the goer's RSVP) and runs
  // well past the far-future start.
  const startAt = new Date(stamp + 3650 * 864e5); // ~10 years out → top of startAt-desc
  const event = await createEvent(adminHeaders, {
    heading,
    capacity: 10, // room to spare → the settled RSVP lands GOING
    premium: true,
    pricePence: 1500, // £15 — a real premium price, so the resolver decides PAY (not FREE)
    startAt: startAt.toISOString(),
    endAt: new Date(startAt.getTime() + 3 * 36e5).toISOString(), // +3h
    visibilityStart: new Date(stamp - 36e5).toISOString(), // visible since an hour ago
    visibilityEnd: new Date(startAt.getTime() + 864e5).toISOString(), // …until just after the (far) start
  });
  expect(event.id).toBeTruthy();
  // Clean slate → idempotent across CI retries / re-runs: a lingering order for this account on this event
  // would make the re-checkout an idempotent no-op and skip the PENDING → CONFIRMED transition we need first.
  await resetOrdersFor(EVENT_GOER.email);

  // ── STEP 1: sign in as the goer and PAY for the premium event, EXACTLY as paid-rsvp proves — RSVP → the
  // checkout detour → "Continue to payment" records a PENDING order server-side → inject the signed settle
  // webhook → the backend confirms the order + performs the held-back RSVP. This produces the CONFIRMED,
  // money-bearing order whose money the admin cancel must later return. ────────────────────────────────────
  await signIn(page, EVENT_GOER);
  await shot("goer-signed-in");
  await clickNav(page, "#nav-events");
  await expect(page.locator("#events-view")).toBeVisible();
  const card = page.locator(`[data-testid="event-card"][data-event-id="${event.id}"]`);
  await expect(card).toBeVisible();
  await card.click();
  const detail = page.locator('[data-testid="event-detail"]');
  await expect(detail).toBeVisible();
  await expect(detail).toHaveAttribute("data-event-id", String(event.id));

  // RSVP → the paid-checkout detour opens the membership checkout screen (TM-624).
  const primary = page.locator('[data-testid="event-primary-action"]');
  await expect(primary).toHaveAttribute("data-kind", "rsvp");
  await primary.click();
  const checkoutScreen = page.locator("#membership-checkout-screen");
  await expect(checkoutScreen).toBeVisible();
  await expect(checkoutScreen.locator(".tm-checkout-badge-pay")).toBeVisible();
  const payAction = checkoutScreen.locator(".tm-checkout-action");
  await expect(payAction).toHaveText("Continue to payment");

  // "Continue to payment" → the checkout POST records the PENDING order server-side.
  const checkoutResponse = page.waitForResponse(
    (r) => r.url().includes(`/api/v1/events/${event.id}/checkout`) && r.request().method() === "POST",
  );
  await payAction.click();
  const checkoutRes = await checkoutResponse;
  expect(checkoutRes.status()).toBe(200);
  const checkoutBody = await checkoutRes.json();
  expect(checkoutBody.paymentRequired).toBe(true);
  expect(checkoutBody.order.status).toBe("PENDING");
  expect(checkoutBody.order.amountPence).toBe(1500);
  await shot("goer-checkout-pending");

  // The PENDING order committed; read the provider order id (the webhook match key the client never exposes).
  await expect(async () => {
    const order = await readOrderForEvent(event.id, EVENT_GOER.email);
    expect(order).not.toBeNull();
    expect(order.status).toBe("PENDING");
    expect(order.providerOrderId).toBeTruthy();
  }).toPass({ timeout: 10_000, intervals: [500] });
  const pending = await readOrderForEvent(event.id, EVENT_GOER.email);

  // Inject the settle webhook Revolut would post — signed with the e2e secret so the REAL provider verifies
  // it. The backend confirms the order and performs the held-back RSVP.
  const webhookRes = await injectSettleWebhook(pending.providerOrderId);
  expect(webhookRes.status).toBe(200); // verified + accepted (401 would mean the signature didn't verify)

  // The order is now CONFIRMED — a settled, money-bearing commitment (captured funds at the provider). This
  // is the precondition for the money-reversal under test.
  await expect(async () => {
    const order = await readOrderForEvent(event.id, EVENT_GOER.email);
    expect(order.status).toBe("CONFIRMED");
  }).toPass({ timeout: 15_000, intervals: [500] });
  await shot("goer-order-confirmed");

  // ── STEP 2: sign out the goer, sign in as the ADMIN, and open the admin events console. ──────────────────
  await signOut(page);
  await signIn(page, ADMIN);
  await openNav(page); // phone: the admin nav link lives behind the hamburger — open it before asserting
  await expect(page.locator("#nav-admin-events")).toBeVisible();
  await clickNav(page, "#nav-admin-events");
  await expect(page.locator("#admin-events-view")).toBeVisible();
  await expect(page.locator("#admin-events-table")).toBeVisible();
  await shot("admin-console");

  // Search by the event's unique heading so its row is the ONLY one rendered — robust against a populated
  // shared CI DB (the console filters the fetched list client-side by heading/location/city). Combined with
  // the far-future startAt (top of the server's startAt-desc fetch), this guarantees the row is present.
  await page.fill("#admin-events-search", heading);
  const row = page.locator(`tr[data-event-id="${event.id}"]`);
  await expect(row).toBeVisible();
  await expect(row).toContainText(heading);

  // ── STEP 3: CANCEL the event through the UI — the row "Cancel" button → the styled confirm dialog → the
  // POST /admin/events/{id}/cancel the fix hooks the refund fan-out onto. Assert the honest 200 + CANCELLED.
  // This is the admin action that, pre-fix, stranded the goer's captured money. ────────────────────────────
  await row.getByRole("button", { name: `Cancel ${heading}` }).click();
  const dialog = page.locator(".tm-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Cancel this event?");
  const cancelResponse = page.waitForResponse(
    (r) => r.url().includes(`/api/v1/admin/events/${event.id}/cancel`) && r.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Cancel event" }).click();
  const cancelled = await (await cancelResponse).json();
  expect(cancelled.status).toBe("CANCELLED");
  await expect(row).toContainText("Cancelled");
  await shot("admin-cancelled");

  // ── STEP 4 (THE FIXED BEHAVIOUR): the paid attendee's captured money is REVERSED. Before 78165aa the admin
  // cancel reversed no money — the goer's order would stay CONFIRMED forever. After the fix the admin cancel
  // enumerates CONFIRMED orders, drives each to REFUND_DUE and issues the provider refund; the loopback stub
  // returns 200 so tryRefund lands the order at REFUNDED (terminal). Poll the DB (the refund runs inside the
  // cancel transaction, then flushes) until the goer's order status transitions to REFUNDED. ───────────────
  await expect(async () => {
    const order = await readOrderForEvent(event.id, EVENT_GOER.email);
    expect(order).not.toBeNull();
    // The load-bearing money-reversal proof: the order left CONFIRMED (it did NOT before the fix) …
    expect(order.status).not.toBe("CONFIRMED");
    // … and, with the deterministic refund stub, landed REFUNDED (money returned). If the provider refund had
    // failed it would sit at REFUND_DUE; the stub always succeeds, so REFUNDED is the expected terminal state.
    expect(order.status).toBe("REFUNDED");
  }).toPass({ timeout: 15_000, intervals: [500] });
  await shot("order-refunded");
});
