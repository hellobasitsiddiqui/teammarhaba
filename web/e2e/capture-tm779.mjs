// TM-779 — visual evidence capture for the admin interests console.
//
// Mock-mode only (pattern: capture-tm781.mjs / capture-tm771.mjs). Boots the real SPA via serve.mjs,
// route-mocks the admin interests API (list catalogue incl. retired + featured rows, the min/max config,
// GET-by-id for the edit prefill), then reveals the admin views through the same hidden-flag seams
// router.js flips — calling window.tmAdminInterests.enterAdminInterests() / enterAdminInterestForm()
// directly (getRole() reads the Firebase ID-token claim, which mock mode has no session for, so we drive
// the view functions the router would call rather than the router's admin gate).
//
// Shots:
//   01 — the list with status/category filters, stats, the "Selection limits" config panel, and a mix of
//        active / retired / featured rows.
//   02 — the create form (empty).
//   03 — an edit form, prefilled from a seeded interest.
//   04 — a row's retire confirm dialog.
//
// Usage:  CAPTURE_OUT=/abs/path CAPTURE_PORT=8197 node capture-tm779.mjs

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm779");
const PORT = Number(process.env.CAPTURE_PORT || 8197);
const BASE = `http://127.0.0.1:${PORT}`;

// A seeded catalogue: a mix of active + retired + featured across several categories.
const INTERESTS = [
  { id: 1, label: "Live music", category: "Music & Nightlife", highlighted: true, sortWeight: 100, active: true, retired: false, deletedAt: null },
  { id: 2, label: "Hiking", category: "Outdoors & Nature", highlighted: true, sortWeight: 100, active: true, retired: false, deletedAt: null },
  { id: 3, label: "Coffee & cafés", category: "Food & Drink", highlighted: false, sortWeight: 40, active: true, retired: false, deletedAt: null },
  { id: 4, label: "Board games", category: "Games & Tech", highlighted: false, sortWeight: 20, active: true, retired: false, deletedAt: null },
  { id: 5, label: "Five-a-side football", category: "Sport & Fitness", highlighted: false, sortWeight: 10, active: true, retired: false, deletedAt: null },
  { id: 6, label: "Pub quizzes", category: "Social & Wellbeing", highlighted: false, sortWeight: 0, active: false, retired: true, deletedAt: "2026-06-01T12:00:00Z" },
  { id: 7, label: "Life drawing", category: "Arts & Creative", highlighted: false, sortWeight: 0, active: false, retired: true, deletedAt: "2026-05-20T09:00:00Z" },
];

