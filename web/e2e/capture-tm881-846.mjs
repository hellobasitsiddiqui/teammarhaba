// TM-881 / TM-846 — before/after visual evidence capture for the strength-nudge + avatar-repaint pair:
//   • TM-881 — the profile-strength "Add …" prompts (inert span text BEFORE → tappable, focusable
//              buttons AFTER, plus an AFTER-only shot of the field actually focused by clicking one).
//   • TM-846 — the identity header immediately after an avatar upload, NO reload (stale 🙂 glyph +
//              stale strength % BEFORE → the uploaded photo + corrected strength AFTER).
//
// FULL-STACK mode (like the capture-tm877-880-884 sibling): drives the REAL login + upload flows
// against the running e2e stack — Postgres + Auth/Storage emulator + backend + a serve.mjs instance.
// It seeds its OWN per-label account (fresh, photo-less, name+city set but NO age) so both runs start
// from the same "gaps = your age + a photo" state; the avatar upload goes to the Storage EMULATOR, so
// nothing real is touched. Run once from `main` (label=before, serving main's web/src) and once from
// the branch (label=after); the same branch-built backend serves both (this PR is web-only).
//
// Captured at an Android-phone viewport (390×844). The boot splash holds ~3.2s, so every page load
// settles ≥4s before a shot.
//
// Usage:
//   CAPTURE_LABEL=after CAPTURE_BASE=http://127.0.0.1:8081 CAPTURE_OUT=/abs/dir \
//     node capture-tm881-846.mjs

import { chromium } from "@playwright/test";
import admin from "firebase-admin";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { API_BASE_URL, AUTH_EMULATOR_HOST, PROJECT_ID } from "./fixtures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm881-846");
const BASE = process.env.CAPTURE_BASE || "http://127.0.0.1:8081";
const LABEL = process.env.CAPTURE_LABEL || "after"; // "before" (main) | "after" (branch)

const BOOT_SPLASH_SETTLE_MS = 4000; // the boot splash holds ~3.2s — settle ≥4s before capturing

// A per-label account so before/after each start photo-less with the same gaps. The password meets
// the emulator's ≥6-char rule; the address is a throwaway on the e2e Auth emulator.
const USER = { email: `capture-881-${LABEL}@teammarhaba.test`, password: "capture-881-pw-123456" };

const shotPath = (ticket, screen) => join(OUT, `${ticket}-${LABEL}-${screen}.png`);

/** Seed USER: create in the Auth emulator, then provision + un-gate it in the backend with a name,
 *  city and phone but deliberately NO age and NO photo — so the strength card shows exactly the
 *  "Add your age + a photo" prompts both runs need. Mirrors global-setup's provisioning path
 *  (phone PATCH before onboarding-complete — mandatory since TM-880). */
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

  // Mint an emulator ID token and walk the backend provisioning path as the user itself.
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

  // Name + city + phone (city from the TM-877 allowed list; phone mandatory pre-onboarding-complete
  // since TM-880). NO age → the age + photo gaps drive both tickets' evidence.
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
  // At the 390px phone width the sign-out control sits behind the hamburger nav, so wait for the
  // signed-in HOME shell instead (the router lands a returning, fully-provisioned user there).
  await page.waitForSelector("#auth-signed-in", { state: "visible", timeout: 20_000 });
}

/** Render a solid-colour square in the browser and screenshot it — a guaranteed-valid avatar PNG
 *  (no hand-rolled image bytes), visually unmistakable (solid pink) against the 🙂 glyph. */
async function makeAvatarPng(page, path) {
  await page.goto("data:text/html,<body style='margin:0'><div style='background:%23e91e63;width:200px;height:200px'></div>");
  const buf = await page.screenshot({ clip: { x: 0, y: 0, width: 200, height: 200 } });
  await writeFile(path, buf);
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
await mkdir(OUT, { recursive: true });

await seedUser();

const avatarPng = join(OUT, `avatar-source-${LABEL}.png`);
await makeAvatarPng(page, avatarPng);

await signIn(page);
await settleGoto(page, "#/profile");
await page.waitForSelector("#profile-form", { state: "visible", timeout: 20_000 });
await page.waitForTimeout(1000); // let the mount GET /me populate the hub + form

// ── TM-881 — the strength card's "Add your age + a photo" prompts (inert before, tappable after). ──
await page.locator(".tm-pf-barnudge").scrollIntoViewIfNeeded();
await page.waitForTimeout(300);
await page.screenshot({ path: shotPath("TM-881", "strength-prompts") });

// AFTER only: click the first prompt ("your age") and capture the field it scrolled to + focused.
// (Not run from main: the prompts are inert spans there — nothing to click is the whole bug.)
if (LABEL !== "before") {
  await page.locator(".tm-pf-nudge-gap").first().click();
  await page.waitForTimeout(800); // let the smooth scroll land and the focus ring paint
  await page.screenshot({ path: shotPath("TM-881", "age-field-focused") });
}

// ── TM-846 — upload an avatar, then shoot the identity header IMMEDIATELY (no reload). ──────────
// Before: the upload succeeds (toast) but the header keeps the glyph and the strength still counts
// the photo as missing. After: the photo + corrected strength appear the moment the toast does.
await page.locator("#profile-avatar-file").scrollIntoViewIfNeeded();
await page.setInputFiles("#profile-avatar-file", avatarPng);
await page.getByText("Avatar updated.").waitFor({ timeout: 20_000 });
await page.waitForTimeout(800); // let the (after-side) repaint + the img fetch settle
await page.locator(".tm-pf-id").scrollIntoViewIfNeeded();
await page.waitForTimeout(300);
await page.screenshot({ path: shotPath("TM-846", "identity-after-upload") });

await browser.close();
console.log(`[capture] ${LABEL} shots written to ${OUT}`);
