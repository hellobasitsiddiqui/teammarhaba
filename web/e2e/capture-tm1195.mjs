// TM-1195 — visual evidence capture for the admin event create form at 390px: the regroup of the one
// long single-column form into 5 labelled collapsible sections (Basics · When · Where · Who can join ·
// Booking rules), retiring the standalone "More options" fold.
//
// Mock-mode only (pattern: capture-tm1157.mjs / capture-tm1066.mjs). Boots the real SPA via serve.mjs,
// mocks the admin events + venues APIs, then reveals the REAL event create form through the router bridge
// (window.tmAdminEvents.enterAdminEventForm("create", null)) — mock mode has no Firebase session, so we
// drive the view function directly rather than the router's admin gate. This is the ACTUAL create form,
// not a synthetic harness page. It also SIDESTEPS the local-Chromium "no plain UTC zone" gotcha
// (blackboard 2026-07-18): we never selectOption a timezone here.
//
// The BEFORE / AFTER contrast is the SAME script run against main's JS vs this branch:
//   BEFORE (main's admin-events.js): one long single-column form; the timezone + booking-cutoff live under
//                                    a "More options" <details> near the bottom.
//   AFTER  (this branch):            5 collapsible sections — Basics/When/Where OPEN, Who-can-join/Booking-
//                                    rules COLLAPSED; no More-options fold.
//
// Shots (390px, the mobile admin width):
//   01-form-default   — the create form as it first opens (default fold state).
//   02-form-expanded  — every section expanded (AFTER: all 5 open; BEFORE: no-op, single column).
//
// Usage:  CAPTURE_OUT=/abs/path CAPTURE_PORT=8271 node capture-tm1195.mjs

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm1195");
const PORT = Number(process.env.CAPTURE_PORT || 8271);
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
  // LAST-registered-wins: broad 404 catch-all first, specific routes after.
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
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const server = spawn(process.execPath, [join(HERE, "serve.mjs")], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: "inherit",
  });
  const stopServer = () => { try { server.kill("SIGTERM"); } catch { /* gone */ } };
  process.on("exit", stopServer);

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 1400 } });
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

    // Report which tree we're in so the BEFORE/AFTER attribution is unambiguous in the run log.
    const sectionCount = await page.locator("#event-form details.tm-form-section").count();
    const hasMoreOptions = await page.locator("#event-more-options").count();
    console.log(sectionCount
      ? `  · ${sectionCount} collapsible form section(s) present (AFTER tree — the 5-section regroup)`
      : "  · NO .tm-form-section sections (BEFORE tree — single-column form)");
    console.log(hasMoreOptions
      ? "  · #event-more-options fold present (BEFORE tree)"
      : "  · #event-more-options fold ABSENT (AFTER tree — More options retired)");

    // 01 — the form as it first opens (default fold state).
    await page.locator("#event-form").screenshot({ path: join(OUT, "01-form-default.png") });
    console.log("  ✓ 01-form-default.png");

    // 02 — every section expanded (AFTER: all 5 open; BEFORE: a no-op — nothing to expand).
    await page.evaluate(() => {
      for (const d of document.querySelectorAll("#event-form details.tm-form-section")) d.open = true;
    });
    await settle(page);
    await page.locator("#event-form").screenshot({ path: join(OUT, "02-form-expanded.png") });
    console.log("  ✓ 02-form-expanded.png");

    await page.close();
  } finally {
    await browser.close();
    stopServer();
  }
  console.log(`\nShots written to ${OUT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
