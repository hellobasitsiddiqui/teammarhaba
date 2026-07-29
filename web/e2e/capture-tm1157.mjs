// TM-1157 — visual evidence capture for the event create/edit form at 390px: the new booking-cutoff
// ("Stop accepting RSVPs N hours before start") override control, which lives under the "More options"
// <details> next to the timezone (mirroring the TM-1066 timezone / TM-408 reveal three-tier idiom).
//
// Mock-mode only (pattern: capture-tm1066.mjs). Boots the real SPA via serve.mjs, mocks the admin
// events + venues APIs, then reveals the event create form through the router bridge
// (window.tmAdminEvents.enterAdminEventForm(mode, id)) — mock mode has no Firebase session, so we drive
// the view function directly rather than the router's admin gate. This also SIDESTEPS the local-Chromium
// "no plain UTC zone" gotcha (blackboard 2026-07-18): we never selectOption a timezone here.
//
// Shots (390px, the mobile admin width):
//   01-more-options-open   — the create form with "More options" OPEN. AFTER: the booking-cutoff field
//                            ("Stop accepting RSVPs …") sits under the timezone, with placeholder "1"
//                            (the effective inherited app default) + its inherit helper text. BEFORE
//                            (main's JS): the disclosure holds ONLY the timezone — no cutoff field.
//
// The BEFORE / AFTER contrast is the SAME script run against main's JS vs this branch: on main the
// #event-booking-cutoff-hours field is absent, so the disclosure shows timezone-only.
//
// Usage:  CAPTURE_OUT=/abs/path CAPTURE_PORT=8267 node capture-tm1157.mjs

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm1157");
const PORT = Number(process.env.CAPTURE_PORT || 8267);
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
  const context = await browser.newContext({ viewport: { width: 390, height: 1100 } });
  try {
    for (let i = 0; i < 40; i++) {
      try { const r = await context.request.get(`${BASE}/`); if (r.ok()) break; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 250));
    }

    const page = await context.newPage();
    await mockApi(page);
    await bootShell(page);
    await revealForm(page);

    // Open "More options" so the disclosure body is visible in the shot.
    await page.locator("#event-more-options-toggle").click();
    await page.waitForTimeout(300);
    // Scroll the disclosure into view so the cutoff field is framed (it sits near the form bottom).
    await page.locator("#event-more-options").scrollIntoViewIfNeeded();
    await settle(page);

    const hasCutoff = await page.locator("#event-booking-cutoff-hours").count();
    console.log(hasCutoff
      ? "  · #event-booking-cutoff-hours present (AFTER tree)"
      : "  · #event-booking-cutoff-hours ABSENT (BEFORE tree — timezone-only disclosure)");

    await page.locator("#event-more-options").screenshot({ path: join(OUT, "01-more-options-open.png") });
    console.log("  ✓ 01-more-options-open.png");

    await page.close();
  } finally {
    await browser.close();
    stopServer();
  }
  console.log(`\nShots written to ${OUT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
