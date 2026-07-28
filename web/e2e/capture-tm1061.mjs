// TM-1061 — visual evidence capture for Clone/Duplicate an event with a time offset, at 390px.
//
// Mock-mode only (pattern: capture-tm1096.mjs) — boots the real SPA via serve.mjs, mocks the admin events
// list API, and drives the console through the router bridge window.tmAdminEvents (mock mode has no
// Firebase session). Europe/London on the events so it runs on this host (the local Chromium lacks a plain
// "UTC" zone — see blackboard).
//
// Shots (390px, the mobile admin width):
//   01-row-actions   — a past event row. AFTER: a "Clone" button sits alongside the (disabled) Edit.
//                      BEFORE (main's JS): no Clone button on any row.
//   02-offset-picker — AFTER: tapping Clone opens the offset-preset picker, LOCKED to +7 days / +7 hours.
//                      (BEFORE: no Clone → the script logs the miss and skips shots 02-03.)
//   03-clone-draft   — AFTER: picking +7 days opens a PRE-FILLED create draft — heading copied, times
//                      shifted +7 days, opening message blank.
//
// The BEFORE tree has no Clone control, so running this same script against main's JS yields only shot 01
// (the row with Edit-only actions) and logs the missing seam — that IS the before/after contrast.
//
// Usage:  CAPTURE_OUT=/abs/path CAPTURE_PORT=8361 node capture-tm1061.mjs

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm1061");
const PORT = Number(process.env.CAPTURE_PORT || 8361);
const BASE = `http://127.0.0.1:${PORT}`;

const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const H = 3600e3;
const D = 24 * H;

// A PAST event (finished) + an upcoming one, so the row-actions shot shows Clone next to a disabled Edit
// (past) AND full actions (upcoming). Cloning a past event forward is a primary TM-1061 use case.
const EVENTS = [
  {
    id: 1, heading: "Coffee & Code (last month)", status: "PUBLISHED", city: "London",
    timezone: "Europe/London", capacity: 20, past: true,
    startAt: iso(now - 30 * D), endAt: iso(now - 30 * D + 2 * H),
    visibilityStart: iso(now - 40 * D), visibilityEnd: iso(now - 29 * D),
    openingMessage: "Welcome! Say hi in the chat when you arrive.",
    description: "Bring a laptop and a mug — we pair on the app.",
    locationText: "Marhaba Cafe, 12 High St", pricePence: 0,
  },
  {
    id: 2, heading: "Weekend Walk (upcoming)", status: "PUBLISHED", city: "London",
    timezone: "Europe/London", capacity: 30, past: false,
    startAt: iso(now + 5 * D), endAt: iso(now + 5 * D + 2 * H),
    visibilityStart: iso(now - 2 * D), visibilityEnd: iso(now + 10 * D),
    description: "A relaxed loop of the park.", locationText: "Willen Lake car park", pricePence: 0,
  },
];

function json(route, body, status = 200) {
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

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
    json(route, { items: [], page: 0, size: 100, totalElements: 0, totalPages: 1 }),
  );
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
  // Show every lifecycle bucket so the past event is visible (default filter hides it).
  const all = await page.locator("#admin-events-lifecycle-all").count();
  if (all) { await page.locator("#admin-events-lifecycle-all").click(); await page.waitForTimeout(300); }
  await page.waitForTimeout(400);
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

    // 01 — the list: every row carries a Clone action (AFTER). BEFORE: no Clone control anywhere.
    await page.locator("#admin-events-view").screenshot({ path: join(OUT, "01-row-actions.png") });
    console.log("  ✓ 01-row-actions.png");

    const cloneBtn = page.locator('tr[data-event-id="1"]').getByRole("button", { name: /^Clone / });
    const hasClone = await cloneBtn.count();
    if (!hasClone) {
      console.log("  · no Clone control (BEFORE tree) — skipping shots 02-03");
    } else {
      // 02 — the offset-preset picker (LOCKED to +7 days / +7 hours).
      await cloneBtn.click();
      await page.waitForSelector(".tm-clone-offset-choices", { state: "visible", timeout: 10_000 });
      await settle(page);
      await page.screenshot({ path: join(OUT, "02-offset-picker.png") });
      console.log("  ✓ 02-offset-picker.png");

      // 03 — pick +7 days → the pre-filled create draft (heading copied, times shifted, opening blank).
      // startCloneEvent stashes the draft + sets the create hash; in mock mode the router isn't driving the
      // view, so mount the form via the bridge (it reads-and-clears the same one-shot stash the router would).
      await page.locator('.tm-clone-offset-btn[data-offset="+7 days"]').click();
      await page.evaluate(async () => {
        const form = document.getElementById("admin-event-form-view");
        const list = document.getElementById("admin-events-view");
        if (list) list.hidden = true;
        if (form) form.hidden = false;
        await window.tmAdminEvents.enterAdminEventForm("create");
      });
      await page.waitForSelector("#event-form", { state: "visible", timeout: 10_000 });
      await settle(page);
      await page.screenshot({ path: join(OUT, "03-clone-draft.png") });
      const heading = await page.locator("#event-heading").inputValue();
      const opening = await page.locator("#event-opening-message").inputValue();
      console.log(`  ✓ 03-clone-draft.png (heading="${heading}", openingMessage="${opening}")`);
    }

    await page.close();
  } finally {
    await browser.close();
    stopServer();
  }
  console.log(`\nShots written to ${OUT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
