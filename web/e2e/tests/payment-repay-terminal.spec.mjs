import { test, expect } from "@playwright/test";
import pg from "pg";
import { ADMIN, EVENT_GOER, dbConfig } from "../fixtures.mjs";
import { authHeadersFor, createEvent } from "../events-api.mjs";
import { injectSettleWebhook, readOrderForEvent, resetOrdersFor } from "../membership-webhook.mjs";

// Membership per-event PAY re-pay e2e (TM-739, epic group-membership) — the behavioural gate for the fix
// that made checkout idempotency STATUS-AWARE so a terminal/abandoned order no longer dead-ends the buyer.
//
// THE BUG (origin/main before 74761b9): CheckoutService.checkout()'s idempotency early-return was
// UNCONDITIONAL — a repeat checkout for any (user, event) that already had an order row returned that same
// row via CheckoutResult.existing(), which hard-codes paymentRequired=(status==PENDING) and NO token. So a
// declined-card FAILED order (the single most common real payment retry) permanently barred the buyer from
// ever paying for that event: UNIQUE(user_id,event_id) forbids a second row, no path resurrected the old
// one, and the re-checkout returned paymentRequired=false with no token — a hard dead-end. The screen even
// falsely rendered "You're confirmed for this event." for that terminal FAILED order (TM-743), keyed on a
// bare paymentRequired===false.
//
// THE FIX asserted here: a re-checkout of a terminal FAILED order RE-OPENS that same row to a fresh PENDING
// order carrying a NON-NULL single-use provider token (Order.reopenForCheckout), so the buyer can mount the
// widget again and genuinely settle — CONFIRMED + a GOING attendance row. This spec proves it end to end
// through the REAL browser + full stack, finishing exactly as production does via VERIFIED signed webhooks,
// never a client "I paid":
//
//   sign in as the goer → open a PREMIUM (£15) event → RSVP → the paid-checkout detour opens the membership
//   checkout screen (TM-624) → "Continue to payment" creates a PENDING order + token → inject a signed
//   ORDER_PAYMENT_DECLINED webhook (the decline Revolut would post for a rejected card) → the order goes
//   terminal FAILED, no attendance → the buyer RETURNS and checks out AGAIN → the FIXED behaviour: the
//   re-checkout POST returns paymentRequired=true, a re-opened PENDING order, and a FRESH non-null token
//   (fail-before: paymentRequired=false, no token — the permanent dead-end), the screen does NOT falsely
//   claim "You're confirmed" (TM-743) and does NOT surface the "could not be initialised" retry dead-end,
//   the card widget re-mounts → inject the settle webhook for the RE-MINTED provider order → the re-opened
//   order settles CONFIRMED + a GOING attendance row persists + the receipt reads "Confirmed".
//
// WHY A PREMIUM EVENT: a premium event at a real price resolves to PAY for every tier below Diamond
// REGARDLESS of the first-event credit (EntitlementResolver rule 2, checked before the credit rule) — so
// the seeded PAY_PER_EVENT goer PAYs on its very first event, with no credit to burn first. Same fixture
// the backend's PaymentWebhookIntegrationTest.premiumEvent() and paid-rsvp.spec.mjs use (pricePence 1500,
// premium true).
//
// THE WIDGET IS STUBBED, THE MONEY IS NOT MOCKED-AWAY: the strict-CSP hermetic env blocks the sandbox
// RevolutCheckout CDN and there is no real card, so we pre-seed window.RevolutCheckout (below) — the SDK
// loader (membership-checkout.js) short-circuits on the present global and injects no external <script>,
// and the card field mounts as an inert stub. The stub NEVER confirms anything: both the FAIL and the final
// SETTLE are driven ONLY by injected webhooks whose signatures the REAL RevolutPaymentProvider verifies end
// to end. So this proves the honest server-side decline → FAILED → re-open → re-pay → confirm, not a
// client-side illusion.
//
// HARNESS (TM-759 wired): the membership money paths are turned on + a loopback Revolut stub answers the
// provider's create-order/cancel-order calls on the backend — .github/workflows/e2e.yml sets
// MEMBERSHIP_ENABLED=true, SUBSCRIPTIONS_ENABLED=false, REVOLUT_API_BASE at the stub
// (web/e2e/revolut-stub.mjs), a non-blank REVOLUT_SECRET_KEY, and REVOLUT_WEBHOOK_SIGNING_SECRET matching
// the value this spec signs with (via membership-webhook.mjs). The re-mint's best-effort void of the
// previous provider order (TM-739) also lands on that same stub's cancel-order endpoint. The WEB membership
// flag is turned on via serve.mjs's injected config AND re-forced client-side below (defence in depth) —
// the same config seam that already sets the emulator hosts. `screenshot: "on"` is global; we ALSO take a
// named shot per major step so the run yields a step-by-step visual trail for the evidence ticket.

