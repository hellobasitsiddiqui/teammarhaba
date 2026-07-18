// TM-885 / TM-886 — reproduction + before/after visual evidence capture for the profile shell-mount
// pair at an Android-phone viewport (390×844):
//   • TM-885 — the four-tab bottom navigation (Home / Events / Chat / Profile) reportedly missing
//              on #/profile.
//   • TM-886 — the auth-landing "find your people" brand + boot-splash "ready" content reportedly
//              leaking above the profile content.
//
// FULL-STACK mode (like the capture-tm881-846 sibling): drives the REAL login flow against the
// running e2e stack — Postgres + Auth emulator + backend + a serve.mjs instance. It seeds its OWN
// per-label account (fresh, fully provisioned: phone PATCH before onboarding-complete, mandatory
// since TM-880). Run once from `main` (label=before) and once from the branch (label=after); dev
// CORS only allows :8081, so serve each side on 8081 in turn.
//
// It walks EVERY plausible entry path into #/profile and, for each, screenshots + probes the DOM:
//   1. warm-tab   — route-change into #/profile from #/home (tap the Profile tab).
//   2. cold-deeplink-signed-in — cold boot (full page load) straight to #/profile with a warm
//                   session (Firebase session restore + deep link).
//   3. cold-deeplink-signed-out — cold boot to #/profile with NO session (fresh context): login
//                   bounce → sign in → returned to #/profile.
//   4. postlogin  — the post-login landing (#/home) then Profile via the tab, on the fresh context.
//
// Each probe records: tab bar visible? which tab active? login card visible? boot splash still in
// the DOM? app-shell h1/tagline/#status visible? profile title visible? — printed as JSON so the
// reproduction verdict is grounded, not eyeballed.
//
// The boot splash holds ~3.2s, so every cold load settles ≥4s before a shot (blackboard rule).
//
// Usage:
//   CAPTURE_LABEL=before CAPTURE_OUT=/abs/dir node capture-tm885-886.mjs

import { chromium } from "@playwright/test";
import admin from "firebase-admin";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { API_BASE_URL, AUTH_EMULATOR_HOST, PROJECT_ID } from "./fixtures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm885-886");
const BASE = process.env.CAPTURE_BASE || "http://127.0.0.1:8081";
const LABEL = process.env.CAPTURE_LABEL || "after"; // "before" (main) | "after" (branch)

const BOOT_SPLASH_SETTLE_MS = 4500; // the boot splash holds ~3.2s — settle ≥4s before capturing

// A per-label account so before/after start identical. Password meets the emulator's ≥6-char rule.
const USER = { email: `capture-885-${LABEL}@teammarhaba.test`, password: "capture-885-pw-123456" };

const shotPath = (name) => join(OUT, `${name}.png`);

/** Seed USER: create in the Auth emulator, then provision + un-gate it in the backend (phone PATCH
 *  before onboarding-complete — mandatory since TM-880). Mirrors capture-tm881-846.mjs. */
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
    body: JSON.stringify({ firstName: "Shell", lastName: "Mount", city: "London", age: 30, phone: "+447700900123" }),
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

/** True when `el` exists, isn't display:none/visibility:hidden, and has a visible box. */
async function isShown(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }, selector);
}