const CONFIG = { minSelections: 3, maxSelections: 7 };

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function mockApi(page) {
  // A signed-in ADMIN /me so the shell chrome (nav/footer) renders as an admin session. The admin views
  // themselves are revealed directly below (the router gate needs the Firebase claim, absent in mock mode).
  const me = {
    uid: "capture-admin", email: "admin@example.com", displayName: "Capture Admin",
    firstName: "Cap", lastName: "Admin", role: "ADMIN", enabled: true,
    onboardingCompleted: true, notificationPref: "EMAIL", timezone: "Europe/London", locale: "en-GB",
    accountState: { emailVerified: true, mfaEnabled: false, phoneVerified: false, photoURL: null, lastLoginAt: null },
  };

  // NOTE: Playwright route precedence is LAST-registered-wins, so the broad catch-all is registered
  // FIRST and the more specific matchers after it (each overrides the catch-all for its own path).
  await page.route(/\/api\/v1\/.*/, (route) => json(route, { title: "Not found" }, 404)); // catch-all → 404
  await page.route(/\/api\/v1\/me$/, (route) => json(route, me));
  await page.route(/\/api\/v1\/me\/membership/, (route) => json(route, { title: "Not found" }, 404));
  // The paged list (?page=&size=&sort=...) — a single full page envelope (PageResponse shape).
  await page.route(/\/api\/v1\/admin\/interests(\?.*)?$/, (route) =>
    json(route, { items: INTERESTS, page: 0, size: 100, totalElements: INTERESTS.length, totalPages: 1 }),
  );
  // GET one interest by id (edit prefill) + retire/restore/PATCH echoes.
  await page.route(/\/api\/v1\/admin\/interests\/(\d+)(\/(retire|restore))?$/, (route) => {
    const m = route.request().url().match(/\/interests\/(\d+)/);
    const id = m ? Number(m[1]) : null;
    const found = INTERESTS.find((i) => i.id === id) || INTERESTS[0];
    return json(route, found);
  });
  // Config (most specific — registered last so it wins for /config).
  await page.route(/\/api\/v1\/admin\/interests\/config/, (route) => {
    if (route.request().method() === "PUT") {
      const body = JSON.parse(route.request().postData() || "{}");
      return json(route, { minSelections: body.minSelections, maxSelections: body.maxSelections });
    }
    return json(route, CONFIG);
  });
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

async function settle(page) {
  await page.evaluate(() => (document.fonts ? document.fonts.ready : Promise.resolve()));
  await page.waitForTimeout(400);
}

async function revealList(page) {
  await page.evaluate(() => {
    for (const id of ["admin-interest-form-view"]) {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    }
    const view = document.getElementById("admin-interests-view");
    if (view) view.hidden = false;
    window.tmAdminInterests.enterAdminInterests();
  });
  await page.waitForSelector("#admin-interests-table table", { state: "visible", timeout: 15_000 });
  await page.waitForTimeout(400);
}

async function revealForm(page, mode, id) {
  await page.evaluate(({ mode, id }) => {
    for (const vid of ["admin-interests-view"]) {
      const el = document.getElementById(vid);
      if (el) el.hidden = true;
    }
    const view = document.getElementById("admin-interest-form-view");
    if (view) view.hidden = false;
    window.tmAdminInterests.enterAdminInterestForm(mode, id);
  }, { mode, id });
  await page.waitForSelector("#interest-form", { state: "visible", timeout: 15_000 });
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
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  try {
    for (let i = 0; i < 40; i++) {
      try { const r = await context.request.get(`${BASE}/`); if (r.ok()) break; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 250));
    }

    // 01 — the list (stats + filters + config panel + active/retired/featured rows).
    const listPage = await context.newPage();
    await mockApi(listPage);
    await bootShell(listPage);
    await revealList(listPage);
    await settle(listPage);
    await listPage.locator("#admin-interests-view").screenshot({ path: join(OUT, "01-list.png") });
    console.log("  ✓ 01-list.png");

    // 04 — a row's retire confirm dialog (do this on the list page while its rows exist).
    await listPage.getByRole("button", { name: "Retire Live music" }).click();
    await listPage.waitForTimeout(400);
    await settle(listPage);
    await listPage.screenshot({ path: join(OUT, "04-retire-confirm.png") });
    console.log("  ✓ 04-retire-confirm.png");
    await listPage.close();

    // 02 — the create form (empty).
    const createPage = await context.newPage();
    await mockApi(createPage);
    await bootShell(createPage);
    await revealForm(createPage, "create", null);
    await settle(createPage);
    await createPage.locator("#admin-interest-form-view").screenshot({ path: join(OUT, "02-create-form.png") });
    console.log("  ✓ 02-create-form.png");
    await createPage.close();

    // 03 — an edit form, prefilled from a seeded interest (id 1 = Live music, featured).
    const editPage = await context.newPage();
    await mockApi(editPage);
    await bootShell(editPage);
    await revealForm(editPage, "edit", "1");
    await settle(editPage);
    await editPage.locator("#admin-interest-form-view").screenshot({ path: join(OUT, "03-edit-form.png") });
    console.log("  ✓ 03-edit-form.png");
    await editPage.close();
  } finally {
    await browser.close();
    stopServer();
  }
  console.log(`\nShots written to ${OUT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
