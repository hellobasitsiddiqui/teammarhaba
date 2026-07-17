import { test, expect } from "@playwright/test";
import { API_BASE_URL } from "../fixtures.mjs";

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
  await expect(page.locator("#signout-btn")).toBeVisible();
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
  await expect(page.locator("#signout-btn")).toBeVisible();
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
  await expect(page.locator("#signout-btn")).toBeHidden();
});
