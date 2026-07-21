// TM-832 — before/after visual evidence for the admin interests "Selected by" column at 390px.
//
// Mock-mode only (pattern: capture-tm779.mjs). Boots the real SPA via serve.mjs, route-mocks the admin
// interests list + the min/max config + the NEW /stats endpoint (per-interest selection analytics), then
// reveals the admin list view through window.tmAdminInterests.enterAdminInterests() and shoots the table
// at a 390px viewport. The served files come straight from web/src, so:
//   • run on the branch  → the "after" (table WITH the "Selected by" column, populated).
//   • run on origin/main → the "before" (table WITHOUT the column) — the /stats mock is simply ignored.
//
// Usage:  CAPTURE_OUT=/abs/out.png CAPTURE_PORT=8198 node capture-tm832.mjs

// Import Playwright from wherever it's installed. In CI the e2e node_modules has @playwright/test; for a
// local sandbox capture we allow PW_IMPORT to point at an absolute playwright entry (e.g. an npx-cached
// index.mjs) since @playwright/test isn't installed in the worktree.
const { chromium } = await import(process.env.PW_IMPORT || "@playwright/test");
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-tm832.png");
const PORT = Number(process.env.CAPTURE_PORT || 8198);
const BASE = `http://127.0.0.1:${PORT}`;

// A small seeded catalogue (mirrors capture-tm779's shape), all active for a clean "Selected by" demo.
const INTERESTS = [
  { id: 1, label: "Live music", category: "Music & Nightlife", emoji: "🎵", highlighted: true, sortWeight: 100, active: true, retired: false, deletedAt: null },
  { id: 2, label: "Hiking", category: "Outdoors & Nature", emoji: "🥾", highlighted: true, sortWeight: 100, active: true, retired: false, deletedAt: null },
  { id: 3, label: "Coffee & cafés", category: "Food & Drink", emoji: "☕", highlighted: false, sortWeight: 40, active: true, retired: false, deletedAt: null },
  { id: 4, label: "Board games", category: "Games & Tech", emoji: "🎲", highlighted: false, sortWeight: 20, active: true, retired: false, deletedAt: null },
  { id: 5, label: "Five-a-side football", category: "Sport & Fitness", emoji: "⚽", highlighted: false, sortWeight: 10, active: true, retired: false, deletedAt: null },
];

const CONFIG = { minSelections: 3, maxSelections: 7 };

// The /stats endpoint (TM-832): per-label selector count + percent of the 600 active users.
const STATS = {
  activeUsers: 600,
  stats: [
    { label: "Live music", selectorCount: 312, percent: 52 },
    { label: "Hiking", selectorCount: 180, percent: 30 },
    { label: "Coffee & cafés", selectorCount: 42, percent: 7 },
    { label: "Board games", selectorCount: 24, percent: 4 },
    // "Five-a-side football" deliberately absent → renders "0 (0%)".
  ],
};

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function mockApi(page) {
  const me = {
    uid: "capture-admin", email: "admin@example.com", displayName: "Capture Admin",
    firstName: "Cap", lastName: "Admin", role: "ADMIN", enabled: true,
    onboardingCompleted: true, notificationPref: "EMAIL", timezone: "Europe/London", locale: "en-GB",
    accountState: { emailVerified: true, mfaEnabled: false, phoneVerified: false, photoURL: null, lastLoginAt: null },
  };
  await page.route(/\/api\/v1\/.*/, (route) => json(route, { title: "Not found" }, 404)); // catch-all → 404
  await page.route(/\/api\/v1\/me$/, (route) => json(route, me));
  await page.route(/\/api\/v1\/me\/membership/, (route) => json(route, { title: "Not found" }, 404));
  // /stats must be registered BEFORE the paged-list matcher (last-wins) so it isn't shadowed by it.
  await page.route(/\/api\/v1\/admin\/interests(\?.*)?$/, (route) =>
    json(route, { items: INTERESTS, page: 0, size: 100, totalElements: INTERESTS.length, totalPages: 1 }),
  );
  await page.route(/\/api\/v1\/admin\/interests\/stats$/, (route) => json(route, STATS));
  await page.route(/\/api\/v1\/admin\/interests\/config/, (route) => json(route, CONFIG));
}

async function bootShell(page) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.tmAdminInterests, { timeout: 30_000 });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    document.getElementById("boot-screen")?.remove();
    for (const id of ["auth-signed-out", "auth-signed-in"]) {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    }
  });
}

async function revealList(page) {
  await page.evaluate(() => {
    const form = document.getElementById("admin-interest-form-view");
    if (form) form.hidden = true;
    const view = document.getElementById("admin-interests-view");
    if (view) view.hidden = false;
    window.tmAdminInterests.enterAdminInterests();
  });
  await page.waitForSelector("#admin-interests-table table", { state: "visible", timeout: 15_000 });
  await page.evaluate(() => (document.fonts ? document.fonts.ready : Promise.resolve()));
  await page.waitForTimeout(600);
}

async function main() {
  const server = spawn(process.execPath, [join(HERE, "serve.mjs")], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: "inherit",
  });
  const stopServer = () => { try { server.kill("SIGTERM"); } catch { /* gone */ } };
  process.on("exit", stopServer);

  const browser = await chromium.launch();
  // 390px — the ticket's required phone width for the before/after.
  const context = await browser.newContext({ viewport: { width: 390, height: 1400 } });
  try {
    for (let i = 0; i < 40; i++) {
      try { const r = await context.request.get(`${BASE}/`); if (r.ok()) break; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    const page = await context.newPage();
    await mockApi(page);
    await bootShell(page);
    await revealList(page);
    await page.locator("#admin-interests-view").screenshot({ path: OUT });
    console.log(`  ✓ ${OUT}`);
  } finally {
    await browser.close();
    stopServer();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