/** Probe everything both tickets care about on the current page state. */
async function probe(page, name) {
  const result = {
    name,
    hash: await page.evaluate(() => window.location.hash),
    tabbarVisible: await isShown(page, "#app-tabbar"),
    profileTabActive: await page.evaluate(() =>
      document.querySelector("#tab-profile")?.classList.contains("is-active") ?? false),
    loginCardVisible: await isShown(page, "#auth-signed-out"),
    bootSplashInDom: await page.evaluate(() => Boolean(document.getElementById("boot-screen"))),
    shellH1Visible: await isShown(page, "main.app > h1"),
    taglineVisible: await isShown(page, "main.app > .tagline"),
    taglineText: await page.evaluate(() => document.querySelector("main.app > .tagline")?.textContent ?? null),
    statusVisible: await isShown(page, "#status"),
    statusText: await page.evaluate(() => document.getElementById("status")?.textContent ?? null),
    profileViewVisible: await isShown(page, "#profile-view"),
    profileTitleVisible: await isShown(page, ".tm-pf-title"),
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

/** Sign USER in via the email+password "Try another way" path (same as the specs). */
async function signIn(page) {
  await page.fill("#email", USER.email);
  await page.click("#try-another-btn");
  await page.fill("#password", USER.password);
  await page.click("#signin-btn");
}

const browser = await chromium.launch();
await mkdir(OUT, { recursive: true });
await seedUser();

const probes = [];

// ── Context A: a warm signed-in session (paths 1 + 2) ────────────────────────────────────────────
{
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();

  // Establish the session: land on login, sign in, wait for home.
  await page.goto(`${BASE}/#/login`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(BOOT_SPLASH_SETTLE_MS);
  await signIn(page);
  await page.waitForSelector("#auth-signed-in", { state: "visible", timeout: 20_000 });
  await page.waitForTimeout(1500); // let role/onboarding resolve + tabbar settle

  // Path 1 — warm route-change into #/profile via the bottom Profile tab (the everyday path).
  await page.click("#tab-profile");
  await page.waitForTimeout(2000); // mount + GET /me for the hub
  await page.screenshot({ path: shotPath(`TM-885-${LABEL}-1-warm-tab-profile`) });
  probes.push(await probe(page, "1-warm-tab"));

  // Path 2 — cold boot (full reload) straight to #/profile with the warm session (deep link +
  // session restore): the router first sees a signed-out state, bounces to #/login (brand visible),
  // then auth restores and it returns to #/profile.
  await page.goto(`${BASE}/#/profile`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(BOOT_SPLASH_SETTLE_MS);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: shotPath(`TM-886-${LABEL}-2-cold-deeplink-signed-in`) });
  probes.push(await probe(page, "2-cold-deeplink-signed-in"));

  await context.close();
}

// ── Context B: fresh (signed-out) context (paths 3 + 4) ──────────────────────────────────────────
{
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();

  // Path 3 — cold deep link to #/profile signed OUT: bounced to login; sign in; returned to profile.
  await page.goto(`${BASE}/#/profile`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(BOOT_SPLASH_SETTLE_MS);
  await signIn(page);
  await page.waitForTimeout(2500); // navigate + mount + role resolve
  await page.screenshot({ path: shotPath(`TM-886-${LABEL}-3-login-return-to-profile`) });
  probes.push(await probe(page, "3-login-return-to-profile"));

  // Path 4 — post-login landing → Profile tab (if the return didn't land on profile, go home first).
  await page.goto(`${BASE}/#/home`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(BOOT_SPLASH_SETTLE_MS);
  await page.waitForTimeout(1500);
  const tabbarThere = await isShown(page, "#app-tabbar");
  if (tabbarThere) await page.click("#tab-profile");
  else await page.goto(`${BASE}/#/profile`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: shotPath(`TM-885-${LABEL}-4-postlogin-tab-profile`) });
  probes.push(await probe(page, "4-postlogin-tab"));

  await context.close();
}

await browser.close();

// ── Verdict ──────────────────────────────────────────────────────────────────────────────────────
const bad = probes.filter(
  (p) =>
    !p.tabbarVisible || !p.profileTabActive || p.loginCardVisible || p.bootSplashInDom ||
    p.shellH1Visible || p.taglineVisible || p.statusVisible,
);
console.log(`\n[capture] ${LABEL}: ${probes.length} paths probed, ${bad.length} with shell-mount defects`);
for (const p of bad) {
  const defects = [];
  if (!p.tabbarVisible) defects.push("tabbar MISSING (TM-885)");
  if (!p.profileTabActive) defects.push("Profile tab NOT active (TM-885)");
  if (p.loginCardVisible) defects.push("login card visible (TM-886)");
  if (p.bootSplashInDom) defects.push("boot splash still in DOM (TM-886)");
  if (p.shellH1Visible || p.taglineVisible) defects.push("brand h1/tagline visible above profile (TM-886)");
  if (p.statusVisible) defects.push(`status line visible above profile (TM-886): ${JSON.stringify(p.statusText)}`);
  console.log(`  - ${p.name}: ${defects.join("; ")}`);
}
console.log(`[capture] ${LABEL} shots written to ${OUT}`);
