// TM-1096 — visual evidence capture for the admin events LIST at 390px: the status filter changes
// from a single-select dropdown (default "All statuses") to multi-toggle lifecycle chips (default
// "Happening now"), and a started-not-finished event reads a "Happening" status badge.
//
// Mock-mode only (pattern: capture-tm1066.mjs). Boots the real SPA via serve.mjs, mocks the admin
// events list API with a spread of lifecycle states, then reveals the list through the router bridge
// window.tmAdminEvents.enterAdminEvents() (mock mode has no Firebase session).
//
// Shots (390px, the mobile admin width):
//   01-list-default   — the list on first load. AFTER: lifecycle chips, "Happening now" pressed, ONLY
//                       the live event shown with a "Happening" badge. BEFORE (main's JS): the status
//                       dropdown defaulting "All statuses", every event shown.
//   02-list-all       — AFTER: clicking "All" shows every lifecycle bucket. (BEFORE tree has no chip,
//                       so the script logs the miss and skips this shot.)
//
// The BEFORE tree has no #admin-events-lifecycle-chips — running this same script against main's JS
// yields the dropdown list (all events shown by default), which is the before/after contrast.
//
// Usage:  CAPTURE_OUT=/abs/path CAPTURE_PORT=8296 node capture-tm1096.mjs

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm1096");
const PORT = Number(process.env.CAPTURE_PORT || 8296);
const BASE = `http://127.0.0.1:${PORT}`;

// A spread of lifecycle states around "now" so the before/after filter contrast is visible.
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const H = 3600e3;
const D = 24 * H;

const EVENTS = [
  {
    // HAPPENING: started 1h ago, ends in 2h, window open, not past.
    id: 1, heading: "Coffee & Code (live now)", status: "PUBLISHED", city: "London",
    timezone: "Europe/London", capacity: 20, past: false,
    startAt: iso(now - H), endAt: iso(now + 2 * H),
    visibilityStart: iso(now - 7 * D), visibilityEnd: iso(now + 1 * D),
  },
  {
    // VISIBLE: listed, starts in 5 days.
    id: 2, heading: "Weekend Walk (upcoming)", status: "PUBLISHED", city: "London",
    timezone: "Europe/London", capacity: 30, past: false,
    startAt: iso(now + 5 * D), endAt: iso(now + 5 * D + 2 * H),
    visibilityStart: iso(now - 2 * D), visibilityEnd: iso(now + 10 * D),
  },
  {
    // HIDDEN (chip: Upcoming): scheduled, window not yet open.
    id: 3, heading: "Book Club (scheduled)", status: "PUBLISHED", city: "London",
    timezone: "Europe/London", capacity: 12, past: false,
    startAt: iso(now + 20 * D), endAt: iso(now + 20 * D + 2 * H),
    visibilityStart: iso(now + 14 * D), visibilityEnd: iso(now + 25 * D),
  },
  {
    // FINISHED: server past flag.
    id: 4, heading: "Last Month's Meetup (finished)", status: "PUBLISHED", city: "London",
    timezone: "Europe/London", capacity: 40, past: true,
    startAt: iso(now - 30 * D), endAt: iso(now - 30 * D + 2 * H),
    visibilityStart: iso(now - 40 * D), visibilityEnd: iso(now - 30 * D),
  },
  {
    // CANCELLED.
    id: 5, heading: "Rained-off Picnic (cancelled)", status: "CANCELLED", city: "London",
    timezone: "Europe/London", capacity: 25, past: false,
    startAt: iso(now + 3 * D), endAt: iso(now + 3 * D + 2 * H),
    visibilityStart: iso(now - 2 * D), visibilityEnd: iso(now + 8 * D),
  },
];

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
  // The admin events list walk (page 0 returns all; the walk stops on a short page).
  await page.route(/\/api\/v1\/admin\/events(\?.*)?$/, (route) =>
    json(route, { items: EVENTS, page: 0, size: 100, totalElements: EVENTS.length, totalPages: 1 }),
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

async function revealList(page) {
  await page.evaluate(() => {
    const view = document.getElementById("admin-events-view");
    if (view) view.hidden = false;
    const form = document.getElementById("admin-event-form-view");
    if (form) form.hidden = true;
    window.tmAdminEvents.enterAdminEvents();
  });
  await page.waitForSelector("#admin-events-table", { state: "visible", timeout: 15_000 });
  await page.waitForTimeout(600);
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
    await revealList(page);
    await settle(page);

    // 01 — the list on first load (AFTER: chips, Happening-now default → only the live event).
    await page.locator("#admin-events-view").screenshot({ path: join(OUT, "01-list-default.png") });
    console.log("  ✓ 01-list-default.png");

    // 02 — click "All" to show every bucket (AFTER only; BEFORE has no chip row → skip).
    const hasChips = await page.locator("#admin-events-lifecycle-all").count();
    if (hasChips) {
      await page.locator("#admin-events-lifecycle-all").click();
      await page.waitForTimeout(300);
      await settle(page);
      await page.locator("#admin-events-view").screenshot({ path: join(OUT, "02-list-all.png") });
      console.log("  ✓ 02-list-all.png (every lifecycle bucket shown)");
    } else {
      console.log("  · no #admin-events-lifecycle-all (BEFORE tree, dropdown) — skipping shot 02");
    }

    await page.close();
  } finally {
    await browser.close();
    stopServer();
  }
  console.log(`\nShots written to ${OUT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
