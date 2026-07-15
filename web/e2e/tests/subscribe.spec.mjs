import { test, expect } from "@playwright/test";
import pg from "pg";
import { CHAT_SEED, dbConfig } from "../fixtures.mjs";
import { authHeadersFor } from "../events-api.mjs";
import {
  injectSettleWebhook,
  readPendingInitialCharge,
  resetSubscriptionFor,
} from "../membership-webhook.mjs";

// Membership Subscribe-to-paid-tier e2e (TM-738, epic group-membership) — the automated-test gate for the
// recurring-subscription join. Drives the whole Subscribe path through the real browser + full stack,
// finishing exactly as production does — via a VERIFIED subscription-charge settle webhook, never a
// client "I paid":
//
//   sign in → open the Subscribe checkout for MONTHLY (#/membership/subscribe/MONTHLY) → "Continue to
//   payment" opens the checkout SERVER-SIDE (creates the INITIAL PENDING charge + a provider order via the
//   stub) → the stubbed Revolut widget mounts (a Subscribe pay button appears) → the charge is PENDING and
//   the subscription is NOT active yet (activation is held back) → inject a signed ORDER_COMPLETED webhook
//   for that charge → the backend activates the subscription → GET /me/subscription flips tier to MONTHLY.
//
// THE WIDGET IS STUBBED, THE MONEY IS NOT MOCKED-AWAY (same rationale as paid-rsvp.spec.mjs): the strict-
// CSP hermetic env blocks the sandbox RevolutCheckout CDN and there is no real card, so window.RevolutCheckout
// is pre-seeded (below) — the shared SDK loader short-circuits on the present global and injects no external
// <script>. The stub NEVER activates anything: the subscription is activated ONLY by the injected settle
// webhook, whose signature the REAL RevolutPaymentProvider verifies end to end. A client can never talk
// itself into a paid tier — this proves the honest server-side settle → activate, not a client illusion.
//
// HARNESS (TM-759 wired): the membership money paths are turned on + a loopback Revolut stub answers the
// provider's create-order / create-customer calls — .github/workflows/e2e.yml sets MEMBERSHIP_ENABLED=true,
// SUBSCRIPTIONS_ENABLED=false (the renewal scheduler bean never fires a background charge mid-suite; we
// drive the INITIAL charge by webhook), REVOLUT_API_BASE at the stub (web/e2e/revolut-stub.mjs), a
// non-blank REVOLUT_SECRET_KEY, and REVOLUT_WEBHOOK_SIGNING_SECRET matching this spec's signing value. The
// WEB membership flag is turned on via serve.mjs's injected config AND re-forced client-side below.
// `screenshot: "on"` is global; we ALSO take a named shot per major step for the evidence ticket.

// Turn the WEB membership flag ON + STUB the Revolut widget before any app script runs (identical seam to
// paid-rsvp.spec.mjs; the subscribe screen shares the same loadRevolutSdk()).
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    // 1) Suppress the first-run product tour (dimmed backdrop) — the shared localStorage init-script.
    const orig = Storage.prototype.getItem;
    Storage.prototype.getItem = function (k) {
      return typeof k === "string" && k.startsWith("tm.tour.")
        ? JSON.stringify({ done: true })
        : orig.call(this, k);
    };

    // 2) Flip the web membership flag ON. serve.mjs freezes the config with membership OFF, so intercept
    // config.js's assign of window.TEAMMARHABA_CONFIG and always re-merge the flag on (+ a payments block
    // so the widget config reads sandbox mode; the stubbed global short-circuits the actual SDK load). If
    // the integrator instead sets the flag in serve.mjs, this merge is idempotent and still correct.
    const merge = (cfg) =>
      Object.freeze({
        ...(cfg || {}),
        flags: Object.freeze({ ...((cfg && cfg.flags) || {}), membership: true }),
        payments: Object.freeze({
          ...((cfg && cfg.payments) || {}),
          revolutMode: "sandbox",
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
    // window.RevolutCheckout is a function (no external script injected). The card field is inert — the
    // subscription is activated by the injected settle webhook, not by any widget callback.
    window.RevolutCheckout = function revolutCheckoutStub() {
      return Promise.resolve({
        createCardField: () => ({ submit: () => {}, destroy: () => {} }),
        destroy: () => {},
      });
    };
  });
});

/** Sign in a seeded, un-gated account via the email+password ("Try another way") flow — the same path the
 *  sibling specs use. Provisioned onboarded + terms-accepted in global-setup, so it lands in the app. */
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

/** Read the caller's subscription state through the real GET /me/subscription API, as the given account.
 *  Used to POLL the webhook-driven activation exactly as the subscribe screen's pollActivation does. */
async function getSubscriptionApi(account) {
  const headers = await authHeadersFor(account);
  const res = await fetch(`${process.env.E2E_API_BASE_URL || "http://127.0.0.1:8080"}/api/v1/me/subscription`, {
    headers,
  });
  if (!res.ok) throw new Error(`GET /me/subscription failed: ${res.status}`);
  return res.json();
}

