// TM-901 — before/after visual evidence for the WCAG 1.4.1 underline fix: the profile strength
// card's tappable "Add …" gap prompts (.tm-pf-nudge-gap) and the next-day interests CTA
// (.tm-pf-nudge-interests) marked by ACCENT COLOUR ALONE in their default state BEFORE → carrying a
// persistent dotted underline AFTER. Touch users never see the hover underline, so the default
// (non-hover) state captured here is exactly the state the finding is about.
//
// FULL-STACK mode, the capture-tm881-846 sibling pattern: drives the REAL login flow against the
// running e2e stack (Postgres + Auth emulator + backend + a serve.mjs instance on :8081 — dev CORS
// allows only that origin). Seeds its OWN per-label account with a name, city and phone but NO age
// and NO photo, so both runs show the same "Add your age + a photo →" prompts; it also best-effort
// seeds EXACTLY ONE interest so the next-day interests CTA (count === 1) is visible in the same shot.
// Run once from `main` (label=before, serving main's web/src) and once from the branch (label=after);
// the same backend serves both (the fix is CSS-only).
//
// Captured at an Android-phone viewport (390×844). The boot splash holds ~3.2s, so every page load
// settles ≥4s before a shot.
//
// Usage:
//   CAPTURE_LABEL=after CAPTURE_BASE=http://127.0.0.1:8081 CAPTURE_OUT=/abs/dir \
//     node capture-tm901.mjs

import { chromium } from "@playwright/test";
import admin from "firebase-admin";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { API_BASE_URL, AUTH_EMULATOR_HOST, PROJECT_ID } from "./fixtures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm901");
const BASE = process.env.CAPTURE_BASE || "http://127.0.0.1:8081";
const LABEL = process.env.CAPTURE_LABEL || "after"; // "before" (main) | "after" (branch)

const BOOT_SPLASH_SETTLE_MS = 4000; // the boot splash holds ~3.2s — settle ≥4s before capturing

// A per-label account so before/after each start from the same gaps. Password meets the emulator's
// ≥6-char rule; the address is a throwaway on the e2e Auth emulator.
const USER = { email: `capture-901-${LABEL}@teammarhaba.test`, password: "capture-901-pw-123456" };

const shotPath = (screen) => join(OUT, `TM-901-${LABEL}-${screen}.png`);

/** Seed USER: create in the Auth emulator, then provision + un-gate it with a name, city and phone
 *  but deliberately NO age and NO photo — so the strength card shows the two "Add your age + a
 *  photo" gap prompts both runs need. Mirrors global-setup's provisioning path (phone PATCH before
 *  onboarding-complete — mandatory since TM-880). Then best-effort: exactly ONE interest, so the
 *  next-day interests CTA (nextDayInterestsNudge fires on count === 1) appears in the same card. */
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

  // Name + city + phone (city from the TM-877 allowed list; phone mandatory pre-onboarding-complete
  // since TM-880). NO age → the "your age" + "a photo" gap prompts render on the strength card.
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

  // Best-effort ONE interest (the interests-CTA trigger). The catalogue + selection bounds are
  // runtime data, so a failure here (empty catalogue, min > 1, …) must not sink the required
  // strength-card evidence — warn and carry on with the gap prompts only.
  try {
    // The lean public catalogue rows: [{label, category, highlighted, sortWeight}] (TM-776).
    const catRes = await fetch(`${API_BASE_URL}/api/v1/interests/catalogue`, { headers: authed });
    const catalogue = catRes.ok ? await catRes.json() : null;
    const label = Array.isArray(catalogue) ? catalogue[0]?.label : undefined;
    if (!label) throw new Error("no catalogue label available");
    const intRes = await fetch(`${API_BASE_URL}/api/v1/me`, {
      method: "PATCH",
      headers: { ...authed, "Content-Type": "application/json" },
      body: JSON.stringify({ interests: [label] }),
    });
    if (!intRes.ok) throw new Error(`${intRes.status} ${await intRes.text()}`);
  } catch (err) {
    console.warn(`[capture] interests seed skipped (${err.message}) — capturing the gap prompts only`);
  }
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
await mkdir(OUT, { recursive: true });

await seedUser();

// Sign in via the email+password "Try another way" path (same as the specs), then open the profile.
await page.goto(`${BASE}/#/login`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(BOOT_SPLASH_SETTLE_MS);
await page.fill("#email", USER.email);
await page.click("#try-another-btn");
await page.fill("#password", USER.password);
await page.click("#signin-btn");
await page.waitForSelector("#auth-signed-in", { state: "visible", timeout: 20_000 });

await page.goto(`${BASE}/#/profile`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(BOOT_SPLASH_SETTLE_MS);
await page.waitForSelector("#profile-form", { state: "visible", timeout: 20_000 });
await page.waitForTimeout(1000); // let the mount GET /me populate the hub (strength paint included)

// The strength card in its DEFAULT state — no hover, no focus: exactly what a touch user sees.
// One viewport shot for context + one tight card crop where the (missing/present) underline is
// unmistakable at review size.
await page.locator(".tm-pf-barnudge").scrollIntoViewIfNeeded();
await page.waitForTimeout(300);
await page.screenshot({ path: shotPath("strength-card-default") });
const card = page.locator(".tm-pf-card", { has: page.locator(".tm-pf-barnudge") }).first();
await card.screenshot({ path: shotPath("strength-card-closeup") });

await browser.close();
console.log(`[capture] ${LABEL} shots written to ${OUT}`);
