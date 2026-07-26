// TM-1076 — visual evidence capture for the event create form at 390px: the new Price control that
// defaults to Free (so a form-created event is £0, not the old silent £5), plus its Custom £ input.
//
// Mock-mode only (pattern: capture-tm1066.mjs). Boots the real SPA via serve.mjs, mocks /api/v1/me,
// then reveals the event create form through the router bridge
// (window.tmAdminEvents.enterAdminEventForm("create", null)) — mock mode has no Firebase session, so we
// drive the view function directly rather than the router's admin gate. This ALSO sidesteps the local
// Chromium "no plain UTC zone" wall the admin-events spec hits, since we never selectOption("UTC").
//
// Shots (390px, the mobile admin width):
//   01-price-default-free  — the create form's Price control, DEFAULTING to "Free (£0)" (active chip).
//   02-price-custom-open   — after tapping the Custom price chip: the £ amount input is revealed.
//
// The BEFORE tree (origin/main) has NO Price control at all — running this same script against main's
// JS yields a form with no `.tm-price-band`, which is the before/after contrast (the script logs the
// miss and still shots the form so the absence is visible).
//
// Usage:  CAPTURE_OUT=/abs/path CAPTURE_PORT=8276 node capture-tm1076.mjs

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm1076");
const PORT = Number(process.env.CAPTURE_PORT || 8276);
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
  // The active-venue list the picker loads (empty is fine — the price control doesn't depend on it).
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
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
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

    // Scroll the Price control into view (it sits after the limits/age rows) so the shot frames it.
    const hasPrice = await page.locator(".tm-price-band").count();
    if (hasPrice) {
      await page.locator(".tm-price-band").scrollIntoViewIfNeeded();
      await settle(page);
      await page.locator("#admin-event-form-view").screenshot({ path: join(OUT, "01-price-default-free.png") });
      console.log("  ✓ 01-price-default-free.png (Free chip active by default)");

      // Tap the Custom price chip to reveal the £ amount input.
      await page.locator('.tm-price-band .tm-chip[data-chip="Custom"]').click();
      await page.waitForSelector("#event-price", { state: "visible", timeout: 5_000 });
      await page.locator(".tm-price-band").scrollIntoViewIfNeeded();
      await settle(page);
      await page.locator("#admin-event-form-view").screenshot({ path: join(OUT, "02-price-custom-open.png") });
      console.log("  ✓ 02-price-custom-open.png (Custom £ input revealed)");
    } else {
      // BEFORE tree: no price control — shot the whole form so the absence is the evidence.
      console.log("  · no .tm-price-band (BEFORE tree) — form has NO price control (silent £5)");
      await page.locator("#admin-event-form-view").screenshot({ path: join(OUT, "01-no-price-control.png"), fullPage: true });
      console.log("  ✓ 01-no-price-control.png");
    }

    await page.close();
  } finally {
    await browser.close();
    stopServer();
  }
  console.log(`\nShots written to ${OUT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
