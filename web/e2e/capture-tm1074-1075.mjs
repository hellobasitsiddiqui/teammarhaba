// TM-1074 + TM-1075 — before/after visual evidence for the app-shell geometry fixes, at BOTH an
// Android-phone viewport (390×844) and a desktop viewport (1440×900), across a spread of tabs:
// Home, Events, Chat, Profile, the Admin hub (#/admin) and one admin console (#/admin/events).
//
// Mock-mode (pattern: capture-shade.mjs): boots the real SPA via serve.mjs, mocks the API the views
// read, reveals each view through the same hidden-flag seams router.js flips for a signed-in user,
// and drives the view's window.tm*.enter* render hook.
//
//   • TM-1075 BEFORE (styles.css on origin/main): body{place-items:center} → short content floats
//     mid-viewport and the .app column background shrinks to content height.
//   • TM-1075 AFTER  (this branch): body{place-items:start center} + .app{min-height:100dvh;
//     align-self:stretch} → content is top-aligned and the column fills the viewport top→bottom.
//   • TM-1074 BEFORE: .admin-console (min(72rem,96vw)) overflows the ≤480px clamped .app to the right.
//   • TM-1074 AFTER : .app:has(> .admin-console:not([hidden])) widens the shell → wide centred column,
//     no horizontal overflow.
//
// Run AFTER from the branch worktree; run BEFORE from the main worktree (its origin/main styles.css).
// Usage:  PHASE=after CAPTURE_PORT=8288 CAPTURE_OUT=/abs/dir node capture-tm1074-1075.mjs

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm1074-1075");
const PORT = Number(process.env.CAPTURE_PORT || 8288);
const PHASE = process.env.PHASE || "after";
const BASE = `http://127.0.0.1:${PORT}`;

const ME = {
  uid: "cap-admin-uid", email: "admin@example.com", displayName: "",
  firstName: "Ada", lastName: "Admin", city: "London", age: 34,
  phone: "+44 20 7946 0958", notificationPref: "EMAIL", timezone: "Europe/London", locale: "en-GB",
  role: "ADMIN", enabled: true, themeAccent: "teal", themeSketchy: false,
  accountState: { emailVerified: true, mfaEnabled: false, phoneVerified: true, photoURL: null, lastLoginAt: null },
};

const soon = (days, h, m) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};

// A short list — the point is short content on a tall screen (exercises the TM-1075 top-align/full-height).
const EVENTS = {
  items: [
    { id: 101, heading: "Coffee & Football meetup", startAt: soon(3, 9, 10), city: "London", locationText: "Regent's Park, London", goingCount: 8, myState: "NONE" },
    { id: 102, heading: "Board games night", startAt: soon(5, 19, 0), city: "London", locationText: "The Fox & Anchor, Clerkenwell", goingCount: 12, myState: "NONE" },
  ],
  page: 0, size: 100, totalElements: 2, totalPages: 1,
};

// Admin users/events lists — a couple of rows so the wide .tm-table renders (the TM-1074 overflow source).
const ADMIN_USERS = {
  content: [
    { id: 1, email: "admin@example.com", displayName: "Ada Admin", role: "ADMIN", enabled: true, createdAt: soon(-30, 9, 0), city: "London" },
    { id: 2, email: "sam@example.com", displayName: "Sam Member", role: "MEMBER", enabled: true, createdAt: soon(-10, 9, 0), city: "London" },
    { id: 3, email: "jo@example.com", displayName: "Jo Member", role: "MEMBER", enabled: false, createdAt: soon(-5, 9, 0), city: "Milton Keynes" },
  ],
  page: 0, size: 100, totalElements: 3, totalPages: 1,
};
const ADMIN_EVENTS = {
  content: [
    { id: 101, heading: "Coffee & Football meetup", startAt: soon(3, 9, 10), city: "London", status: "PUBLISHED", capacity: 20, goingCount: 8 },
    { id: 102, heading: "Board games night", startAt: soon(5, 19, 0), city: "London", status: "PUBLISHED", capacity: 30, goingCount: 12 },
  ],
  page: 0, size: 100, totalElements: 2, totalPages: 1,
};

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function mockApi(page) {
  // Catch-all first (any unmocked endpoint → empty-ish 200 so a view never hard-fails its render).
  await page.route(/\/api\/v1\/.*/, (route) => json(route, { content: [], items: [], page: 0, size: 100, totalElements: 0, totalPages: 0 }));
  await page.route(/\/api\/v1\/me$/, (route) => json(route, ME));
  await page.route(/\/api\/v1\/events(\?.*)?$/, (route) => json(route, EVENTS));
  await page.route(/\/api\/v1\/admin\/users(\?.*)?$/, (route) => json(route, ADMIN_USERS));
  await page.route(/\/api\/v1\/admin\/events(\?.*)?$/, (route) => json(route, ADMIN_EVENTS));
  await page.route(/\/api\/v1\/conversations(\?.*)?$/, (route) => json(route, { content: [], items: [], page: 0, size: 100, totalElements: 0, totalPages: 0 }));
}

