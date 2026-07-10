import { test, expect } from "@playwright/test";
import pg from "pg";
import { ADMIN, API_BASE_URL, dbConfig } from "../fixtures.mjs";

// Terms/privacy acceptance gate (TM-170): after the first-login profile gate (TM-250), a brand-new
// user is routed to a blocking "before you continue" step showing the current terms version + links
// to the Terms/Privacy pages, and CANNOT enter the app until they accept. Accepting posts to
// POST /api/v1/me/accept-terms and persists the accepted version; the gate then lifts. A returning
// user who has already accepted the current version (the seeded ADMIN — global-setup accepts it) is
// NOT gated. Mirrors the onboarding-gate spec's shape (real emulator sign-in + DB persistence check).
//
// Suppress the first-run product tour (TM-147) so its modal can't overlay the gate controls — same
// trick the onboarding-gate / email-code specs use.
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

/** Read the last code the backend "emailed" to an address (emulator-only peek endpoint). */
async function peekCode(email) {
  const res = await fetch(`${API_BASE_URL}/auth/email-code/peek?email=${encodeURIComponent(email)}`);
  if (!res.ok) throw new Error(`peek failed for ${email}: ${res.status}`);
  return (await res.text()).trim();
}

/** Sign in a fresh email-code user (a never-seen address ⇒ a brand-new, un-onboarded account). */
async function signInFreshUser(page, email) {
  await page.goto("/#/login");
  await expect(page.locator("#auth-signed-out")).toBeVisible();
  await page.fill("#email", email);
  const requested = page.waitForResponse(
    (r) => r.url().includes("/auth/email-code/request") && r.request().method() === "POST",
  );
  await page.click("#emailcode-send-btn");
  await requested;
  const code = await peekCode(email);
  await page.fill("#emailcode-code", code);
  await page.click("#emailcode-verify-btn");
  await expect(page.locator("#signout-btn")).toBeVisible();
}

/** Clear the first-login profile gate so we land on the SECOND gate (terms).
 *
 *  Robust against the onboarding gate's async prefill (TM-590): onboarding.js `load()` fires a mount
 *  GET /api/v1/me and pre-fills the form from it. For a brand-new user that prefill is BLANK, so a value
 *  typed BEFORE the response lands is clobbered back to empty — the same async-populate clobber the
 *  edit-profile spec documents (TM-198). The submit then no-ops on empty-field validation and NO POST
 *  fires, so the old `waitForResponse(POST /api/v1/me/onboarding)` hung to the 60s test timeout.
 *  Golden-path only dodged this because a full-page screenshot between the form appearing and the fill
 *  gave the prefill time to land first.
 *
 *  Fix: wait on the app OUTCOME — the onboarding gate LIFTING — instead of a specific POST, and retry the
 *  fill+submit so a late prefill that clears the fields can't strand the test. Deterministic regardless
 *  of prefill timing. */
async function completeOnboarding(page) {
  await expect(page.locator("#onboarding-form")).toBeVisible();
  await expect(async () => {
    // Already through (a prior iteration's submit landed)? Nothing left to do.
    if (await page.locator("#onboarding-view").isHidden()) return;
    await page.fill("#onboarding-name", "Terms Tester");
    await page.fill("#onboarding-location", `Termsville-${Date.now()}`);
    await page.fill("#onboarding-age", "30");
    await page.click("#onboarding-form button[type=submit]");
    // The gate lifts once the POST succeeds (the router re-guards → the terms gate). If a late prefill
    // wiped the fields the submit no-ops and the gate stays up, so this times out and the outer retry
    // re-fills (the prefill has since landed, so the values now stick).
    await expect(page.locator("#onboarding-view")).toBeHidden({ timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
}

test("@terms a brand-new user is terms-gated, accepts, and then enters the app", async ({ page }) => {
  const email = `e2e-terms-${Date.now()}@teammarhaba.test`;

  await signInFreshUser(page, email);
  await completeOnboarding(page);

  // GATED: routed to the terms view; the home view is NOT shown and the version + links are present.
  await expect(page.locator("#terms-view")).toBeVisible();
  await expect(page.locator("#auth-signed-in")).toBeHidden();
  await expect(page.locator("#terms-version")).toBeVisible();
  await expect(page.locator("#terms-link")).toBeVisible();
  await expect(page.locator("#privacy-link")).toBeVisible();
  // The in-app nav links are suppressed while gated, so the user can't side-step it.
  await expect(page.locator("#nav-profile")).toBeHidden();

  // Accept the current terms version → the gate lifts.
  const accepted = page.waitForResponse(
    (r) => r.url().includes("/api/v1/me/accept-terms") && r.request().method() === "POST",
  );
  await page.click("#terms-accept");
  await accepted;

  // ENTERED: the app home view shows, the terms gate is gone, the nav links return.
  await expect(page.locator("#auth-signed-in")).toBeVisible();
  await expect(page.locator("#terms-view")).toBeHidden();
  await expect(page.locator("#nav-profile")).toBeVisible();

  // It persisted: terms_accepted_version + terms_accepted_at are on the row.
  const client = new pg.Client(dbConfig);
  await client.connect();
  try {
    const { rows } = await client.query(
      "SELECT terms_accepted_version, terms_accepted_at FROM users WHERE lower(email) = lower($1)",
      [email],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].terms_accepted_version).toBeTruthy();
    expect(rows[0].terms_accepted_at).not.toBeNull();
  } finally {
    await client.end();
  }
});

test("@terms a returning user who already accepted the current terms is NOT terms-gated", async ({ page }) => {
  // The seeded ADMIN accepted the current terms version in global-setup, so signing in skips the gate.
  await page.goto("/#/login");
  await page.fill("#email", ADMIN.email);
  await page.click("#try-another-btn");
  await page.fill("#password", ADMIN.password);
  await page.click("#signin-btn");

  await expect(page.locator("#signout-btn")).toBeVisible();
  // Not gated: the terms view never shows; the app (admin nav) is reachable.
  await expect(page.locator("#terms-view")).toBeHidden();
  await expect(page.locator("#nav-admin")).toBeVisible();
});
