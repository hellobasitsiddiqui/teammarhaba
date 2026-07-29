// TM-1154 — visual evidence for the profile-edit "Short bio" field spanning the FULL width of the
// 2-column edit grid instead of pairing lopsidedly beside a single-line field (it pairs with "Phone").
//
// Mock-mode only (pattern: capture-tm1096.mjs). Boots the real SPA via serve.mjs, mocks /me, reveals
// the profile edit form via window.tmProfile.enterProfile("#/profile"), and unhides the collapsible
// edit section so #profile-form is on screen.
//
// The change is a single additive class on the bio field wrapper (.tm-form-field-wide → grid-column:
// 1 / -1) + its CSS rule. So the faithful BEFORE == removing that class in the DOM (exactly main's
// render: no wide flag, no rule); the AFTER == the branch default. Both shots come from the real
// branch bundle at the SAME wide viewport.
//
// Shots (820px wide — past the 32rem=512px breakpoint, so the grid is 2-column):
//   01-before-bio-paired  — bio sits in the LEFT half of a row next to "Phone" (main's layout).
//   02-after-bio-fullwidth — bio spans the WHOLE row; "Phone" drops to the next row.
//
// Usage:  CAPTURE_OUT=/abs/path CAPTURE_PORT=8354 node capture-tm1154.mjs

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm1154");
const PORT = Number(process.env.CAPTURE_PORT || 8354);
const BASE = `http://127.0.0.1:${PORT}`;

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function mockApi(page) {
  const me = {
    uid: "capture-user", email: "sam@example.com", displayName: "Sam Rivers",
    firstName: "Sam", lastName: "Rivers", role: "USER", enabled: true,
    onboardingCompleted: true, notificationPref: "EMAIL", timezone: "Europe/London", locale: "en-GB",
    phone: "+447700900123", city: "London", age: 29, gender: "FEMALE", nationality: "GB",
    bio: "Weekend hiker, flat-white enthusiast, and occasional board-game host. Always up for meeting new people around London.",
    accountState: { emailVerified: true, mfaEnabled: false, phoneVerified: true, photoURL: null, lastLoginAt: null },
  };
  await page.route(/\/api\/v1\/.*/, (route) => json(route, { title: "Not found" }, 404));
  await page.route(/\/api\/v1\/me$/, (route) => json(route, me));
  await page.route(/\/api\/v1\/me\/membership/, (route) => json(route, { title: "Not found" }, 404));
  await page.route(/\/api\/v1\/interests(\?.*)?$/, (route) => json(route, { items: [] }));
  await page.route(/\/api\/v1\/me\/interests(\?.*)?$/, (route) => json(route, { items: [] }));
}

async function bootShell(page) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.tmProfile, { timeout: 30_000 });
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
    const view = document.getElementById("profile-view");
    if (view) view.hidden = false;
    window.tmProfile.enterProfile("#/profile");
  });
  await page.waitForSelector("#profile-section-edit", { state: "attached", timeout: 15_000 });
  // The edit form lives in the "Edit profile" accordion section (TM-879), which defaults COLLAPSED.
  // Expand it via its own header button so the section lays out naturally (panel.hidden → false).
  await page.evaluate(() => {
    const header = document.querySelector('#profile-section-edit button[aria-expanded]');
    if (header && header.getAttribute("aria-expanded") !== "true") header.click();
  });
  await page.waitForSelector("#profile-form", { state: "visible", timeout: 15_000 });
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
  const context = await browser.newContext({ viewport: { width: 820, height: 1200 } });
  try {
    for (let i = 0; i < 40; i++) {
      try { const r = await context.request.get(`${BASE}/`); if (r.ok()) break; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 250));
    }

    const page = await context.newPage();
    await mockApi(page);
    await bootShell(page);
    await revealForm(page);
    await settle(page);

    const grid = page.locator("#profile-form .tm-form-grid");
    await grid.waitFor({ state: "visible", timeout: 10_000 });

    // Confirm the branch DOM actually flagged the bio wide before we lean on it.
    const wideCount = await page.locator("#profile-form .tm-form-field-wide").count();
    if (!wideCount) throw new Error("no .tm-form-field-wide in the form — the bio wide flag is missing");

    // 01 — BEFORE: strip the wide class so bio flows as a normal 2-col cell (exactly main's render).
    await page.evaluate(() => {
      document.querySelectorAll("#profile-form .tm-form-field-wide")
        .forEach((el) => el.classList.remove("tm-form-field-wide"));
    });
    await settle(page);
    await grid.screenshot({ path: join(OUT, "01-before-bio-paired.png") });
    console.log("  ✓ 01-before-bio-paired.png (bio paired beside Phone — main's layout)");

    // 02 — AFTER: restore the class → bio spans the full row (the branch default).
    await page.evaluate(() => {
      const bio = document.querySelector("#profile-form #profile-bio")
        || document.querySelector('#profile-form [name="bio"]');
      const wrap = bio && bio.closest(".tm-form-field");
      if (wrap) wrap.classList.add("tm-form-field-wide");
    });
    await settle(page);
    await grid.screenshot({ path: join(OUT, "02-after-bio-fullwidth.png") });
    console.log("  ✓ 02-after-bio-fullwidth.png (bio spans the whole row)");

    await page.close();
  } finally {
    await browser.close();
    stopServer();
  }
  console.log(`\nShots written to ${OUT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
