import { test, expect } from "@playwright/test";
import { expectSignedIn, expectSignedOut } from "../helpers/auth-state.mjs";
import { API_BASE_URL, AUTH_EMULATOR_HOST, PROJECT_ID } from "../fixtures.mjs";

// Six-box OTP input with auto-submit (TM-867) — the email-code verify step now renders six
// single-digit boxes (#emailcode-code … #emailcode-code-6) instead of one input, and typing the
// 6th digit / pasting a full code submits WITHOUT touching the visible "Sign in" button.
//
// Same harness as email-code-login.spec.mjs: real backend + Firebase Auth emulator, the
// emulator-only peek endpoint hands the test the emailed code — no real email, no secrets.
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

/** Walk to the code step for a fresh address and return the issued 6-digit code. */
async function reachCodeStep(page, email) {
  await page.goto("/#/login");
  await expect(page.locator("#auth-signed-out")).toBeVisible();
  await page.fill("#email", email);
  const requested = page.waitForResponse(
    (r) => r.url().includes("/auth/email-code/request") && r.request().method() === "POST",
  );
  await page.click("#emailcode-send-btn");
  await requested;
  await expect(page.locator("#emailcode-step-code")).toBeVisible();
  const code = await peekCode(email);
  expect(code).toMatch(/^\d{6}$/);
  return code;
}

/** The nth (1-based) email-code box — box 1 keeps the legacy id, the rest are suffixed. */
const box = (page, n) => page.locator(n === 1 ? "#emailcode-code" : `#emailcode-code-${n}`);

test("@auth typing the 6th digit auto-submits — no verify click — and signs the user in", async ({ page }) => {
  const email = `e2e-otp-type-${Date.now()}@teammarhaba.test`;
  const code = await reachCodeStep(page, email);

  // The step reveals six boxes with the first focused, ready for the code.
  await expect(page.locator("#emailcode-otp input")).toHaveCount(6);
  await expect(box(page, 1)).toBeFocused();

  // Type the code digit-by-digit at the KEYBOARD (pressSequentially sends real key events to
  // whatever is focused, so each keystroke exercises the auto-advance into the next box).
  await box(page, 1).pressSequentially(code, { delay: 40 });

  // The crux: NO #emailcode-verify-btn click — the 6th digit fired the verify itself.
  await expectSignedIn(page);
  await expect(page.locator("#auth-signed-out")).toBeHidden();
});

test("@auth pasting a space-formatted code into a MIDDLE box fills every box and auto-submits", async ({ page }) => {
  const email = `e2e-otp-paste-${Date.now()}@teammarhaba.test`;
  const code = await reachCodeStep(page, email);

  // Paste "123 456"-style text into box 3 — the widget must strip the spaces and distribute one
  // digit per box FROM BOX 1 (a full code pasted anywhere replaces the whole thing). A synthetic
  // ClipboardEvent (not keyboard Ctrl+V) so the test owns the clipboard payload cross-platform.
  const formatted = `${code.slice(0, 3)} ${code.slice(3)}`;
  await box(page, 3).click();
  await box(page, 3).evaluate((el, text) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, formatted);

  // Auto-submitted straight from the paste: signed in without any verify click.
  await expectSignedIn(page);
  await expect(page.locator("#auth-signed-out")).toBeHidden();

  // And the paste genuinely DISTRIBUTED (not just submitted): each box holds its own digit.
  // The signed-out panel is hidden, not destroyed, so the values are still assertable.
  for (let n = 1; n <= 6; n++) {
    await expect(box(page, n)).toHaveValue(code[n - 1]);
  }
});

