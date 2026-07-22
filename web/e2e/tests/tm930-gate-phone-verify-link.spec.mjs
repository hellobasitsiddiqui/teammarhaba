import { test, expect } from "@playwright/test";
import pg from "pg";
import { expectSignedIn } from "../helpers/auth-state.mjs";
import { completeInterestsStep, peekPhoneOtp } from "../helpers/onboarding.mjs";
import { API_BASE_URL, dbConfig } from "../fixtures.mjs";

// TM-930 — the #/onboarding completion gate now makes the mandatory phone a Firebase phone
// VERIFY-AND-LINK step: the user proves ownership via an OTP and the credential is linked to their
// signed-in Firebase account, so one verified number maps to exactly one account. Two regressions:
//
//   (a) HAPPY PATH — a fresh user verifies + links on the gate; the account lands in the app and
//       GET /me phone equals the verified E.164.
//   (b) COLLISION — a number linked to account 1 is entered on account 2; the confirm hard-blocks
//       with the exact copy "This number is already registered — sign into that account." and the
//       gate does NOT lift.
//
// Both FAIL on main before this change (the gate has no Send-code button / OTP boxes, so the
// `#onboarding-phone-send` click never resolves) and PASS after it.
//
// Harness: real backend + Firebase Auth emulator (the same one the SMS sign-in path drives). The
// gate's PhoneAuthProvider.verifyPhoneNumber texts through the emulator; peekPhoneOtp reads the code
// back exactly like tm867-otp-6box.spec.mjs. No real SMS, no secrets.
//
// Suppress the first-run product tour (TM-147) so its modal/backdrop can't overlay the gate controls.
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
async function peekEmailCode(email) {
  const res = await fetch(`${API_BASE_URL}/auth/email-code/peek?email=${encodeURIComponent(email)}`);
  if (!res.ok) throw new Error(`peek failed for ${email}: ${res.status}`);
  return (await res.text()).trim();
}

/** Sign in a brand-new email-code user (a never-seen address ⇒ a fresh, un-onboarded account). */
async function signInFreshUser(page, email) {
  await page.goto("/#/login");
  await expect(page.locator("#auth-signed-out")).toBeVisible();
  await page.fill("#email", email);
  const requested = page.waitForResponse(
    (r) => r.url().includes("/auth/email-code/request") && r.request().method() === "POST",
  );
  await page.click("#emailcode-send-btn");
  await requested;
  // TM-867: filling the first OTP box distributes the code and AUTO-submits (no verify click).
  await page.fill("#emailcode-code", await peekEmailCode(email));
  await expectSignedIn(page);
}

/**
 * A GB mobile number unique to this run: `+4477 009 NNNNN` where NNNNN is the low 5 digits of a
 * timestamp/seed. The Auth emulator is NOT wiped between local re-runs, so a FIXED number would stay
 * linked to a prior run's account and make a fresh "link this number" collide unexpectedly — a unique
 * number per test keeps the OTP session + Firebase link unambiguous. Returns { national, e164 }.
 */
function uniqueGbNumber(seed = Date.now()) {
  const five = String(seed).slice(-5).padStart(5, "0");
  return { national: `7700 9${five}`, e164: `+4477009${five}` };
}

/** Fill the gate profile fields (name/location/age + the national phone), WITHOUT verifying. */
async function fillGateProfile(page, { name, location = "London", age = 30, phone }) {
  await expect(page.locator("#onboarding-form")).toBeVisible();
  // Robust against the async blank prefill (TM-590): re-fill until the values stick.
  await expect(async () => {
    await page.fill("#onboarding-name", name);
    await page.selectOption("#onboarding-location", location);
    await page.fill("#onboarding-age", String(age));
    await page.fill("#onboarding-phone", phone);
    await expect(page.locator("#onboarding-name")).toHaveValue(name);
    await expect(page.locator("#onboarding-phone")).toHaveValue(phone);
  }).toPass({ timeout: 15_000 });
}

