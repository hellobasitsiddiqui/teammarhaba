// TM-1073 — before/after visual evidence for the soft-shade page background + white content cards, at an
// Android-phone viewport (390×844). Mock-mode (pattern: capture-tm940.mjs): boots the real SPA via
// serve.mjs, mocks GET /api/v1/me + the events listing, reveals the Events browse list through the same
// hidden-flag seams router.js flips for a signed-in user, and drives window.tmEvents.enterEvents().
//
//   • BEFORE (styles.css on origin/main): the page ground is near-white (--page-bg/--surface = --g1
//     #fafafa) so the white event cards barely separate from the page.
//   • AFTER  (this branch): the page ground is the soft shade (--shade-1 #e9ebee); the white cards pop.
//
// Run AFTER from the branch worktree; run BEFORE from the main worktree (its near-white styles.css).
// Usage:  PHASE=after CAPTURE_PORT=8271 CAPTURE_OUT=/abs/dir node capture-shade.mjs

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-shade");
const PORT = Number(process.env.CAPTURE_PORT || 8271);
const PHASE = process.env.PHASE || "after";
const BASE = `http://127.0.0.1:${PORT}`;

const ME = {
  uid: "capture-uid", email: "aya@example.com", displayName: "",
  firstName: "Aya", lastName: "Rahman", city: "London", age: 30,
  phone: "+44 20 7946 0958", notificationPref: "EMAIL", timezone: "Europe/London", locale: "en-GB",
  role: "MEMBER", enabled: true, themeAccent: "teal", themeSketchy: false,
  accountState: { emailVerified: true, mfaEnabled: false, phoneVerified: true, photoURL: null, lastLoginAt: null },
};

// A few London events, all upcoming (so none read "Ended"), with going counts → the cards render title,
// a `date · time · where` meta line, an "N going" pill and the primary "RSVP" state label.
const soon = (days, h, m) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};
const EVENTS = {
  items: [
    { id: 101, heading: "Coffee & Football meetup", startAt: soon(3, 9, 10), city: "London", locationText: "Regent's Park, London", goingCount: 8, myState: "NONE" },
    { id: 102, heading: "Board games night", startAt: soon(5, 19, 0), city: "London", locationText: "The Fox & Anchor, Clerkenwell", goingCount: 12, myState: "NONE" },
    { id: 103, heading: "Sunrise hike & breakfast", startAt: soon(6, 6, 30), city: "London", locationText: "Hampstead Heath", goingCount: 5, myState: "NONE" },
    { id: 104, heading: "Friday night bowling", startAt: soon(8, 20, 0), city: "London", locationText: "Bloomsbury Lanes", goingCount: 16, myState: "NONE" },
  ],
  page: 0, size: 100, totalElements: 4, totalPages: 1,
};

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function mockApi(page) {
  await page.route(/\/api\/v1\/.*/, (route) => json(route, { title: "Not found" }, 404)); // catch-all first
  await page.route(/\/api\/v1\/me$/, (route) => json(route, ME));
  await page.route(/\/api\/v1\/events(\?.*)?$/, (route) => json(route, EVENTS));
}

async function bootList(page) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.tmEvents, { timeout: 30_000 });
  await page.waitForTimeout(4_000); // boot splash holds ~3.2s
  await page.evaluate(() => {
    document.getElementById("boot-screen")?.remove();
    for (const elId of ["auth-signed-out", "auth-signed-in", "profile-view", "home-view", "chat-view"]) {
      const el = document.getElementById(elId);
      if (el) el.hidden = true;
    }
    const view = document.getElementById("events-view");
    if (view) view.hidden = false;
    const bar = document.getElementById("app-tabbar");
    if (bar) bar.hidden = false;
    document.body.classList.add("tm-has-tabbar");
    window.tmEvents.enterEvents(); // render the browse list into #events-view
  });
  await page.waitForSelector('[data-testid="event-card"]', { state: "visible", timeout: 15_000 });
  await page.evaluate(() => (document.fonts ? document.fonts.ready : Promise.resolve()));
  await page.waitForTimeout(600);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const server = spawn(process.execPath, [join(HERE, "serve.mjs")], {
    env: { ...process.env, PORT: String(PORT) }, stdio: "inherit",
  });
  const stopServer = () => { try { server.kill("SIGTERM"); } catch { /* already gone */ } };
  process.on("exit", stopServer);

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  });
  try {
    for (let i = 0; i < 40; i++) {
      try { const r = await context.request.get(`${BASE}/`); if (r.ok()) break; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    const page = await context.newPage();
    await mockApi(page);
    await bootList(page);
    await page.screenshot({ path: join(OUT, `TM-1073-${PHASE}.png`) });
    console.log(`  ✓ TM-1073-${PHASE}.png`);
    await page.close();
  } finally {
    await browser.close();
    stopServer();
  }
  console.log(`\nShot written to ${OUT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
