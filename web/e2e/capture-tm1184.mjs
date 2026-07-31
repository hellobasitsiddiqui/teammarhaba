// TM-1184 — visual evidence capture for the event CREATE form at 390px: what turning "Repeat" ON does to
// the NON-TEMPLATE fields + the Online format option (the fix that closes the "Online recurring series with
// no join link" trap).
//
// The contrast this captures (both shots on THIS branch's JS — the change is a WITHIN-form state flip):
//   01-repeat-off — BEFORE: Repeat OFF (single-create). The Format selector offers Online, and the
//                   non-template fields — Map URL, Chat opening message, and the Age band — are all present
//                   and fillable. This is the state that used to silently drop those fields onto a series.
//   02-repeat-on  — AFTER: Repeat ON → Online is DISABLED with a note ("Online isn't available for a
//                   repeating series…"), and Map URL / opening message / age band are HIDDEN, each with the
//                   inline "Not carried onto a recurring series (v1)." note. Nothing that would be dropped
//                   per occurrence is fillable, and an Online series is impossible.
//
// Mock-mode only (same harness as capture-tm796.mjs): boots the real SPA via serve.mjs, mocks the admin
// events + venues APIs, then reveals the create form directly through the router bridge — sidestepping the
// local-Chromium "no plain UTC zone" gotcha (we never selectOption a timezone).
//
// Usage:  CAPTURE_OUT=/abs/path CAPTURE_PORT=8284 node capture-tm1184.mjs

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm1184");
const PORT = Number(process.env.CAPTURE_PORT || 8284);
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

async function settle(page) {
  await page.evaluate(() => (document.fonts ? document.fonts.ready : Promise.resolve()));
  await page.waitForTimeout(400);
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
  const context = await browser.newContext({ viewport: { width: 390, height: 1400 } });
  try {
    for (let i = 0; i < 40; i++) {
      try { const r = await context.request.get(`${BASE}/`); if (r.ok()) break; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 250));
    }

    const page = await context.newPage();
    await mockApi(page);
    await bootShell(page);
    await revealForm(page);

    // 01 — BEFORE: Repeat OFF. Online is available; Map URL / opening message / age band are all present.
    await settle(page);
    await page.screenshot({ path: join(OUT, "01-repeat-off.png"), fullPage: true });
    console.log("  ✓ 01-repeat-off.png (Repeat OFF — Online allowed, all non-template fields present)");

    // 02 — AFTER: Repeat ON. Online disabled + note; Map URL / opening message / age band hidden with notes.
    await page.locator("#event-repeat-toggle").check();
    await page.locator('#event-repeat-frequency .tm-chip[data-chip="WEEKLY"]').click();
    await page.waitForTimeout(300);
    // Prove the invariant nodes are in the expected state (logged, not asserted — this is a capture script).
    const onlineDisabled = await page.locator("#event-format-online").isDisabled();
    const lockNoteVisible = await page.locator("#event-format-online-lock-note").isVisible();
    const mapHidden = !(await page.locator("#event-map-url").isVisible());
    console.log(`  · Online disabled=${onlineDisabled}  lock-note=${lockNoteVisible}  mapUrl hidden=${mapHidden}`);
    await settle(page);
    await page.screenshot({ path: join(OUT, "02-repeat-on.png"), fullPage: true });
    console.log("  ✓ 02-repeat-on.png (Repeat ON — Online disabled + note, non-template fields hidden + notes)");

    await page.close();
  } finally {
    await browser.close();
    stopServer();
  }
  console.log(`\nShots written to ${OUT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
