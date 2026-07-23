import { test, expect } from "@playwright/test";
import { expectSignedIn } from "../helpers/auth-state.mjs";
import pg from "pg";
import { ADMIN, API_BASE_URL, dbConfig, uniqueGateGbNumber } from "../fixtures.mjs";
import { completeInterestsStep, verifyGatePhone } from "../helpers/onboarding.mjs";

// First-login profile gate (TM-250): a brand-new passwordless user is routed to a blocking
// "complete your profile" form (Name, Location, Age) and cannot enter the app until it's filled +
// saved; a returning, already-onboarded user (the seeded ADMIN — global-setup marks it complete) is
// NOT gated and lands straight in the app. Mirrors the email-code-login + profile-edit specs' shape
// (real Firebase emulator sign-in + DB persistence assertion).
//
// Suppress the first-run product tour (TM-147) so its modal/backdrop can't overlay the gate controls
// — same trick the email-code spec uses.
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
  // TM-867: filling the first OTP box with the whole code distributes + AUTO-submits (no verify click).
  await page.fill("#emailcode-code", code);
  // Signed in (the router flips body[data-auth] to signed-in regardless of where the guard then routes us).
  await expectSignedIn(page);
}

test("@onboarding a brand-new user is gated, completes the profile, and then enters the app", async ({ page }) => {
  const email = `e2e-onboard-${Date.now()}@teammarhaba.test`;
  // TM-934: the number this fresh user VERIFIES + LINKS in the browser gate must be run-unique — under
  // strict 1:1 Firebase phone uniqueness a FIXED number (was +447700900456) would already be linked on a
  // re-run against a non-wiped emulator. TM-994: uniqueGateGbNumber derives a per-run GB national/E.164
  // pair AND excludes the persona band (+4477009001NN) by construction — a raw `Date.now()%100000` tail
  // could land in 00100–00108 (~1/1100 runs) and 409 the second claim against a seeded persona.
  const { national: gateNational, e164: gateE164 } = uniqueGateGbNumber();
  // TM-898: location is the TM-877 allowed-cities dropdown now (it was free text, which let the
  // gate persist an off-list city the profile form refuses). A multi-word list city pins the
  // value-with-a-space case end-to-end.
  const location = "Milton Keynes";

  await signInFreshUser(page, email);

  // GATED: routed to the onboarding view; the home view is NOT shown.
  await expect(page.locator("#onboarding-view")).toBeVisible();
  await expect(page.locator("#onboarding-form")).toBeVisible();
  await expect(page.locator("#auth-signed-in")).toBeHidden();
  // The in-app nav links are suppressed while gated, so the user can't side-step it.
  await expect(page.locator("#nav-profile")).toBeHidden();

  // Validation: submitting empty surfaces required-field errors and does NOT let the user through.
  await page.click("#onboarding-form button[type=submit]");
  await expect(page.locator("#onboarding-name-error")).toBeVisible();
  // TM-880: phone is REQUIRED at the gate too — the empty submit flags it like the other fields.
  await expect(page.locator("#onboarding-phone-error")).toBeVisible();
  await expect(page.locator("#onboarding-phone-error")).toContainText("required");
  await expect(page.locator("#onboarding-view")).toBeVisible();

  // The location control is the allowed-cities DROPDOWN (TM-898), not free text: a real <select>
  // offering exactly the blank "choose" affordance plus the TM-877 list — same as the profile form.
  await expect(page.locator("select#onboarding-location")).toBeVisible();
  await expect(page.locator("#onboarding-location option")).toHaveText([
    "Choose a city…",
    "London",
    "Milton Keynes",
    "Sharjah",
    "Karachi",
  ]);

  // Fill all four required fields and submit (phone = national number; the country picker beside it
  // defaults to GB for a fresh user, so it composes + stores as E.164 +44…, TM-880/TM-781).
  await page.fill("#onboarding-name", "Fresh User");
  await page.selectOption("#onboarding-location", location);
  await page.fill("#onboarding-age", "27");
  await page.fill("#onboarding-phone", gateNational);
  // TM-930: the phone must be OTP-VERIFIED (Firebase phone verify + link) before the gate submits —
  // send the code, peek it from the Auth emulator, auto-submit the six boxes → "Verified ✓".
  await verifyGatePhone(page, gateE164);
  const saved = page.waitForResponse(
    (r) => r.url().includes("/api/v1/me/onboarding") && r.request().method() === "POST",
  );
  await page.click("#onboarding-form button[type=submit]");
  await saved;

  // The onboarding gate lifts into the SECOND onboarding step — the interests picker (TM-776/TM-804),
  // rendered into the SAME #onboarding-view. Complete it (select the minimum, Continue → PATCH /me) so
  // the router hands off to the terms gate. Done via the shared helper (TM-851) so future onboarding
  // changes touch one place.
  await completeInterestsStep(page);

  // The interests step done, a brand-new user now hits the SECOND first-run gate — terms acceptance
  // (TM-170): they haven't accepted the current terms version yet. Accept it to reach the app.
  await expect(page.locator("#terms-view")).toBeVisible();
  await expect(page.locator("#auth-signed-in")).toBeHidden();
  const accepted = page.waitForResponse(
    (r) => r.url().includes("/api/v1/me/accept-terms") && r.request().method() === "POST",
  );
  await page.click("#terms-accept");
  await accepted;

  // ENTERED: both gates cleared → the app home view shows, the gates are gone, the nav links return.
  await expect(page.locator("#auth-signed-in")).toBeVisible();
  await expect(page.locator("#onboarding-view")).toBeHidden();
  await expect(page.locator("#terms-view")).toBeHidden();
  await expect(page.locator("#nav-profile")).toBeVisible();

  // It persisted: name → display_name, location → city, age, the composed E.164 phone (TM-880),
  // and the onboarding flag are on the row.
  const client = new pg.Client(dbConfig);
  await client.connect();
  try {
    const { rows } = await client.query(
      "SELECT display_name, city, age, phone, onboarding_completed FROM users WHERE lower(email) = lower($1)",
      [email],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].display_name).toBe("Fresh User");
    expect(rows[0].city).toBe(location);
    expect(rows[0].age).toBe(27);
    expect(rows[0].phone).toBe(gateE164); // GB picker + national digits, trunk 0 absent (TM-934: run-unique)
    expect(rows[0].onboarding_completed).toBe(true);
  } finally {
    await client.end();
  }
});

test("@onboarding a returning, already-onboarded user is NOT gated and lands straight in the app", async ({ page }) => {
  // The seeded ADMIN is marked onboarding-complete in global-setup, so signing in must skip the gate.
  await page.goto("/#/login");
  await page.fill("#email", ADMIN.email);
  await page.click("#try-another-btn");
  await page.fill("#password", ADMIN.password);
  await page.click("#signin-btn");

  await expectSignedIn(page);
  // Not gated: the onboarding view never shows; the app (admin nav, signed-in home) is reachable.
  await expect(page.locator("#onboarding-view")).toBeHidden();
  await expect(page.locator("#nav-admin")).toBeVisible();
});
