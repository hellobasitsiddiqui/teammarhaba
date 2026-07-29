// TM-1149 — before/after visual evidence for the SMS invalid-phone error (390px phone width).
//
// The bug (iPhone Safari, sign-in screen → "Try another way" → "Text me a code (SMS)"): entering a
// malformed number (+44747009007 — a valid +44 prefix but a digit short) triggers Firebase
// `auth/invalid-phone-number`, and TWO things go wrong:
//   • Bug 1 (copy): the message says "…include the country code (e.g. +1…)" — but the user DID
//     include a country code (+44); the real fault is the digit count. Wrong fix, wrong example.
//   • Bug 2 (placement): the error rendered UP in the shared #auth-error banner in the EMAIL
//     section, while the phone field that caused it is DOWN in the SMS section.
//
// Reaching a REAL Firebase auth/invalid-phone-number needs the live SDK + reCAPTCHA + provider; in
// this static harness we instead FORCE-RENDER the exact error path login.js takes — resolving the
// copy through the served login-error.js and writing it to the surface login.js targets — so the
// shots faithfully show each side's real behaviour:
//   • BEFORE (main's web/src): resolve authErrorMessage({code}) with NO context (the old fixed copy)
//     and write it to the shared #auth-error banner (where main's login.js routes it).
//   • AFTER  (branch web/src): resolve authErrorMessage({code}, phoneContext) with hasCountryCode
//     from the +44 value, and write it to the inline #sms-error next to the phone field.
//
// Serve each side on :8081 IN TURN (serve.mjs — the only origin dev CORS allows), never in parallel.
//
// Usage:
//   CAPTURE_LABEL=before CAPTURE_OUT=/abs/dir node capture-tm1149.mjs   # serving main's web/src
//   CAPTURE_LABEL=after  CAPTURE_OUT=/abs/dir node capture-tm1149.mjs   # serving the branch web/src

import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm1149");
const BASE = process.env.CAPTURE_BASE || "http://127.0.0.1:8081";
const LABEL = process.env.CAPTURE_LABEL || "after"; // "before" (main src) | "after" (branch src)

const BOOT_SPLASH_SETTLE_MS = 4000; // the boot splash holds ~3.2s — settle ≥4s before capturing
const BAD_NUMBER = "+44747009007"; // the exact reported input: +44 prefix, one digit short

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch();
  // 390×844 = the Android-phone viewport the ticket asks for (matches the TM-933/880 capture width).
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();

  // Suppress the first-run tour so no modal overlays the login card (same init as the specs).
  await page.addInitScript(() => {
    const orig = Storage.prototype.getItem;
    Storage.prototype.getItem = function (k) {
      return typeof k === "string" && k.startsWith("tm.tour.")
        ? JSON.stringify({ done: true })
        : orig.call(this, k);
    };
  });

  await page.goto(`${BASE}/#/login`);
  await page.waitForTimeout(BOOT_SPLASH_SETTLE_MS);
  await page.locator("#auth-signed-out").waitFor({ state: "visible" });

  // Open "Try another way" to reveal the SMS fieldset, then type the malformed number.
  await page.click("#try-another-btn");
  await page.locator("#sms-step-phone").waitFor({ state: "visible" });
  await page.fill("#phone", BAD_NUMBER);
  await page.waitForTimeout(300);

  // Force-render the invalid-phone error EXACTLY as this side's login.js would, resolving the copy
  // through the served login-error.js (so the shot reflects real code, not a hand-typed string).
  await page.evaluate(async (label) => {
    const mod = await import("/assets/login-error.js");
    const err = { code: "auth/invalid-phone-number", message: "Firebase: Error (auth/invalid-phone-number)." };
    const phone = document.getElementById("phone")?.value ?? "";

    const sharedBanner = document.getElementById("auth-error");
    const smsError = document.getElementById("sms-error"); // only exists on the AFTER (branch) side

    if (label === "after" && smsError && typeof mod.hasCountryCode === "function") {
      // Branch behaviour: context-aware copy in the inline SMS surface next to the phone field.
      const msg = mod.authErrorMessage(err, { hasCountryCode: mod.hasCountryCode(phone) });
      smsError.textContent = msg;
      smsError.hidden = false;
      if (sharedBanner) sharedBanner.hidden = true;
    } else {
      // main behaviour: the old fixed copy (no context arg) in the shared top banner.
      const msg = mod.authErrorMessage(err);
      if (sharedBanner) {
        sharedBanner.textContent = msg;
        sharedBanner.hidden = false;
      }
    }
  }, LABEL);
  await page.waitForTimeout(300);

  // Full front-door card (shows WHERE the error lands relative to the phone field) …
  await page.screenshot({ path: join(OUT, `TM-1149-${LABEL}.png`) });
  // … and a tight shot of the SMS fieldset (the region the error should live in).
  await page
    .locator(".auth-alt", { has: page.locator("#sms-step-phone") })
    .screenshot({ path: join(OUT, `TM-1149-${LABEL}-sms-fieldset.png`) });

  console.log(`[capture ${LABEL}] wrote TM-1149 shots to ${OUT}`);
  await browser.close();
}

main().catch((err) => {
  console.error("capture error:", err);
  process.exit(1);
});
