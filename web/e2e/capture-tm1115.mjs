// TM-1115 — before/after visual evidence for the admin roster at 390px.
//
// BEFORE (run against main's JS): the Roster button opens an INLINE expando panel below the row in the
//   events list (openRosterId / rosterPanelRow). 2-state badges (Going / Waitlist), no page, no chips.
// AFTER (this branch's JS): the Roster button NAVIGATES to the roster PAGE (#/admin/events/{id}/roster).
//   4-state badges (Going / Waitlist / Evicted / Cancelled), include/exclude chips (waitlist on,
//   evicted/cancelled off by default) that filter the already-fetched set with no refetch.
//
// Mock-mode only (pattern: capture-tm1096.mjs). Boots the real SPA via serve.mjs, mocks the admin events
// list + the roster endpoint (entries + pastEntries), and drives through the router bridge
// window.tmAdminEvents. The script auto-detects which tree it's on: if window.tmAdminEvents has
// enterAdminEventRoster it captures the AFTER page flow; otherwise it captures the BEFORE inline expando.
//
// Usage:  CAPTURE_OUT=/abs/path CAPTURE_PORT=8315 node capture-tm1115.mjs

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm1115");
const PORT = Number(process.env.CAPTURE_PORT || 8315);
const BASE = `http://127.0.0.1:${PORT}`;

const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const H = 3600e3;
const D = 24 * H;
const EVENT_ID = 1;

const EVENT = {
  // "Happening" now (started 1h ago, ends in 2h) so it survives the console's default lifecycle chip
  // (which lands on "Happening now") — the Roster button is then on the visible row.
  id: EVENT_ID, heading: "Coffee & Code", status: "PUBLISHED", city: "London",
  timezone: "Europe/London", capacity: 2, past: false,
  startAt: iso(now - H), endAt: iso(now + 2 * H),
  visibilityStart: iso(now - 2 * D), visibilityEnd: iso(now + 8 * D),
  goingCount: 1, waitlistCount: 1,
};

// The roster payload (TM-1114 shape): a live GOING + WAITLISTED, plus two past exits (an admin evict and
// a self-cancel) so all four badge states + the chip filter are exercised in the AFTER shots.
const ROSTER = {
  eventId: EVENT_ID, capacity: 2, going: 1, waitlist: 1,
  entries: [
    { userId: 10, displayName: "Ada Going", state: "GOING", overCapacity: false },
    { userId: 11, displayName: "Ben Waiting", state: "WAITLISTED", overCapacity: false },
  ],
  pastEntries: [
    { userId: 12, displayName: "Cy Evicted", lastState: "EVICTED", at: iso(now - 2 * D), byAdmin: true },
    { userId: 13, displayName: "Di Cancelled", lastState: "CANCELLED", at: iso(now - 1 * D), byAdmin: false },
  ],
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
  await page.route(/\/api\/v1\/.*/, (route) => json(route, { title: "Not found" }, 404));
  await page.route(/\/api\/v1\/me$/, (route) => json(route, me));
  await page.route(/\/api\/v1\/me\/membership/, (route) => json(route, { title: "Not found" }, 404));
  await page.route(/\/api\/v1\/admin\/events\/1\/roster$/, (route) => json(route, ROSTER));
  await page.route(/\/api\/v1\/admin\/events\/1$/, (route) => json(route, EVENT));
  await page.route(/\/api\/v1\/admin\/events(\?.*)?$/, (route) =>
    json(route, { items: [EVENT], page: 0, size: 100, totalElements: 1, totalPages: 1 }),
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
    for (const id of ["admin-event-form-view", "admin-event-roster-view"]) {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    }
    window.tmAdminEvents.enterAdminEvents();
  });
  await page.waitForSelector("#admin-events-table", { state: "visible", timeout: 15_000 });
  await page.waitForTimeout(600);
}

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const server = spawn(process.execPath, [join(HERE, "serve.mjs")], {
    env: { ...process.env, PORT: String(PORT) }, stdio: "inherit",
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

    // Shot 01 — the events list (both trees). The Roster button is present on the row.
    await page.locator("#admin-events-view").screenshot({ path: join(OUT, "01-events-list.png") });
    console.log("  ✓ 01-events-list.png");

    const isAfter = await page.evaluate(() => !!window.tmAdminEvents.enterAdminEventRoster);

    // Click the row's Roster button.
    await page.locator(`.tm-actions button[aria-label^="Manage roster"]`).first().click();
    await page.waitForTimeout(500);

    if (isAfter) {
      // AFTER: navigated to the roster PAGE.
      await page.evaluate(() => {
        // In mock mode there's no auth, so the router guard won't mount the page — drive the bridge
        // directly (the route toggle + enterAdminEventRoster), mirroring revealList().
        const view = document.getElementById("admin-event-roster-view");
        if (view) view.hidden = false;
        const list = document.getElementById("admin-events-view");
        if (list) list.hidden = true;
        window.tmAdminEvents.enterAdminEventRoster(1);
      });
      await page.waitForSelector('[data-testid="admin-event-roster-panel"]', { state: "visible", timeout: 15_000 });
      await page.waitForTimeout(500);
      await settle(page);
      await page.locator("#admin-event-roster-view").screenshot({ path: join(OUT, "02-roster-page.png") });
      console.log("  ✓ 02-roster-page.png (4-state badges, default chips: waitlist on)");

      // Enable Evicted + Cancelled chips to reveal the past rows (client-side filter, no refetch).
      await page.locator('.tm-chip[data-roster-state="EVICTED"]').click();
      await page.locator('.tm-chip[data-roster-state="CANCELLED"]').click();
      await page.waitForTimeout(300);
      await settle(page);
      await page.locator("#admin-event-roster-view").screenshot({ path: join(OUT, "03-roster-all-states.png") });
      console.log("  ✓ 03-roster-all-states.png (all 4 states shown)");
    } else {
      // BEFORE: the inline expando panel dropped below the row.
      await page.waitForSelector('[data-testid="admin-event-roster-panel"]', { state: "visible", timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(500);
      await settle(page);
      await page.locator("#admin-events-view").screenshot({ path: join(OUT, "02-inline-expando.png") });
      console.log("  ✓ 02-inline-expando.png (BEFORE: 2-state inline panel, no page/chips)");
    }

    await page.close();
  } finally {
    await browser.close();
    stopServer();
  }
  console.log(`\nShots written to ${OUT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
