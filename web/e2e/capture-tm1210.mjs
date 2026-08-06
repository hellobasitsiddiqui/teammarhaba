// TM-1210 — reproduce the broken event-form action bar at 390px on the REAL admin create form.
// Boots the SPA via serve.mjs, mounts the real form, and reports the action bar + button geometry so we
// can SEE why Cancel / Clear all / Save "float everywhere / don't show". Also shots the bar + full page.
//
// Usage:  CAPTURE_OUT=/abs/path CAPTURE_PORT=8275 node capture-tm1210.mjs

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm1210");
const PORT = Number(process.env.CAPTURE_PORT || 8275);
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
  // Mark the body as a signed-in admin so the tabbar-lift rule (body.tm-has-tabbar) applies like prod.
  await page.evaluate(() => {
    document.getElementById("boot-screen")?.remove();
    for (const id of ["auth-signed-out", "auth-signed-in"]) {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    }
    document.body.classList.add("tm-has-tabbar");
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
  await page.waitForTimeout(500);
}

async function report(page, label) {
  const info = await page.evaluate(() => {
    const bar = document.getElementById("event-actions-bar");
    const row = bar ? bar.querySelector(".tm-form-actions") : null;
    const btns = bar ? [...bar.querySelectorAll("button")] : [];
    const box = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
    const cs = (n, props) => { if (!n) return {}; const s = getComputedStyle(n); const o = {}; for (const p of props) o[p] = s[p]; return o; };
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      formHeight: Math.round(document.getElementById("event-form")?.getBoundingClientRect().height || 0),
      bar: box(bar),
      barCss: cs(bar, ["position", "bottom", "zIndex", "display"]),
      rowCss: cs(row, ["display", "flexDirection", "gap"]),
      buttons: btns.map((b) => ({ text: b.textContent, box: box(b), width: cs(b, ["width"]).width })),
    };
  });
  console.log(`\n[${label}] viewport=${JSON.stringify(info.viewport)} formH=${info.formHeight}`);
  console.log(`  bar box=${JSON.stringify(info.bar)} css=${JSON.stringify(info.barCss)}`);
  console.log(`  row css=${JSON.stringify(info.rowCss)}`);
  for (const b of info.buttons) console.log(`  btn "${b.text}" box=${JSON.stringify(b.box)} width=${b.width}`);
  return info;
}

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  const server = spawn(process.execPath, [join(HERE, "serve.mjs")], { env: { ...process.env, PORT: String(PORT) }, stdio: "inherit" });
  const stopServer = () => { try { server.kill("SIGTERM"); } catch { /* gone */ } };
  process.on("exit", stopServer);

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    for (let i = 0; i < 40; i++) { try { const r = await context.request.get(`${BASE}/`); if (r.ok()) break; } catch { /* not up */ } await new Promise((r) => setTimeout(r, 250)); }
    const page = await context.newPage();
    await mockApi(page);
    await bootShell(page);
    await revealForm(page);
    await page.evaluate(() => (document.fonts ? document.fonts.ready : Promise.resolve()));
    await page.waitForTimeout(300);

    // (A) all sections collapsed (Basit's screenshot state) — short form
    await page.evaluate(() => { for (const d of document.querySelectorAll("#event-form details.tm-form-section")) d.open = false; });
    await page.waitForTimeout(200);
    await report(page, "ALL COLLAPSED");
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(OUT, "01-collapsed-bottom.png") });
    const bar = page.locator("#event-actions-bar");
    if (await bar.count()) await bar.screenshot({ path: join(OUT, "02-actions-bar.png") });

    await page.close();
  } finally { await browser.close(); stopServer(); }
  console.log(`\nShots -> ${OUT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
