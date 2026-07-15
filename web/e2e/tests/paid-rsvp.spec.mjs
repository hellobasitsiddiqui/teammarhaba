import { test, expect } from "@playwright/test";
import pg from "pg";
import { ADMIN, EVENT_GOER, dbConfig } from "../fixtures.mjs";
import { authHeadersFor, createEvent } from "../events-api.mjs";
import { injectSettleWebhook, readOrderForEvent, resetOrdersFor } from "../membership-webhook.mjs";

// Membership per-event PAY checkout e2e (TM-738, epic group-membership) — the automated-test gate for
// the paid-ticket journey, and the P0 that DEDUPES the events "paidRsvpJourney" (this spec owns it).
// Drives the whole PAY path through the real browser + full stack, finishing exactly as production does —
// via a VERIFIED settle webhook, never a client "I paid":
//
//   sign in as the goer → open a PREMIUM (£15) event → RSVP → the paid-checkout detour opens the
//   membership checkout screen (TM-624) → "Continue to payment" creates the order SERVER-SIDE → the
//   order is PENDING and NO attendance is written (the RSVP is held back) → inject a signed
//   ORDER_COMPLETED webhook (the settle Revolut would post) → the backend confirms the order and performs
//   the held-back RSVP → the order is CONFIRMED + a GOING attendance row persists → the receipts screen
//   (#/receipts) shows the order as "Confirmed".
//
// WHY A PREMIUM EVENT: a premium event at a real price resolves to PAY for every tier below Diamond
// REGARDLESS of the first-event credit (EntitlementResolver rule 2, checked before the credit rule) — so
// the seeded PAY_PER_EVENT goer PAYs on its very first event, with no credit to burn first. Same fixture
// the backend's PaymentWebhookIntegrationTest.premiumEvent() uses (pricePence 1500, premium true).
//
// THE WIDGET IS STUBBED, THE MONEY IS NOT MOCKED-AWAY: the strict-CSP hermetic env blocks the sandbox
// RevolutCheckout CDN and there is no real card, so we pre-seed window.RevolutCheckout (below) — the
// SDK loader (membership-checkout.js) short-circuits on the present global and injects no external
// <script>, and the card field mounts as an inert stub. The stub NEVER confirms anything: the order is
// confirmed ONLY by the injected settle webhook, whose signature the REAL RevolutPaymentProvider verifies
// end to end. So this proves the honest server-side settle → confirm → RSVP, not a client-side illusion.
//
// HARNESS (TM-759 wired): the membership money paths are turned on + a loopback Revolut stub answers the
// provider's create-order calls on the backend — .github/workflows/e2e.yml sets MEMBERSHIP_ENABLED=true,
// SUBSCRIPTIONS_ENABLED=false, REVOLUT_API_BASE at the stub (web/e2e/revolut-stub.mjs), a non-blank
// REVOLUT_SECRET_KEY, and REVOLUT_WEBHOOK_SIGNING_SECRET matching the value this spec signs with (see the
// header of membership-webhook.mjs for the contract). The WEB membership flag is turned on via serve.mjs's
// injected config (config.flags.membership) AND re-forced client-side below (defence in depth) — the same
// config seam that already sets the emulator hosts. `screenshot: "on"` is global; we ALSO take a named shot
// per major step so the run yields a step-by-step visual trail for the evidence ticket.

// Turn the WEB membership flag ON for this spec (serve.mjs ships it OFF, matching prod), and STUB the
// Revolut widget, BEFORE any app script runs. addInitScript runs in the page before module evaluation, so
// membershipEnabled() reads true and the checkout detour + screen are live, and loadRevolutSdk() finds a
// ready global instead of trying to fetch the blocked CDN script.
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
    // returns an inert card field: submit() is a no-op here because the ORDER is confirmed by the injected
    // settle webhook, not by any widget callback. We DON'T fire onSuccess — settle is the server's job.
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
 *  broadcast-admin / events use. These accounts are provisioned onboarded + terms-accepted in
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
 *  state — the "it persisted" proof the events spec uses. */
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

/** Assert (via Postgres) the caller holds NO attendance row on the event — the RSVP is genuinely held
 *  back while the order is PENDING (the money-first invariant). */
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