// Turn the WEB membership flag ON for this spec (serve.mjs ships it OFF, matching prod), and STUB the
// Revolut widget, BEFORE any app script runs. addInitScript runs in the page before module evaluation, so
// membershipEnabled() reads true and the checkout detour + screen are live, and loadRevolutSdk() finds a
// ready global instead of trying to fetch the blocked CDN script. Identical init-script to paid-rsvp.spec.
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
    // returns an inert card field: submit() is a no-op here because the ORDER is settled by the injected
    // webhook, not by any widget callback. We DON'T fire onSuccess — settle is the server's job.
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

/** Assert (via Postgres, the house DB seam) the caller's attendance row on the event is in the expected
 *  state — the "it persisted" proof the events / paid-rsvp specs use. */
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

/** Assert (via Postgres) the caller holds NO attendance row on the event — a FAILED (declined) order never
 *  wrote an RSVP, and a still-PENDING re-checkout holds the RSVP back (the money-first invariant). */
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

/** Open the premium event's detail from the events list and reveal the membership checkout screen by
 *  RSVPing — the paid-checkout detour (TM-624). Returns the visible #membership-checkout-screen locator and
 *  its "Continue to payment" action. Factored out because THIS spec drives the checkout TWICE (first
 *  attempt, then the post-FAILED re-pay), each from a fresh page load. */
async function openCheckout(page, eventId) {
  await clickNav(page, "#nav-events");
  await expect(page.locator("#events-view")).toBeVisible();
  const card = page.locator(`[data-testid="event-card"][data-event-id="${eventId}"]`);
  await expect(card).toBeVisible();
  await card.click();
  const detail = page.locator('[data-testid="event-detail"]');
  await expect(detail).toBeVisible();
  await expect(detail).toHaveAttribute("data-event-id", String(eventId));

  // RSVP → the paid-checkout detour opens the membership checkout screen. With no live attendance (a FAILED
  // order held no RSVP), the primary action is still "rsvp" — so this same path re-opens checkout on the
  // second visit exactly as on the first.
  const primary = page.locator('[data-testid="event-primary-action"]');
  await expect(primary).toHaveAttribute("data-kind", "rsvp");
  await primary.click();

  const checkoutScreen = page.locator("#membership-checkout-screen");
  await expect(checkoutScreen).toBeVisible();
  await expect(checkoutScreen.locator(".tm-checkout-badge-pay")).toBeVisible();
  const payAction = checkoutScreen.locator(".tm-checkout-action");
  await expect(payAction).toHaveText("Continue to payment");
  return { checkoutScreen, payAction };
}

