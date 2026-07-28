// TM-1112 + TM-1101 + TM-1113 — visual evidence capture for the event create form at 390px.
//
// Mock-mode only (pattern: capture-tm1076.mjs). Boots the real SPA via serve.mjs, mocks /api/v1/me, then
// reveals the create form through the router bridge (window.tmAdminEvents.enterAdminEventForm("create",
// null)) — mock mode has no Firebase session, so we drive the view function directly. This also sidesteps
// the local Chromium "no plain UTC zone" wall the admin-events spec hits.
//
// Shots (390px, the mobile admin width):
//   01-load-no-location-error — the create form on LOAD: NO "Location is required" error (TM-1112).
//   02-description-templates  — the description template chips above the Description textarea (TM-1113).
//   03-reset-and-dirty-confirm — after typing (dirty), the Reset button + the discard-confirm dialog (TM-1101).
//
// BEFORE contrast: run this same script against the origin/main JS (checkout web/src/assets/*.js) and shot
// 01 shows the "Location is required" error on load; there is no Reset button and no dirty confirm. The
// script logs which state it observed so the before/after is self-describing.
//
// Usage:  CAPTURE_OUT=/abs/path CAPTURE_PORT=8281 node capture-tm1101-1112-1113.mjs

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm1101-1112-1113");
const PORT = Number(process.env.CAPTURE_PORT || 8281);
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
  // Let the venue picker's async list resolve + fire its initial echo (the TM-1112 path).
  await page.waitForTimeout(800);
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

    // ── 01: on LOAD — the location field must NOT show a required error (TM-1112). ──────────────
    const locErrorVisible = await page.evaluate(() => {
      const err = document.getElementById("event-location-error");
      return !!err && !err.hidden && (err.textContent || "").trim().length > 0;
    });
    console.log(locErrorVisible
      ? "  · BEFORE: #event-location-error IS shown on load (the TM-1112 bug)"
      : "  ✓ AFTER: no #event-location-error on load (TM-1112 fixed)");
    await page.locator("#event-location").scrollIntoViewIfNeeded();
    await settle(page);
    await page.locator("#admin-event-form-view").screenshot({ path: join(OUT, "01-load-no-location-error.png") });
    console.log("  ✓ 01-load-no-location-error.png");

    // ── 02: the description template chips above the Description textarea (TM-1113). ────────────
    const hasDescTemplates = await page.locator('[aria-label="Description templates"] .tm-chip').count();
    console.log(hasDescTemplates
      ? `  ✓ AFTER: ${hasDescTemplates} description template chip(s) (TM-1113)`
      : "  · BEFORE: no description template chips");
    if (hasDescTemplates) {
      await page.locator('[aria-label="Description templates"]').scrollIntoViewIfNeeded();
      await settle(page);
      await page.locator("#admin-event-form-view").screenshot({ path: join(OUT, "02-description-templates.png") });
      console.log("  ✓ 02-description-templates.png");
    } else {
      await page.locator("#event-description").scrollIntoViewIfNeeded();
      await settle(page);
      await page.locator("#admin-event-form-view").screenshot({ path: join(OUT, "02-no-description-templates.png") });
      console.log("  ✓ 02-no-description-templates.png");
    }

    // ── 03: the Reset button (TM-1101) + the dirty-exit confirm dialog. ────────────────────────
    const hasReset = await page.locator("#event-reset").count();
    console.log(hasReset ? "  ✓ AFTER: #event-reset present (TM-1101)" : "  · BEFORE: no Reset button");
    // Make the form DIRTY: type a heading.
    await page.fill("#event-heading", "Coffee & Code");
    await settle(page);
    if (hasReset) {
      // Click the back link — a dirty form should raise the discard confirm.
      await page.locator("#admin-event-form-back").click();
      const dialog = page.locator('.tm-dialog[role="dialog"]');
      try {
        await dialog.waitFor({ state: "visible", timeout: 3000 });
        console.log("  ✓ AFTER: dirty back-link raised the discard confirm (TM-1101)");
      } catch {
        console.log("  · dirty confirm did not appear (unexpected)");
      }
      await settle(page);
      await page.screenshot({ path: join(OUT, "03-reset-and-dirty-confirm.png") });
      console.log("  ✓ 03-reset-and-dirty-confirm.png (Reset button in the actions row + discard dialog)");
    } else {
      // BEFORE: no Reset, and the back link discards silently — shot the filled form + its actions row.
      await page.locator(".tm-form-actions").scrollIntoViewIfNeeded();
      await settle(page);
      await page.locator("#admin-event-form-view").screenshot({ path: join(OUT, "03-no-reset-no-dirty-guard.png") });
      console.log("  ✓ 03-no-reset-no-dirty-guard.png");
    }

    await page.close();
  } finally {
    await browser.close();
    stopServer();
  }
  console.log(`\nShots written to ${OUT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
