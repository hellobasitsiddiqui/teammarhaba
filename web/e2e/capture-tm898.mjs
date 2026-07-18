// TM-898 — before/after visual evidence capture for the onboarding-gate location field:
// free-text input BEFORE → the TM-877 allowed-cities dropdown AFTER (the same select the profile
// edit form uses), plus an AFTER shot with a list city picked.
//
// FULL-STACK mode (the capture-tm877-880-884 pattern): drives the REAL email-code login for a
// brand-new user against the running e2e stack — Postgres + Auth emulator + backend + a serve.mjs
// instance on :8081 (the only origin dev CORS allows) — because a fresh account is what the
// completion gate intercepts. Run it once serving main's web/src (label=before) and once from the
// branch (label=after); the same branch backend serves both since the before shot is render-only
// (nothing is submitted).
//
// Captured at an Android-phone viewport (390×844). The boot splash holds ~3.2s, so every page load
// settles ≥4s before a shot.
//
// Usage:
//   CAPTURE_LABEL=after CAPTURE_BASE=http://127.0.0.1:8081 CAPTURE_OUT=/abs/dir \
//     node capture-tm898.mjs

import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { API_BASE_URL } from "./fixtures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm898");
const BASE = process.env.CAPTURE_BASE || "http://127.0.0.1:8081";
const LABEL = process.env.CAPTURE_LABEL || "after"; // "before" (main) | "after" (branch)

const BOOT_SPLASH_SETTLE_MS = 4000; // the boot splash holds ~3.2s — settle ≥4s before capturing

const shotPath = (screen) => join(OUT, `TM-898-${LABEL}-${screen}.png`);

/** Read the last code the backend "emailed" to an address (emulator-only peek endpoint). */
async function peekCode(email) {
  const res = await fetch(`${API_BASE_URL}/auth/email-code/peek?email=${encodeURIComponent(email)}`);
  if (!res.ok) throw new Error(`peek failed for ${email}: ${res.status}`);
  return (await res.text()).trim();
}

/** Sign in a brand-new email-code user (⇒ un-onboarded, so the profile gate intercepts). */
async function signInFreshUser(page, email) {
  await page.goto(`${BASE}/#/login`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(BOOT_SPLASH_SETTLE_MS);
  await page.fill("#email", email);
  await page.click("#emailcode-send-btn");
  await page.waitForResponse((r) => r.url().includes("/auth/email-code/request"));
  // Filling the full code auto-submits (TM-867 six-box OTP) — no verify click, same as the specs.
  await page.fill("#emailcode-code", await peekCode(email));
  await page.waitForSelector("#onboarding-form", { state: "visible", timeout: 20_000 });
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
await mkdir(OUT, { recursive: true });

await signInFreshUser(page, `capture-tm898-${LABEL}-${Date.now()}@teammarhaba.test`);
await page.waitForTimeout(2000); // let the gate's async mount prefill (TM-590) settle first

// The gate as first painted — BEFORE: Location is a free-text input; AFTER: the allowed-cities
// dropdown showing its blank "Choose a city…" affordance.
await page.locator("#onboarding-location").scrollIntoViewIfNeeded();
await page.screenshot({ path: shotPath("gate-location"), fullPage: true });

// A concrete location value in place — BEFORE: any free text ("Bristol", an off-list city the
// profile form refuses) types straight in; AFTER: a TM-877 list city is PICKED (free text is
// impossible — "Bristol" isn't on offer).
if (LABEL === "before") {
  await page.fill("#onboarding-location", "Bristol");
} else {
  await page.selectOption("#onboarding-location", "Milton Keynes");
}
await page.waitForTimeout(300);
await page.screenshot({ path: shotPath("gate-location-value") });

await browser.close();
console.log(`[capture] ${LABEL} shots written to ${OUT}`);