// TM-759 wired: MEMBERSHIP_ENABLED + the loopback Revolut stub are set in e2e.yml, so this runs live.
test("@membership @payments re-pay after decline: FAILED order re-opens to a fresh PENDING+token → CONFIRMED + GOING + receipt", async ({
  page,
}, testInfo) => {
  const shot = stepShot(page, testInfo, "repay-terminal");
  const stamp = Date.now();

  // ── SETUP: the ADMIN creates a PREMIUM (£15) event — a PAY event for the PAY_PER_EVENT goer regardless of
  // its first-event credit. Clean slate → idempotent across CI retries / re-runs (a lingering order for this
  // (user, event) is exactly what this test manipulates, so start with none). ────────────────────────────
  const adminHeaders = await authHeadersFor(ADMIN);
  const event = await createEvent(adminHeaders, {
    heading: `e2e repay meetup ${stamp}`,
    capacity: 10, // room to spare → a settled re-pay lands GOING
    premium: true,
    pricePence: 1500, // £15 — a real premium price, so the resolver decides PAY (not FREE)
  });
  expect(event.id).toBeTruthy();
  await resetOrdersFor(EVENT_GOER.email);

  // ── STEP 1: sign in as the goer and drive the FIRST checkout → a PENDING order + a widget token. ────────
  await signIn(page, EVENT_GOER);
  await shot("signed-in");
  const first = await openCheckout(page, event.id);
  await shot("checkout-open-1");

  const firstCheckoutResponse = page.waitForResponse(
    (r) => r.url().includes(`/api/v1/events/${event.id}/checkout`) && r.request().method() === "POST",
  );
  await first.payAction.click();
  const firstRes = await firstCheckoutResponse;
  expect(firstRes.status()).toBe(200);
  const firstBody = await firstRes.json();
  expect(firstBody.paymentRequired).toBe(true);
  expect(firstBody.order.status).toBe("PENDING");
  expect(typeof firstBody.paymentToken).toBe("string"); // a real single-use widget token minted
  await shot("pay-mount-1");

  // The order committed PENDING with a provider order id (our webhook match key); no attendance yet.
  await expect(async () => {
    const order = await readOrderForEvent(event.id, EVENT_GOER.email);
    expect(order).not.toBeNull();
    expect(order.status).toBe("PENDING");
    expect(order.providerOrderId).toBeTruthy();
  }).toPass({ timeout: 10_000, intervals: [500] });
  await assertNoAttendance(event.id, EVENT_GOER.email);

  // ── STEP 2: the card is DECLINED. Inject the signed ORDER_PAYMENT_DECLINED webhook Revolut would post for
  // a rejected card (the same signed-webhook seam as a settle, verified end to end by the real provider).
  // The backend moves the order PENDING → FAILED (CheckoutService.failPayment / Order.failPending, TM-634)
  // and writes NO RSVP — this is the terminal, non-attending state the OLD code then dead-ended on. ───────
  const pendingBefore = await readOrderForEvent(event.id, EVENT_GOER.email);
  const declineRes = await injectSettleWebhook(pendingBefore.providerOrderId, "ORDER_PAYMENT_DECLINED");
  // injectSettleWebhook returns a native fetch Response — `status` is a PROPERTY, not a method. 200 = the
  // signature verified + the delivery was accepted (401 would mean the HMAC didn't verify).
  expect(declineRes.status).toBe(200);
  await expect(async () => {
    const order = await readOrderForEvent(event.id, EVENT_GOER.email);
    expect(order.status).toBe("FAILED"); // terminal, non-attending — the pre-fix permanent dead-end
  }).toPass({ timeout: 15_000, intervals: [500] });
  await assertNoAttendance(event.id, EVENT_GOER.email);
  await shot("declined-failed");

  // ── STEP 3 (THE FIX): the buyer RETURNS and checks out AGAIN. Reload the app (drop any in-page widget
  // state, exactly as a buyer coming back later) and re-drive the checkout. This is the assertion that FAILS
  // before 74761b9 and PASSES after: the re-checkout POST must re-OPEN the terminal FAILED row to a fresh
  // PENDING order and return a NON-NULL token — not the old paymentRequired=false / no-token dead-end. ────
  await page.goto("/#/home");
  await expect(page.locator("#auth-signed-in")).toBeVisible();
  const second = await openCheckout(page, event.id);
  await shot("checkout-open-2");

  const repayResponse = page.waitForResponse(
    (r) => r.url().includes(`/api/v1/events/${event.id}/checkout`) && r.request().method() === "POST",
  );
  await second.payAction.click();
  const repayRes = await repayResponse;
  expect(repayRes.status()).toBe(200);
  const repayBody = await repayRes.json();
  // THE CORE AC — all three of these are wrong on origin/main (existing() returns paymentRequired=false,
  // order.status FAILED, and paymentToken absent):
  expect(repayBody.paymentRequired).toBe(true); // fail-before: false
  expect(repayBody.order.status).toBe("PENDING"); // fail-before: "FAILED" (the same row, re-opened)
  expect(typeof repayBody.paymentToken).toBe("string"); // fail-before: undefined — the permanent dead-end
  expect(repayBody.paymentToken.length).toBeGreaterThan(0);
  await shot("repay-response");

  // The UI reflects a live card step, NOT the pre-fix dead-ends. Before the fix, startPayment saw
  // paymentRequired=false and reflectPaid()'d a FALSE "You're confirmed for this event." (TM-743); and with
  // a null token it would have shown "Payment could not be initialised. Please try again." (TM-744). The Pay
  // mount must show neither — the widget re-mounts from the fresh token instead.
  const payMount = second.checkoutScreen.locator("#membership-checkout-pay-mount");
  await expect(payMount).toBeVisible();
  await expect(payMount).not.toContainText("You're confirmed for this event.");
  await expect(payMount).not.toContainText("Payment could not be initialised");
  // The re-mounted card widget's Pay button appears (mountRevolutCard ran on the fresh token) — the positive
  // proof the buyer CAN act on this checkout again, not a dead-end.
  await expect(payMount.locator(".tm-checkout-pay-btn")).toBeVisible();
  await shot("pay-mount-2");

  // The re-opened order is PENDING again with a NEW provider order id (the fresh mint — the re-mint voids the
  // old provider ref and sets a new one). Read it for the settle match key. The RSVP is still held back.
  const reopened = await readOrderForEvent(event.id, EVENT_GOER.email);
  expect(reopened.status).toBe("PENDING");
  expect(reopened.providerOrderId).toBeTruthy();
  expect(reopened.providerOrderId).not.toBe(pendingBefore.providerOrderId); // a genuinely fresh provider order
  await assertNoAttendance(event.id, EVENT_GOER.email);

  // ── STEP 4: this time the payment SETTLES. Inject the signed ORDER_COMPLETED webhook for the RE-MINTED
  // provider order → the backend confirms the re-opened order and performs the held-back RSVP. ────────────
  const settleRes = await injectSettleWebhook(reopened.providerOrderId);
  expect(settleRes.status).toBe(200);
  await shot("settle-injected");

  // ── STEP 5: the re-opened order is CONFIRMED and a GOING attendance row persists — the buyer genuinely
  // re-paid an event that, before the fix, they were permanently barred from. Both are DB-authoritative. ──
  await expect(async () => {
    const order = await readOrderForEvent(event.id, EVENT_GOER.email);
    expect(order.status).toBe("CONFIRMED");
  }).toPass({ timeout: 15_000, intervals: [500] });
  await assertAttendanceState(event.id, EVENT_GOER.email, "GOING");

  // ── STEP 6: the receipts screen (#/receipts) shows THIS event's order as "Confirmed" — the user-visible
  // proof the re-pay produced a real ticket. Scope by event id so a stray order can't satisfy the assert. ─
  await page.evaluate(() => {
    window.location.hash = "#/receipts";
  });
  const receipts = page.locator("#membership-receipts-screen");
  await expect(receipts).toBeVisible();
  await expect(receipts.locator(".tm-receipts-list")).toBeVisible();
  const row = receipts.locator('.tm-receipt-row[data-status="CONFIRMED"]', {
    hasText: `Event #${event.id}`,
  });
  await expect(row).toHaveCount(1);
  await expect(row.locator(".tm-receipt-status")).toHaveText("Confirmed");
  await expect(row.locator(".tm-receipt-amount")).toHaveText("£15");
  await shot("receipt-confirmed");
});
