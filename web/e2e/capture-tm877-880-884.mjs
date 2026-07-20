// TM-877 / TM-880 / TM-884 — before/after visual evidence capture for the profile edit-field batch:
//   • TM-877 — the city field (free-text BEFORE → allowed-list dropdown AFTER).
//   • TM-880 — the first-use completion gate (no phone field BEFORE → mandatory phone pair AFTER,
//              plus the AFTER-only "Phone is required." blocked-submit state).
//   • TM-884 — the age field (13–120 hint, 17 accepted BEFORE → 18–99 hint, 17 rejected AFTER).
//
// FULL-STACK mode (unlike the mock-mode capture-tm771/tm781 siblings): it drives the REAL login +
// gate flows against the running e2e stack — Postgres + Auth emulator + backend + a serve.mjs
// instance — using the global-setup-seeded ADMIN for the profile shots and a fresh email-code user
// for the gate shots (a brand-new account is what the completion gate intercepts). Run it once from
// `main` (label=before, serving main's web/src) and once from the branch (label=after); the same
// branch backend serves both since the before shots are render-only (nothing is submitted).
//
// Captured at an Android-phone viewport (390×844). The boot splash holds ~3.2s, so every page load
// settles ≥4s before a shot.
//
// Usage:
//   CAPTURE_LABEL=after CAPTURE_BASE=http://127.0.0.1:8081 CAPTURE_OUT=/abs/dir \
//     node capture-tm877-880-884.mjs

import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ADMIN, API_BASE_URL } from "./fixtures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm877-880-884");
const BASE = process.env.CAPTURE_BASE || "http://127.0.0.1:8081";
const LABEL = process.env.CAPTURE_LABEL || "after"; // "before" (main) | "after" (branch)

const BOOT_SPLASH_SETTLE_MS = 4000; // the boot splash holds ~3.2s — settle ≥4s before capturing

const shotPath = (ticket, screen) => join(OUT, `${ticket}-${LABEL}-${screen}.png`);

/** Load a hash route and let the boot splash + fonts settle before anything is captured. */
async function settleGoto(page, hash) {
  await page.goto(`${BASE}/${hash}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(BOOT_SPLASH_SETTLE_MS);
}

/** Sign the seeded ADMIN in via the email+password "Try another way" path (same as the specs). */
async function signInAdmin(page) {
  await settleGoto(page, "#/login");
  await page.fill("#email", ADMIN.email);
  await page.click("#try-another-btn");
  await page.fill("#password", ADMIN.password);
  await page.click("#signin-btn");
  // At the 390px phone width the sign-out control sits behind the hamburger nav, so wait for the
  // signed-in HOME shell instead (the router lands a returning user there).
  await page.waitForSelector("#auth-signed-in", { state: "visible", timeout: 20_000 });
}

/** Read the last code the backend "emailed" to an address (emulator-only peek endpoint). */
async function peekCode(email) {
  const res = await fetch(`${API_BASE_URL}/auth/email-code/peek?email=${encodeURIComponent(email)}`);
  if (!res.ok) throw new Error(`peek failed for ${email}: ${res.status}`);
  return (await res.text()).trim();
}

/** Sign in a brand-new email-code user (⇒ phone-less, so the completion gate intercepts). */
async function signInFreshUser(page, email) {
  await settleGoto(page, "#/login");
  await page.fill("#email", email);
  await page.click("#emailcode-send-btn");
  await page.waitForResponse((r) => r.url().includes("/auth/email-code/request"));
  // Filling the full code auto-submits (TM-867 six-box OTP) — no verify click, same as the specs.
  await page.fill("#emailcode-code", await peekCode(email));
  // A brand-new user is routed straight to the completion gate (the gate is the visible signal).
  await page.waitForSelector("#onboarding-view", { state: "visible", timeout: 20_000 });
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
await mkdir(OUT, { recursive: true });

// ── Profile shots (TM-877 city + TM-884 age) — as the seeded, phone-carrying ADMIN. ─────────────
await signInAdmin(page);
await settleGoto(page, "#/profile");
await page.waitForSelector("#profile-form", { state: "visible", timeout: 20_000 });
await page.waitForTimeout(1000); // let the mount GET /me populate the form

// TM-877 — the city field (text input before, dropdown after).
await page.locator("#profile-city").scrollIntoViewIfNeeded();
await page.screenshot({ path: shotPath("TM-877", "city-field") });

// TM-884 — the age field with 17 typed: accepted (no inline error, 13–120 hint) before; rejected
// live ("Must be 18 or more.", 18–99 hint) after. Nothing is saved, so the stored profile — and the
// paired before/after run — stays untouched.
await page.fill("#profile-age", "17");
await page.locator("#profile-age").scrollIntoViewIfNeeded();
await page.waitForTimeout(400);
await page.screenshot({ path: shotPath("TM-884", "age-validation") });

// ── Completion-gate shots (TM-880) — as a brand-new (phone-less) user. ──────────────────────────
// A FRESH browser context: the Firebase session persists in the first context's IndexedDB, so a
// same-context #/login visit would silently restore the ADMIN sign-in instead of showing the form.
const fresh = `capture-${LABEL}-${Date.now()}@teammarhaba.test`;
await page.close();
const gateContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
const gatePage = await gateContext.newPage();
await signInFreshUser(gatePage, fresh);
await gatePage.waitForSelector("#onboarding-form", { state: "visible", timeout: 20_000 });
await gatePage.waitForTimeout(2000); // let the gate's async mount prefill (TM-590) settle first
await gatePage.screenshot({ path: shotPath("TM-880", "phone-gate"), fullPage: true });

// AFTER only: everything but the phone filled + submitted → the "Phone is required." blocked state.
// (Not run from main: there is no phone field there, so the same submit would complete onboarding.)
if (LABEL !== "before") {
  await gatePage.fill("#onboarding-name", "Capture Tester");
  // TM-898: the gate location became the allowed-cities <select> — picked, not typed.
  await gatePage.selectOption("#onboarding-location", "London");
  await gatePage.fill("#onboarding-age", "30");
  await gatePage.click("#onboarding-form button[type=submit]");
  await gatePage.waitForSelector("#onboarding-phone-error", { state: "visible", timeout: 10_000 });
  await gatePage.locator("#onboarding-phone").scrollIntoViewIfNeeded();
  await gatePage.waitForTimeout(300);
  await gatePage.screenshot({ path: shotPath("TM-880", "phone-required-error"), fullPage: true });
}

await browser.close();
console.log(`[capture] ${LABEL} shots written to ${OUT}`);
