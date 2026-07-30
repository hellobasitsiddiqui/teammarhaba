// TM-1175 — signed-in visual of the pinned top bar (headline + bell) on Home + Events, at 390×844.
// Mock-mode (pattern: capture-shade.mjs): boots the real SPA via serve.mjs, mocks /me + /events, reveals
// each view through the same hidden-flag seams, and reveals the top-bar chrome the way the harness already
// reveals the tab bar (real CSS/markup/fonts; the headline TEXT is the real topbar-headline-core output).
// Events also keeps its own sub-header so the temporary double-header is visible.
import pkg from "/Users/basitsiddiqui/Projects/TeamMarhaba/teammarhaba/web/e2e/node_modules/playwright-core/index.js";
const { chromium } = pkg;
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-1175");
const PORT = Number(process.env.CAPTURE_PORT || 8291);
const BASE = `http://127.0.0.1:${PORT}`;

const ME = {
  uid: "cap-uid", email: "aya@example.com", displayName: "", firstName: "Aya", lastName: "Rahman",
  city: "London", age: 30, phone: "+44 20 7946 0958", notificationPref: "EMAIL",
  timezone: "Europe/London", locale: "en-GB", role: "MEMBER", enabled: true,
  themeAccent: "teal", themeSketchy: false,
  accountState: { emailVerified: true, mfaEnabled: false, phoneVerified: true, photoURL: null, lastLoginAt: null },
};
const soon = (days, h, m) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(h, m, 0, 0); return d.toISOString(); };
const EVENTS = {
  items: [
    { id: 101, heading: "Coffee & Football meetup", startAt: soon(3, 9, 10), city: "London", locationText: "Regent's Park, London", goingCount: 8, myState: "NONE" },
    { id: 102, heading: "Board games night", startAt: soon(5, 19, 0), city: "London", locationText: "The Fox & Anchor, Clerkenwell", goingCount: 12, myState: "NONE" },
    { id: 103, heading: "Sunrise hike & breakfast", startAt: soon(6, 6, 30), city: "London", locationText: "Hampstead Heath", goingCount: 5, myState: "NONE" },
  ],
  page: 0, size: 100, totalElements: 3, totalPages: 1,
};
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function mockApi(page) {
  await page.route(/\/api\/v1\/.*/, (route) => json(route, { title: "Not found" }, 404));
  await page.route(/\/api\/v1\/me$/, (route) => json(route, ME));
  await page.route(/\/api\/v1\/events(\?.*)?$/, (route) => json(route, EVENTS));
  await page.route(/\/api\/v1\/me\/conversations(\?.*)?$/, (route) => json(route, { items: [] }));
}

// Reveal the top-bar chrome the same faithful way the harness reveals the tab bar. The headline TEXT is
// the real topbar-headline-core output for that route.
async function revealBar(page, headline) {
  await page.evaluate((headline) => {
    // Faithfulness: the router hides the walking-skeleton brand block + footer on the self-headed
    // routes (shell-brand.js / footer.js). The mock bypasses the router, so replicate that here — else
    // "Circle / Find your people / Ready when you are." + the store badges show as false artifacts.
    for (const el of [
      document.querySelector("main.app > h1"),
      document.querySelector("main.app > .tagline"),
      document.getElementById("status"),
      document.getElementById("me"),
      document.querySelector(".app-footer"),
      document.querySelector(".app-store-badges"),
    ]) { if (el) el.hidden = true; }

    const bar = document.getElementById("app-topbar");
    if (bar) bar.hidden = false;
    const h = document.getElementById("app-topbar-headline");
    if (h) { h.hidden = false; h.textContent = headline; }
    const bell = document.getElementById("nav-notif-bell");
    if (bell) bell.hidden = false;
    const badge = bell && bell.querySelector(".tm-notif-badge");
    if (badge) { badge.hidden = false; badge.textContent = "3"; }
    document.body.classList.add("tm-has-tabbar");
    const tb = document.getElementById("app-tabbar");
    if (tb) tb.hidden = false;
  }, headline);
  await page.evaluate(() => (document.fonts ? document.fonts.ready : Promise.resolve()));
  await page.waitForTimeout(500);
}

const hideAllViews = () => {
  for (const id of ["auth-signed-out", "auth-signed-in", "profile-view", "events-view", "chat-view"]) {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  }
  document.getElementById("boot-screen")?.remove();
};

async function main() {
  await mkdir(OUT, { recursive: true });
  const server = spawn(process.execPath, [join(HERE, "serve.mjs")], { env: { ...process.env, PORT: String(PORT) }, stdio: "inherit" });
  const stop = () => { try { server.kill("SIGTERM"); } catch { /* gone */ } };
  process.on("exit", stop);

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  try {
    for (let i = 0; i < 40; i++) { try { const r = await context.request.get(`${BASE}/`); if (r.ok()) break; } catch { /* wait */ } await new Promise((r) => setTimeout(r, 250)); }
    const page = await context.newPage();
    await mockApi(page);
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.tmEvents && window.tmHome && window.tmChat, { timeout: 30_000 });
    await page.waitForTimeout(4_000);

    // EVENTS — headline "Events · London" + the events view's own "Events" sub-header (double-header).
    await page.evaluate(hideAllViews);
    await page.evaluate(() => { const v = document.getElementById("events-view"); if (v) v.hidden = false; window.tmEvents.enterEvents(); });
    await page.waitForSelector('[data-testid="event-card"]', { state: "visible", timeout: 15_000 });
    await revealBar(page, "Events · London");
    await page.screenshot({ path: join(OUT, "TM-1175-events.png") });
    console.log("  ✓ events");

    // HOME — headline "Complete the circle" (clean; home has no plain title header).
    await page.evaluate(hideAllViews);
    await page.evaluate(async () => { const v = document.getElementById("auth-signed-in"); if (v) v.hidden = false; await window.tmHome.enterHome(); });
    await page.waitForTimeout(1_500);
    await revealBar(page, "Complete the circle");
    await page.screenshot({ path: join(OUT, "TM-1175-home.png") });
    console.log("  ✓ home");

    // CHAT — headline "Your event chats"; the list no longer paints its own "Chats" header.
    await page.evaluate(hideAllViews);
    await page.evaluate(() => { const v = document.getElementById("chat-view"); if (v) v.hidden = false; window.tmChat.enterChat(); });
    await page.waitForTimeout(1_200);
    await revealBar(page, "Your event chats");
    await page.screenshot({ path: join(OUT, "TM-1175-chat.png") });
    console.log("  ✓ chat");

    await page.close();
  } finally {
    await browser.close();
    stop();
  }
  console.log(`\nShots in ${OUT}`);
}
main().catch((err) => { console.error(err); process.exit(1); });
