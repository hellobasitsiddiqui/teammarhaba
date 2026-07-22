// TM-940 — before/after visual evidence for the event-chat message-row clean-up (industry-standard
// WhatsApp/Slack layout: aligned name+time header, reaction pill chips, tap-to-reveal actions, "Sent"
// receipt).
//
// Mock-mode only (pattern: capture-tm939.mjs). Boots the real SPA via serve.mjs, mocks GET /api/v1/me plus
// the conversation LIST / MESSAGES / MEMBERS / READ endpoints, reveals the chat surface through the same
// hidden-flag seams router.js flips for a signed-in user, and drives window.tmChat.enterChat() onto an
// EVENT_GROUP thread carrying: one INCOMING message (with a reaction chip) that starts a sender-run, and
// one OWN message (with a zero-reader receipt → "Sent"). Shot at 390x844 so the row layout, reaction pills
// and receipt are all visible.
//
//   • BEFORE (chat.js + chat-core.js + styles.css swapped to origin/main): scattered row — name above a
//     detached avatar, timestamp/reactions/reply-edit-delete stacked below with heavy whitespace, dashed
//     empty-oval react placeholder, a permanent reply/edit/delete icon column, receipt reads "Read by none".
//   • AFTER  (this branch): aligned name+time header on the avatar line, filled reaction pill chips on the
//     bubble's bottom edge, a compact "⋯" overflow (tap-to-reveal reply/edit/delete), receipt reads "Sent".
//
// Usage:  PHASE=after  node capture-tm940.mjs   (writes capture-out-tm940/TM-940-after.png)
//         PHASE=before node capture-tm940.mjs   (caller must have swapped the sources to main first)
//         CAPTURE_OUT=/abs/path CAPTURE_PORT=8194 PHASE=... node capture-tm940.mjs

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm940");
const PORT = Number(process.env.CAPTURE_PORT || 8194);
const PHASE = process.env.PHASE || "after"; // "before" (main sources) | "after" (this branch)
const BASE = `http://127.0.0.1:${PORT}`;
const THREAD_ID = "7001";

const ME = {
  uid: "capture-uid",
  email: "me@example.com",
  displayName: "",
  firstName: "Aya",
  lastName: "Rahman",
  city: "London",
  age: 33,
  phone: "+44 20 7946 0958",
  notificationPref: "EMAIL",
  timezone: "Europe/London",
  locale: "en-GB",
  role: "MEMBER",
  enabled: true,
  themeAccent: "teal",
  themeSketchy: true,
  accountState: { emailVerified: true, mfaEnabled: false, phoneVerified: false, photoURL: null, lastLoginAt: null },
};

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
  page: 0, size: 20, totalElements: 1, totalPages: 1,
};

// One INCOMING message that starts a sender-run (with a reaction chip) + one OWN message (zero-reader
// receipt → "Sent"). createdAt "now" keeps the own message inside the edit window (so all three actions
// exist behind the overflow).
const MESSAGES = {
  items: [
    {
      id: "m1", senderId: "other-1", senderName: "Omar",
      body: "Are we still on for Saturday?",
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
      mine: false,
      reactions: [{ emoji: "👍", count: 2, mine: false }],
    },
    {
      id: "m2", senderId: "capture-uid", senderName: "Aya",
      body: "Yes! Courts booked 6pm.",
      createdAt: new Date().toISOString(),
      mine: true,
      readReceipt: { count: 0, readerIds: [] },
    },
  ],
  page: 0, size: 30, totalElements: 2, totalPages: 1,
};

const MEMBERS = [{ id: "other-1", displayName: "Omar", firstName: "Omar", lastName: "K" }];

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function mockApi(page) {
  await page.route(/\/api\/v1\/.*/, (route) => json(route, { title: "Not found" }, 404)); // catch-all first
  await page.route(/\/api\/v1\/me\/conversations\/unread-total/, (route) => json(route, { total: 0 }));
  await page.route(/\/api\/v1\/me\/conversations(\?.*)?$/, (route) => json(route, CONVERSATIONS));
  await page.route(new RegExp(`/api/v1/conversations/${THREAD_ID}/messages`), (route) => json(route, MESSAGES));
  await page.route(new RegExp(`/api/v1/conversations/${THREAD_ID}/members`), (route) => json(route, MEMBERS));
  await page.route(new RegExp(`/api/v1/conversations/${THREAD_ID}/read`), (route) => json(route, { unread: 0 }));
  await page.route(/\/api\/v1\/me$/, (route) => json(route, ME));
}

async function bootThread(page) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.tmChat, { timeout: 30_000 });
  await page.waitForTimeout(4_000); // boot splash holds ~3.2s
  await page.evaluate(() => {
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
    window.tmChat.enterChat(); // render LIST → populate state.rows (thread resolves typeKey "event")
  });
  await page.waitForTimeout(800);
  await page.evaluate((id) => window.tmChat.enterChat(id), THREAD_ID);
  await page.waitForSelector('[data-testid="chat-composer"]', { state: "visible", timeout: 15_000 });
  await page.waitForSelector('[data-testid="chat-msg"]', { state: "visible", timeout: 15_000 });
  await page.evaluate(() => (document.fonts ? document.fonts.ready : Promise.resolve()));
  await page.waitForTimeout(500);
}

// Shoot the message body region (the rows under test) + a full-viewport shot for context.
async function shoot(page) {
  const body = page.locator('[data-testid="chat-body"], .tm-chat-body').first();
  try {
    await body.scrollIntoViewIfNeeded();
    await body.screenshot({ path: join(OUT, `TM-940-${PHASE}-body.png`) });
  } catch { /* fall back to the full-page shot below */ }
  await page.screenshot({ path: join(OUT, `TM-940-${PHASE}.png`) });
  console.log(`  ✓ TM-940-${PHASE}[-body].png`);
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
