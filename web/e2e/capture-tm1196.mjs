// TM-1196 — visual evidence capture for the admin event create form at 390px: LIVE value summaries on
// the COLLAPSED section headers ("Who can join" / "Booking rules"). Each collapsed <summary> shows a
// terse one-line summary of its current field values (recomputed on field change), so an admin sees what
// is inside a fold without opening it.
//
// Mock-mode only (mirrors capture-tm1195.mjs). Boots the real SPA via serve.mjs, mocks the admin events +
// venues APIs, then reveals the REAL event create form through the router bridge
// (window.tmAdminEvents.enterAdminEventForm("create", null)) — this is the ACTUAL create form, not a
// synthetic harness page. Sidesteps the local-Chromium "no plain UTC zone" gotcha (blackboard 2026-07-18):
// we never selectOption a timezone.
//
// The BEFORE / AFTER contrast is the SAME script run against main's JS vs this branch:
//   BEFORE (main's admin-events.js): the collapsed "Who can join" / "Booking rules" headers show ONLY the
//                                    section TITLE — no value line (the summary slot is left empty, TM-1195).
//   AFTER  (this branch):            the same two collapsed headers show a live one-line value summary,
//                                    e.g. "Who can join  public · cap 20 · 18-30" and
//                                    "Booking rules  cutoff 1h · reveal 24h · £5".
//
// To make the AFTER summary non-default we SET a few values on the REAL inputs first (capacity, visibility,
// booking cutoff, reveal, age band, price) via the actual field controls, then re-collapse the two folds and
// screenshot the headers.
//
// Shots (390px, the mobile admin width):
//   01-form-collapsed   — the whole create form, both sections COLLAPSED (default fold state after seeding).
//   02-collapsed-headers — a tight crop of just the two collapsed section headers (the value summaries).
//
// Usage:  CAPTURE_OUT=/abs/path CAPTURE_PORT=8272 node capture-tm1196.mjs

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm1196");
const PORT = Number(process.env.CAPTURE_PORT || 8272);
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

// Fire an input event so the form's per-change revalidate hook (which recomputes the summaries) runs.
async function setInput(page, selector, value) {
  await page.evaluate(({ selector, value }) => {
    const input = document.querySelector(selector);
    if (!input) return;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, { selector, value });
}

async function seedValues(page) {
  // The two collapsed sections must be OPEN to reach their inputs; open all folds, set values, re-collapse.
  await page.evaluate(() => {
    for (const d of document.querySelectorAll("#event-form details.tm-form-section")) d.open = true;
  });
  await page.waitForTimeout(200);
  // Who can join: a visibility window (→ scheduled), capacity 20, age band 18-30 (custom inputs).
  await setInput(page, "#event-visibility-start", "2026-08-01T09:00");
  await setInput(page, "#event-visibility-end", "2026-08-10T09:00");
  await setInput(page, "#event-capacity", "20");
  await setInput(page, "#event-age-min", "18");
  await setInput(page, "#event-age-max", "30");
  // Booking rules: cutoff 1h, reveal 24h, price £5.
  await setInput(page, "#event-booking-cutoff-hours", "1");
  await setInput(page, "#event-reveal-hours", "24");
  await setInput(page, "#event-price", "5");
  await page.waitForTimeout(200);
  // Re-collapse the two target sections so the summaries show on the FOLDED header (the whole point).
  await page.evaluate(() => {
    for (const id of ["event-section-who", "event-section-booking"]) {
      const d = document.getElementById(id);
      if (d) d.open = false;
    }
  });
  await page.waitForTimeout(200);
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
  const context = await browser.newContext({ viewport: { width: 390, height: 2200 } });
  try {
    for (let i = 0; i < 40; i++) {
      try { const r = await context.request.get(`${BASE}/`); if (r.ok()) break; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 250));
    }

    const page = await context.newPage();
    await mockApi(page);
    await bootShell(page);
    await revealForm(page);
    await seedValues(page);
    await settle(page);

    // Report the value line each collapsed header carries so the BEFORE/AFTER attribution is unambiguous.
    const readValue = async (id) =>
      (await page.locator(`#${id} > summary .tm-form-section-value`).first().textContent().catch(() => "")) || "";
    const who = (await readValue("event-section-who")).trim();
    const booking = (await readValue("event-section-booking")).trim();
    console.log(who || booking
      ? `  · collapsed headers show value summaries (AFTER tree) — who: "${who}"  booking: "${booking}"`
      : "  · collapsed headers show NO value summary (BEFORE tree — titles only)");

    // 01 — the whole form, both target sections collapsed.
    await page.locator("#event-form").screenshot({ path: join(OUT, "01-form-collapsed.png") });
    console.log("  ✓ 01-form-collapsed.png");

    // 02 — a tight crop of just the two collapsed section headers (the value summaries in context).
    // Scroll them into view first (the two collapsed folds sit near the bottom of the tall form), then
    // element-screenshot a wrapper spanning both so the clip is always within the rendered page.
    await page.locator("#event-section-who").scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    const who1 = await page.locator("#event-section-who").boundingBox();
    const book1 = await page.locator("#event-section-booking").boundingBox();
    if (who1 && book1) {
      const top = Math.min(who1.y, book1.y);
      const bottom = Math.max(who1.y + who1.height, book1.y + book1.height);
      const y = Math.max(0, top - 6);
      const height = Math.min(2200 - y, bottom - top + 12);
      await page.screenshot({
        path: join(OUT, "02-collapsed-headers.png"),
        clip: { x: 0, y, width: 390, height },
      });
      console.log("  ✓ 02-collapsed-headers.png");
    }

    await page.close();
  } finally {
    await browser.close();
    stopServer();
  }
  console.log(`\nShots written to ${OUT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