// TM-759 wired: MEMBERSHIP_ENABLED + the loopback Revolut stub are now set in e2e.yml, so this runs live.
test("@membership @subscription subscribe MONTHLY: checkout → settle webhook → tier flips to MONTHLY", async ({
  page,
}, testInfo) => {
  const shot = stepShot(page, testInfo, "subscribe");

  // ── SETUP: clean slate → idempotent across CI retries / re-runs. A leftover ACTIVE subscription from a
  // prior run would make the Subscribe checkout 409 (already actively subscribed), so drop the account's
  // subscription + charge rows first. ─────────────────────────────────────────────────────────────────
  await resetSubscriptionFor(CHAT_SEED.email);

  // Baseline: the account starts UNSUBSCRIBED (the none-state) — a well-defined 200, not a 404.
  expect((await getSubscriptionApi(CHAT_SEED)).subscribed).toBe(false);

  // ── STEP 1: sign in and open the MONTHLY Subscribe checkout. Navigating to the route (flag ON) makes
  // the router reveal #membership-subscribe-screen and paint the "Continue to payment" start button. ────
  await signIn(page, CHAT_SEED);
  await shot("signed-in");
  await page.evaluate(() => {
    window.location.hash = "#/membership/subscribe/MONTHLY";
  });
  const subscribeScreen = page.locator("#membership-subscribe-screen");
  await expect(subscribeScreen).toBeVisible();
  await expect(subscribeScreen.locator(".tm-subscribe-title")).toContainText("Subscribe");
  // The £9.99/month summary + the start button.
  await expect(subscribeScreen.locator(".tm-subscribe-summary")).toHaveAttribute("data-tier", "MONTHLY");
  const startBtn = subscribeScreen.locator(".tm-subscribe-start");
  await expect(startBtn).toHaveText("Continue to payment");
  await shot("subscribe-open");

  // ── STEP 2: "Continue to payment" → the checkout POST opens the Subscribe checkout SERVER-SIDE. Capture
  // POST /me/subscription/checkout and assert its honest shape: the MONTHLY tier + a widget token (the
  // stubbed widget then mounts, activating nothing). ──────────────────────────────────────────────────
  const checkoutResponse = page.waitForResponse(
    (r) => r.url().includes("/api/v1/me/subscription/checkout") && r.request().method() === "POST",
  );
  await startBtn.click();
  const checkoutRes = await checkoutResponse;
  expect(checkoutRes.status()).toBe(200);
  const checkoutBody = await checkoutRes.json();
  expect(checkoutBody.tier).toBe("MONTHLY");
  expect(typeof checkoutBody.paymentToken).toBe("string"); // the stub minted a widget token
  expect(checkoutBody.provider).toBe("revolut");

  // The stubbed widget mounts → the Subscribe pay button appears (the SDK loader found our global, no CDN
  // fetch). This is the "widget mount (stub)" the P0 calls for; the button confirms the mount, not payment.
  await expect(subscribeScreen.locator(".tm-subscribe-pay-btn")).toBeVisible();
  await shot("widget-mounted");

  // The subscription is NOT active yet — the INITIAL charge is PENDING and no subscription row is ACTIVE.
  await expect(async () => {
    const charge = await readPendingInitialCharge(CHAT_SEED.email);
    expect(charge).not.toBeNull();
    expect(charge.status).toBe("PENDING");
    expect(charge.providerOrderId).toBeTruthy(); // the provider order id — our webhook match key
  }).toPass({ timeout: 10_000, intervals: [500] });
  expect((await getSubscriptionApi(CHAT_SEED)).subscribed).toBe(false); // still unsubscribed pre-webhook

  // ── STEP 3: inject the subscription-charge settle webhook Revolut would post (ORDER_COMPLETED), signed
  // with the e2e signing secret so the REAL provider verifies it. The backend activates the subscription.
  // Read the provider order id (the match key) from the DB — the client response never exposes it. ──────
  const pending = await readPendingInitialCharge(CHAT_SEED.email);
  const webhookRes = await injectSettleWebhook(pending.providerOrderId);
  expect(webhookRes.status()).toBe(200); // verified + accepted (401 = signature didn't verify)
  await shot("webhook-injected");

  // ── STEP 4: poll GET /me/subscription until the webhook-driven activation shows up — the tier flips to
  // MONTHLY and the subscription is ACTIVE + renewing. This is the exact poll the subscribe screen runs
  // after payment; here it proves the activation is honest (server-side), not a client claim. ──────────
  await expect(async () => {
    const sub = await getSubscriptionApi(CHAT_SEED);
    expect(sub.subscribed).toBe(true);
    expect(sub.tier).toBe("MONTHLY");
    expect(sub.status).toBe("ACTIVE");
    expect(sub.renewing).toBe(true);
  }).toPass({ timeout: 15_000, intervals: [500] });

  // It PERSISTED: the subscriptions row is MONTHLY + ACTIVE, and the INITIAL charge settled to PAID — the
  // DB-authoritative proof (the same pg seam the sibling specs assert on).
  const client = new pg.Client(dbConfig);
  await client.connect();
  try {
    const { rows: subs } = await client.query(
      `SELECT s.tier, s.status
         FROM subscriptions s
         JOIN users u ON u.id = s.user_id
        WHERE lower(u.email) = lower($1)`,
      [CHAT_SEED.email],
    );
    expect(subs).toHaveLength(1);
    expect(subs[0].tier).toBe("MONTHLY");
    expect(subs[0].status).toBe("ACTIVE");

    const { rows: charges } = await client.query(
      `SELECT sc.status
         FROM subscription_charges sc
         JOIN users u ON u.id = sc.user_id
        WHERE lower(u.email) = lower($1) AND sc.kind = 'INITIAL'
        ORDER BY sc.created_at DESC, sc.id DESC
        LIMIT 1`,
      [CHAT_SEED.email],
    );
    expect(charges).toHaveLength(1);
    expect(charges[0].status).toBe("PAID"); // the INITIAL charge settled
  } finally {
    await client.end();
  }
  await shot("subscribed-monthly");
});
