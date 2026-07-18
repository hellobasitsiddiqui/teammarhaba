import { test, expect } from "@playwright/test";

// Resend-code cooldown with a visible countdown (TM-866) — after a send the backend accepted,
// the send/resend button is held for 30s with a ticking "Resend in 0:29" label, then restored.
//
// Same harness as tm867-otp-6box.spec.mjs: real backend + Firebase Auth emulator — no real
// email/SMS, no secrets. (No code is ever VERIFIED here, so the peek endpoint isn't needed:
// these tests live entirely on the send/resend side of the flow.)
//
// Time is driven with Playwright's clock API (page.clock, available since 1.45 — the repo pins
// 1.49.1), so NO test ever sleeps out the 30s window for real. clock.install() keeps ticking in
// real time (the login flow works normally); fastForward() jumps the page's Date/timers ahead.
// Crucially fastForward fires a due interval only ONCE — which the deadline-based core is built
// for: the single late tick still computes the correct remaining time / crosses the expiry.
// The BACKEND's clock is untouched by page.clock — its own 60s per-address send cooldown keeps
// running in real time, which one test below exploits deliberately.
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

/** Walk to the email-code step for a fresh address (the accepted send that starts the cooldown). */
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
}

/** Parse the seconds out of a "Resend in m:ss" label (throws on any other shape). */
async function labelSeconds(button) {
  const text = (await button.textContent()).trim();
  const match = /^Resend in (\d+):(\d\d)$/.exec(text);
  if (!match) throw new Error(`not a countdown label: "${text}"`);
  return Number(match[1]) * 60 + Number(match[2]);
}

test("@auth the code step reveals a held Resend with a ticking countdown; expiry restores it; a failed resend does not restart it", async ({ page }) => {
  await page.clock.install(); // before goto, so the page's Date/interval are controllable
  const email = `e2e-cooldown-${Date.now()}@teammarhaba.test`;
  await reachCodeStep(page, email);

  // Held from the moment the step appears: disabled, with the countdown label in place of "Resend".
  const resend = page.locator("#emailcode-resend-btn");
  await expect(resend).toBeDisabled();
  await expect(resend).toHaveText(/^Resend in \d:\d\d$/);
  const before = await labelSeconds(resend);

  // It genuinely TICKS: jump 5s and the label re-derives from the clock (deadline-based, so the
  // single catch-up interval fire lands on the right number — a decrementing counter would not).
  await page.clock.fastForward(5_000);
  await expect(resend).toHaveText(/^Resend in \d:\d\d$/);
  expect(await labelSeconds(resend)).toBeLessThanOrEqual(before - 5);

  // A click during the window must NOT fire a code request. A real user can't click a disabled
  // button at all — dispatchEvent bypasses the disabled attribute, so this exercises the
  // handler-level isActive() guard (the belt-and-braces for programmatic/synthetic clicks).
  let requests = 0;
  page.on("request", (r) => {
    if (r.url().includes("/auth/email-code/request") && r.method() === "POST") requests++;
  });
  await resend.dispatchEvent("click");
  await page.waitForTimeout(300); // real-time settle — page.clock does not affect test-side waits
  expect(requests).toBe(0);

  // Past the 30s window: the original label + enabled state come back, and the polite live region
  // (not the assertive error banner) announces the re-enable.
  await page.clock.fastForward(31_000);
  await expect(resend).toBeEnabled();
  await expect(resend).toHaveText("Resend");
  await expect(page.locator("#auth-status")).toHaveText("You can request a new code now.");

  // A REAL click now fires exactly one request. Only the BROWSER's clock jumped — the backend's
  // 60s per-address cooldown is still running in real time, so this send comes back 429. That is
  // deliberate: it pins the "failed send" contract — the error surfaces as today, and the
  // client cooldown does NOT restart (the button stays immediately usable for a retry).
  const resent = page.waitForResponse(
    (r) => r.url().includes("/auth/email-code/request") && r.request().method() === "POST",
  );
  await resend.click();
  expect((await resent).status()).toBe(429);
  expect(requests).toBe(1);
  await expect(page.locator("#auth-error")).toBeVisible();
  await expect(resend).toBeEnabled();
  await expect(resend).toHaveText("Resend");
});

test("@auth leaving the code step resets the cooldown, and a fresh send opens a fresh full window", async ({ page }) => {
  // No clock needed here — nothing waits out a window; this pins the step-leave reset semantics
  // (TM-866 decision: back = reset; the SERVER cooldown still guards a same-address repeat).
  const first = `e2e-cooldown-back-${Date.now()}@teammarhaba.test`;
  await reachCodeStep(page, first);
  const resend = page.locator("#emailcode-resend-btn");
  await expect(resend).toBeDisabled();

  // "Use a different email" leaves the step: the cooldown resets SILENTLY — original label and
  // enabled state restored (the button hides with its step; state assertions still see it), and
  // no "you can request a new code now" announcement for a mere navigation.
  await page.click("#emailcode-back-btn");
  await expect(page.locator("#emailcode-step-email")).toBeVisible();
  await expect(resend).toBeEnabled();
  await expect(resend).toHaveText("Resend");

  // A fresh send — to a NEW address, so the backend's per-address cooldown can't 429 it — starts
  // a brand-new FULL window, proving restart-after-reset (the core's start-from-inactive path).
  const second = `e2e-cooldown-back2-${Date.now()}@teammarhaba.test`;
  await page.fill("#email", second);
  const requested = page.waitForResponse(
    (r) => r.url().includes("/auth/email-code/request") && r.request().method() === "POST",
  );
  await page.click("#emailcode-send-btn");
  await requested;
  await expect(page.locator("#emailcode-step-code")).toBeVisible();
  await expect(resend).toBeDisabled();
  await expect(resend).toHaveText(/^Resend in 0:(2\d|30)$/); // full-ish window, not a leftover
});

test("@auth SMS: a successful send holds 'Text me a code' with the countdown; expiry restores it", async ({ page }) => {
  await page.clock.install();
  await page.goto("/#/login");
  await expect(page.locator("#auth-signed-out")).toBeVisible();
  await page.click("#try-another-btn");

  const send = page.locator("#sms-send-btn");
  await expect(send).toHaveText("Text me a code");

  // A number unique to this spec (emulator accepts any) so other SMS specs can't interfere.
  await page.fill("#phone", "+16505550188");
  await send.click();
  await expect(page.locator("#sms-step-code")).toBeVisible();

  // The send button hides with its phone step, but its STATE is pinned held + counting — any
  // path that re-reveals the phone step inside the window must find it disabled, and the
  // 30s-later restore below is what a re-revealed step would show after expiry.
  await expect(send).toBeDisabled();
  await expect(send).toHaveText(/^Resend in \d:\d\d$/);
  await expect(page.locator("#auth-status")).toHaveText("You can request a new code in 30 seconds.");

  await page.clock.fastForward(31_000);
  await expect(send).toBeEnabled();
  await expect(send).toHaveText("Text me a code"); // the SMS button's ORIGINAL label, not "Resend"
  await expect(page.locator("#auth-status")).toHaveText("You can request a new code now.");
});
