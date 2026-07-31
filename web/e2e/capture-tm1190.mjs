// TM-1190 — visual evidence for the sticky Save action bar on the admin event form at 390px.
//
// The contrast this captures is BETWEEN branches (the change is the sticky bar itself), so run the SAME
// script twice — once on clean main (label=before), once on this branch (label=after) — pointing CAPTURE_OUT
// at the right subfolder each time (the caller stash-toggles the source between runs):
//   before — clean main: the Save row is an ordinary in-flow footer. Scrolled to the TOP of a tall form,
//            the primary Save is off-screen (buried at the very bottom) — the fixed viewport shot shows no
//            Save button.
//   after  — this branch: the Save row is pinned in a sticky .tm-event-actions-bar. Scrolled to the same
//            top-of-form position, the primary Save (#event-save) stays visible at the bottom of the
//            viewport, above the tab bar, with its top border/shadow.
// Each label also takes a full-page shot so the whole form + the bar's bottom placement are visible.
//
// Mock-mode only (same harness as capture-tm1184.mjs): boots the real SPA via serve.mjs, mocks the admin
// events + venues APIs, reveals the create form via the router bridge (no timezone selectOption → sidesteps
// the local-Chromium "no plain UTC zone" gotcha). We also flip on `body.tm-has-tabbar` + reveal the tab bar
// so the sticky-bar-clears-the-tab-bar layout is exercised exactly as a signed-in admin sees it.
//
// Usage:  CAPTURE_OUT=/abs/path CAPTURE_PORT=8290 node capture-tm1190.mjs

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm1190");
const PORT = Number(process.env.CAPTURE_PORT || 8290);
const BASE = `http://127.0.0.1:${PORT}`;

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function mockApi(page) {
  const me = {
    uid: "capture-admin", email: "admin@example.com", displayName: "Capture Admin",
    firstName: "Cap", lastName: "Admin", role: "ADMIN", enabled: true,
    onboardingCompleted: true, notificationPref: "EMAIL", timezone: "Europe/London", locale: "en-GB",
    phone: "+447700900123",
    accountState: { emailVerified: true, mfaEnabled: false, phoneVerified: true, photoURL: null, lastLoginAt: null },
  };
  await page.route(/\/api\/v1\/.*/, (route) => json(route, { title: "Not found" }, 404));
  await page.route(/\/api\/v1\/me$/, (route) => json(route, me));
  await page.route(/\/api\/v1\/me\/membership/, (route) => json(route, { title: "Not found" }, 404));
  await page.route(/\/api\/v1\/admin\/venues(\?.*)?$/, (route) =>
    json(route, { items: [], page: 0, size: 100, totalElements: 0, totalPages: 0 }),
  );
}

async function bootShell(page) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.tmAdminEvents, { timeout: 30_000 });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    document.getElementById("boot-screen")?.remove();
    for (const id of ["auth-signed-out", "auth-signed-in"]) {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    }
    // Mirror the signed-in admin state so the sticky bar's tab-bar clearance is exercised: the tab bar is
    // fixed at the bottom and body.tm-has-tabbar lifts the sticky bar above it.
    document.body.classList.add("tm-has-tabbar");
    const bar = document.querySelector(".app-tabbar");
    if (bar) bar.hidden = false;
  });
}

async function settle(page) {
  await page.evaluate(() => (document.fonts ? document.fonts.ready : Promise.resolve()));
  await page.waitForTimeout(400);
}

async function revealForm(page) {
  await page.evaluate(() => {
    const list = document.getElementById("admin-events-view");
    if (list) list.hidden = true;
    const view = document.getElementById("admin-event-form-view");
    if (view) view.hidden = false;
    window.tmAdminEvents.enterAdminEventForm("create", null);
  });
  await page.waitForSelector("#event-form", { state: "visible", timeout: 15_000 });
  await page.waitForTimeout(500);
}

async function main() {
  const label = process.env.CAPTURE_LABEL || "shot";
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const server = spawn(process.execPath, [join(HERE, "serve.mjs")], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: "inherit",
  });
  const stopServer = () => { try { server.kill("SIGTERM"); } catch { /* gone */ } };
  process.on("exit", stopServer);

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    for (let i = 0; i < 40; i++) {
      try { const r = await context.request.get(`${BASE}/`); if (r.ok()) break; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 250));
    }

    const page = await context.newPage();
    await mockApi(page);
    await bootShell(page);
    await revealForm(page);
    await settle(page);

    // Scroll to the TOP of the form so the ordinary footer Save would be off-screen. On this branch the
    // sticky bar keeps Save pinned at the bottom of THIS fixed-height viewport shot; on main it's absent.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    const saveInView = await page.locator("#event-save").isVisible().catch(() => false);
    let inViewport = false;
    try {
      inViewport = await page.locator("#event-save").evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= window.innerHeight;
      });
    } catch { /* not present on main-before path is fine */ }
    console.log(`  · [${label}] #event-save present=${saveInView} within-viewport-while-scrolled-top=${inViewport}`);
    await page.screenshot({ path: join(OUT, `${label}-01-scrolled-top.png`), fullPage: false });
    console.log(`  ✓ ${label}-01-scrolled-top.png (390x844 fixed viewport, scrolled to top of form)`);

    // Whole-form shot so the bar's bottom placement + full field list are visible.
    await page.screenshot({ path: join(OUT, `${label}-02-fullpage.png`), fullPage: true });
    console.log(`  ✓ ${label}-02-fullpage.png (full form)`);

    await page.close();
  } finally {
    await browser.close();
    stopServer();
  }
  console.log(`\nShots written to ${OUT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
