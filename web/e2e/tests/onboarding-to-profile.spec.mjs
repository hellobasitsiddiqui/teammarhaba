import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { API_BASE_URL, dbConfig } from "../fixtures.mjs";

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

  await signInFreshUser(page, email);

  // DEEP-LINK the Profile page. A not-yet-onboarded user must NOT reach it — the guard intercepts.
  await page.goto("/#/profile");

  // GATED: the guard bounced the profile deep-link onto the onboarding gate. The onboarding view is
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

  // The onboarding gate lifts, but a brand-new user hits the SECOND gate — terms acceptance (TM-170).
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
