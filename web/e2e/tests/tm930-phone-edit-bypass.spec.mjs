import { test, expect } from "@playwright/test";
import pg from "pg";
import { expectSignedIn } from "../helpers/auth-state.mjs";
import { peekPhoneOtp } from "../helpers/onboarding.mjs";
import { API_BASE_URL, dbConfig } from "../fixtures.mjs";

// TM-930 review fixes — two regressions in the gate phone VERIFY-AND-LINK step (onboarding.js):
//
//   (1) EDIT-AFTER-SEND BYPASS (blocker): editing the national number AFTER "Send code" but BEFORE
//       entering the OTP used to let an UNVERIFIED number pass the gate — confirmPhoneOtp re-derived
//       the E.164 fresh from the (now-edited) input and marked THAT number verified, while the OTP
//       actually linked the ORIGINAL number. The fix records the exact E.164 the verificationId was
//       issued for (pendingE164) and (a) drops the in-flight code the moment the input/picker changes,
//       (b) refuses to mark a drifted number verified. So an edit -> the OTP boxes vanish and the number
//       is NOT verified; the DB never gets the edited number.
//
//   (2) NO WAY TO CHANGE A VERIFIED NUMBER (major): once verified the input is readOnly, the picker
//       disabled, and Send hidden — with no affordance to correct a wrong-but-owned number. The fix
//       adds a "Change number" button (only shown when verified) that returns the field to editable.
//
// Both FAIL on the pre-fix code and PASS after. Harness = real backend + Firebase Auth emulator, same
// as tm930-gate-phone-verify-link.spec.mjs.

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

async function peekEmailCode(email) {
  const res = await fetch(`${API_BASE_URL}/auth/email-code/peek?email=${encodeURIComponent(email)}`);
  if (!res.ok) throw new Error(`peek failed for ${email}: ${res.status}`);
  return (await res.text()).trim();
}

async function signInFreshUser(page, email) {
  await page.goto("/#/login");
  await expect(page.locator("#auth-signed-out")).toBeVisible();
  await page.fill("#email", email);
  const requested = page.waitForResponse(
    (r) => r.url().includes("/auth/email-code/request") && r.request().method() === "POST",
  );
  await page.click("#emailcode-send-btn");
  await requested;
  await page.fill("#emailcode-code", await peekEmailCode(email));
  await expectSignedIn(page);
}

function uniqueGbNumber(seed = Date.now()) {
  const five = String(seed).slice(-5).padStart(5, "0");
  return { national: `7700 9${five}`, e164: `+4477009${five}` };
}

async function fillGateProfile(page, { name, location = "London", age = 30, phone }) {
  await expect(page.locator("#onboarding-form")).toBeVisible();
  await expect(async () => {
    await page.fill("#onboarding-name", name);
    await page.selectOption("#onboarding-location", location);
    await page.fill("#onboarding-age", String(age));
    await page.fill("#onboarding-phone", phone);
    await expect(page.locator("#onboarding-name")).toHaveValue(name);
    await expect(page.locator("#onboarding-phone")).toHaveValue(phone);
  }).toPass({ timeout: 15_000 });
}

test("@tm930 editing the number after Send code drops the in-flight code — the edited number is NOT verified and the gate holds", async ({
  page,
}) => {
  const email = `e2e-tm930-editbypass-${Date.now()}@teammarhaba.test`;
  const orig = uniqueGbNumber(Date.now());
  const edited = uniqueGbNumber(Date.now() + 7);

  await signInFreshUser(page, email);
  await expect(page.locator("#onboarding-view")).toBeVisible();
  await expect(page.locator("#onboarding-phone-send")).toBeVisible();

  // Enter the ORIGINAL number and send the code — the verificationId is issued for `orig`.
  await fillGateProfile(page, { name: "Edit Bypass", phone: orig.national });
  await page.click("#onboarding-phone-send");
  await expect(page.locator("#onboarding-phone-otp-group")).toBeVisible();

  // Now EDIT the national number to a DIFFERENT one before entering any OTP. The fix drops the stale
  // in-flight code immediately: the OTP boxes hide and the field returns to unverified.
  await page.fill("#onboarding-phone", edited.national);
  await expect(page.locator("#onboarding-phone-otp-group")).toBeHidden();
  await expect(page.locator("#onboarding-phone-verified")).toBeHidden();
  // Send is back (unverified), so nothing is verified.
  await expect(page.locator("#onboarding-phone-send")).toBeVisible();

  // The gate cannot be submitted — the phone is unverified — so the user stays on the gate.
  await page.click("#onboarding-form button[type=submit]");
  await expect(page.locator("#onboarding-view")).toBeVisible();
  await expect(page.locator("#auth-signed-in")).toBeHidden();

  // Crucially: the EDITED number was never PATCHed to /me (the pre-fix bug wrote it as "verified").
  const client = new pg.Client(dbConfig);
  await client.connect();
  try {
    const { rows } = await client.query("SELECT phone FROM users WHERE lower(email) = lower($1)", [email]);
    const stored = rows[0]?.phone ?? null;
    expect(stored).not.toBe(edited.e164);
    expect(stored).not.toBe(orig.e164);
  } finally {
    await client.end();
  }
});

test("@tm930 a verified number can be changed: the Change-number button re-opens the field for editing", async ({
  page,
}) => {
  const email = `e2e-tm930-change-${Date.now()}@teammarhaba.test`;
  const { national, e164 } = uniqueGbNumber(Date.now() + 3);

  await signInFreshUser(page, email);
  await expect(page.locator("#onboarding-phone-send")).toBeVisible();
  await fillGateProfile(page, { name: "Change Number", phone: national });

  // Verify the number → the field locks (readOnly), Send hides, "Verified ✓" shows.
  await page.click("#onboarding-phone-send");
  await expect(page.locator("#onboarding-phone-otp-group")).toBeVisible();
  await page.fill("#onboarding-phone-otp", await peekPhoneOtp(e164));
  await expect(page.locator("#onboarding-phone-verified")).toBeVisible();
  await expect(page.locator("#onboarding-phone")).toHaveAttribute("readonly", /.*/);

  // The "Change number" affordance is now shown — the ONLY exit from the locked state.
  const changeBtn = page.locator("#onboarding-phone-change");
  await expect(changeBtn).toBeVisible();
  await changeBtn.click();

  // The field is editable again: readOnly cleared, Send back, "Verified ✓" and the Change button gone.
  await expect(page.locator("#onboarding-phone")).not.toHaveAttribute("readonly", /.*/);
  await expect(page.locator("#onboarding-phone-send")).toBeVisible();
  await expect(page.locator("#onboarding-phone-verified")).toBeHidden();
  await expect(changeBtn).toBeHidden();

  // And it really is editable — a new value sticks.
  await page.fill("#onboarding-phone", "7700 912345");
  await expect(page.locator("#onboarding-phone")).toHaveValue("7700 912345");
});
