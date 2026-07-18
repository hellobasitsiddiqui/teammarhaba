import { test, expect } from "@playwright/test";
import { ADMIN, AUTH_EMULATOR_HOST, API_BASE_URL } from "../fixtures.mjs";
import { authHeadersFor, createEvent, apiRsvp, apiCancelRsvp } from "../events-api.mjs";

// Money-safety e2e (TM-728, epic group-membership) — the browser gate for TM-728 finding #3 (the
// first-event-credit forfeiture rule), the one TM-728 fix with an observable UI signal in this hermetic
// harness. It proves, end to end against the full stack, the exact money-safety behaviour the merged fix
// (commit 7260915) LANDS ON — after its own regression-correction:
//
//   the first-event credit, once SPENT by a FREE-first commitment, is NOT handed back when the user
//   leaves via the DIRECT un-RSVP verb (DELETE /rsvp). Only a genuine paid-commitment reversal via
//   /checkout/cancel returns it — CheckoutService is the single money-safety owner. So a pay-per-event
//   caller can free-join their FIRST priced event, leave, and the SECOND priced event resolves PAY.
//
// WHY THIS FINDING (and not the other five in TM-728): the other fixes have no faithful e2e signal in this
// emulator harness — the webhook settle guards (soft-deleted buyer refund / already-ACTIVE double-settle
// refund) need a second PENDING INITIAL charge the Subscribe checkout gate (409 on an ACTIVE subscription)
// won't let the UI create, and manufacturing that state by raw DB insert would be inventing state, not
// driving a real flow; the subscribe mount-generation race + the 3DS TIMEOUT→SUCCESS state-machine
// correction are client-only races already pinned by node unit tests (web/tools/*.test.mjs) and can't be
// deterministically forced through a real browser; and the deploy.yml sandbox-pin warning is a CI/deploy
// guard with no runtime surface. Finding #3 is the one with a clean, deterministic, user-visible outcome.
//
// WHAT WOULD FAIL BEFORE THE FIX: the intermediate TM-728 commit moved the credit return INTO the shared
// cancelRsvp path, so a DIRECT un-RSVP handed the credit back — re-opening the TM-625a freebie loop, and
// this is exactly what the backend regression pin EventRsvpPaidGateIntegrationTest
// .secondFreeFirstDirectRsvpIsPricedOnceTheCreditIsSpent catches (it ended 200 GOING, not 402). The final
// fix forfeits the credit on the direct verb. So the load-bearing assertions below — event 2 resolves
// decision=PAY (not FREE) at the entitlement API, and the RSVP on it routes to the membership checkout
// screen (not a free GOING) in the browser — are precisely the behaviour that fails pre-fix and passes
// after it.
//
// HARNESS: reuses the SAME live money harness the sibling payment specs (paid-rsvp / event-cancel-refund)
// run under — MEMBERSHIP_ENABLED=true is set in .github/workflows/e2e.yml so the paid-checkout detour is
// live, and the WEB membership flag is forced ON per-spec below (defence in depth, identical seam to the
// siblings). No Revolut widget is exercised: this finding is decided BEFORE any payment (the credit is
// forfeited on leave, so the second event simply resolves PAY) — we assert the PAY detour opens, never a
// charge. The Revolut global is still stubbed so the checkout screen's SDK loader finds a ready global and
// injects no blocked CDN <script> when the checkout screen mounts its (unused) widget host.
//
// ACCOUNT: a FRESH, per-run emulator account is created in-spec (via the emulator's own accounts:signUp
// REST endpoint — the same host/key the suite already hits to sign in) and un-gated through the exact
// public-API sequence global-setup's provisionInBackend uses (GET /me → onboarding-complete → accept-terms),
// replicated inline. A fresh account is REQUIRED, not a convenience: the shared seeded accounts run across
// many specs on one CI database, so their one first-event credit may already be spent (or not) depending on
// run order — only a brand-new PAY_PER_EVENT account guarantees the credit is available, which is the
// precondition the whole assertion rests on. No shared fixture / seed endpoint / global-setup change.

