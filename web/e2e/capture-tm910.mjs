// TM-934 (migrated): seeds its account with uniqueTestPhone() (a per-run-unique Ofcom-fictional GB
//   number), not the old shared +447700900123 — under TM-923 strict 1:1 phone uniqueness the shared
//   literal 409s the V48 users_phone_normalized_uq index on any account after the first. Not a CI path.
// TM-910 — before/after visual evidence for the Profile-tab chrome rework at an Android-phone
// viewport (390×844), for BOTH a normal user AND an admin.
//
// THE CHANGE: Profile is already self-headed (TM-885/886 hid the walking-skeleton brand block), so
// the only remaining top chrome above the "Profile" heading is the floating account-nav row — the
// hamburger toggle (#nav-toggle) + the notification bell (#nav-notif-bell) beside it. TM-910 removes
// that floating row on Profile and pins the bell to the top-right corner, so "Profile" is the first
// content. The role-conditional FIFTH admin tab in the bottom bar (TM-916) must be undisturbed — so
// we capture as an ADMIN too and probe the tab count (4 for a user, 5 for an admin).
//
// FULL-STACK mode (like capture-tm885-886): drives the REAL login flow against the running e2e stack
// (Postgres + Auth emulator + backend + a serve.mjs the harness starts). Seeds its OWN per-label
// accounts — one plain user, one admin (role=ADMIN custom claim). Run once from `main`
// (label=before) and once from the branch (label=after); dev CORS only allows :8081, so serve each
// side on 8081 in turn.
//
// Probes per screen (printed as JSON so the verdict is grounded, not eyeballed):
//   • floatingRowVisible  — is the hamburger toggle OR the nav-items menu row visible above the
//     heading? (the thing being removed — true=before, false=after on #/profile)
//   • bellVisible / bellCornerPinned — the bell shows, and (after) its parent .app-nav carries the
//     .app-nav--corner-bell class + the bell sits in the top-right of the app.
//   • gearVisible / bellGearOverlap — the Profile heading's diagnostics gear (.tm-pf-gear) shows and
//     does NOT overlap the bell (the collision the ticket calls out).
//   • profileTitleFirst — "Profile" is the first visible heading (top of the profile content).
//   • tabCount / adminTabPresent — the bottom-bar tab grid is 4 (user) / 5 (admin) — undisturbed.
//
// Usage:
//   CAPTURE_LABEL=before CAPTURE_OUT=/abs/dir node capture-tm910.mjs
//   CAPTURE_LABEL=after  CAPTURE_OUT=/abs/dir node capture-tm910.mjs

import { chromium } from "@playwright/test";
import admin from "firebase-admin";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { API_BASE_URL, AUTH_EMULATOR_HOST, PROJECT_ID, uniqueTestPhone } from "./fixtures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm910");
const BASE = process.env.CAPTURE_BASE || "http://127.0.0.1:8081";
const LABEL = process.env.CAPTURE_LABEL || "after"; // "before" (main) | "after" (branch)
const START_SERVE = process.env.CAPTURE_NO_SERVE !== "1"; // start our own serve.mjs unless told not to

const BOOT_SPLASH_SETTLE_MS = 4500; // the boot splash holds ~3.2s — settle ≥4s before capturing
const VIEWPORT = { width: 390, height: 844 };

// Per-label accounts so before/after start identical. Passwords meet the emulator's ≥6-char rule.
const USER = { email: `capture-910-user-${LABEL}@teammarhaba.test`, password: "capture-910-pw-123456", admin: false };
const ADMIN = { email: `capture-910-admin-${LABEL}@teammarhaba.test`, password: "capture-910-pw-123456", admin: true };

const shotPath = (name) => join(OUT, `${name}.png`);

/** Seed one account: create in the Auth emulator (+ role=ADMIN claim for the admin), then provision
 *  + un-gate it in the backend (phone PATCH before onboarding-complete — mandatory since TM-880). */
async function seed(account) {
  process.env.FIREBASE_AUTH_EMULATOR_HOST ||= AUTH_EMULATOR_HOST;
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT_ID });
  const auth = admin.auth();

  let uid;
  try {
    const existing = await auth.getUserByEmail(account.email);
    uid = existing.uid;
    await auth.updateUser(uid, { password: account.password, emailVerified: true, disabled: false });
  } catch (err) {
    if (err && err.code === "auth/user-not-found") {
      uid = (await auth.createUser({ email: account.email, password: account.password, emailVerified: true })).uid;
    } else {
      throw err;
    }
  }
  // Grant the ADMIN role BEFORE minting the provisioning token so it already carries role=ADMIN (TM-110).
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
    body: JSON.stringify({ firstName: account.admin ? "Ada" : "Sam", lastName: account.admin ? "Admin" : "User",
      city: "London", age: 30, phone: uniqueTestPhone() }),
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

