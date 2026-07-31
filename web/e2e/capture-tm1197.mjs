// TM-1197 — visual evidence for the generalised error-force-open on the admin event create form at 390px.
//
// THE BEHAVIOUR: on a failed Save, an errored field whose home section is COLLAPSED must not leave the
// blocking error stranded off-screen. TM-1195 already force-OPENS the home section (setFieldError), but on
// main the submit path only ever FOCUSED/scrolled to the two hardcoded fields timezone / booking-cutoff — an
// error on any OTHER collapsed-section field (e.g. `capacity` in "Who can join") opened the fold but never
// scrolled it into view or focused it, so on a tall mobile form the admin saw "Please fix the highlighted
// fields" with the actual error below the fold. TM-1197 generalises it: scroll the FIRST errored field's
// section into view + focus that field, any section, DOM order.
//
// Mock-mode only (mirrors capture-tm1196.mjs) — boots the real SPA via serve.mjs and drives the REAL create
// form through window.tmAdminEvents.enterAdminEventForm("create", null). NOT a synthetic harness. Sidesteps
// the local-Chromium "no plain UTC zone" gotcha: the mock `me.timezone` prefills a valid IANA zone, we never
// selectOption a timezone.
//
// The BEFORE / AFTER contrast is the SAME script against main's admin-events.js vs this branch:
//   Repro: fill a fully-VALID event but set Capacity = 0 (invalid, @Min 1) inside the collapsed "Who can
//          join" section, re-collapse it, scroll to the top of the form, then click Save.
//   BEFORE (main): the fold opens but the viewport stays at the top (Basics) — the capacity error is stranded
//                  below the fold, only a toast hints at it.
//   AFTER  (branch): the page scrolls "Who can join" into view and focuses the invalid Capacity field (focus
//                    ring on the field showing "Must be 1 or more.").
//
// Shots (390px mobile width, 844 tall viewport so the form actually scrolls):
//   01-viewport-after-save — the VIEWPORT right after a failed Save (the scroll/focus differentiator).
//   02-who-section         — an element crop of "Who can join" showing the capacity error inline.
//
// Usage:  CAPTURE_OUT=/abs/path CAPTURE_PORT=8273 node capture-tm1197.mjs

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm1197");
const PORT = Number(process.env.CAPTURE_PORT || 8273);
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
  await page.waitForTimeout(500);
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

// Fill a fully-VALID event, except Capacity = 0 (invalid) inside the collapsed "Who can join".
async function seedInvalidCapacity(page) {
  await page.evaluate(() => {
    for (const d of document.querySelectorAll("#event-form details.tm-form-section")) d.open = true;
  });
  await page.waitForTimeout(150);
  await setInput(page, "#event-heading", "Coffee Morning");
  await setInput(page, "#event-description", "A relaxed weekly meetup for the circle.");
  await setInput(page, "#event-location", "Community Hall, 12 High St");
  await setInput(page, "#event-start", "2026-08-15T18:00");
  await setInput(page, "#event-visibility-start", "2026-08-01T09:00");
  await setInput(page, "#event-visibility-end", "2026-08-10T09:00");
  // timezone prefills from me.timezone (Europe/London) — leave it valid, don't touch the select.
  await setInput(page, "#event-capacity", "0"); // the one invalid value → @Min(1) client error
  await page.waitForTimeout(150);
  // Re-collapse "Who can join" so the error starts hidden behind the fold (the whole point).
  await page.evaluate(() => {
    const d = document.getElementById("event-section-who");
    if (d) d.open = false;
    // Scroll the form back to the top so BEFORE/AFTER start from the same viewport.
    window.scrollTo(0, 0);
    const sc = document.scrollingElement;
    if (sc) sc.scrollTop = 0;
  });
  await page.waitForTimeout(150);
}

async function settle(page) {
  await page.evaluate(() => (document.fonts ? document.fonts.ready : Promise.resolve()));
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
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    for (let i = 0; i < 40; i++) {
      try { const r = await context.request.get(`${BASE}/`); if (r.ok()) break; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 250));
    }

    const page = await context.newPage();
    await mockApi(page);
    await bootShell(page);
    await revealForm(page);
    await seedInvalidCapacity(page);
    await settle(page);

    // Click the REAL Save button → the form's submit handler runs paintAllErrors (client validation), which
    // paints the capacity error and (on this branch) reveals+scrolls+focuses it. No POST (validation bails).
    await page.locator("#event-save").click();
    await page.waitForTimeout(700); // let the smooth scroll + focus settle

    // Report where focus + the capacity error landed so the BEFORE/AFTER attribution is unambiguous.
    const info = await page.evaluate(() => {
      const cap = document.getElementById("event-capacity");
      const who = document.getElementById("event-section-who");
      const active = document.activeElement;
      const capBox = cap ? cap.getBoundingClientRect() : null;
      return {
        focusedIsCapacity: active === cap,
        focusedId: active ? active.id || active.tagName : "(none)",
        whoOpen: who ? who.open : null,
        capacityInViewport: capBox ? capBox.top >= 0 && capBox.top <= 844 : null,
        capacityTop: capBox ? Math.round(capBox.top) : null,
      };
    });
    console.log(`  · whoOpen=${info.whoOpen} focused=${info.focusedId} focusedIsCapacity=${info.focusedIsCapacity} `
      + `capacityInViewport=${info.capacityInViewport} (top=${info.capacityTop}px of 844)`);

    // 01 — the VIEWPORT right after Save: AFTER scrolls the focused capacity field into view; BEFORE leaves
    // the viewport at the top with the error stranded below the fold.
    await page.screenshot({ path: join(OUT, "01-viewport-after-save.png") });
    console.log("  ✓ 01-viewport-after-save.png");

    // 02 — an element crop of the "Who can join" section showing the inline capacity error.
    await page.locator("#event-section-who").scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    await page.locator("#event-section-who").screenshot({ path: join(OUT, "02-who-section.png") });
    console.log("  ✓ 02-who-section.png");

    await page.close();
  } finally {
    await browser.close();
    stopServer();
  }
  console.log(`\nShots written to ${OUT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
