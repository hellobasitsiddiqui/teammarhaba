// TM-1063 — before/after visual evidence for the admin event form's In person/Online format selector,
// City dropdown, and Map URL preview, at an Android-phone viewport (390×844).
//
// THE CHANGE: the admin create/edit event form gains a CLIENT-ONLY "In person / Online" format selector
// above the location cluster (In person → Location + Venue + City + Map URL; Online → Online URL only),
// the free-text City field becomes a 4-option dropdown (CITY_OPTIONS, shared with the profile), and the
// Map URL field grows a debounced live link-preview (reachable → card / "no rich preview"; unreachable →
// "looks broken"; never gates Save).
//
// FULL-STACK mode (like capture-tm969): drives the REAL login against the running e2e stack (Postgres +
// Auth emulator + backend + a serve.mjs the harness starts). Seeds its OWN admin account. Run once from
// `main` (label=before) and once from the branch (label=after); dev CORS only allows :8081, so serve
// each side on 8081 in turn.
//
// Shots (fullPage):
//   • TM-1063-<label>-create-inperson — the create form default (In person). AFTER: shows the Format
//     selector + a City <select>; BEFORE: no selector, City is a text input.
//   • TM-1063-<label>-create-online   — AFTER: after clicking "Online", the physical trio is hidden and
//     only the Online URL remains. BEFORE: the toggle doesn't exist, so this is the same as the create
//     shot (probe records the toggle was absent).
//
// Probes (JSON, grounded not eyeballed):
//   • hasFormatSelector — is the [data-field="format"] radio group present?
//   • cityControl       — "select" | "input" (the City field's tag).
//   • onlineVisibleInPerson / locationVisibleOnline — the show/hide behaviour after toggling.
//
// Usage:
//   CAPTURE_LABEL=before CAPTURE_OUT=/abs/dir node capture-tm1063.mjs
//   CAPTURE_LABEL=after  CAPTURE_OUT=/abs/dir node capture-tm1063.mjs

import { chromium } from "@playwright/test";
import admin from "firebase-admin";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { API_BASE_URL, AUTH_EMULATOR_HOST, PROJECT_ID } from "./fixtures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm1063");
const BASE = process.env.CAPTURE_BASE || "http://127.0.0.1:8081";
const LABEL = process.env.CAPTURE_LABEL || "after"; // "before" (main) | "after" (branch)
const START_SERVE = process.env.CAPTURE_NO_SERVE !== "1";

const BOOT_SPLASH_SETTLE_MS = 4500;
const VIEWPORT = { width: 390, height: 844 };

const ADMIN = { email: `capture-1063-admin-${LABEL}@teammarhaba.test`, password: "capture-1063-pw-123456", admin: true };

const shotPath = (name) => join(OUT, `${name}.png`);

/** Seed the admin: create in the Auth emulator (+ role=ADMIN claim), provision + un-gate in the backend. */
async function seed(account) {
  process.env.FIREBASE_AUTH_EMULATOR_HOST ||= AUTH_EMULATOR_HOST;
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT_ID });
  const auth = admin.auth();

  let uid;
  try {
    uid = (await auth.getUserByEmail(account.email)).uid;
    await auth.updateUser(uid, { password: account.password, emailVerified: true, disabled: false });
  } catch (err) {
    if (err && err.code === "auth/user-not-found") {
      uid = (await auth.createUser({ email: account.email, password: account.password, emailVerified: true })).uid;
    } else {
      throw err;
    }
  }
  await auth.setCustomUserClaims(uid, account.admin ? { role: "ADMIN" } : {});

  const signInUrl =
    `http://${AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`;
  const signInRes = await fetch(signInUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: account.email, password: account.password, returnSecureToken: true }),
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
    body: JSON.stringify({ firstName: "Ada", lastName: "Admin", city: "London", age: 30, phone: "+447700900123", gender: "PREFER_NOT_TO_SAY" }),
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

/** Sign in via the email+password "Try another way" path (same as the specs). */
async function signIn(page, account) {
  await page.fill("#email", account.email);
  await page.click("#try-another-btn");
  await page.fill("#password", account.password);
  await page.click("#signin-btn");
}

/** True when `sel` exists and has a visible box. */
async function isShown(page, sel) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return false;
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || el.hidden) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }, sel);
}

function startServe() {
  if (!START_SERVE) return null;
  return spawn("node", [join(HERE, "serve.mjs")], { stdio: "inherit", env: { ...process.env, PORT: "8081" } });
}

const serve = startServe();
if (serve) await new Promise((r) => setTimeout(r, 1200));

const browser = await chromium.launch();
await mkdir(OUT, { recursive: true });
await seed(ADMIN);

const context = await browser.newContext({ viewport: VIEWPORT });
const page = await context.newPage();

await page.goto(`${BASE}/#/login`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(BOOT_SPLASH_SETTLE_MS);
await signIn(page, ADMIN);
await page.waitForSelector("#auth-signed-in", { state: "visible", timeout: 20_000 });
await page.waitForTimeout(2000);

// Straight to the create-event form route.
await page.goto(`${BASE}/#/admin/events/new`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#event-form", { state: "visible", timeout: 20_000 });
await page.waitForTimeout(1200);

const probe = { name: LABEL };
probe.hasFormatSelector = await isShown(page, '[data-field="format"]');
probe.cityControl = await page.evaluate(() => document.querySelector("#event-city")?.tagName?.toLowerCase() || null);
probe.onlineVisibleInPerson = await isShown(page, '[data-field="onlineUrl"]');
probe.locationVisibleInPerson = await isShown(page, '[data-field="locationText"]');

await page.screenshot({ path: shotPath(`TM-1063-${LABEL}-create-inperson`), fullPage: true });

// Toggle to Online if the selector exists (AFTER only); BEFORE has no toggle → same form.
const onlineRadio = await page.$("#event-format-online");
if (onlineRadio) {
  await onlineRadio.check();
  await page.waitForTimeout(500);
  probe.locationVisibleOnline = await isShown(page, '[data-field="locationText"]');
  probe.onlineVisibleOnline = await isShown(page, '[data-field="onlineUrl"]');
  probe.cityVisibleOnline = await isShown(page, '[data-field="city"]');
}
await page.screenshot({ path: shotPath(`TM-1063-${LABEL}-create-online`), fullPage: true });

console.log(JSON.stringify(probe, null, 2));

await context.close();
await browser.close();
if (serve) serve.kill("SIGTERM");

console.log(`\n[capture] ${LABEL}: admin event form probed`);
console.log(`  - hasFormatSelector=${probe.hasFormatSelector}; cityControl=${probe.cityControl}`);
if (probe.locationVisibleOnline !== undefined) {
  console.log(`  - after toggling Online: location visible=${probe.locationVisibleOnline}, online visible=${probe.onlineVisibleOnline}, city visible=${probe.cityVisibleOnline}`);
}
console.log(`[capture] ${LABEL} shots written to ${OUT}`);
