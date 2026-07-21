// TM-930 — before/after visual evidence for the #/onboarding gate phone step at a 390px phone
// viewport. BEFORE (pre-change tree, served from main) = the free-text phone gate. AFTER (this
// branch) = the Firebase phone VERIFY-AND-LINK step: the "Send code" button, the revealed six-box
// OTP group, and the collision hard-block error.
//
// FULL-STACK mode (like capture-tm885-886.mjs): drives the REAL gate against the running e2e stack
// (Postgres + Auth emulator + backend + a serve.mjs). It seeds its OWN per-label accounts (fresh,
// email-verified, password sign-in) but deliberately leaves them PHONE-LESS + un-onboarded so the
// completion gate shows. Dev CORS only allows one web origin, so serve each side on the SAME port in
// turn: run once from main (label=before) then once from this branch (label=after).
//
// Usage:
//   CAPTURE_LABEL=before CAPTURE_OUT=/abs/dir CAPTURE_BASE=http://127.0.0.1:18081 \
//     E2E_API_BASE_URL=... E2E_AUTH_EMULATOR_HOST=... node capture-tm930.mjs

import { chromium } from "@playwright/test";
import admin from "firebase-admin";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { API_BASE_URL, AUTH_EMULATOR_HOST, PROJECT_ID } from "./fixtures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm930");
const BASE = process.env.CAPTURE_BASE || "http://127.0.0.1:8081";
const LABEL = process.env.CAPTURE_LABEL || "after"; // "before" (main) | "after" (branch)
const BOOT_SETTLE_MS = 4500;

const shotPath = (name) => join(OUT, `${name}.png`);

/** Peek the OTP the Auth emulator "texted" for an E.164 number. */
async function peekPhoneOtp(phoneE164) {
  const res = await fetch(`http://${AUTH_EMULATOR_HOST}/emulator/v1/projects/${PROJECT_ID}/verificationCodes`);
  if (!res.ok) throw new Error(`verificationCodes lookup failed: ${res.status}`);
  const { verificationCodes = [] } = await res.json();
  const session = verificationCodes.filter((v) => v.phoneNumber === phoneE164).at(-1);
  if (!session?.code) throw new Error(`no emulator OTP session for ${phoneE164}`);
  return session.code;
}

/** Create/refresh a fresh email-verified account in the Auth emulator (no phone, un-onboarded). */
async function seedAccount(email, password) {
  process.env.FIREBASE_AUTH_EMULATOR_HOST ||= AUTH_EMULATOR_HOST;
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT_ID });
  const auth = admin.auth();
  try {
    const existing = await auth.getUserByEmail(email);
    await auth.updateUser(existing.uid, { password, emailVerified: true, disabled: false });
  } catch (err) {
    if (err && err.code === "auth/user-not-found") {
      await auth.createUser({ email, password, emailVerified: true });
    } else {
      throw err;
    }
  }
}

/** Sign in via the email+password "Try another way" path; land on the completion gate. */
async function signInToGate(page, email, password) {
  await page.goto(`${BASE}/#/login`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(BOOT_SETTLE_MS);
  await page.fill("#email", email);
  await page.click("#try-another-btn");
  await page.fill("#password", password);
  await page.click("#signin-btn");
  await page.waitForSelector("#onboarding-form", { state: "visible", timeout: 20_000 });
  await page.waitForTimeout(1200);
}

const browser = await chromium.launch();
await mkdir(OUT, { recursive: true });

const stamp = Date.now();
const gateUser = { email: `capture-930-${LABEL}-${stamp}@teammarhaba.test`, password: "capture-930-pw-123456" };
await seedAccount(gateUser.email, gateUser.password);

// ── The gate as first seen (BEFORE = free-text phone; AFTER = phone + a "Send code" button). ──
{
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await signInToGate(page, gateUser.email, gateUser.password);
  // Fill name/location/age + the national phone so the gate reads like a real in-progress form.
  await page.fill("#onboarding-name", "Verify Demo");
  await page.selectOption("#onboarding-location", "London");
  await page.fill("#onboarding-age", "30");
  await page.fill("#onboarding-phone", "7700 903100");
  await page.waitForTimeout(500);
  await page.screenshot({ path: shotPath(`TM-930-${LABEL}-1-gate`), fullPage: true });
  console.log(`[capture] wrote TM-930-${LABEL}-1-gate.png`);

  if (LABEL === "after") {
    // Send the code → the six-box OTP group reveals. Screenshot it.
    await page.click("#onboarding-phone-send");
    await page.waitForSelector("#onboarding-phone-otp-group", { state: "visible", timeout: 10_000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: shotPath(`TM-930-${LABEL}-2-otp-boxes`), fullPage: true });
    console.log(`[capture] wrote TM-930-${LABEL}-2-otp-boxes.png`);
  }
  await context.close();
}

// ── AFTER only: the collision hard-block error state. ─────────────────────────────────────────────
if (LABEL === "after") {
  const sharedE164 = `+4477009031${String(stamp).slice(-2)}`;
  const sharedNational = `7700 9031${String(stamp).slice(-2)}`;

  // Owner account: sign in, verify + link the shared number (leaves it owned in Firebase).
  const owner = { email: `capture-930-owner-${stamp}@teammarhaba.test`, password: "capture-930-pw-123456" };
  await seedAccount(owner.email, owner.password);
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await signInToGate(page, owner.email, owner.password);
    await page.fill("#onboarding-name", "Owner Demo");
    await page.selectOption("#onboarding-location", "London");
    await page.fill("#onboarding-age", "30");
    await page.fill("#onboarding-phone", sharedNational);
    await page.click("#onboarding-phone-send");
    await page.waitForSelector("#onboarding-phone-otp-group", { state: "visible", timeout: 10_000 });
    await page.fill("#onboarding-phone-otp", await peekPhoneOtp(sharedE164));
    await page.waitForSelector("#onboarding-phone-verified", { state: "visible", timeout: 10_000 });
    await context.close();
  }

  // Colliding account: sign in, enter the SAME number → confirm hard-blocks with the exact copy.
  const collide = { email: `capture-930-collide-${stamp}@teammarhaba.test`, password: "capture-930-pw-123456" };
  await seedAccount(collide.email, collide.password);
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await signInToGate(page, collide.email, collide.password);
    await page.fill("#onboarding-name", "Collide Demo");
    await page.selectOption("#onboarding-location", "London");
    await page.fill("#onboarding-age", "30");
    await page.fill("#onboarding-phone", sharedNational);
    await page.click("#onboarding-phone-send");
    await page.waitForSelector("#onboarding-phone-otp-group", { state: "visible", timeout: 10_000 });
    await page.fill("#onboarding-phone-otp", await peekPhoneOtp(sharedE164));
    // The confirm rejects with auth/credential-already-in-use → the hard-block copy paints.
    await page.waitForSelector("#onboarding-phone-error", { state: "visible", timeout: 10_000 });
    await page.waitForFunction(
      () => document.querySelector("#onboarding-phone-error")?.textContent?.includes("already registered"),
      { timeout: 10_000 },
    );
    await page.waitForTimeout(400);
    await page.screenshot({ path: shotPath(`TM-930-${LABEL}-3-collision-error`), fullPage: true });
    console.log(`[capture] wrote TM-930-${LABEL}-3-collision-error.png`);
    await context.close();
  }
}

await browser.close();
console.log("[capture] done");
