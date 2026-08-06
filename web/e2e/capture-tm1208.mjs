// TM-1208 — visual proof that moving Start slides End to preserve the event's length, on the REAL admin
// create form at 390px. Boots the SPA via serve.mjs, mounts the real form, sets a 2h event (18:30–20:30),
// then pushes Start to 21:00 and screenshots the When section.
//   BEFORE (main): End stays 20:30 — now BEFORE the 21:00 start (invalid).
//   AFTER  (branch): End auto-updates to 23:00 — still a 2h event.
//
// Usage:  CAPTURE_OUT=/abs/path CAPTURE_PORT=8277 node capture-tm1208.mjs

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm1208");
const PORT = Number(process.env.CAPTURE_PORT || 8277);
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

async function revealForm(page) {
  await page.evaluate(() => {
    const list = document.getElementById("admin-events-view");
    if (list) list.hidden = true;
    const view = document.getElementById("admin-event-form-view");
    if (view) view.hidden = false;
    window.tmAdminEvents.enterAdminEventForm("create", null);
  });
  await page.waitForSelector("#event-form", { state: "visible", timeout: 15_000 });
  await page.waitForTimeout(400);
}

async function setInput(page, selector, value) {
  await page.evaluate(({ selector, value }) => {
    const input = document.querySelector(selector);
    if (!input) return;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, { selector, value });
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
    await revealForm(page);

    // A 2-hour event: Start 18:30, End 20:30 (set Start first so the tracker baselines, then End).
    await setInput(page, "#event-start", "2026-08-02T18:30");
    await setInput(page, "#event-end", "2026-08-02T20:30");
    await page.waitForTimeout(150);
    // Now push Start to 21:00 — the whole point. On the branch, End slides to 23:00; on main it stays 20:30.
    await setInput(page, "#event-start", "2026-08-02T21:00");
    await page.waitForTimeout(200);

    const endVal = await page.locator("#event-end").inputValue();
    console.log(`  · after moving Start→21:00, End = "${endVal}" (branch expects 2026-08-02T23:00; main leaves 2026-08-02T20:30)`);

    await page.evaluate(() => { document.getElementById("event-section-when")?.scrollIntoView({ block: "center" }); });
    await page.waitForTimeout(150);
    const when = page.locator("#event-section-when");
    if (await when.count()) await when.screenshot({ path: join(OUT, "01-when-section.png") });
    console.log("  ✓ 01-when-section.png");

    await page.close();
  } finally { await browser.close(); stopServer(); }
  console.log(`\nShots -> ${OUT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
