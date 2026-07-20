// TM-906 — before/after visual evidence capture for "Sign out only from Profile, with a confirm":
//   • BEFORE (main's web/src): the top-nav sign-out control — at the 390px phone width the nav
//     collapses behind the hamburger (TM-229), so the shot opens it and captures the "Sign out"
//     button sitting in the nav menu (the thing TM-906 removes).
//   • AFTER (branch web/src): the Profile hub with the styled confirm dialog OPEN over the
//     "Sign out" menu row — the ONLY sign-out entry now, gated behind ui.js confirmDialog.
//
// FULL-STACK mode (the capture-tm881-846 pattern): drives the REAL email+password login against the
// running e2e stack — Postgres + Auth emulator + backend + a serve.mjs instance on :8081 (the ONLY
// origin dev CORS allows — serve each side on 8081 IN TURN, never in parallel). It seeds its OWN
// per-label, fully-onboarded account (name/city/phone + onboarding-complete + terms) so no first-run
// gate intercepts either shot. Run once serving main's web/src (label=before) and once from the
// branch (label=after); the same branch-built backend serves both (this PR is web-only).
//
// NB: this script never references the retired top-nav button's DOM id (banned repo-wide by
// web/tools/tm906-signout-ban.test.mjs) — the before shot only needs the hamburger menu OPEN; the
// after shot drives the Profile row by its stable #profile-signout-row id.
//
// Captured at an Android-phone viewport (390×844). The boot splash holds ~3.2s, so every page load
// settles ≥4s before a shot.
//
// Usage:
//   CAPTURE_LABEL=after CAPTURE_BASE=http://127.0.0.1:8081 CAPTURE_OUT=/abs/dir \
//     node capture-tm906.mjs

import { chromium } from "@playwright/test";
import admin from "firebase-admin";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { API_BASE_URL, AUTH_EMULATOR_HOST, PROJECT_ID } from "./fixtures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm906");
const BASE = process.env.CAPTURE_BASE || "http://127.0.0.1:8081";
const LABEL = process.env.CAPTURE_LABEL || "after"; // "before" (main src) | "after" (branch src)

const BOOT_SPLASH_SETTLE_MS = 4000; // the boot splash holds ~3.2s — settle ≥4s before capturing

// A per-label throwaway on the e2e Auth emulator; password meets the emulator's ≥6-char rule.
const USER = { email: `capture-906-${LABEL}@teammarhaba.test`, password: "capture-906-pw-123456" };

const shotPath = (screen) => join(OUT, `TM-906-${LABEL}-${screen}.png`);

/** Seed USER fully onboarded (name/city/phone PATCH → onboarding-complete → accept-terms — the
 *  global-setup provisioning path; phone first is mandatory since TM-880) so the router lands the
 *  signed-in user on HOME, no gate. */
async function seedUser() {
  process.env.FIREBASE_AUTH_EMULATOR_HOST ||= AUTH_EMULATOR_HOST;
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT_ID });
  const auth = admin.auth();
  try {
    const existing = await auth.getUserByEmail(USER.email);
    await auth.updateUser(existing.uid, { password: USER.password, emailVerified: true, disabled: false });
  } catch (err) {
    if (err && err.code === "auth/user-not-found") {
      await auth.createUser({ email: USER.email, password: USER.password, emailVerified: true });
    } else {
      throw err;
    }
  }

  const signInUrl =
    `http://${AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`;
  const signInRes = await fetch(signInUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: USER.email, password: USER.password, returnSecureToken: true }),
  });
  if (!signInRes.ok) throw new Error(`emulator sign-in failed: ${signInRes.status} ${await signInRes.text()}`);
  const { idToken } = await signInRes.json();
  const authed = { Authorization: `Bearer ${idToken}`, Accept: "application/json" };

  const meRes = await fetch(`${API_BASE_URL}/api/v1/me`, { headers: authed });
  if (!meRes.ok) throw new Error(`provision (GET /me) failed: ${meRes.status} ${await meRes.text()}`);
  const me = await meRes.json();

  const patchRes = await fetch(`${API_BASE_URL}/api/v1/me`, {
    method: "PATCH",
    headers: { ...authed, "Content-Type": "application/json" },
    body: JSON.stringify({ firstName: "Cap", lastName: "Ture", city: "London", phone: "+447700900123" }),
  });
  if (!patchRes.ok) throw new Error(`seed profile failed: ${patchRes.status} ${await patchRes.text()}`);

  const onboardRes = await fetch(`${API_BASE_URL}/api/v1/me/onboarding-complete`, { method: "POST", headers: authed });
  if (!onboardRes.ok) throw new Error(`onboarding-complete failed: ${onboardRes.status} ${await onboardRes.text()}`);

  if (me.currentTermsVersion) {
    const termsRes = await fetch(`${API_BASE_URL}/api/v1/me/accept-terms`, {
      method: "POST",
      headers: { ...authed, "Content-Type": "application/json" },
      body: JSON.stringify({ version: me.currentTermsVersion }),
    });
    if (!termsRes.ok) throw new Error(`accept-terms failed: ${termsRes.status} ${await termsRes.text()}`);
  }
}

/** Load a hash route and let the boot splash + fonts settle before anything is captured. */
async function settleGoto(page, hash) {
  await page.goto(`${BASE}/${hash}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(BOOT_SPLASH_SETTLE_MS);
}

/** Sign USER in via the email+password "Try another way" path (same as the specs). */
async function signIn(page) {
  await settleGoto(page, "#/login");
  await page.fill("#email", USER.email);
  await page.click("#try-another-btn");
  await page.fill("#password", USER.password);
  await page.click("#signin-btn");
  // Fully provisioned ⇒ the router lands on the signed-in HOME shell.
  await page.waitForSelector("#auth-signed-in", { state: "visible", timeout: 20_000 });
  await page.waitForTimeout(1000);
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
await mkdir(OUT, { recursive: true });

await seedUser();
await signIn(page);

if (LABEL === "before") {
  // ── BEFORE (main): the top-nav sign-out control, behind the 390px hamburger. ────────────────────
  await page.click("#nav-toggle");
  // The collapsed menu (#nav-items) slides open; "Sign out" is its last signed-in entry.
  await page.getByRole("button", { name: "Sign out" }).waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(400); // let the open animation finish
  await page.screenshot({ path: shotPath("nav-menu-signout") });
} else {
  // ── AFTER (branch): the Profile hub row + the styled confirm dialog OPEN. ───────────────────────
  await settleGoto(page, "#/profile");
  const row = page.locator("#profile-signout-row");
  await row.waitFor({ state: "visible", timeout: 20_000 });
  await row.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: shotPath("profile-signout-row") });

  await row.click();
  await page.locator(".tm-dialog").waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: shotPath("profile-confirm-dialog") });
}

await browser.close();
console.log(`[capture] ${LABEL} shots written to ${OUT}`);
