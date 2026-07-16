// TM-781 — before/after visual evidence capture for the phone country picker.
//
// Mock-mode only (pattern: capture-tm771.mjs / capture-chat-foundation.mjs). Boots the real SPA via
// serve.mjs, mocks GET /api/v1/me (+membership 404) and PATCH /api/v1/me (200 echo), reveals the
// profile view through the same hidden-flag seams router.js flips, then captures the phone field:
//
//   • Run from main (no picker)          → BEFORE: a single phone text input.
//   • Run from the TM-781 branch          → AFTER: flag+name+dial picker before the input, GB/AE
//     pinned top, city soft-preselect (London→GB, Dubai→AE), legacy bare-number confirm state.
//
// Usage:  CAPTURE_OUT=/abs/path CAPTURE_PORT=8196 node capture-tm781.mjs

import { chromium, devices } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm781");
const PORT = Number(process.env.CAPTURE_PORT || 8196);
const BASE = `http://127.0.0.1:${PORT}`;

const ME_BASE = {
  uid: "capture-uid",
  email: "capture@example.com",
  displayName: "",
  firstName: "Ghalia",
  lastName: "Qazi",
  age: 28,
  notificationPref: "EMAIL",
  timezone: "Europe/London",
  locale: "en-GB",
  role: "USER",
  enabled: true,
  themeAccent: "teal",
  themeSketchy: true,
  accountState: { emailVerified: true, mfaEnabled: false, phoneVerified: false, photoURL: null, lastLoginAt: null },
};

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function mockApi(page, me) {
  await page.route(/\/api\/v1\/.*/, (route) => json(route, { title: "Not found" }, 404));
  await page.route(/\/api\/v1\/me\/membership/, (route) => json(route, { title: "Not found" }, 404));
  await page.route(/\/api\/v1\/me$/, (route) => {
    if (route.request().method() === "PATCH") {
      const body = JSON.parse(route.request().postData() || "{}");
      return json(route, { ...me, ...body });
    }
    return json(route, me);
  });
}

async function bootProfile(page) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.tmProfile, { timeout: 30_000 });
  await page.waitForSelector("#auth-signed-out", { state: "attached", timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    document.getElementById("boot-screen")?.remove();
    for (const id of ["auth-signed-out", "auth-signed-in"]) {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    }
    const view = document.getElementById("profile-view");
    if (view) view.hidden = false;
    document.body.classList.add("tm-has-tabbar");
    window.tmProfile.enterProfile("#/profile");
  });
  await page.waitForSelector("#profile-form", { state: "visible", timeout: 15_000 });
  await page.waitForTimeout(500); // let the mocked /me populate the form
}

async function settle(page) {
  await page.evaluate(() => (document.fonts ? document.fonts.ready : Promise.resolve()));
  await page.waitForTimeout(400);
}

// Element shot of the phone field's row (label + picker + input + hint/error), padded via the form.
async function shotPhoneRow(page, name) {
  await settle(page);
  const row = page.locator("#profile-form");
  await row.scrollIntoViewIfNeeded();
  await row.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`  ✓ ${name}.png`);
}

async function withProfile(context, me, fn) {
  const page = await context.newPage();
  await mockApi(page, me);
  await bootProfile(page);
  await fn(page);
  await page.close();
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
  const context = await browser.newContext({ ...devices["Pixel 5"] });
  try {
    for (let i = 0; i < 40; i++) {
      try { const r = await context.request.get(`${BASE}/`); if (r.ok()) break; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 250));
    }

    const hasPicker = async (page) => (await page.locator("#profile-phone-country").count()) > 0;

    // 01 — London user, saved GB E.164 number: picker pre-selects 🇬🇧 +44, input shows the national part.
    await withProfile(context, { ...ME_BASE, city: "London", phone: "+442079460958" }, async (page) => {
      await shotPhoneRow(page, "01-saved-e164-splits-gb");
    });

    // 02 — Dubai user, NO phone: city soft-preselects 🇦🇪 UAE (the TM-781 signup-city rule).
    await withProfile(context, { ...ME_BASE, city: "Dubai", phone: "" }, async (page) => {
      await shotPhoneRow(page, "02-city-dubai-preselects-uae");
    });

    // 03 — the pinned list: render the select as an inline listbox (size attr) so the option order
    //      (🇬🇧 UK then 🇦🇪 UAE pinned above the alphabetical rest) is visible in a static shot.
    await withProfile(context, { ...ME_BASE, city: "London", phone: "" }, async (page) => {
      if (await hasPicker(page)) {
        await page.evaluate(() => {
          const sel = document.getElementById("profile-phone-country");
          sel.size = 8;
          sel.style.height = "auto";
        });
      }
      await shotPhoneRow(page, "03-picker-open-gb-ae-pinned");
    });

    // 04 — legacy bare number: picker drops to "Confirm country…" and save is blocked until confirmed.
    await withProfile(context, { ...ME_BASE, city: "London", phone: "020 7946 0958" }, async (page) => {
      await page.locator("#profile-form button[type=submit]").click().catch(() => {});
      await page.waitForTimeout(500);
      await shotPhoneRow(page, "04-legacy-number-confirm-blocked");
    });

    // 05 — save composes E.164: pick UAE, type a national number, save → success toast (PATCH echo).
    await withProfile(context, { ...ME_BASE, city: "London", phone: "" }, async (page) => {
      if (await hasPicker(page)) {
        await page.selectOption("#profile-phone-country", "AE");
        await page.fill("#profile-phone", "50 123 4567");
      } else {
        await page.fill("#profile-phone", "050 123 4567");
      }
      await page.locator("#profile-form button[type=submit]").click();
      await page.waitForTimeout(700);
      await settle(page);
      await page.screenshot({ path: join(OUT, "05-uae-number-saved.png"), fullPage: true });
      console.log("  ✓ 05-uae-number-saved.png");
    });
  } finally {
    await browser.close();
    stopServer();
  }
  console.log(`\nShots written to ${OUT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
