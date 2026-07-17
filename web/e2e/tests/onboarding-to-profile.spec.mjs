import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { API_BASE_URL, dbConfig } from "../fixtures.mjs";
import { completeInterestsStep } from "../helpers/onboarding.mjs";

// Cold onboarding → profile journey (TM-738 P0). A BRAND-NEW passwordless user who deep-links the
// Profile page is INTERCEPTED by the first-login gate (TM-250): the guard in router.js can't let a
// not-yet-onboarded user reach #/profile, so it stashes #/profile as the intended route and forces
// them onto #/onboarding. Only after they supply the three required minimum fields — Name, Location,
// Age (POST /api/v1/me/onboarding) — AND clear the second gate (terms acceptance, TM-170) does the
// guard RELEASE them to where they were headed: #/profile. We then prove the onboarding-supplied
// identity actually populates the Profile hub, and that it persisted to Postgres.
//
// This complements onboarding-gate.spec.mjs (which asserts the gate lands a plain sign-in on HOME):
// here the entry point is a Profile deep-link, and the release target is #/profile itself — the full
// "gate intercepts pre-onboarding → releases post-onboarding, straight to the page they wanted".
//
// Hermetic: real Firebase Auth EMULATOR sign-in (no real email/SMS, no secrets); the login code is
// read via the emulator-only peek endpoint; state is asserted against the same Postgres the stack
// uses. Mirrors the email-code-login + onboarding-gate specs' shape exactly.
//
// Suppress the first-run product tour (TM-147) so its modal/backdrop can't overlay the gate/profile
// controls — the same trick the email-code + onboarding-gate specs use.
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

/**
 * Sign in a fresh email-code user (a never-seen address ⇒ a brand-new, un-onboarded account).
 *
 * `deepLink` reproduces the REAL "deep-linked a protected page while signed out" entry: we navigate
 * straight to it first, and the signed-out guard (router.js: `!signedIn && isProtected`) stashes it
 * in `tm.intendedRoute` and bounces us to the login form. That stash is what the guard restores after
 * the first-run gates clear — so the user lands back on the page they originally wanted.
 *
 * NB: the intended route MUST be stashed by a signed-out deep-link like this, NOT by a `goto` AFTER
 * sign-in. Sign-in fires a nav-first guard (TM-307) that routes the still-cached-as-onboarded user to
 * HOME, and the follow-up background re-guard then stashes HOME before a post-sign-in goto can register
 * — so HOME would win the stash and the user would never be returned to the deep-linked route.
 */
