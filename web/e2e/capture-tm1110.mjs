// TM-1110 — visual evidence capture for the admin events lifecycle CHIP ROW at 390px.
//
// TM-1096 shipped the chips with a mislabelled "Upcoming" chip that maps to the Hidden lifecycle
// (now < visibilityStart = not visible yet) — so it's ~always empty, and the admin's real upcoming
// (published, not-yet-started = "Visible") events hide under a chip literally labelled "Visible".
// TM-1110 relabels: Visible bucket → "Upcoming" chip, Hidden bucket → "Scheduled" chip.
//
// BEFORE (main's JS): chip row reads  Happening now · Visible · Upcoming · Unlisted · Finished · Cancelled
// AFTER  (this branch): chip row reads Happening now · Upcoming · Scheduled · Unlisted · Finished · Cancelled
//
// Mock-mode only (pattern: capture-tm1096.mjs). Boots the real SPA via serve.mjs, mocks the admin
// events list API, reveals the list via the router bridge, clicks "All" so every chip is pressed, then
// screenshots the chip row so all bucket labels are visible.
//
// Usage:  CAPTURE_OUT=/abs/path CAPTURE_PORT=8297 node capture-tm1110.mjs

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm1110");
const PORT = Number(process.env.CAPTURE_PORT || 8297);
const BASE = `http://127.0.0.1:${PORT}`;

const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const H = 3600e3;
const D = 24 * H;

// A spread of lifecycle states so the row body has content; the chip row is what we screenshot.
const EVENTS = [
  {
    id: 1, heading: "Coffee & Code (live now)", status: "PUBLISHED", city: "London",
    timezone: "Europe/London", capacity: 20, past: false,
    startAt: iso(now - H), endAt: iso(now + 2 * H),
    visibilityStart: iso(now - 7 * D), visibilityEnd: iso(now + 1 * D),
  },
  {
    // VISIBLE: listed, starts in 5 days → this is the real "Upcoming" event.
    id: 2, heading: "Weekend Walk (upcoming)", status: "PUBLISHED", city: "London",
    timezone: "Europe/London", capacity: 30, past: false,
    startAt: iso(now + 5 * D), endAt: iso(now + 5 * D + 2 * H),
    visibilityStart: iso(now - 2 * D), visibilityEnd: iso(now + 10 * D),
  },
  {
    // HIDDEN: scheduled, window not yet open → the real "Scheduled" event.
    id: 3, heading: "Book Club (scheduled)", status: "PUBLISHED", city: "London",
    timezone: "Europe/London", capacity: 12, past: false,
    startAt: iso(now + 20 * D), endAt: iso(now + 20 * D + 2 * H),
    visibilityStart: iso(now + 14 * D), visibilityEnd: iso(now + 25 * D),
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

    // Click "All" so every chip is pressed and all bucket labels render, then shoot the chip row.
    const hasAll = await page.locator("#admin-events-lifecycle-all").count();
    if (!hasAll) throw new Error("no #admin-events-lifecycle-all — is this the chips tree?");
    await page.locator("#admin-events-lifecycle-all").click();
    await page.waitForTimeout(300);
    await settle(page);

    await page.locator("#admin-events-lifecycle-chips").screenshot({ path: join(OUT, "chip-row.png") });
    console.log("  ✓ chip-row.png");
    // Full view for context.
    await page.locator("#admin-events-view").screenshot({ path: join(OUT, "list-all.png") });
    console.log("  ✓ list-all.png");

    // The literal chip labels, in order, as a machine-checkable text record.
    const labels = await page.$$eval("#admin-events-lifecycle-chips .tm-chip", (btns) =>
      btns.filter((b) => !b.classList.contains("tm-chip-all")).map((b) => b.textContent.trim()),
    );
    console.log("  chip labels:", JSON.stringify(labels));

    await page.close();
  } finally {
    await browser.close();
    stopServer();
  }
  console.log(`\nShots written to ${OUT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
