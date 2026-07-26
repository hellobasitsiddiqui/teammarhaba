// TM-1067 — visual evidence capture for the venues console create/edit form at 390px.
//
// Mock-mode only (pattern: capture-tm779.mjs). Boots the real SPA via serve.mjs, mocks the admin venues
// API, then reveals the venue form through the same bridge the router uses
// (window.tmAdminVenues.enterAdminVenueForm(mode, id)) — mock mode has no Firebase session, so we drive
// the view function directly rather than the router's admin gate.
//
// Shots (390px, the mobile admin width):
//   01-create-form — the empty create form (after = with the new "Time zone (optional)" select + "Use mine").
//   02-edit-form   — an edit form prefilled from a seeded venue that carries timezone "Asia/Karachi".
//
// Run it once on this branch (after) and once against main's JS (before) to get the before/after pair.
//
// Usage:  CAPTURE_OUT=/abs/path CAPTURE_PORT=8267 node capture-tm1067.mjs

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm1067");
const PORT = Number(process.env.CAPTURE_PORT || 8267);
const BASE = `http://127.0.0.1:${PORT}`;

// A seeded venue for the edit prefill — carries a timezone so the "after" edit form shows it selected.
const VENUE = {
  id: 7,
  name: "Marhaba Community Hall",
  addressLine: "12 High Street, London E1 6AA",
  city: "London",
  latitude: 51.5074,
  longitude: -0.1278,
  mapUrl: null,
  notes: "Meet at the north entrance.",
  capacity: 120,
  accessibility: "Step-free access; accessible toilets.",
  parking: "Free after 6pm.",
  indoorOutdoor: "INDOOR",
  timezone: "Asia/Karachi",
  photoPath: null,
  active: true,
  createdBy: 1,
  createdAt: "2026-06-01T12:00:00Z",
  updatedAt: "2026-07-01T12:00:00Z",
};

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
  // GET one venue by id (edit prefill) + PATCH echo.
  await page.route(/\/api\/v1\/admin\/venues\/(\d+)$/, (route) => json(route, VENUE));
  // The paged list (defensive — the form view doesn't need it, but keep it 200).
  await page.route(/\/api\/v1\/admin\/venues(\?.*)?$/, (route) =>
    json(route, { items: [VENUE], page: 0, size: 100, totalElements: 1, totalPages: 1 }),
  );
}

async function bootShell(page) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.tmAdminVenues, { timeout: 30_000 });
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

async function revealForm(page, mode, id) {
  await page.evaluate(({ mode, id }) => {
    const list = document.getElementById("admin-venues-view");
    if (list) list.hidden = true;
    const view = document.getElementById("admin-venue-form-view");
    if (view) view.hidden = false;
    window.tmAdminVenues.enterAdminVenueForm(mode, id);
  }, { mode, id });
  await page.waitForSelector("#venue-form", { state: "visible", timeout: 15_000 });
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

    // 01 — the create form (empty).
    const createPage = await context.newPage();
    await mockApi(createPage);
    await bootShell(createPage);
    await revealForm(createPage, "create", null);
    await settle(createPage);
    await createPage.locator("#admin-venue-form-view").screenshot({ path: join(OUT, "01-create-form.png") });
    console.log("  ✓ 01-create-form.png");
    await createPage.close();

    // 02 — an edit form, prefilled from the seeded venue (id 7).
    const editPage = await context.newPage();
    await mockApi(editPage);
    await bootShell(editPage);
    await revealForm(editPage, "edit", "7");
    await settle(editPage);
    await editPage.locator("#admin-venue-form-view").screenshot({ path: join(OUT, "02-edit-form.png") });
    console.log("  ✓ 02-edit-form.png");
    await editPage.close();
  } finally {
    await browser.close();
    stopServer();
  }
  console.log(`\nShots written to ${OUT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