async function signInFreshUser(page, email, deepLink) {
  if (deepLink) {
    // Signed-out deep-link to a protected route ⇒ the guard stashes it and redirects to the login form.
    await page.goto(`/#${deepLink.replace(/^#/, "")}`);
    await expect(page).toHaveURL(/#\/login$/);
  } else {
    await page.goto("/#/login");
  }
  await expect(page.locator("#auth-signed-out")).toBeVisible();
  await page.fill("#email", email);
  const requested = page.waitForResponse(
    (r) => r.url().includes("/auth/email-code/request") && r.request().method() === "POST",
  );
  await page.click("#emailcode-send-btn");
  await requested;
  const code = await peekCode(email);
  // TM-867: filling the first OTP box with the whole code distributes + AUTO-submits (no verify click).
  await page.fill("#emailcode-code", code);
  // Signed in (the nav sign-out control appears regardless of where the guard then routes us).
  await expect(page.locator("#signout-btn")).toBeVisible();
}

test("@onboarding a brand-new user deep-linking #/profile is gated, onboards, and lands on their profile", async ({ page }) => {
  // Unique-per-run identity. The emulator is wiped each run so a fixed address would be clean too, but
  // a random suffix guarantees a never-seen (⇒ un-onboarded) account even across in-run retries — and
  // avoids Date.now(). Location/name are unique so the DB + hub assertions can't match stale data.
  const run = randomUUID().slice(0, 8);
  const email = `e2e-onboard-profile-${run}@teammarhaba.test`;
  const displayName = `Fresh User ${run}`;
  const location = `Gateville-${run}`;
  const age = 27;

  // DEEP-LINK the Profile page as a brand-new user: the signed-out guard stashes #/profile as the
  // intended route and bounces to the login form; we then sign in. The intended-route memory is what
  // the guard restores once BOTH first-run gates clear, so the user is returned to #/profile — not home.
  await signInFreshUser(page, email, "#/profile");

  // GATED: a signed-in but not-yet-onboarded user still can't reach the Profile page — the guard forces
  // the onboarding gate first (the stashed #/profile is preserved for after). The onboarding view is
  // shown; neither the requested Profile view nor the signed-in home shell is visible.
  await expect(page.locator("#onboarding-view")).toBeVisible();
  await expect(page.locator("#onboarding-form")).toBeVisible();
  await expect(page.locator("#profile-view")).toBeHidden();
  await expect(page.locator("#auth-signed-in")).toBeHidden();
  // The hash was redirected to the gate, and the in-app nav (incl. the Profile link) is suppressed so
  // the user can't side-step the gate back to the page they wanted.
  await expect(page).toHaveURL(/#\/onboarding$/);
  await expect(page.locator("#nav-profile")).toBeHidden();

  // Validation: an empty submit surfaces required-field errors and does NOT release the user.
  await page.click("#onboarding-form button[type=submit]");
  await expect(page.locator("#onboarding-name-error")).toBeVisible();
  await expect(page.locator("#onboarding-view")).toBeVisible();

  // Fill the three required fields and submit → POST /api/v1/me/onboarding.
  await page.fill("#onboarding-name", displayName);
  await page.fill("#onboarding-location", location);
  await page.fill("#onboarding-age", String(age));
  const saved = page.waitForResponse(
    (r) => r.url().includes("/api/v1/me/onboarding") && r.request().method() === "POST",
  );
  await page.click("#onboarding-form button[type=submit]");
  await saved;

  // The onboarding gate lifts into the SECOND onboarding step — the interests picker (TM-776/TM-804),
  // rendered into the SAME #onboarding-view. Complete it (select the minimum, Continue → PATCH /me) so
  // the router hands off to the terms gate — the stashed #/profile intended route is still preserved
  // throughout. Done via the shared helper (TM-851).
  await completeInterestsStep(page);

  // The interests step done, a brand-new user hits the SECOND first-run gate — terms acceptance (TM-170).
  // Accept the current version to clear it. (The gate STILL preserves the stashed #/profile target.)
  await expect(page.locator("#terms-view")).toBeVisible();
  await expect(page.locator("#profile-view")).toBeHidden();
  const accepted = page.waitForResponse(
    (r) => r.url().includes("/api/v1/me/accept-terms") && r.request().method() === "POST",
  );
  await page.click("#terms-accept");
  await accepted;

  // RELEASED — straight to the page they originally wanted. Both gates cleared, so the guard restores
  // the stashed intended route (#/profile), NOT home: the Profile view shows and the gates are gone.
  await expect(page.locator("#profile-view")).toBeVisible();
  await expect(page).toHaveURL(/#\/profile$/);
  await expect(page.locator("#onboarding-view")).toBeHidden();
  await expect(page.locator("#terms-view")).toBeHidden();
  await expect(page.locator("#profile-form")).toBeVisible();
  // The nav Profile link is back now the gates are cleared.
  await expect(page.locator("#nav-profile")).toBeVisible();

  // The onboarding-supplied identity actually populates the Profile hub (paper-profile): the hub name
  // renders the display name (single onboarding "name" ⇒ display_name ⇒ identitySummary.short == full),
  // and the meta line carries the city + age they entered. This proves onboarding fed the profile, not
  // just that some profile page rendered.
  await expect(page.locator(".tm-pf-name")).toHaveText(displayName);
  await expect(page.locator(".tm-pf-id")).toContainText(location);
  await expect(page.locator(".tm-pf-id")).toContainText(String(age));

  // It persisted: name → display_name, location → city, age, and the onboarding flag are on the row.
  const client = new pg.Client(dbConfig);
  await client.connect();
  try {
    const { rows } = await client.query(
      "SELECT display_name, city, age, onboarding_completed FROM users WHERE lower(email) = lower($1)",
      [email],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].display_name).toBe(displayName);
    expect(rows[0].city).toBe(location);
    expect(rows[0].age).toBe(age);
    expect(rows[0].onboarding_completed).toBe(true);
  } finally {
    await client.end();
  }
});
