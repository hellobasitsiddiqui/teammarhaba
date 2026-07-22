// TM-913 — before/after visual evidence for the Profile-strength progress RING (was a horizontal bar),
// at an Android-phone viewport (390×844), at THREE strength states: 0%, partial, and 100% ("all set").
//
// Mock-mode (pattern: capture-tm882.mjs / capture-tm771.mjs). Boots the real SPA via serve.mjs, mocks
// GET /api/v1/me with a payload whose filled fields yield the target strength percent, reveals the
// profile surface through the same hidden-flag seams router.js flips for a signed-in user, and shoots
// the Profile-strength card at each state. No backend, no onboarding gate — deterministic.
//
//   • Run from a checkout WITHOUT the fix (main)  → horizontal bar + "N% complete" label (BEFORE).
//   • Run from a checkout WITH the fix (TM-913)   → circular progress ring + centred "N%" (AFTER).
//
// The five strength fields (profile-core STRENGTH_FIELDS) are name/city/age/phone (from /me) + photo
// (the live Firebase photoURL). Each is 20%. To hit each state:
//   • 0%   — an empty /me (no name/city/age/phone) + no photo.
//   • 60%  — name + city + age (no phone, no photo) — a partial ring.
//   • 100% — name + city + age + phone + a photoURL (stubbed on the mock auth user so `hasPhoto` is true).
//
// Usage:  PHASE=before node capture-tm913.mjs      (writes capture-out-tm913/TM-913-before-*.png)
//         PHASE=after  node capture-tm913.mjs
//         CAPTURE_OUT=/abs/path CAPTURE_PORT=8197 PHASE=... node capture-tm913.mjs

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm913");
const PORT = Number(process.env.CAPTURE_PORT || 8197);
const PHASE = process.env.PHASE || "after"; // "before" (main) | "after" (this branch)
const BASE = `http://127.0.0.1:${PORT}`;

// A 1×1 transparent PNG data URL — a valid photoURL so `hasPhoto` is true for the 100% state without a
// real Firebase upload (the ring only cares that a photoURL EXISTS, not what it shows).
const PHOTO_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

// A realistic MeResponse-shaped base (matches the me() fixture in profile-core.test.mjs). Per-state
// overrides below strip fields to land the target strength percent.
const ME_BASE = {
  uid: "capture-uid",
  email: "capture@example.com",
  displayName: "",
  notificationPref: "EMAIL",
  timezone: "Europe/London",
  locale: "en-GB",
  role: "USER",
  enabled: true,
  themeAccent: "teal",
  themeSketchy: true,
  accountState: { emailVerified: true, mfaEnabled: false, phoneVerified: false, photoURL: null, lastLoginAt: null },
};

// The three states: label → the /me overrides + whether a photo is present. profileStrength() counts
// name/city/age/phone (from /me) + photo (Firebase photoURL) at 20% each.
const STATES = [
  { key: "0pct", label: "0%", me: { firstName: "", lastName: "", city: "", age: null, phone: "" }, photo: false },
  { key: "partial", label: "60%", me: { firstName: "Ghalia", lastName: "Qazi", city: "London", age: 28, phone: "", }, photo: false },
  { key: "100pct", label: "100%", me: { firstName: "Ghalia", lastName: "Qazi", city: "London", age: 28, phone: "+44 20 7946 0958" }, photo: true },
];

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function mockApi(page, meOverrides) {
  // Catch-all FIRST (Playwright checks routes newest-first, so specific mocks below win).
  await page.route(/\/api\/v1\/.*/, (route) => json(route, { title: "Not found" }, 404));
  // The membership row's free base (irrelevant to the strength card, but the hub paints it).
  await page.route(/\/api\/v1\/me\/membership/, (route) =>
    json(route, { tier: "PAY_PER_EVENT", firstEventCreditAvailable: true }),
  );
  await page.route(/\/api\/v1\/me$/, (route) => json(route, { ...ME_BASE, ...meOverrides }));
}

