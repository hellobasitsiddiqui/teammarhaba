import { test, expect } from "@playwright/test";
import { API_BASE_URL, AUTH_EMULATOR_HOST, PROJECT_ID } from "../fixtures.mjs";

// Passwordless email-code login (TM-234) — the new DEFAULT front door — plus the SMS "try another
// way" smoke, all against the Firebase Auth emulator (no real email/SMS, no secrets).
//
// Email-code happy path: enter email → "Email me a code" → the backend emails a 6-digit code; the
// emulator-only peek endpoint (registered ONLY when FIREBASE_AUTH_EMULATOR_HOST is set — inert in
// dev/prod) hands the test that code → enter it → the backend verifies + mints a custom token → the
// client signs in → the signed-in panel appears. We also exercise Resend and the SMS path.
//
// Suppress the first-run product tour (TM-147) so its modal/backdrop can't overlay the controls.
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

test("email-code is the default and a user signs in with the emailed code", async ({ page }) => {
  // A unique address per run so a stale code / cooldown from a prior run can't bleed in.
  const email = `e2e-emailcode-${Date.now()}@teammarhaba.test`;

  await page.goto("/#/login");
  await expect(page.locator("#auth-signed-out")).toBeVisible();

  // The primary action is "Email me a code" — the password field is NOT shown by default.
  await expect(page.locator("#emailcode-send-btn")).toBeVisible();
  await expect(page.locator("#password")).toBeHidden();

  // Step 1: request the code. Wait for the request POST to settle before peeking.
  await page.fill("#email", email);
  const requested = page.waitForResponse(
    (r) => r.url().includes("/auth/email-code/request") && r.request().method() === "POST",
  );
  await page.click("#emailcode-send-btn");
  await requested;

  // The code step is now shown and names the address.
  await expect(page.locator("#emailcode-step-code")).toBeVisible();
  await expect(page.locator("#emailcode-sent-to")).toHaveText(email);

  // Step 2: fetch the issued code and enter it → signed in.
  const code = await peekCode(email);
  expect(code).toMatch(/^\d{6}$/);
  await page.fill("#emailcode-code", code);
  await page.click("#emailcode-verify-btn");

  // Signed in: the sign-out control appears and the signed-out form is gone.
  await expect(page.locator("#signout-btn")).toBeVisible();
  await expect(page.locator("#auth-signed-out")).toBeHidden();
});

test("a wrong code shows an error and does not sign the user in", async ({ page }) => {
  const email = `e2e-emailcode-bad-${Date.now()}@teammarhaba.test`;
  await page.goto("/#/login");
  await page.fill("#email", email);
  const requested = page.waitForResponse(
    (r) => r.url().includes("/auth/email-code/request") && r.request().method() === "POST",
  );
  await page.click("#emailcode-send-btn");
  await requested;

  await page.fill("#emailcode-code", "000000");
  await page.click("#emailcode-verify-btn");

  // The error surfaces and the user stays on the signed-out form.
  await expect(page.locator("#auth-error")).toBeVisible();
  await expect(page.locator("#signout-btn")).toBeHidden();
});

test('"Try another way" reveals SMS and email+password, and SMS reaches the code step', async ({ page }) => {
  await page.goto("/#/login");

  // Alternatives are hidden until the user asks for them.
  await expect(page.locator("#auth-alternatives")).toBeHidden();
  await page.click("#try-another-btn");
  await expect(page.locator("#auth-alternatives")).toBeVisible();
  await expect(page.locator("#password")).toBeVisible(); // existing email+password still here
  await expect(page.locator("#sms-send-btn")).toBeVisible(); // SMS option present

  // TM-242: the consent/disclosure line is present on the SMS phone step, BEFORE the send button,
  // and tells the user we'll text a code + that standard SMS rates may apply. The deliberate act of
  // choosing SMS + clicking send having seen this line is the explicit consent Firebase requires.
  const disclosure = page.locator("#sms-disclosure");
  await expect(disclosure).toBeVisible();
  await expect(disclosure).toContainText(/text/i);
  await expect(disclosure).toContainText(/standard sms rates may apply/i);

  // The privacy-policy line discloses that phone numbers are sent to and stored by Google.
  await expect(page.locator("#privacy-policy")).toContainText(/sent to and stored by google/i);

  // SMS smoke against the configured fictional test number (+16505550100 → 123456, TM-241): request a
  // code → the SMS code step appears. No real SMS / no quota burn; we assert the flow advances, which
  // exercises Firebase Phone Auth wiring end-to-end short of the emulator's code lookup.
  const phone = "+16505550100";
  await page.fill("#phone", phone);
  await page.click("#sms-send-btn");

  // Either the SMS code step shows (Phone Auth accepted the number against the emulator) or a clear
  // error surfaces — never a silent hang. The happy branch is the contract we assert.
  await expect(page.locator("#sms-step-code")).toBeVisible();
  await expect(page.locator("#sms-verify-btn")).toBeVisible();
});
