// TM-907 — before/after visual evidence for the Profile NAME-LOCK read-only UX, at an Android-phone
// viewport (390×844). Two states of the SAME name fields:
//
//   • editable  (BEFORE) — me.nameLocked=false: First/Last name are normal editable inputs.
//   • locked    (AFTER)  — me.nameLocked=true : the SET First/Last name render READ-ONLY (aria-readonly,
//                          muted look) with the visible "Names are locked after your first event —
//                          contact support to correct." note, instead of save-then-error.
//
// Mock-mode (pattern: capture-tm913.mjs). Boots the real SPA via serve.mjs, mocks GET /api/v1/me with
// the two nameLocked values, reveals the profile surface through the same hidden-flag seams router.js
// flips for a signed-in user, and shoots the name-field region + a full-viewport shot. No backend, no
// onboarding gate — deterministic. The read-only behaviour comes from the REAL applyNameLock() in
// profile.js reacting to the mocked flag.
//
// Usage:  node capture-tm907.mjs
//         CAPTURE_OUT=/abs/path CAPTURE_PORT=8207 node capture-tm907.mjs

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm907");
const PORT = Number(process.env.CAPTURE_PORT || 8207);
const BASE = `http://127.0.0.1:${PORT}`;

// A realistic MeResponse-shaped base with a SET first/last name (so the lock has a non-empty name to
// freeze — the carve-out only freezes already-set names). Mirrors the capture-tm913 fixture shape.
const ME_BASE = {
  uid: "capture-uid",
  email: "aisha@example.com",
  firstName: "Aisha",
  lastName: "Khan",
  displayName: "Aisha Khan",
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
  interests: [],
  accountState: { emailVerified: true, mfaEnabled: false, phoneVerified: false, photoURL: null, lastLoginAt: null },
};

const STATES = [
  { key: "editable", label: "BEFORE (editable)", nameLocked: false },
  { key: "locked", label: "AFTER (locked read-only)", nameLocked: true },
];

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function mockApi(page, nameLocked) {
  await page.route(/\/api\/v1\/.*/, (route) => json(route, { title: "Not found" }, 404)); // catch-all first
  await page.route(/\/api\/v1\/me\/membership/, (route) =>
    json(route, { tier: "PAY_PER_EVENT", firstEventCreditAvailable: true }),
  );
  await page.route(/\/api\/v1\/me$/, (route) => json(route, { ...ME_BASE, nameLocked }));
}

async function bootProfile(page) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.tmProfile, { timeout: 30_000 });
  await page.waitForTimeout(4_000); // settle past the boot splash
  await page.evaluate(() => {
    // A minimal signed-in-looking Firebase user so load() can mint an Authorization header off
    // currentUser before fetching /me (the /me response itself is route-mocked).
    if (window.tmAuth && window.tmAuth.auth) {
      try {
        const stubUser = { uid: "capture-uid", photoURL: null, getIdToken: () => Promise.resolve("capture-token") };
        Object.defineProperty(window.tmAuth.auth, "currentUser", { configurable: true, get() { return stubUser; } });
      } catch { /* leave as-is */ }
    }
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
  await page.evaluate(() => (document.fonts ? document.fonts.ready : Promise.resolve()));
  await page.waitForTimeout(600); // let fillForm + applyNameLock settle
}

async function shoot(page, state) {
  // The name-field region: scroll the First-name field into view and shoot the surrounding fields +
  // the (conditional) lock note, plus a full-viewport shot for context.
  const firstField = page.locator(".tm-form-field").filter({ has: page.locator("#profile-firstName") }).first();
  await firstField.scrollIntoViewIfNeeded();
  // A tight crop around the two name fields + note by shooting the form-grid area is noisy; the two
  // labelled field wrappers + note read clearly in a full-viewport phone shot, which is the mandated
  // 390px evidence. Also grab the first-name field wrapper alone as a focused crop.
  await firstField.screenshot({ path: join(OUT, `TM-907-${state.key}-firstname-field.png`) });
  await page.screenshot({ path: join(OUT, `TM-907-${state.key}.png`) });

  // For the locked state, also shoot with the name fields AND the lock note both in frame, so the
  // read-only fields + their explanation appear together in one evidence image.
  if (state.nameLocked) {
    await page.locator("#profile-lastName").scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(OUT, `TM-907-${state.key}-with-note.png`) });
  }

  const probe = await page.evaluate(() => {
    const fn = document.getElementById("profile-firstName");
    const ln = document.getElementById("profile-lastName");
    const note = document.getElementById("profile-namelock-note");
    return {
      firstReadOnly: fn ? fn.readOnly : null,
      firstAriaReadonly: fn ? fn.getAttribute("aria-readonly") : null,
      firstValue: fn ? fn.value : null,
      lastReadOnly: ln ? ln.readOnly : null,
      noteHidden: note ? note.hidden : null,
      noteText: note && !note.hidden ? note.textContent.trim() : "",
      ageReadOnly: document.getElementById("profile-age")?.readOnly ?? null,
    };
  });
  console.log(`  ${state.label}:`, JSON.stringify(probe));
  return probe;
}

async function main() {
  await mkdir(OUT, { recursive: true });

  const server = spawn(process.execPath, [join(HERE, "serve.mjs")], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: "inherit",
  });
  const stopServer = () => { try { server.kill("SIGTERM"); } catch { /* already gone */ } };
  process.on("exit", stopServer);

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

  try {
    for (let i = 0; i < 40; i++) {
      try { const r = await context.request.get(`${BASE}/`); if (r.ok()) break; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }

    for (const state of STATES) {
      const page = await context.newPage();
      await mockApi(page, state.nameLocked);
      await bootProfile(page);
      await shoot(page, state);
      await page.close();
    }
  } finally {
    await browser.close();
    stopServer();
  }
  console.log(`\nShots written to ${OUT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