// Turn the WEB membership flag ON + STUB the Revolut widget before any app script runs — copied verbatim
// from paid-rsvp.spec.mjs / event-cancel-refund.spec.mjs so the paid-checkout detour + screen are live and
// the checkout screen's SDK loader finds a ready global instead of the blocked CDN script.
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
    // widget config reads sandbox mode). Idempotent if the integrator instead adds the flag to serve.mjs.
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

    // 3) Stub the Revolut checkout SDK global so the checkout screen's loader short-circuits (no external
    // <script> injected). The card field is inert — no payment is exercised in this spec; the finding is
    // decided before any charge (event 2 simply resolves PAY because the credit was forfeited on leave).
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

/** Sign in a seeded/provisioned, un-gated account via the email+password ("Try another way") flow — the
 *  same path the sibling specs use. The account must already be onboarded + terms-accepted (below), so it
 *  lands straight in the app with no first-run gate to walk. */
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

/** A named step-screenshot helper (on top of the global screenshot:"on") — a step-by-step visual trail. */
function stepShot(page, testInfo, prefix) {
  let n = 0;
  return (name) =>
    page.screenshot({
      path: testInfo.outputPath(`${prefix}-${String(++n).padStart(2, "0")}-${name}.png`),
      fullPage: true,
    });
}

/**
 * Create a FRESH emulator account (accounts:signUp — the emulator's own REST endpoint, same host/key the
 * suite already hits for sign-in) so its one first-event credit is guaranteed available regardless of the
 * shared-DB run order, then un-gate it through the exact public-API sequence global-setup.provisionInBackend
 * uses (GET /me → POST /me/onboarding-complete → POST /me/accept-terms), replicated inline so no shared
 * helper / fixture is touched. Returns the account creds (for the browser sign-in) + its authed API headers.
 */