test("@auth backspace walks back through the boxes and non-digits are rejected", async ({ page }) => {
  const email = `e2e-otp-back-${Date.now()}@teammarhaba.test`;
  await reachCodeStep(page, email); // real step, but this test never submits

  // Type three digits: boxes 1-3 fill, focus lands on box 4.
  await box(page, 1).pressSequentially("123", { delay: 40 });
  await expect(box(page, 3)).toHaveValue("3");
  await expect(box(page, 4)).toBeFocused();

  // Backspace on the EMPTY box 4 clears box 3 and moves focus onto it…
  await page.keyboard.press("Backspace");
  await expect(box(page, 3)).toHaveValue("");
  await expect(box(page, 3)).toBeFocused();

  // …and again: box 3 is now empty, so the next Backspace clears box 2 and steps onto it.
  await page.keyboard.press("Backspace");
  await expect(box(page, 2)).toHaveValue("");
  await expect(box(page, 2)).toBeFocused();
  await expect(box(page, 1)).toHaveValue("1"); // box 1 untouched

  // Arrow keys navigate without editing.
  await page.keyboard.press("ArrowLeft");
  await expect(box(page, 1)).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(box(page, 2)).toBeFocused();

  // Non-digit input is rejected: the focused box stays empty.
  await page.keyboard.type("x");
  await expect(box(page, 2)).toHaveValue("");

  // Nothing auto-submitted along the way — still on the code step, still signed out.
  await expect(page.locator("#emailcode-step-code")).toBeVisible();
  await expectSignedOut(page);
});

test("@auth a failed auto-submit re-focuses box 1 so the code can be retyped straight away", async ({ page }) => {
  // Review fix (TM-867): the verify disables every box (setBusy), which drops focus to <body>;
  // on FAILURE run() must hand focus back to the widget or keyboard/AT users re-navigate from
  // the top of the page to correct the code.
  const email = `e2e-otp-refocus-${Date.now()}@teammarhaba.test`;
  const code = await reachCodeStep(page, email);

  // A deterministically WRONG code: the real one with its last digit flipped.
  const wrong = code.slice(0, 5) + String((Number(code[5]) + 1) % 10);
  await box(page, 1).pressSequentially(wrong, { delay: 40 });

  // The auto-submitted verify fails: error banner up, still signed out, and — the fix — focus is
  // back on the first box rather than lost to the document body.
  await expect(page.locator("#auth-error")).toBeVisible();
  await expectSignedOut(page);
  await expect(box(page, 1)).toBeFocused();

  // Standard OTP recovery: the rejected code is CLEARED, ready for a fresh entry. (Load-bearing:
  // were the stale code kept, the first retyped digit would leave all six boxes filled and
  // auto-submit a mixed old/new code — exactly what the first branch e2e run caught.)
  await expect(box(page, 1)).toHaveValue("");
  await expect(box(page, 6)).toHaveValue("");

  // The recovery is immediate: retyping the CORRECT code from the restored focus signs in.
  await box(page, 1).pressSequentially(code, { delay: 40 });
  await expectSignedIn(page);
  await expect(page.locator("#auth-signed-out")).toBeHidden();
});

test("@auth SMS: the texted code auto-submits from the six boxes — sign-in with NO verify click", async ({ page }) => {
  // Review fix (TM-867): SMS auto-submit previously had no failing signal anywhere — the Maestro
  // flow's verify tap is optional (it silently masks a regression) and the web SMS smoke stopped
  // before code entry. This completes SMS sign-in in the browser exactly like the email test:
  // fill the first box, never touch #sms-verify-btn.
  await page.goto("/#/login");
  await expect(page.locator("#auth-signed-out")).toBeVisible();
  await page.click("#try-another-btn");

  // A number unique to this spec so the emulator session lookup below is unambiguous.
  const phone = "+16505550142";
  await page.fill("#phone", phone);
  await page.click("#sms-send-btn");
  await expect(page.locator("#sms-step-code")).toBeVisible();

  // The step reveal focuses the first SMS box (same deferred-focus contract as the email step).
  await expect(page.locator("#sms-code")).toBeFocused();

  // Fetch the code the Auth emulator "texted" — the SMS twin of the email peek endpoint.
  const res = await fetch(
    `http://${AUTH_EMULATOR_HOST}/emulator/v1/projects/${PROJECT_ID}/verificationCodes`,
  );
  if (!res.ok) throw new Error(`verificationCodes lookup failed: ${res.status}`);
  const { verificationCodes = [] } = await res.json();
  const session = verificationCodes.filter((v) => v.phoneNumber === phone).at(-1);
  expect(session?.code).toMatch(/^\d{6}$/);

  // The crux: filling box 1 fans the code out and AUTO-submits — no #sms-verify-btn click. If the
  // SMS auto-submit wiring regresses, this stays signed out and fails loudly.
  await page.fill("#sms-code", session.code);
  await expectSignedIn(page);
  await expect(page.locator("#auth-signed-out")).toBeHidden();
});
