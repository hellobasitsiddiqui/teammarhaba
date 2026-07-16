// TM-771 — before/after visual evidence capture for the name/city validation fix.
//
// Mock-mode only (pattern: capture-chat-foundation.mjs). Boots the real SPA via serve.mjs, mocks the
// two profile endpoints (GET /api/v1/me + membership) and PATCH /api/v1/me (200 echo), reveals the
// profile view through the same hidden-flag seams router.js flips, then drives Ghalia's exact repro:
// type "676767" into First name / Last name / City and press Save changes.
//
//   • Run from a checkout WITHOUT the fix (main)  → the numeric values submit, PATCH fires, and the
//     "Profile saved." toast confirms the defect (BEFORE).
//   • Run from a checkout WITH the fix (TM-771)   → inline per-field errors block the save, no PATCH
//     is sent (AFTER).
//
// Usage:  node capture-tm771.mjs            (writes capture-out-tm771/*.png, git-ignored)
//         CAPTURE_OUT=/abs/path node capture-tm771.mjs
//         CAPTURE_PORT=8199 node capture-tm771.mjs

import { chromium, devices } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm771");
const PORT = Number(process.env.CAPTURE_PORT || 8198);
const BASE = `http://127.0.0.1:${PORT}`;

// A realistic MeResponse-shaped payload (matches the me() fixture in web/tools/profile-core.test.mjs):
// profile fields at the top level + the Firebase-owned accountState block (no createdAt — /me has none).
const ME = {
  uid: "capture-uid",
  email: "capture@example.com",
  displayName: "",
  firstName: "Ghalia",
  lastName: "Qazi",
  city: "London",
  age: 28,
  phone: "+44 20 7946 0958",
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

let patchCount = 0;

async function mockApi(page) {
  // Catch-all FIRST (Playwright checks routes newest-first, so specific mocks below win).
  await page.route(/\/api\/v1\/.*/, (route) => json(route, { title: "Not found" }, 404));
  await page.route(/\/api\/v1\/me\/membership/, (route) => json(route, { title: "Not found" }, 404));
  await page.route(/\/api\/v1\/me$/, (route) => {
    if (route.request().method() === "PATCH") {
      patchCount += 1;
      const body = JSON.parse(route.request().postData() || "{}");
      return json(route, { ...ME, ...body }); // echo-merge = what the unfixed backend did
    }
    return json(route, ME);
  });
}

// Boot the SPA signed-out, then reveal the profile surface — flips ONLY the same hidden/body-class
// seams router.js flips for a signed-in user; the profile DOM + CSS are untouched production UI.
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
    const bar = document.getElementById("app-tabbar");
    if (bar) bar.hidden = false;
    document.body.classList.add("tm-has-tabbar");
    document.getElementById("tab-profile")?.setAttribute("aria-current", "page");
    window.tmProfile.enterProfile("#/profile");
  });
  await page.waitForSelector("#profile-form", { state: "visible", timeout: 15_000 });
}

async function settle(page) {
  await page.evaluate(() => (document.fonts ? document.fonts.ready : Promise.resolve()));
  await page.waitForTimeout(450);
}

// Element shot of the Edit-profile card when it fits, else full page.
async function shotEditCard(page, name) {
  await settle(page);
  const card = page.locator("#profile-form");
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`  ✓ ${name}.png`);
}

async function shotFull(page, name) {
  await settle(page);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
  console.log(`  ✓ ${name}.png`);
}

async function fillAndSave(page, first, last, city) {
  for (const [id, value] of [["profile-firstName", first], ["profile-lastName", last], ["profile-city", city]]) {
    const input = page.locator(`#${id}`);
    await input.fill("");
    await input.fill(value);
  }
  await page.locator("#profile-form button[type=submit]").click();
  await page.waitForTimeout(600); // let inline errors render / toast appear
}

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const server = spawn(process.execPath, [join(HERE, "serve.mjs")], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: "inherit",
  });
  const stopServer = () => { try { server.kill("SIGTERM"); } catch { /* already gone */ } };
  process.on("exit", stopServer);

  const browser = await chromium.launch();
  const context = await browser.newContext({ ...devices["Pixel 5"] });

  try {
    for (let i = 0; i < 40; i++) {
      try { const r = await context.request.get(`${BASE}/`); if (r.ok()) break; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }

    const page = await context.newPage();
    await mockApi(page);
    await bootProfile(page);

    // 01 — the freshly-loaded edit form (with the fix: the three new field hints are visible).
    await shotEditCard(page, "01-edit-form");

    // 02 — Ghalia's repro: numeric values in all three fields + Save.
    //      BEFORE: values submit + "Profile saved." toast.  AFTER: inline errors, save blocked.
    await fillAndSave(page, "676767", "676767", "676767");
    await shotFull(page, "02-numeric-save-attempt");
    await shotEditCard(page, "03-numeric-save-attempt-form");
    console.log(`  PATCH /api/v1/me calls after numeric save: ${patchCount} ${patchCount === 0 ? "(blocked client-side)" : "(request went through)"}`);

    // 04 — real values still save fine (no over-rejection): punctuation + non-ASCII letters.
    await fillAndSave(page, "Jean-Luc", "O'Brien", "São Paulo");
    await shotFull(page, "04-valid-save");
  } finally {
    await browser.close();
    stopServer();
  }
  console.log(`\nShots written to ${OUT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
