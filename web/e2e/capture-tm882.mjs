// TM-882 — before/after visual evidence capture for the Profile membership row's Manage affordance.
//
// Mock-mode only (pattern: capture-tm771.mjs). Boots the real SPA via serve.mjs (which ships the
// membership flag OFF, matching prod), mocks GET /api/v1/me + /me/membership, reveals the profile view
// through the same hidden-flag seams router.js flips, and shoots the membership card at an
// Android-mobile viewport (390x844).
//
//   • Run from a checkout WITHOUT the fix (main)  → the flag-OFF row shows the muted, non-interactive
//     "Manage →" label that reads as a dead link (BEFORE).
//   • Run from a checkout WITH the fix (TM-882)   → the flag-OFF row shows the unambiguous
//     "Coming soon" badge (AFTER); a second page with the flag forced ON (the paid-rsvp.spec.mjs
//     config-accessor seam) proves the live "Manage →" link is untouched.
//
// Usage:  PHASE=before node capture-tm882.mjs      (writes capture-out-tm882/TM-882-before-*.png)
//         PHASE=after  node capture-tm882.mjs
//         CAPTURE_OUT=/abs/path CAPTURE_PORT=8196 PHASE=... node capture-tm882.mjs

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm882");
const PORT = Number(process.env.CAPTURE_PORT || 8196);
const PHASE = process.env.PHASE || "after"; // "before" (main) | "after" (this branch)
const BASE = `http://127.0.0.1:${PORT}`;

// A realistic MeResponse-shaped payload (matches the me() fixture in web/tools/profile-core.test.mjs).
const ME = {
  uid: "capture-uid",
  email: "capture@example.com",
  displayName: "",
  firstName: "Ghalia",
  lastName: "Qazi",
  city: "London",
  age: 28,
  phone: "+44 20 7946 0958",
  notificationPref: "EMAIL",
  timezone: "Europe/London",
  locale: "en-GB",
  role: "USER",
  enabled: true,
  themeAccent: "teal",
  themeSketchy: true,
  accountState: { emailVerified: true, mfaEnabled: false, phoneVerified: false, photoURL: null, lastLoginAt: null },
};

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function mockApi(page) {
  // Catch-all FIRST (Playwright checks routes newest-first, so specific mocks below win).
  await page.route(/\/api\/v1\/.*/, (route) => json(route, { title: "Not found" }, 404));
  // The free base — the row's sub text stays "Pay as you go · first event free" in both phases.
  await page.route(/\/api\/v1\/me\/membership/, (route) =>
    json(route, { tier: "PAY_PER_EVENT", firstEventCreditAvailable: true }),
  );
  await page.route(/\/api\/v1\/me$/, (route) => json(route, ME));
}

// Boot the SPA signed-out, then reveal the profile surface — flips ONLY the same hidden/body-class
// seams router.js flips for a signed-in user; the profile DOM + CSS are untouched production UI.
async function bootProfile(page) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  // Boot-splash holds ~3.2s — settle well past it before touching/shooting anything.
  await page.waitForFunction(() => window.tmProfile, { timeout: 30_000 });
  await page.waitForTimeout(4_000);
  await page.evaluate(() => {
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
  });
  await page.waitForSelector("#profile-form", { state: "visible", timeout: 15_000 });
  await page.evaluate(() => (document.fonts ? document.fonts.ready : Promise.resolve()));
  await page.waitForTimeout(450);
}

// Shot the membership card (the row under test) + the top of the profile hub for context.
async function shoot(page, suffix) {
  const card = page.locator(".tm-pf-memb");
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: join(OUT, `TM-882-${PHASE}-${suffix}-card.png`) });
  await page.screenshot({ path: join(OUT, `TM-882-${PHASE}-${suffix}.png`) });
  console.log(`  ✓ TM-882-${PHASE}-${suffix}[-card].png`);
}

// Force the membership flag ON before any app script runs (the paid-rsvp.spec.mjs seam): serve.mjs
// freezes TEAMMARHABA_CONFIG with the flag OFF, then config.js assigns its own frozen config — an
// accessor whose setter re-merges flags.membership=true wins over both.
const FLAG_ON_INIT = () => {
  const merge = (cfg) =>
    Object.freeze({ ...(cfg || {}), flags: Object.freeze({ ...((cfg && cfg.flags) || {}), membership: true }) });
  let current = merge(window.TEAMMARHABA_CONFIG || {});
  Object.defineProperty(window, "TEAMMARHABA_CONFIG", {
    configurable: true,
    get() { return current; },
    set(next) { current = merge(next); },
  });
};

async function main() {
  await mkdir(OUT, { recursive: true });

  const server = spawn(process.execPath, [join(HERE, "serve.mjs")], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: "inherit",
  });
  const stopServer = () => { try { server.kill("SIGTERM"); } catch { /* already gone */ } };
  process.on("exit", stopServer);

  const browser = await chromium.launch();
  // The mandated Android-mobile viewport for ticket evidence (~390x844).
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

  try {
    for (let i = 0; i < 40; i++) {
      try { const r = await context.request.get(`${BASE}/`); if (r.ok()) break; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }

    // 1 — flag OFF (the shipped default): the state this ticket changes.
    const page = await context.newPage();
    await mockApi(page);
    await bootProfile(page);
    await shoot(page, "profile-membership");
    await page.close();

    // 2 — flag ON: the live "Manage →" link must render unchanged in both phases.
    const pageOn = await context.newPage();
    await pageOn.addInitScript(FLAG_ON_INIT);
    await mockApi(pageOn);
    await bootProfile(pageOn);
    await shoot(pageOn, "profile-membership-flag-on");
    await pageOn.close();
  } finally {
    await browser.close();
    stopServer();
  }
  console.log(`\nShots written to ${OUT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