/** Reveal exactly one view container (hide the rest) + the tab bar, then run its render hook. */
async function showView(page, { viewId, drive }) {
  await page.evaluate(({ viewId }) => {
    document.getElementById("boot-screen")?.remove();
    const ALL = [
      "auth-signed-out", "auth-signed-in", "profile-view", "onboarding-view", "terms-view",
      "help-view", "events-view", "chat-view", "notifications-view",
      "admin-hub-view", "admin-view", "admin-events-view", "admin-event-form-view",
      "admin-venues-view", "admin-interests-view",
    ];
    for (const id of ALL) {
      const el = document.getElementById(id);
      if (el) el.hidden = id !== viewId;
    }
    const bar = document.getElementById("app-tabbar");
    if (bar) bar.hidden = false;
    document.body.classList.add("tm-has-tabbar");
  }, { viewId });
  await drive(page);
  await page.evaluate(() => (document.fonts ? document.fonts.ready : Promise.resolve()));
  await page.waitForTimeout(500);
}

const VIEWS = [
  { name: "home", viewId: "auth-signed-in", drive: async (p) => { await p.evaluate(() => window.tmHome?.enterHome?.()); } },
  { name: "events", viewId: "events-view", drive: async (p) => { await p.evaluate(() => window.tmEvents?.enterEvents?.()); await p.waitForTimeout(400); } },
  { name: "chat", viewId: "chat-view", drive: async (p) => { await p.evaluate(() => window.tmChat?.enterChat?.()); await p.waitForTimeout(400); } },
  { name: "profile", viewId: "profile-view", drive: async (p) => { await p.evaluate(() => window.tmProfile?.enterProfile?.("#/profile")); await p.waitForTimeout(400); } },
  { name: "admin-hub", viewId: "admin-hub-view", drive: async (p) => { await p.evaluate(() => window.tmAdminHub?.enterAdminHub?.()); await p.waitForTimeout(300); } },
  { name: "admin-events", viewId: "admin-events-view", drive: async (p) => { await p.evaluate(() => window.tmAdminEvents?.enterAdminEvents?.()); await p.waitForTimeout(500); } },
];

const VIEWPORTS = [
  { label: "390", width: 390, height: 844, mobile: true },
  { label: "1440", width: 1440, height: 900, mobile: false },
];

async function main() {
  await mkdir(OUT, { recursive: true });
  const server = spawn(process.execPath, [join(HERE, "serve.mjs")], {
    env: { ...process.env, PORT: String(PORT) }, stdio: "inherit",
  });
  const stopServer = () => { try { server.kill("SIGTERM"); } catch { /* already gone */ } };
  process.on("exit", stopServer);

  const browser = await chromium.launch();
  try {
    // Wait for the server.
    const probe = await browser.newContext();
    for (let i = 0; i < 60; i++) {
      try { const r = await probe.request.get(`${BASE}/`); if (r.ok()) break; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    await probe.close();

    for (const vp of VIEWPORTS) {
      for (const view of VIEWS) {
        const context = await browser.newContext({
          viewport: { width: vp.width, height: vp.height },
          deviceScaleFactor: vp.mobile ? 2 : 1, isMobile: vp.mobile, hasTouch: vp.mobile,
        });
        const page = await context.newPage();
        await mockApi(page);
        await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => window.tmHome && window.tmEvents && window.tmAdminHub, { timeout: 30_000 });
        await page.waitForTimeout(3500); // boot splash holds ~3.2s
        await showView(page, view);
        const file = `TM-1074-1075_${view.name}_${vp.label}_${PHASE}.png`;
        await page.screenshot({ path: join(OUT, file), fullPage: false });
        console.log(`  ✓ ${file}`);
        await page.close();
        await context.close();
      }
    }
  } finally {
    await browser.close();
    stopServer();
  }
  console.log(`\nShots written to ${OUT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
