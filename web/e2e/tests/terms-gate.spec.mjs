import { test, expect } from "@playwright/test";
import pg from "pg";
import { ADMIN, API_BASE_URL, dbConfig } from "../fixtures.mjs";
import { completeOnboarding } from "../helpers/onboarding.mjs";

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

// The first-login profile gate + the interests picker are now walked by the shared
// helpers/onboarding.mjs `completeOnboarding` (TM-851): onboarding is a two-step flow inside
// `#onboarding-view` — profile gate → interests picker → the router hands off to the terms gate. The
// helper is robust against the onboarding gate's async prefill (TM-590), and completes the interests
// step (min-1 gate, seed config) before the terms gate can appear. See that file for the full rationale.

test("@terms a brand-new user is terms-gated, accepts, and then enters the app", async ({ page }) => {
  const email = `e2e-terms-${Date.now()}@teammarhaba.test`;

  await signInFreshUser(page, email);
  await completeOnboarding(page, {
    name: "Terms Tester",
    location: `Termsville-${Date.now()}`,
    age: 30,
  });

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
