// TM-939 — before/after visual evidence for the event-chat composer's "Send as announcement" toggle
// squeezing the message input at a 390px viewport.
//
// Mock-mode only (pattern: capture-tm882.mjs). Boots the real SPA via serve.mjs, mocks GET /api/v1/me
// (role ADMIN — the announce toggle is admin-only, TM-710) plus the conversation LIST, MESSAGES, MEMBERS
// and READ endpoints the composer needs, then reveals the chat surface through the same hidden-flag seams
// router.js flips for a signed-in user, and drives window.tmChat.enterChat() straight onto an EVENT_GROUP
// thread (typeKey "event", NOT "admin") so the announce bar mounts. Shot at 390x844.
//
//   • BEFORE (styles.css swapped to origin/main): .tm-chat-announce-bar has no full-width basis → it wraps
//     INLINE to the left of the input on the same flex row, squeezing the input to a "Mes:" sliver.
//   • AFTER  (this branch): .tm-chat-announce-bar gets `flex: 0 0 100%` (mirroring .tm-chat-reply-bar) →
//     the toggle drops to its OWN full-width row BELOW a full-width input + send button (announceBar
//     is last in the composer DOM).
//
// Usage:  PHASE=after  node capture-tm939.mjs   (writes capture-out-tm939/TM-939-after.png)
//         PHASE=before node capture-tm939.mjs   (caller must have swapped styles.css to main first)
//         CAPTURE_OUT=/abs/path CAPTURE_PORT=8199 PHASE=... node capture-tm939.mjs

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm939");
const PORT = Number(process.env.CAPTURE_PORT || 8199);
const PHASE = process.env.PHASE || "after"; // "before" (main styles) | "after" (this branch)
const BASE = `http://127.0.0.1:${PORT}`;
const THREAD_ID = "7001";

// An ADMIN MeResponse — createAdminFlagCache reads role.toUpperCase()==="ADMIN" to mount the toggle.
const ME = {
  uid: "capture-admin-uid",
  email: "admin@example.com",
  displayName: "",
  firstName: "Aya",
  lastName: "Rahman",
  city: "London",
  age: 33,
  phone: "+44 20 7946 0958",
  notificationPref: "EMAIL",
  timezone: "Europe/London",
  locale: "en-GB",
  role: "ADMIN",
  enabled: true,
  themeAccent: "teal",
  themeSketchy: true,
  accountState: { emailVerified: true, mfaEnabled: false, phoneVerified: false, photoURL: null, lastLoginAt: null },
};

// One EVENT_GROUP conversation summary (type !== ADMIN_BROADCAST → toConversationRow gives type.key
// "event", so maybeMountAnnounceToggle proceeds).
const CONVERSATIONS = {
  items: [
    {
      id: THREAD_ID,
      title: "Riyadh Padel Meetup",
      type: "EVENT_GROUP",
      lastMessagePreview: "See you all on the courts!",
      lastMessageAt: new Date().toISOString(),
      unreadCount: 0,
      notificationsMuted: false,
      left: false,
    },
  ],
  page: 0,
  size: 20,
  totalElements: 1,
  totalPages: 1,
};

const MESSAGES = {
  items: [
    {
      id: "m1",
      senderId: "other-1",
      senderName: "Omar",
      body: "Are we still on for Saturday?",
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
      mine: false,
    },
    {
      id: "m2",
      senderId: "capture-admin-uid",
      senderName: "Aya",
      body: "Yes! Courts booked 6pm.",
      createdAt: new Date(Date.now() - 1_800_000).toISOString(),
      mine: true,
    },
  ],
  page: 0,
  size: 30,
  totalElements: 2,
  totalPages: 1,
};

const MEMBERS = [
  { id: "other-1", displayName: "Omar", firstName: "Omar", lastName: "K" },
];

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function mockApi(page) {
  // Catch-all FIRST (Playwright checks routes newest-first, so specific mocks below win).
  await page.route(/\/api\/v1\/.*/, (route) => json(route, { title: "Not found" }, 404));
  await page.route(/\/api\/v1\/me\/conversations\/unread-total/, (route) => json(route, { total: 0 }));
  await page.route(/\/api\/v1\/me\/conversations(\?.*)?$/, (route) => json(route, CONVERSATIONS));
  await page.route(new RegExp(`/api/v1/conversations/${THREAD_ID}/messages`), (route) => json(route, MESSAGES));
  await page.route(new RegExp(`/api/v1/conversations/${THREAD_ID}/members`), (route) => json(route, MEMBERS));
  await page.route(new RegExp(`/api/v1/conversations/${THREAD_ID}/read`), (route) =>
    json(route, { unread: 0 }),
  );
  await page.route(/\/api\/v1\/me$/, (route) => json(route, ME));
}

// Boot the SPA signed-out, then reveal the chat surface: flips ONLY the same hidden/body-class seams
// router.js flips for a signed-in user, then drives the list once (to populate state.rows so the thread
// resolves typeKey "event") and opens the thread.
async function bootThread(page) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.tmChat, { timeout: 30_000 });
  await page.waitForTimeout(4_000); // boot splash holds ~3.2s
  await page.evaluate((id) => {
    document.getElementById("boot-screen")?.remove();
    for (const elId of ["auth-signed-out", "auth-signed-in", "profile-view"]) {
      const el = document.getElementById(elId);
      if (el) el.hidden = true;
    }
    const view = document.getElementById("chat-view");
    if (view) view.hidden = false;
    const bar = document.getElementById("app-tabbar");
    if (bar) bar.hidden = false;
    document.body.classList.add("tm-has-tabbar");
    // 1 — render the LIST so state.rows is populated (thread meta resolves typeKey "event" from it).
    window.tmChat.enterChat();
  }, THREAD_ID);
  // let the list fetch land
  await page.waitForTimeout(800);
  // 2 — open the EVENT thread; the announce toggle mounts async once the ADMIN flag resolves.
  await page.evaluate((id) => window.tmChat.enterChat(id), THREAD_ID);
  await page.waitForSelector('[data-testid="chat-composer"]', { state: "visible", timeout: 15_000 });
  // Wait for the async admin-flag resolve to reveal the announce bar.
  await page.waitForSelector('[data-testid="chat-announce-toggle"]', { state: "attached", timeout: 15_000 });
  await page.evaluate(() => (document.fonts ? document.fonts.ready : Promise.resolve()));
  await page.waitForTimeout(500);
}

// Shoot the composer area (the region under test) + a full-viewport shot for context.
async function shoot(page) {
  const composer = page.locator('[data-testid="chat-composer"]');
  await composer.scrollIntoViewIfNeeded();
  await composer.screenshot({ path: join(OUT, `TM-939-${PHASE}-composer.png`) });
  await page.screenshot({ path: join(OUT, `TM-939-${PHASE}.png`) });
  console.log(`  ✓ TM-939-${PHASE}[-composer].png`);
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
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });

  try {
    for (let i = 0; i < 40; i++) {
      try { const r = await context.request.get(`${BASE}/`); if (r.ok()) break; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }

    const page = await context.newPage();
    await mockApi(page);
    await bootThread(page);
    await shoot(page);
    await page.close();
  } finally {
    await browser.close();
    stopServer();
  }
  console.log(`\nShots written to ${OUT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