// TM-759 wired: MEMBERSHIP_ENABLED + the loopback Revolut stub are now set in e2e.yml, so this runs live.
test("@membership @payments per-event PAY: checkout PENDING → settle webhook → CONFIRMED + GOING + receipt", async ({
  page,
}, testInfo) => {
  const shot = stepShot(page, testInfo, "paid-rsvp");
  const stamp = Date.now();

  // ── SETUP: the ADMIN creates a PREMIUM (£15) event. No admin web form is merged (TM-392 is API-only),
  // so this is the first-party admin API — the same seam the events spec uses. A premium event at a real
  // price is a PAY event for the PAY_PER_EVENT goer regardless of its first-event credit. ──────────────
  const adminHeaders = await authHeadersFor(ADMIN);
  const event = await createEvent(adminHeaders, {
    heading: `e2e paid meetup ${stamp}`,
    capacity: 10, // room to spare → a settled RSVP lands GOING
    premium: true,
    pricePence: 1500, // £15 — a real premium price, so the resolver decides PAY (not FREE)
  });
  expect(event.id).toBeTruthy();
  // Clean slate → idempotent across CI retries / re-runs (a lingering CONFIRMED order for this account
  // would make the re-checkout an idempotent no-op and skip the PENDING → CONFIRMED transition we assert).
  await resetOrdersFor(EVENT_GOER.email);

  // ── STEP 1: sign in as the seeded goer and open the premium event's detail. ─────────────────────────
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

  // ── STEP 2: RSVP → the paid-checkout detour opens the membership checkout screen (TM-624). With the
  // membership flag ON, a join→GOING RSVP on a PAY event routes through window.tmMembershipCheckout.open()
  // instead of a free RSVP, so the checkout screen (#membership-checkout-screen) reveals with the price
  // badge + a "Continue to payment" action. (No confirm dialog — the detour runs before it.) ───────────
  const primary = page.locator('[data-testid="event-primary-action"]');
  await expect(primary).toHaveAttribute("data-kind", "rsvp");
  await primary.click();

  const checkoutScreen = page.locator("#membership-checkout-screen");
  await expect(checkoutScreen).toBeVisible();
  // The £15 PAY badge + the paid action ("Continue to payment", class tm-checkout-action).
  await expect(checkoutScreen.locator(".tm-checkout-badge-pay")).toBeVisible();
  const payAction = checkoutScreen.locator(".tm-checkout-action");
  await expect(payAction).toHaveText("Continue to payment");
  await shot("checkout-open");

  // ── STEP 3: "Continue to payment" → the checkout POST records the order SERVER-SIDE. Capture the
  // POST /events/{id}/checkout response and assert its honest shape: a PENDING order, paymentRequired,
  // and a widget token (the stubbed widget then mounts, confirming nothing). ───────────────────────────
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
  expect(typeof checkoutBody.paymentToken).toBe("string"); // the stub minted a widget token
  await shot("pay-mount");

  // The RSVP is HELD BACK: the order is PENDING and there is NO attendance row yet.
  await expect(async () => {
    const order = await readOrderForEvent(event.id, EVENT_GOER.email);
    expect(order).not.toBeNull();
    expect(order.status).toBe("PENDING");
    expect(order.providerOrderId).toBeTruthy(); // the provider order id — our webhook match key
  }).toPass({ timeout: 10_000, intervals: [500] });
  await assertNoAttendance(event.id, EVENT_GOER.email);

  // ── STEP 4: inject the settle webhook Revolut would post (ORDER_COMPLETED) — signed with the e2e signing
  // secret so the REAL provider verifies it. The backend confirms the order and performs the held-back
  // RSVP. Read the provider order id (the match key) from the DB — the client response never exposes it. ─
  const pending = await readOrderForEvent(event.id, EVENT_GOER.email);
  const webhookRes = await injectSettleWebhook(pending.providerOrderId);
  // injectSettleWebhook returns a native fetch Response — `status` is a PROPERTY, not a method.
  expect(webhookRes.status).toBe(200); // verified + accepted (401 would mean the signature didn't verify)
  await shot("webhook-injected");

  // ── STEP 5: the order is CONFIRMED and a GOING attendance row persists — the settle → confirm → RSVP the
  // webhook performed. Both are DB-authoritative (the confirm is async under the caller's row lock). ─────
  await expect(async () => {
    const order = await readOrderForEvent(event.id, EVENT_GOER.email);
    expect(order.status).toBe("CONFIRMED");
  }).toPass({ timeout: 15_000, intervals: [500] });
  await assertAttendanceState(event.id, EVENT_GOER.email, "GOING");

  // ── STEP 6: the receipts screen (#/receipts, wired live TM-624) shows the order as "Confirmed". This is
  // the user-visible receipt the whole PAY path exists to produce. Navigate by hash (the no-reload nav the
  // events spec uses); the row's status badge reads the CONFIRMED label. ──────────────────────────────
  await page.evaluate(() => {
    window.location.hash = "#/receipts";
  });
  const receipts = page.locator("#membership-receipts-screen");
  await expect(receipts).toBeVisible();
  await expect(receipts.locator(".tm-receipts-list")).toBeVisible();
  // THIS event's order row: each row is a <button class="tm-receipt-row" data-status="…"> that shows
  // "Event #<id>". Scope by event id so a stray order from another spec's account can never satisfy the
  // assertion, and assert data-status=CONFIRMED + the "Confirmed" label + the £15 amount.
  const row = receipts.locator('.tm-receipt-row[data-status="CONFIRMED"]', {
    hasText: `Event #${event.id}`,
  });
  await expect(row).toHaveCount(1);
  await expect(row.locator(".tm-receipt-status")).toHaveText("Confirmed");
  await expect(row.locator(".tm-receipt-amount")).toHaveText("£15");
  await shot("receipt-confirmed");
});
