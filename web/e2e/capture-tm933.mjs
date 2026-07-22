// TM-933 — before/after visual evidence for the SMS-step login copy (390px phone width).
//
// The change is a single line of static helper copy on the signed-OUT login card's SMS step
// (index.html #sms-signin-hint, styled .auth-hint): "Sign in with the mobile number on your
// account." — post-TM-930 framing that SMS signs you into YOUR account. No account / login needed:
// the SMS step lives behind the "Try another way" disclosure on the front door, so the shot just
// opens that disclosure and captures the SMS fieldset.
//
//   • BEFORE (main's web/src): the SMS step with NO helper line above the phone field.
//   • AFTER  (branch web/src): the same step with the #sms-signin-hint line present.
//
// Serve each side on :8081 IN TURN (serve.mjs, the only origin dev CORS allows) — never in parallel.
// Run once serving main's web/src (label=before) and once from the branch (label=after).
//
// Usage:
//   CAPTURE_LABEL=after CAPTURE_BASE=http://127.0.0.1:8081 CAPTURE_OUT=/abs/dir node capture-tm933.mjs

import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm933");
const BASE = process.env.CAPTURE_BASE || "http://127.0.0.1:8081";
const LABEL = process.env.CAPTURE_LABEL || "after"; // "before" (main src) | "after" (branch src)

const BOOT_SPLASH_SETTLE_MS = 4000; // the boot splash holds ~3.2s — settle ≥4s before capturing

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch();
  // 390×844 = the Android-phone viewport the ticket asks for (matches the TM-880/885 capture width).
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

  // Open the "Try another way" disclosure to reveal the SMS fieldset.
  await page.click("#try-another-btn");
  await page.locator("#sms-step-phone").waitFor({ state: "visible" });
  await page.waitForTimeout(400); // let the disclosure settle

  // Full front-door card (shows the SMS step in context) …
  await page.screenshot({ path: join(OUT, `TM-933-${LABEL}-login-sms-step.png`) });
  // … and a tight shot of just the SMS fieldset (the changed region). There are two .auth-alt
  // fieldsets (SMS + email/password) — target the one that CONTAINS the SMS phone step.
  await page
    .locator(".auth-alt", { has: page.locator("#sms-step-phone") })
    .screenshot({ path: join(OUT, `TM-933-${LABEL}-sms-fieldset.png`) });

  console.log(`[capture ${LABEL}] wrote SMS-step shots to ${OUT}`);
  await browser.close();
}

main().catch((err) => {
  console.error("capture error:", err);
  process.exit(1);
});