/** Probe the chrome state on #/profile for the current signed-in account. */
async function probe(page, name) {
  const geo = await page.evaluate(() => {
    const rectOf = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, w: r.width, h: r.height };
    };
    const overlap = (a, b) => {
      if (!a || !b) return false;
      return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    };
    const bell = rectOf("#nav-notif-bell");
    const gear = rectOf(".tm-pf-gear");
    const nav = document.querySelector("nav.app-nav");
    const vw = window.innerWidth;
    return {
      bell,
      gear,
      bellGearOverlap: overlap(bell, gear),
      // "top-right corner": bell right edge within 24px of the viewport right, in the top 120px.
      bellCornerPinned: Boolean(bell) && bell.right >= vw - 24 && bell.top <= 120,
      navCornerClass: Boolean(nav) && nav.classList.contains("app-nav--corner-bell"),
    };
  });

  const result = {
    name,
    hash: await page.evaluate(() => window.location.hash),
    // The floating row = the hamburger toggle OR the collapsible menu group being visible.
    floatingRowVisible: (await isShown(page, "#nav-toggle")) || (await isShown(page, "#nav-items")),
    bellVisible: await isShown(page, "#nav-notif-bell"),
    bellCornerPinned: geo.bellCornerPinned,
    navCornerClass: geo.navCornerClass,
    gearVisible: await isShown(page, ".tm-pf-gear"),
    bellGearOverlap: geo.bellGearOverlap,
    profileTitleVisible: await isShown(page, ".tm-pf-title"),
    tabbarVisible: await isShown(page, "#app-tabbar"),
    tabCount: await page.evaluate(() =>
      document.querySelectorAll("#app-tabbar a, #app-tabbar button").length),
    adminTabPresent: await page.evaluate(() => Boolean(document.querySelector('#app-tabbar [href="#/admin"], #tab-admin'))),
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

/** Sign an account in via the email+password "Try another way" path (same as the specs). */
async function signIn(page, account) {
  await page.fill("#email", account.email);
  await page.click("#try-another-btn");
  await page.fill("#password", account.password);
  await page.click("#signin-btn");
}

/** Optionally start serve.mjs from THIS worktree's web/src, on :8081. Returns the child (or null). */
function startServe() {
  if (!START_SERVE) return null;
  const child = spawn("node", [join(HERE, "serve.mjs")], {
    stdio: "inherit",
    env: { ...process.env, PORT: "8081" },
  });
  return child;
}

const serve = startServe();
if (serve) await new Promise((r) => setTimeout(r, 1200)); // let the static server bind

const browser = await chromium.launch();
await mkdir(OUT, { recursive: true });
await seed(USER);
await seed(ADMIN);

const probes = [];

for (const account of [USER, ADMIN]) {
  const role = account.admin ? "admin" : "user";
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();

  await page.goto(`${BASE}/#/login`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(BOOT_SPLASH_SETTLE_MS);
  await signIn(page, account);
  await page.waitForSelector("#auth-signed-in", { state: "visible", timeout: 20_000 });
  await page.waitForTimeout(2000); // role/onboarding resolve + tabbar settle (admin tab needs the role)

  // Into #/profile via the bottom Profile tab (the everyday path).
  await page.click("#tab-profile");
  await page.waitForTimeout(2500); // mount + GET /me for the hub
  await page.screenshot({ path: shotPath(`TM-910-${LABEL}-${role}-profile`) });
  probes.push(await probe(page, `${role}-profile`));

  await context.close();
}

await browser.close();
if (serve) serve.kill("SIGTERM");

// ── Verdict ────────────────────────────────────────────────────────────────────────────────────
console.log(`\n[capture] ${LABEL}: ${probes.length} screens probed`);
for (const p of probes) {
  const notes = [];
  if (p.floatingRowVisible) notes.push("floating nav row VISIBLE (before-state / removed after)");
  else notes.push("floating nav row removed");
  if (p.bellVisible && p.bellCornerPinned) notes.push("bell corner-pinned");
  else if (p.bellVisible) notes.push("bell visible (not corner-pinned — before-state)");
  else notes.push("bell NOT visible");
  if (p.bellGearOverlap) notes.push("⚠ bell/gear OVERLAP");
  notes.push(`tabs=${p.tabCount}${p.adminTabPresent ? " (admin tab present)" : ""}`);
  console.log(`  - ${p.name}: ${notes.join("; ")}`);
}
console.log(`[capture] ${LABEL} shots written to ${OUT}`);