// Boot the SPA signed-out, then reveal the profile surface — flips ONLY the same hidden/body-class seams
// router.js flips for a signed-in user; the profile DOM + CSS are untouched production UI. When `photo`
// is set, stub a photoURL on the mock Firebase auth user BEFORE the paint so `hasPhoto` is true (the ring
// reads currentUser().photoURL live) — the only way to exercise the photo field in mock mode.
async function bootProfile(page, { photo }) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  // Boot-splash holds ~3.2s — settle well past it before touching/shooting anything.
  await page.waitForFunction(() => window.tmProfile, { timeout: 30_000 });
  await page.waitForTimeout(4_000);
  await page.evaluate((photoUrl) => {
    // Stub a signed-in-looking Firebase user carrying a photoURL so the strength's photo field counts.
    if (photoUrl && window.tmAuth && window.tmAuth.auth) {
      try {
        // A minimal Firebase-User-shaped stub: `photoURL` is what the strength reads, and `getIdToken`
        // must exist because the app mints an Authorization header off currentUser before fetching /me
        // (without it, load() throws and the hub never paints). The /me response itself is route-mocked.
        const stubUser = { uid: "capture-uid", photoURL: photoUrl, getIdToken: () => Promise.resolve("capture-token") };
        Object.defineProperty(window.tmAuth.auth, "currentUser", {
          configurable: true,
          get() { return stubUser; },
        });
      } catch { /* leave hasPhoto false if the property is locked down */ }
    }
    document.getElementById("boot-screen")?.remove();
    for (const id of ["auth-signed-out", "auth-signed-in"]) {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    }
    const view = document.getElementById("profile-view");
    if (view) view.hidden = false;
    const bar = document.getElementById("app-tabbar");
    if (bar) bar.hidden = false;
    document.body.classList.add("tm-has-tabbar");
    document.getElementById("tab-profile")?.setAttribute("aria-current", "page");
    window.tmProfile.enterProfile("#/profile");
  }, photo ? PHOTO_DATA_URL : null);
  await page.waitForSelector("#profile-form", { state: "visible", timeout: 15_000 });
  await page.evaluate(() => (document.fonts ? document.fonts.ready : Promise.resolve()));
  await page.waitForTimeout(600); // let paintHub + the fill transition settle
}

// Shoot the Profile-strength card (the thing under test) + a full-viewport shot for context.
async function shoot(page, state) {
  const suffix = state.key;
  const card = page.locator(".tm-pf-card").filter({ hasText: "Profile strength" }).first();
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: join(OUT, `TM-913-${PHASE}-${suffix}-card.png`) });
  await page.screenshot({ path: join(OUT, `TM-913-${PHASE}-${suffix}.png`) });

  // Probe (printed as JSON so the verdict is grounded, not eyeballed): the visible strength number + the
  // ring's aria-valuenow (after) or the bar width (before), so we can assert the state actually rendered.
  const probe = await page.evaluate(() => {
    const ring = document.querySelector(".tm-pf-ring");
    const pct = document.querySelector(".tm-pf-ring-pct")?.textContent
      || document.querySelector(".tm-pf-barlbl > span")?.textContent
      || "";
    const barI = document.querySelector(".tm-pf-bar > i");
    return {
      hasRing: Boolean(ring),
      ringRole: ring?.getAttribute("role") || null,
      ariaValueNow: ring?.getAttribute("aria-valuenow") || null,
      centreLabel: pct.trim(),
      hasBar: Boolean(barI),
      barWidth: barI ? getComputedStyle(barI).width : null,
    };
  });
  console.log(`  ${state.label}:`, JSON.stringify(probe));
  return probe;
}

async function main() {
  await mkdir(OUT, { recursive: true });

  const server = spawn(process.execPath, [join(HERE, "serve.mjs")], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: "inherit",
  });
  const stopServer = () => { try { server.kill("SIGTERM"); } catch { /* already gone */ } };
  process.on("exit", stopServer);

  const browser = await chromium.launch();
  // The mandated Android-mobile viewport for ticket evidence (~390×844).
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

  try {
    for (let i = 0; i < 40; i++) {
      try { const r = await context.request.get(`${BASE}/`); if (r.ok()) break; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }

    for (const state of STATES) {
      const page = await context.newPage();
      await mockApi(page, state.me);
      await bootProfile(page, { photo: state.photo });
      await shoot(page, state);
      await page.close();
    }
  } finally {
    await browser.close();
    stopServer();
  }
  console.log(`\nShots written to ${OUT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
