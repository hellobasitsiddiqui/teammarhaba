import { test, expect } from "@playwright/test";
import pg from "pg";
import { ADMIN, API_BASE_URL, dbConfig, lettersOnlyStamp } from "../fixtures.mjs";
import { completeInterestsStep } from "../helpers/onboarding.mjs";

// Phone-mandatory behaviour (TM-880 — supersedes the TM-188 "blank phone is allowed" regression this
// spec used to pin). The contract now:
//
//   1. A user WITH a stored phone who saves the edit form with the phone input left blank still
//      succeeds — blank means "leave unchanged" (the TM-188 partial-PATCH semantics survive) — and
//      the STORED phone is PRESERVED, never cleared by an unrelated edit.
//   2. A user WITHOUT a phone cannot complete first-use onboarding: the completion gate requires a
//      valid phone (client + the backend's POST /me/onboarding validation), and only once a valid
//      E.164 phone is saved does the gate lift. Email is never required (it isn't even a gate field).
//
// Mirrors profile-edit.spec's shape (UI assertion + DB persistence via pg). The seeded ADMIN now has
// a phone (global-setup seeds one — required, since the backend refuses onboarding-complete without
// it); the phone-less case therefore uses a brand-new email-code user, like the onboarding specs.

// Suppress the first-run product tour so its backdrop can't overlay the gate controls.
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

test("@profile saving with a blank phone input PRESERVES the stored phone (TM-880/TM-188)", async ({ page }) => {
  const first = `Phonekeeper${lettersOnlyStamp()}`;

  // 1. Sign in as the seeded ADMIN (a real, provisioned account WITH a stored phone).
  await page.goto("/#/login");
  await page.fill("#email", ADMIN.email);
  await page.click("#try-another-btn");
  await page.fill("#password", ADMIN.password);
  await page.click("#signin-btn");
  await expect(page.locator("#signout-btn")).toBeVisible();

  // 2. Open the self-service profile form (wait for the mount GET /me so the prefill has landed).
  const meLoaded = page.waitForResponse(
    (r) => r.url().includes("/api/v1/me") && r.request().method() === "GET",
  );
  await page.click("#nav-profile");
  await expect(page.locator("#profile-form")).toBeVisible();
  await meLoaded;

  // 3. Blank the phone input, change an unrelated field, save.
  await page.fill("#profile-phone", "");
  await page.fill("#profile-firstName", first);
  await page.getByRole("button", { name: "Save changes" }).click();

  // 4. Save succeeds — blank still means "no change", never a 400 and never a wipe.
  await expect(page.locator("#tm-toasts .tm-toast-success")).toContainText("Profile saved");

  // 5. The unrelated edit persisted AND the stored phone survived untouched (the global-setup seed).
  const client = new pg.Client(dbConfig);
  await client.connect();
  try {
    const { rows } = await client.query(
      "SELECT first_name, phone FROM users WHERE lower(email) = lower($1)",
      [ADMIN.email],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].first_name).toBe(first);
    expect(rows[0].phone).toBe("+447700900123");
  } finally {
    await client.end();
  }
});

/** Read the last code the backend "emailed" to an address (emulator-only peek endpoint). */
async function peekCode(email) {
  const res = await fetch(`${API_BASE_URL}/auth/email-code/peek?email=${encodeURIComponent(email)}`);
  if (!res.ok) throw new Error(`peek failed for ${email}: ${res.status}`);
  return (await res.text()).trim();
}

test("@profile a phone-less user is held at the completion gate until a valid phone is saved (TM-880)", async ({ page }) => {
  const email = `e2e-phonegate-${Date.now()}@teammarhaba.test`;

  // 1. Sign in a brand-new email-code user (⇒ no phone on record).
  await page.goto("/#/login");
  await page.fill("#email", email);
  const requested = page.waitForResponse(
    (r) => r.url().includes("/auth/email-code/request") && r.request().method() === "POST",
  );
  await page.click("#emailcode-send-btn");
  await requested;
  await page.fill("#emailcode-code", await peekCode(email));
  await page.click("#emailcode-verify-btn");
  await expect(page.locator("#signout-btn")).toBeVisible();

  // 2. GATED: the completion gate intercepts, and it carries the phone pair (country picker + input).
  await expect(page.locator("#onboarding-view")).toBeVisible();
  await expect(page.locator("#onboarding-phone")).toBeVisible();
  await expect(page.locator("#onboarding-phone-country")).toBeVisible();

  // 3. Filling everything EXCEPT the phone must NOT let the user through — phone is required.
  // Retried (the helpers/onboarding.mjs pattern): the gate's async mount prefill (TM-590) is BLANK
  // for a brand-new user, so a value typed before that GET /me lands is clobbered back to empty —
  // the name-error check below detects the clobber and the outer retry re-fills.
  await expect(async () => {
    await page.fill("#onboarding-name", "Gate Tester");
    await page.fill("#onboarding-location", "Gateville");
    await page.fill("#onboarding-age", "30");
    await page.click("#onboarding-form button[type=submit]");
    await expect(page.locator("#onboarding-phone-error")).toContainText("required", { timeout: 2_000 });
    await expect(page.locator("#onboarding-name-error")).toBeHidden({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  await expect(page.locator("#onboarding-view")).toBeVisible();
  await expect(page.locator("#auth-signed-in")).toBeHidden();

  // 4. A too-short number is rejected by the TM-752/TM-781 digit guard — still gated.
  await page.fill("#onboarding-phone", "12");
  await page.click("#onboarding-form button[type=submit]");
  await expect(page.locator("#onboarding-phone-error")).toContainText("7 to 15");

  // 5. A valid national number (GB picker default) completes the gate.
  await page.fill("#onboarding-phone", "7700 900654");
  const saved = page.waitForResponse(
    (r) => r.url().includes("/api/v1/me/onboarding") && r.request().method() === "POST",
  );
  await page.click("#onboarding-form button[type=submit]");
  await saved;
  await completeInterestsStep(page);

  // 6. The phone persisted as composed E.164 and onboarding is complete server-side.
  const client = new pg.Client(dbConfig);
  await client.connect();
  try {
    const { rows } = await client.query(
      "SELECT phone, onboarding_completed FROM users WHERE lower(email) = lower($1)",
      [email],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].phone).toBe("+447700900654");
    expect(rows[0].onboarding_completed).toBe(true);
  } finally {
    await client.end();
  }
});
