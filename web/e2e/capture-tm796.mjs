// TM-796 — visual evidence capture for the event CREATE form at 390px: the new "Repeat" recurrence
// picker. OFF = the unchanged single create (no recurrence controls); ON reveals the picker — Daily/
// Weekly frequency chips, an "every N" interval, a weekday selector (Weekly), and the end condition
// (Until a date OR After N occurrences).
//
// Mock-mode only (pattern: capture-tm1157.mjs / capture-tm1066.mjs). Boots the real SPA via serve.mjs,
// mocks the admin events + venues APIs, then reveals the create form through the router bridge
// (window.tmAdminEvents.enterAdminEventForm("create", null)) — mock mode has no Firebase session, so we
// drive the view function directly. This also SIDESTEPS the local-Chromium "no plain UTC zone" gotcha
// (blackboard 2026-07-18): we never selectOption a timezone here.
//
// Shots (390px, the mobile admin width):
//   01-repeat-off  — BEFORE: the create form's Repeat control OFF (the recurrence body is hidden), i.e.
//                    the unchanged single-create form. On main's JS the #event-repeat control is ABSENT
//                    entirely — the true before.
//   02-repeat-on   — AFTER: Repeat toggled ON → the recurrence picker revealed (Weekly frequency + the
//                    interval + weekday + end-condition controls). Absent on main.
//
// The BEFORE / AFTER contrast is the SAME script run against main's JS vs this branch: on main the
// #event-repeat control doesn't exist, so only the single-create form renders (01), and 02 is a no-op.
//
// Usage:  CAPTURE_OUT=/abs/path CAPTURE_PORT=8296 node capture-tm796.mjs

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm796");
const PORT = Number(process.env.CAPTURE_PORT || 8296);
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
  const context = await browser.newContext({ viewport: { width: 390, height: 1200 } });
  try {
    for (let i = 0; i < 40; i++) {
      try { const r = await context.request.get(`${BASE}/`); if (r.ok()) break; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 250));
    }

    const page = await context.newPage();
    await mockApi(page);
    await bootShell(page);
    await revealForm(page);

    const hasRepeat = await page.locator("#event-repeat").count();
    console.log(hasRepeat
      ? "  · #event-repeat present (AFTER tree)"
      : "  · #event-repeat ABSENT (BEFORE tree — no recurrence picker)");

    // 01 — Repeat OFF: the create form with the recurrence body hidden (or, on main, no control at all).
    if (hasRepeat) await page.locator("#event-repeat").scrollIntoViewIfNeeded();
    await settle(page);
    await page.screenshot({ path: join(OUT, "01-repeat-off.png"), fullPage: true });
    console.log("  ✓ 01-repeat-off.png");

    // 02 — Repeat ON: toggle it and reveal the picker (a no-op on main, where the control is absent).
    if (hasRepeat) {
      await page.locator("#event-repeat-toggle").check();
      // Weekly reveals the weekday field — pick it so the fullest picker is captured.
      await page.locator('#event-repeat-frequency .tm-chip[data-chip="WEEKLY"]').click();
      await page.waitForTimeout(300);
      await page.locator("#event-repeat").scrollIntoViewIfNeeded();
      await settle(page);
    }
    await page.screenshot({ path: join(OUT, "02-repeat-on.png"), fullPage: true });
    console.log("  ✓ 02-repeat-on.png");

    await page.close();
  } finally {
    await browser.close();
    stopServer();
  }
  console.log(`\nShots written to ${OUT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
