// TM-1066 — visual evidence capture for the event create form at 390px: the timezone selector moved
// under a collapsed "More options" <details>, and derived from the picked venue.
//
// Mock-mode only (pattern: capture-tm1067.mjs). Boots the real SPA via serve.mjs, mocks the admin
// events + venues APIs, then reveals the event create form through the router bridge
// (window.tmAdminEvents.enterAdminEventForm(mode, id)) — mock mode has no Firebase session, so we drive
// the view function directly rather than the router's admin gate.
//
// Shots (390px, the mobile admin width):
//   01-form-collapsed      — the create form; "More options" is present + COLLAPSED (timezone hidden),
//                            and the timezone field's hint reads "Derived from the venue…".
//   02-venue-picked-derived — after picking the seeded venue (Asia/Karachi) then opening More options:
//                            the timezone shows the DERIVED "Asia/Karachi" value.
//
// The BEFORE tree has no "More options" — running this same script against main's JS yields the old
// layout (timezone inline, no disclosure), which is the before/after contrast.
//
// Usage:  CAPTURE_OUT=/abs/path CAPTURE_PORT=8266 node capture-tm1066.mjs

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm1066");
const PORT = Number(process.env.CAPTURE_PORT || 8266);
const BASE = `http://127.0.0.1:${PORT}`;

// A seeded active venue carrying a timezone so the "after" derive shows a value.
const VENUE = {
  id: 7,
  name: "Marhaba Community Hall",
  addressLine: "12 High Street, London E1 6AA",
  city: "London",
  timezone: "Asia/Karachi",
  active: true,
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
  // The active-venue list the picker loads (so a venue is pickable in the "after" shot).
  await page.route(/\/api\/v1\/admin\/venues(\?.*)?$/, (route) =>
    json(route, { items: [VENUE], page: 0, size: 100, totalElements: 1, totalPages: 1 }),
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

    // 01 — the create form; "More options" collapsed (AFTER only; BEFORE has the timezone inline).
    await page.locator("#admin-event-form-view").screenshot({ path: join(OUT, "01-form-collapsed.png") });
    console.log("  ✓ 01-form-collapsed.png");

    // 02 — pick the seeded venue (Asia/Karachi), then open More options to show the DERIVED timezone.
    // (These selectors only exist on the AFTER tree; on BEFORE the script logs the miss and skips 02.)
    const hasMoreOptions = await page.locator("#event-more-options-toggle").count();
    if (hasMoreOptions) {
      await page.locator("#event-venue").selectOption(String(VENUE.id));
      await page.waitForTimeout(300);
      await page.locator("#event-more-options-toggle").click();
      await page.waitForTimeout(300);
      await settle(page);
      await page.locator("#admin-event-form-view").screenshot({ path: join(OUT, "02-venue-picked-derived.png") });
      console.log("  ✓ 02-venue-picked-derived.png (timezone should read Asia/Karachi)");
    } else {
      console.log("  · no #event-more-options-toggle (BEFORE tree) — skipping shot 02");
    }

    await page.close();
  } finally {
    await browser.close();
    stopServer();
  }
  console.log(`\nShots written to ${OUT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