test("@tm930 gate happy path: verify + link the phone, land in the app, GET /me phone = the verified E.164", async ({
  page,
}) => {
  const email = `e2e-tm930-happy-${Date.now()}@teammarhaba.test`;
  // A number unique to this run so the emulator OTP session + the Firebase link are unambiguous.
  const { national, e164 } = uniqueGbNumber();

  await signInFreshUser(page, email);

  // GATED: the completion gate intercepts with the phone verify step (Send code button, not a plain
  // free-text submit).
  await expect(page.locator("#onboarding-view")).toBeVisible();
  await expect(page.locator("#onboarding-phone-send")).toBeVisible();

  await fillGateProfile(page, { name: "Verify Happy", phone: national });

  // Send the OTP, peek it from the Auth emulator, fill the first box → the six-box widget auto-submits
  // → confirmPhoneLink links the credential to this account and PATCHes /me { phone }.
  await page.click("#onboarding-phone-send");
  await expect(page.locator("#onboarding-phone-otp-group")).toBeVisible();
  await page.fill("#onboarding-phone-otp", await peekPhoneOtp(e164));

  // Verified state: the "Verified ✓" badge shows and the national input locks (read-only).
  await expect(page.locator("#onboarding-phone-verified")).toBeVisible();
  await expect(page.locator("#onboarding-phone-verified")).toContainText("Verified");
  await expect(page.locator("#onboarding-phone")).toHaveAttribute("readonly", /.*/);

  // The immediate PATCH /me stored the verified E.164 even before the gate submits.
  const client = new pg.Client(dbConfig);
  await client.connect();
  try {
    await expect
      .poll(async () => {
        const { rows } = await client.query("SELECT phone FROM users WHERE lower(email) = lower($1)", [email]);
        return rows[0]?.phone ?? null;
      }, { timeout: 10_000, message: "PATCH /me { phone } should persist the verified E.164" })
      .toBe(e164);
  } finally {
    await client.end();
  }

  // Submit the gate (atomic POST /me/onboarding) → interests → terms → the app.
  const onboarded = page.waitForResponse(
    (r) => r.url().includes("/api/v1/me/onboarding") && r.request().method() === "POST",
  );
  await page.click("#onboarding-form button[type=submit]");
  await onboarded;
  await completeInterestsStep(page);

  // Terms gate (fresh user hasn't accepted) → accept → the app.
  await expect(page.locator("#terms-view")).toBeVisible();
  const accepted = page.waitForResponse(
    (r) => r.url().includes("/api/v1/me/accept-terms") && r.request().method() === "POST",
  );
  await page.click("#terms-accept");
  await accepted;
  await expect(page.locator("#auth-signed-in")).toBeVisible();
  await expect(page.locator("#onboarding-view")).toBeHidden();

  // GET /me phone equals the verified E.164 (the crux assertion). Read via the tmAuth bridge the app
  // exposes for the framework-free page (same handle avatar-upload.spec.mjs uses).
  const me = await page.evaluate(async (base) => {
    const token = await window.tmAuth.getIdToken();
    const res = await fetch(`${base}/api/v1/me`, { headers: { Authorization: `Bearer ${token}` } });
    return res.json();
  }, API_BASE_URL);
  expect(me.phone).toBe(e164);
});

test("@tm930 collision: a number linked to another account HARD-BLOCKS with the exact copy, gate does not lift", async ({
  browser,
}) => {
  // The shared number both accounts try to own — unique to this run (offset the seed so it can't
  // clash with the happy-path test's number when both run in the same emulator session).
  const { national, e164 } = uniqueGbNumber(Date.now() + 1);

  // Two SEPARATE browser contexts (= separate sessions, separate module state) rather than a
  // sign-out between accounts: the onboarding.js verify controller is a page-level singleton, so
  // reusing one page would leak account 1's verified/locked phone state into account 2's gate. Two
  // contexts is also the more faithful "two different accounts" model.

  // ── Account 1 (context A): verify + link the number so it is owned in Firebase. ──
  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();
  const email1 = `e2e-tm930-owner-${Date.now()}@teammarhaba.test`;
  await signInFreshUser(pageA, email1);
  await expect(pageA.locator("#onboarding-phone-send")).toBeVisible();
  await fillGateProfile(pageA, { name: "Owner One", phone: national });
  await pageA.click("#onboarding-phone-send");
  await expect(pageA.locator("#onboarding-phone-otp-group")).toBeVisible();
  await pageA.fill("#onboarding-phone-otp", await peekPhoneOtp(e164));
  await expect(pageA.locator("#onboarding-phone-verified")).toBeVisible();
  await ctxA.close(); // the link persists in Firebase; the session is no longer needed

  // ── Account 2 (context B): sign in fresh, enter the SAME number → the confirm hard-blocks. ──
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  const email2 = `e2e-tm930-collide-${Date.now()}@teammarhaba.test`;
  await signInFreshUser(pageB, email2);
  await expect(pageB.locator("#onboarding-view")).toBeVisible();
  await expect(pageB.locator("#onboarding-phone-send")).toBeVisible();
  await fillGateProfile(pageB, { name: "Collide Two", phone: national });

  await pageB.click("#onboarding-phone-send");
  await expect(pageB.locator("#onboarding-phone-otp-group")).toBeVisible();
  // The emulator texts a valid code for THIS verify session; the confirm then rejects with
  // auth/credential-already-in-use because the number is already linked to account 1.
  await pageB.fill("#onboarding-phone-otp", await peekPhoneOtp(e164));

  // HARD BLOCK: the exact copy paints, the boxes clear, "Verified ✓" never appears, the gate holds.
  await expect(pageB.locator("#onboarding-phone-error")).toContainText(
    "This number is already registered — sign into that account.",
  );
  await expect(pageB.locator("#onboarding-phone-verified")).toBeHidden();
  await expect(pageB.locator("#onboarding-view")).toBeVisible();

  // The gate cannot be submitted — an unverified phone paints the verify prompt and stays gated.
  await pageB.click("#onboarding-form button[type=submit]");
  await expect(pageB.locator("#onboarding-view")).toBeVisible();
  await expect(pageB.locator("#auth-signed-in")).toBeHidden();
  await ctxB.close();
});
