// TM-1221 — visual proof that an OPEN-ENDED event past its assumed 3h duration no longer reads
// "Happening". Mounts the REAL admin events list (window.tmAdminEvents.enterAdminEvents) fed a mocked
// admin-events page containing ONE open-ended event that started 30h ago with a STALE `past:false`
// (the bug scenario). Screenshots the row's status chip under the "All" lifecycle filter.
//   BEFORE (main): chip reads "Happening" — the client never finishes an end-less event, so a stale
//                  `past` pins it live forever.
//   AFTER  (branch): chip reads "Finished" — the client now finishes it at startAt + 3h.
//
// Usage:  CAPTURE_OUT=/abs/path CAPTURE_PORT=8281 node capture-tm1221.mjs

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm1221");
const PORT = Number(process.env.CAPTURE_PORT || 8281);
const BASE = `http://127.0.0.1:${PORT}`;
const H = 60 * 60 * 1000;

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
  const now = Date.now();
  const event = {
    id: "evt-coffee-walk",
    heading: "Coffee & Walk",
    status: "PUBLISHED",
    startAt: new Date(now - 30 * H).toISOString(), // started 30h ago
    endAt: null,                                    // OPEN-ENDED
    visibilityStart: new Date(now - 40 * H).toISOString(),
    visibilityEnd: new Date(now + 240 * H).toISOString(),
    timezone: "Europe/London",
    capacity: 5, going: 0, waitlist: 0,
    past: false, // STALE flag — the bug scenario (a fresh fetch would say true; a cached one says false)
  };
  // Register the catch-all FIRST — Playwright prefers the LAST-registered matching route, so the specific
  // mocks below must come after it to win.
  await page.route(/\/api\/v1\/.*/, (route) => json(route, { title: "Not found" }, 404));
  await page.route(/\/api\/v1\/me$/, (route) => json(route, me));
  await page.route(/\/api\/v1\/me\/membership/, (route) => json(route, { title: "Not found" }, 404));
  await page.route(/\/api\/v1\/admin\/venues(\?.*)?$/, (route) => json(route, { items: [], page: 0, size: 100, totalElements: 0, totalPages: 0 }));
  await page.route(/\/api\/v1\/admin\/events(\?.*)?$/, (route) => json(route, { items: [event], totalElements: 1, totalPages: 1 }));
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

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  const server = spawn(process.execPath, [join(HERE, "serve.mjs")], { env: { ...process.env, PORT: String(PORT) }, stdio: "inherit" });
  const stopServer = () => { try { server.kill("SIGTERM"); } catch { /* gone */ } };
  process.on("exit", stopServer);

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
  try {
    for (let i = 0; i < 40; i++) { try { const r = await context.request.get(`${BASE}/`); if (r.ok()) break; } catch { /* not up */ } await new Promise((r) => setTimeout(r, 250)); }
    const page = await context.newPage();
    await mockApi(page);
    await bootShell(page);
    // Mount the real admin events list.
    await page.evaluate(() => {
      const view = document.getElementById("admin-events-view");
      if (view) view.hidden = false;
      window.tmAdminEvents.enterAdminEvents();
    });
    await page.waitForSelector("#admin-events-view", { state: "visible", timeout: 15_000 });
    await page.waitForTimeout(600);
    // Show ALL lifecycle buckets so the row is visible whether it reads Happening or Finished.
    const allChip = page.getByText("All", { exact: true }).first();
    if (await allChip.count()) { await allChip.click().catch(() => {}); await page.waitForTimeout(300); }

    const chip = await page.evaluate(() => {
      const badge = document.querySelector("#admin-events-view td[data-label='Status'] .tm-badge, #admin-events-view .tm-badge");
      return badge ? badge.textContent.trim() : "(no badge found)";
    });
    console.log(`  · Coffee & Walk (open-ended, started 30h ago, past:false) status chip = "${chip}"`);

    await page.evaluate(() => (document.fonts ? document.fonts.ready : Promise.resolve()));
    await page.waitForTimeout(200);
    await page.locator("#admin-events-view").screenshot({ path: join(OUT, "01-events-list.png") });
    console.log("  ✓ 01-events-list.png");

    await page.close();
  } finally { await browser.close(); stopServer(); }
  console.log(`\nShots -> ${OUT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
