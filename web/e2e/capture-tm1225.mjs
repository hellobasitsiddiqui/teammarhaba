// TM-1225 — visual evidence for the two visibility fixes on the REAL admin event create form at 390px.
//   (a) "Visible until" chips: BEFORE a single invalid "1h before start" (= start − 1h, always 400s);
//       AFTER three valid presets "At start / 1 day after / 1 week after".
//   (b) Series 400 message: BEFORE the raw DTO text "firstVisibilityStart must be at or before
//       firstStartAt …"; AFTER "Visible from must be at or before Start …" (mocked 400 on /events/series).
//
// Usage:  CAPTURE_OUT=/abs/path CAPTURE_PORT=8283 node capture-tm1225.mjs

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm1225");
const PORT = Number(process.env.CAPTURE_PORT || 8283);
const BASE = `http://127.0.0.1:${PORT}`;

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

// The raw server @AssertTrue message the client used to paint verbatim (CreateSeriesRequest.java:155).
const RAW_SERIES_MSG = "firstVisibilityStart must be at or before firstStartAt, which must be at or before firstVisibilityEnd";

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
  await page.route(/\/api\/v1\/admin\/venues(\?.*)?$/, (route) => json(route, { items: [], page: 0, size: 100, totalElements: 0, totalPages: 0 }));
  // A series create 400 carrying the raw DTO-name @AssertTrue message on the window-ordering getter.
  await page.route(/\/api\/v1\/admin\/events\/series$/, (route) =>
    json(route, { title: "Bad Request", detail: "Validation failed", errors: [{ field: "firstVisibilityWindowOrdered", message: RAW_SERIES_MSG }] }, 400),
  );
}

async function bootShell(page) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.tmAdminEvents, { timeout: 30_000 });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    document.getElementById("boot-screen")?.remove();
    for (const id of ["auth-signed-out", "auth-signed-in"]) { const el = document.getElementById(id); if (el) el.hidden = true; }
  });
}

async function revealForm(page) {
  await page.evaluate(() => {
    const view = document.getElementById("admin-event-form-view");
    if (view) view.hidden = false;
    document.getElementById("admin-events-view") && (document.getElementById("admin-events-view").hidden = true);
    window.tmAdminEvents.enterAdminEventForm("create", null);
  });
  await page.waitForSelector("#event-form", { state: "visible", timeout: 15_000 });
  await page.waitForTimeout(400);
  // Open all sections so the "When" (visibility) fields are reachable.
  await page.evaluate(() => { for (const d of document.querySelectorAll("#event-form details.tm-form-section")) d.open = true; });
  await page.waitForTimeout(150);
}

async function setInput(page, sel, value) {
  await page.evaluate(({ sel, value }) => {
    const i = document.querySelector(sel);
    if (!i) return;
    i.value = value;
    i.dispatchEvent(new Event("input", { bubbles: true }));
    i.dispatchEvent(new Event("change", { bubbles: true }));
  }, { sel, value });
}

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  const server = spawn(process.execPath, [join(HERE, "serve.mjs")], { env: { ...process.env, PORT: String(PORT) }, stdio: "inherit" });
  const stopServer = () => { try { server.kill("SIGTERM"); } catch { /* gone */ } };
  process.on("exit", stopServer);

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 1000 } });
  try {
    for (let i = 0; i < 40; i++) { try { const r = await context.request.get(`${BASE}/`); if (r.ok()) break; } catch { /* not up */ } await new Promise((r) => setTimeout(r, 250)); }
    const page = await context.newPage();
    await mockApi(page);
    await bootShell(page);
    await revealForm(page);

    // A valid future start so the relative chips compute.
    await setInput(page, "#event-start", "2026-09-10T18:00");
    await page.waitForTimeout(150);

    // --- (a) the "Visible until" chip row ---
    const chipLabels = await page.evaluate(() => {
      // The chip row sits inside the visibility-end field wrapper; read its chip labels.
      const wrap = document.getElementById("event-visibility-end")?.closest(".tm-form-field");
      const chips = wrap ? [...wrap.querySelectorAll(".tm-chip, button")].map((b) => b.textContent.trim()).filter(Boolean) : [];
      return chips;
    });
    console.log(`  · (a) Visible-until chips = [${chipLabels.join(", ")}]`);
    const visWrap = page.locator("#event-visibility-end").locator("xpath=ancestor::*[contains(@class,'tm-form-field')][1]");
    if (await visWrap.count()) { await visWrap.scrollIntoViewIfNeeded(); await page.waitForTimeout(150); await visWrap.screenshot({ path: join(OUT, "01-visible-until-chips.png") }); console.log("  ✓ 01-visible-until-chips.png"); }

    // --- (b) series 400 → the painted inline error on "Visible until" ---
    // Fill a valid event + turn Repeat ON with a default DAILY + Until date so the client series validation
    // passes and the POST /events/series fires (→ mocked 400 with the raw DTO message).
    await setInput(page, "#event-heading", "Weekly Coffee");
    await setInput(page, "#event-description", "A recurring meetup.");
    await setInput(page, "#event-location", "Community Hall");
    await setInput(page, "#event-visibility-start", "2026-09-01T09:00");
    await setInput(page, "#event-visibility-end", "2026-09-10T18:00"); // at start (valid client-side)
    await page.evaluate(() => { const t = document.getElementById("event-repeat-toggle"); if (t && !t.checked) t.click(); });
    await page.waitForTimeout(200);
    await setInput(page, "#event-repeat-until", "2026-10-10");
    await page.waitForTimeout(150);
    await page.evaluate(() => document.getElementById("event-save")?.click());
    await page.waitForTimeout(800);

    const painted = await page.evaluate(() => {
      const wrap = document.getElementById("event-visibility-end")?.closest(".tm-form-field");
      const err = wrap ? wrap.querySelector(".tm-field-error:not([hidden])") : null;
      return err ? err.textContent.trim() : "(no inline error painted)";
    });
    console.log(`  · (b) painted Visible-until error = "${painted}"`);
    if (await visWrap.count()) { await visWrap.scrollIntoViewIfNeeded(); await page.waitForTimeout(150); await visWrap.screenshot({ path: join(OUT, "02-series-error-message.png") }); console.log("  ✓ 02-series-error-message.png"); }

    await page.close();
  } finally { await browser.close(); stopServer(); }
  console.log(`\nShots -> ${OUT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
