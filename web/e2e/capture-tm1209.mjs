// TM-1209 — visual proof that EVERY collapsed section shows a value summary (not just Who-can-join /
// Booking-rules). Boots the SPA via serve.mjs, mounts the real create form, fills a value into each
// section, collapses ALL five, and screenshots the fully-folded form.
//   BEFORE (main): Basics / When / Where headers show only the TITLE; only Who / Booking have a summary.
//   AFTER  (branch): all five headers show a terse one-line value summary.
//
// Usage:  CAPTURE_OUT=/abs/path CAPTURE_PORT=8279 node capture-tm1209.mjs

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm1209");
const PORT = Number(process.env.CAPTURE_PORT || 8279);
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
  const context = await browser.newContext({ viewport: { width: 390, height: 1100 } });
  try {
    for (let i = 0; i < 40; i++) { try { const r = await context.request.get(`${BASE}/`); if (r.ok()) break; } catch { /* not up */ } await new Promise((r) => setTimeout(r, 250)); }
    const page = await context.newPage();
    await mockApi(page);
    await bootShell(page);
    await revealForm(page);

    // Open every section, fill one meaningful value per section, then collapse them all.
    await page.evaluate(() => { for (const d of document.querySelectorAll("#event-form details.tm-form-section")) d.open = true; });
    await page.waitForTimeout(150);
    await setInput(page, "#event-heading", "Coffee Morning");            // Basics
    await setInput(page, "#event-start", "2026-08-02T18:30");            // When
    await setInput(page, "#event-end", "2026-08-02T20:30");
    await setInput(page, "#event-location", "Community Hall");           // Where
    await setInput(page, "#event-capacity", "20");                       // Who can join
    await setInput(page, "#event-booking-cutoff-hours", "1");            // Booking rules
    await setInput(page, "#event-reveal-hours", "24");
    await page.waitForTimeout(150);
    await page.evaluate(() => { for (const d of document.querySelectorAll("#event-form details.tm-form-section")) d.open = false; });
    await page.waitForTimeout(200);

    const summaries = await page.evaluate(() =>
      [...document.querySelectorAll("#event-form details.tm-form-section")].map((d) => ({
        title: d.querySelector(".tm-form-section-title")?.textContent,
        value: d.querySelector(".tm-form-section-value")?.textContent || "(none)",
      })),
    );
    for (const s of summaries) console.log(`  · ${s.title}  →  ${s.value}`);

    await page.locator("#event-form").screenshot({ path: join(OUT, "01-all-collapsed.png") });
    console.log("  ✓ 01-all-collapsed.png");

    await page.close();
  } finally { await browser.close(); stopServer(); }
  console.log(`\nShots -> ${OUT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