async function createFreshUngatedAccount() {
  const email = `e2e-tm728-credit-${Date.now()}@teammarhaba.test`;
  const password = "e2e-tm728-pw-123456";

  // 1) Create the account in the Auth emulator (returnSecureToken → we get an ID token straight back).
  const signUpUrl =
    `http://${AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`;
  const signUpRes = await fetch(signUpUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  if (!signUpRes.ok) {
    throw new Error(`emulator signUp failed for ${email}: ${signUpRes.status} ${await signUpRes.text()}`);
  }
  const { idToken } = await signUpRes.json();
  const authed = { Authorization: `Bearer ${idToken}`, Accept: "application/json" };

  // 2) Provision the backend users row (JIT via GET /me) — this also JIT-enrols a PAY_PER_EVENT membership
  // with the first-event credit UNUSED, the precondition the whole test rests on. Read the current terms
  // version the backend reports so we accept exactly that.
  const meRes = await fetch(`${API_BASE_URL}/api/v1/me`, { headers: authed });
  if (!meRes.ok) throw new Error(`provision (GET /me) failed for ${email}: ${meRes.status} ${await meRes.text()}`);
  const currentTermsVersion = (await meRes.json()).currentTermsVersion;

  // 3) Seed a phone (TM-880: mandatory — the backend refuses onboarding-complete without a valid
  // E.164 phone on record, and the client would re-gate a phone-less account).
  const phoneRes = await fetch(`${API_BASE_URL}/api/v1/me`, {
    method: "PATCH",
    headers: { ...authed, "Content-Type": "application/json" },
    body: JSON.stringify({ phone: "+447700900123" }),
  });
  if (!phoneRes.ok) throw new Error(`seed phone failed for ${email}: ${phoneRes.status} ${await phoneRes.text()}`);

  // 4) Clear the first-run onboarding gate (TM-250) so the browser sign-in lands straight in the app.
  const onboardRes = await fetch(`${API_BASE_URL}/api/v1/me/onboarding-complete`, { method: "POST", headers: authed });
  if (!onboardRes.ok) {
    throw new Error(`onboarding-complete failed for ${email}: ${onboardRes.status} ${await onboardRes.text()}`);
  }

  // 5) Accept the current terms version (TM-170) so the terms gate is cleared too.
  if (currentTermsVersion) {
    const termsRes = await fetch(`${API_BASE_URL}/api/v1/me/accept-terms`, {
      method: "POST",
      headers: { ...authed, "Content-Type": "application/json" },
      body: JSON.stringify({ version: currentTermsVersion }),
    });
    if (!termsRes.ok) throw new Error(`accept-terms failed for ${email}: ${termsRes.status} ${await termsRes.text()}`);
  }

  return { account: { email, password }, headers: { ...authed, "Content-Type": "application/json" } };
}

/** Read the caller's authoritative per-event entitlement (GET /events/{id}/entitlement, TM-476) — the same
 *  { decision, amountPence, reason } the checkout detour consumes. This is the crisp, deterministic proof of
 *  the credit-forfeiture rule that the browser detour then confirms visually. */
async function getEntitlement(headers, eventId) {
  const res = await fetch(`${API_BASE_URL}/api/v1/events/${eventId}/entitlement`, { headers });
  if (!res.ok) throw new Error(`GET entitlement failed for event ${eventId}: ${res.status} ${await res.text()}`);
  return res.json();
}

// TM-728 finding #3 — first-event credit is forfeited on a DIRECT un-RSVP, so the next priced event PAYs.
test("@membership @payments @money-safety a direct un-RSVP forfeits the first-event credit — the next priced event resolves PAY", async ({
  page,
}, testInfo) => {
  const shot = stepShot(page, testInfo, "credit-forfeit");
  const stamp = Date.now();

  // ── SETUP: the ADMIN creates TWO standard PRICED (£5, non-premium) events. A standard priced event is
  // the ONE case where the first-event credit applies (EntitlementResolver: premium is PAY before the
  // credit rule; £0 is FREE for everyone consuming nothing) — so event 1 resolves FREE via the credit and,
  // once the credit is spent + not returned, event 2 resolves PAY. Both are created via the admin API (the
  // same seam paid-rsvp / events use). ────────────────────────────────────────────────────────────────
  const adminHeaders = await authHeadersFor(ADMIN);
  const eventOne = await createEvent(adminHeaders, {
    heading: `e2e credit-forfeit first ${stamp}`,
    capacity: 10, // room to spare → a settled RSVP lands GOING (not WAITLISTED)
    premium: false,
    pricePence: 500, // £5 — a real standard price, so the credit (not £0-FREE) decides the first join
  });
  const eventTwo = await createEvent(adminHeaders, {
    heading: `e2e credit-forfeit second ${stamp}`,
    capacity: 10,
    premium: false,
    pricePence: 500,
  });
  expect(eventOne.id).toBeTruthy();
  expect(eventTwo.id).toBeTruthy();

  // A FRESH pay-per-event account whose first-event credit is guaranteed available (see the helper).
  const { account, headers } = await createFreshUngatedAccount();

  // ── PRECONDITION (API): both priced events resolve FREE for this brand-new account — the first-event
  // credit is available and applies to a standard priced event (reason FIRST_EVENT_FREE, £0 to the caller).
  // This is the state event 2 must LEAVE once the credit is spent-and-forfeited. ─────────────────────────
  const entOneBefore = await getEntitlement(headers, eventOne.id);
  expect(entOneBefore.decision).toBe("FREE");
  expect(entOneBefore.reason).toBe("FIRST_EVENT_FREE");
  expect(entOneBefore.amountPence).toBe(0);
  const entTwoBefore = await getEntitlement(headers, eventTwo.id);
  expect(entTwoBefore.decision).toBe("FREE"); // still FREE — the credit is not yet committed to either event
  expect(entTwoBefore.reason).toBe("FIRST_EVENT_FREE");

  // ── STEP 1: sign in as the fresh account (un-gated above, so it lands straight in the app). ────────────
  await signIn(page, account);
  await shot("signed-in");

  // ── STEP 2: free-join event 1 via the DIRECT RSVP verb (this is a COMMITMENT, so it SPENDS the one
  // first-event credit — the resolver's consume-on-commitment rule, TM-629). Driven as a first-party API
  // call (the same seam the events spec uses to set up scenarios); the browser then observes the downstream
  // consequence on event 2. A FREE join proceeds directly (no checkout, no 402). ────────────────────────
  const rsvpOne = await apiRsvp(headers, eventOne.id);
  expect(rsvpOne.state).toBe("GOING");

  // The credit is now SPENT: event 2 immediately re-resolves to PAY (its FREE-first coverage is gone,
  // because the credit is committed to event 1). This is the consume-on-commitment half of the rule.
  await expect(async () => {
    const midTwo = await getEntitlement(headers, eventTwo.id);
    expect(midTwo.decision).toBe("PAY");
    expect(midTwo.reason).toBe("PAY_STANDARD");
    expect(midTwo.amountPence).toBe(500);
  }).toPass({ timeout: 10_000, intervals: [500] });

  // ── STEP 3: LEAVE event 1 via the DIRECT un-RSVP verb (DELETE /rsvp) — NOT /checkout/cancel. This is
  // the exact code path TM-728 finding #3 hardens: the direct verb must FORFEIT the credit (return it, and
  // a pay-per-event caller loops the freebie forever — the TM-625a abuse). Also drops the GOING row so the
  // one-active-event rule can't mask event 2's outcome. ─────────────────────────────────────────────────
  await apiCancelRsvp(headers, eventOne.id);

  // ── STEP 4 (THE FIXED BEHAVIOUR, API): event 2 STAYS PAY after the direct leave. Pre-fix (the
  // intermediate TM-728 commit that returned the credit on cancelRsvp) it would have flipped back to
  // FREE / FIRST_EVENT_FREE — the money-losing regression the paid-gate integration test pins. The credit
  // is forfeited, so the second priced event is genuinely PAY: decision=PAY, reason=PAY_STANDARD, £5. ─────
  await expect(async () => {
    const entTwoAfter = await getEntitlement(headers, eventTwo.id);
    expect(entTwoAfter.decision).toBe("PAY"); // load-bearing: FREE here would be the pre-fix freebie loop
    expect(entTwoAfter.reason).toBe("PAY_STANDARD");
    expect(entTwoAfter.amountPence).toBe(500);
  }).toPass({ timeout: 10_000, intervals: [500] });
  // The credit is FORFEITED, not RETURNED: it stays committed to event 1 (EntitlementService keeps the
  // FREE coverage only for the event that consumed the credit — firstEventCreditEventId), so re-joining
  // event 1 is still FREE, while EVERY OTHER priced event (event 2) is now PAY. That asymmetry is the
  // whole point — the freebie is spent-and-parked, never handed back to be spent again elsewhere.
  const entOneAfter = await getEntitlement(headers, eventOne.id);
  expect(entOneAfter.decision).toBe("FREE");
  expect(entOneAfter.reason).toBe("FIRST_EVENT_FREE");

  // ── STEP 5 (THE FIXED BEHAVIOUR, BROWSER): the user-visible consequence. Open event 2 in the app and
  // press RSVP — with the credit forfeited, the paid-checkout detour (TM-624) takes over and the membership
  // checkout screen reveals with the £5 PAY badge, instead of a free GOING. Pre-fix this RSVP would have
  // free-joined (confirm dialog → GOING) with no checkout screen. ───────────────────────────────────────
  await clickNav(page, "#nav-events");
  await expect(page.locator("#events-view")).toBeVisible();
  const card = page.locator(`[data-testid="event-card"][data-event-id="${eventTwo.id}"]`);
  await expect(card).toBeVisible();
  await card.click();
  const detail = page.locator('[data-testid="event-detail"]');
  await expect(detail).toBeVisible();
  await expect(detail).toHaveAttribute("data-event-id", String(eventTwo.id));
  await shot("event-two-detail");

  const primary = page.locator('[data-testid="event-primary-action"]');
  await expect(primary).toHaveAttribute("data-kind", "rsvp"); // a join that WOULD land GOING → gets gated
  await primary.click();

  // The paid-checkout detour opened the membership checkout screen with the £5 PAY badge — the money gate
  // the forfeited credit produced. (No free GOING, no confirm dialog: routePaidCheckout took over.)
  const checkoutScreen = page.locator("#membership-checkout-screen");
  await expect(checkoutScreen).toBeVisible();
  await expect(checkoutScreen.locator(".tm-checkout-badge-pay")).toBeVisible();
  const payAction = checkoutScreen.locator(".tm-checkout-action");
  await expect(payAction).toHaveText("Continue to payment");
  await shot("event-two-pay-checkout");

  // And the browser NEVER landed a free GOING attendance on event 2 — the detour intercepted the join
  // before any RSVP fired, exactly as a PAY event must.
  await expect(page.locator('[data-testid="event-mystate"]')).toHaveCount(0);
});
