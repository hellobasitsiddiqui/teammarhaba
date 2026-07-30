// TM-1177 — before/after visual evidence for scoping the app-download store badges + the build/version
// stamp to the Help page (#/help) + the signed-out login screen ONLY, at an Android-phone viewport
// (390×844). Mock-mode (pattern: capture-shade.mjs / capture-tm940.mjs): boots the real SPA via
// serve.mjs, mocks GET /api/v1/me + the events listing, reveals a view through the same hidden-flag
// seams router.js flips, and drives the REAL footer wiring (footer.js updateFooter) for the target
// (signedIn, route) so the shots reflect the shipped logic, not a hand-toggled mock.
//
//   • SCENE=events-signed-in — a signed-in Events browse list. On origin/main (run this scene with
//     PHASE=before from the MAIN worktree) the "Get the app" badges + the build stamp are present at
//     the bottom of the footer; on this branch (PHASE=after) they are GONE.
//   • SCENE=help — signed-in on #/help: badges + stamp STILL present (Help is app-download scope).
//   • SCENE=login — signed-out login screen: badges + stamp STILL present (pre-auth scope).
//
// Usage:  SCENE=events-signed-in PHASE=after CAPTURE_PORT=8277 CAPTURE_OUT=/abs/dir node capture-tm1177.mjs
//
// playwright-core is resolved from the MAIN clone's e2e node_modules (this worktree shares no install).
import pkg from "/Users/basitsiddiqui/Projects/TeamMarhaba/teammarhaba/web/e2e/node_modules/playwright-core/index.js";
const { chromium } = pkg;
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm1177");
const PORT = Number(process.env.CAPTURE_PORT || 8277);
const PHASE = process.env.PHASE || "after";
const SCENE = process.env.SCENE || "events-signed-in";
const BASE = `http://127.0.0.1:${PORT}`;

const ME = {
  uid: "capture-uid", email: "aya@example.com", displayName: "",
  firstName: "Aya", lastName: "Rahman", city: "London", age: 30,
  phone: "+44 20 7946 0958", notificationPref: "EMAIL", timezone: "Europe/London", locale: "en-GB",
  role: "MEMBER", enabled: true, themeAccent: "teal", themeSketchy: false,
  accountState: { emailVerified: true, mfaEnabled: false, phoneVerified: true, photoURL: null, lastLoginAt: null },
};

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
  ],
  page: 0, size: 100, totalElements: 3, totalPages: 1,
};

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function mockApi(page) {
  await page.route(/\/api\/v1\/.*/, (route) => json(route, { title: "Not found" }, 404)); // catch-all first
  await page.route(/\/api\/v1\/me$/, (route) => json(route, ME));
  await page.route(/\/api\/v1\/events(\?.*)?$/, (route) => json(route, EVENTS));
  // A believable /version so the build stamp has real content to show (or, after, to be hidden).
  await page.route(/\/version$/, (route) =>
    json(route, { sha: "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567", version: "0a1b2c3", revision: "teammarhaba-backend-00219-abc", buildTime: "2026-07-25T10:00:00Z" }),
  );
}

async function boot(page) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.tmEvents, { timeout: 30_000 });
  await page.waitForTimeout(4_000); // boot splash holds ~3.2s
}

// Reveal a view + drive the REAL footer wiring for (signedIn, route), matching what router.render() does.
async function revealAndDriveFooter(page, { signedIn, route, view, enter }) {
  await page.evaluate(
    async ({ signedIn, route, view, enter }) => {
      document.getElementById("boot-screen")?.remove();
      const allViews = [
        "auth-signed-out", "auth-signed-in", "profile-view", "home-view", "chat-view",
        "events-view", "help-view",
      ];
      for (const id of allViews) {
        const el = document.getElementById(id);
        if (el) el.hidden = id !== view;
      }
      if (signedIn) {
        const bar = document.getElementById("app-tabbar");
        if (bar) bar.hidden = false;
        document.body.classList.add("tm-has-tabbar");
        document.body.setAttribute("data-auth", "in");
      } else {
        document.body.setAttribute("data-auth", "out");
      }
      if (enter === "events" && window.tmEvents?.enterEvents) window.tmEvents.enterEvents();
      // Drive the shipped footer logic for this (signedIn, route) — the same call router.render() makes.
      const mod = await import("/assets/footer.js");
      mod.updateFooter({ signedIn, route });
    },
    { signedIn, route, view, enter },
  );
  await page.evaluate(() => (document.fonts ? document.fonts.ready : Promise.resolve()));
  await page.waitForTimeout(500);
}

const SCENES = {
  "events-signed-in": { signedIn: true, route: "#/events", view: "events-view", enter: "events" },
  help: { signedIn: true, route: "#/help", view: "help-view", enter: null },
  login: { signedIn: false, route: "#/login", view: "auth-signed-out", enter: null },
};

async function main() {
  const scene = SCENES[SCENE];
  if (!scene) throw new Error(`unknown SCENE=${SCENE} (want one of ${Object.keys(SCENES).join(", ")})`);
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
    await boot(page);
    await revealAndDriveFooter(page, scene);
    const name = `TM-1177-${SCENE}-${PHASE}.png`;
    await page.screenshot({ path: join(OUT, name), fullPage: true });
    console.log(`  ✓ ${name}`);
    await page.close();
  } finally {
    await browser.close();
    stopServer();
  }
  console.log(`\nShot written to ${OUT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
