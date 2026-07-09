// Chat foundation — visual evidence capture (TM-564).
//
// A SELF-CONTAINED screenshot harness for the Event Chat foundation screens (the chat section shell
// TM-438 + the unread Chat-tab badge TM-439, reading the TM-436 conversation API). It produces named,
// viewable PNGs at a phone viewport (Pixel 5, mobile-web) on the default Paper look, for the cross-
// surface visual-evidence ticket TM-564.
//
// WHY THIS IS SEPARATE FROM THE PLAYWRIGHT SUITE. The real tests/ specs sign in through the Firebase
// Auth emulator and hit a live backend + Postgres. But the chat *content* screens need SEEDED
// conversations to render anything, and the backend has no conversation-WRITE path yet (message posting
// is a later ticket, TM-447), so a live backend returns an EMPTY list. To show a populated list / thread
// / unread badge we therefore inject fixtures at the network seam that match the TM-436 read-API
// contract exactly (ConversationSummaryResponse / ConversationMessageResponse in the shared page
// envelope — see web/src/assets/chat-core.js), driving the REAL chat.js / chat-tab-badge.js DOM + the
// real Paper CSS. So every pixel here is the production UI; only the JSON payloads are fixtures.
//
// HOW IT WORKS. It boots the real web app (index.html via serve.mjs, which it spawns), lets the SPA
// settle to the signed-out gate, then — with the conversation endpoints route-mocked — un-hides the
// #chat-view + the bottom tab bar and calls the app's own QA seams (window.tmChat.enterChat /
// window.tmChatTabBadge.update). getIdToken() returns null when signed-out (auth.js), so the mocked
// fetch resolves without any auth. No backend, emulator or Postgres required — `node capture-...mjs`.
//
// Run (Node 20, the version CI pins):  npm run capture:chat   (from web/e2e)
// Output: capture-out/*.png (git-ignored).

import { chromium, devices } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "capture-out");
const PORT = Number(process.env.CAPTURE_PORT || 8199);
const BASE = `http://127.0.0.1:${PORT}`;

// ── Fixtures (shaped exactly like the TM-436 read API the chat screens consume) ───────────────────
const iso = (minsAgo) => new Date(Date.now() - minsAgo * 60_000).toISOString();
const envelope = (items) => ({ items, page: 0, size: 100, totalElements: items.length, totalPages: 1 });

// A UNIFIED conversation list: event group chats (EVENT_GROUP) + admin broadcasts (ADMIN_BROADCAST),
// varied unread so both the row unread pills and the summed Chat-tab badge have something to show.
// Unread total = 3 + 1 + 0 + 8 + 0 = 12  → the capped "9+" tab badge.
const CONVERSATIONS = [
  { id: "evt-201", type: "EVENT_GROUP", title: "Sunday Morning Dog Walk", eventId: 201,
    lastMessagePreview: "Priya: See you all at the north gate at 9!", lastMessageAt: iso(4), lastActiveAt: iso(4), unreadCount: 3 },
  { id: "adm-1", type: "ADMIN_BROADCAST", title: "TeamMarhaba",
    lastMessagePreview: "Group chat has arrived for your events 🎉", lastMessageAt: iso(90), lastActiveAt: iso(90), unreadCount: 1 },
  { id: "evt-207", type: "EVENT_GROUP", title: "Rooftop Board Games", eventId: 207,
    lastMessagePreview: "Sam: I can bring Catan and Codenames", lastMessageAt: iso(180), lastActiveAt: iso(180), unreadCount: 0 },
  { id: "evt-198", type: "EVENT_GROUP", title: "Riverside 5k Run Club", eventId: 198,
    lastMessagePreview: "You: Nice pace today everyone 👏", lastMessageAt: iso(60 * 26), lastActiveAt: iso(60 * 26), unreadCount: 8 },
  { id: "adm-2", type: "ADMIN_BROADCAST", title: "TeamMarhaba",
    lastMessagePreview: "Reminder: complete your profile for better matches", lastMessageAt: iso(60 * 50), lastActiveAt: iso(60 * 50), unreadCount: 0 },
];

// One event thread — chronological, opening with a system "you joined" notice, a couple of reacted
// messages, ending on the newest. (chat.js renders a flat, sender-agnostic list; system → centred.)
const EVENT_THREAD = [
  { id: "m1", system: true, body: "You joined Sunday Morning Dog Walk", createdAt: iso(240) },
  { id: "m2", senderId: 55, body: "Morning all! Weather looks perfect for a walk ☀️", createdAt: iso(150), reactions: [{ emoji: "👍", count: 2 }, { emoji: "🎉", count: 1 }] },
  { id: "m3", senderId: 61, body: "Bringing my golden retriever Max — he loves company", createdAt: iso(120), reactions: [{ emoji: "❤️", count: 3 }] },
  { id: "m4", senderId: 55, body: "Perfect. North gate, 9am sharp — there's parking on Elm Street.", createdAt: iso(30), deepLink: "#/events/201" },
  { id: "m5", senderId: 72, body: "See you all at the north gate at 9!", createdAt: iso(4) },
];

// One admin-broadcast thread — the "from TeamMarhaba" system voice (rendered as centred system notices).
const ADMIN_THREAD = [
  { id: "a1", system: true, body: "📣 Group chat has arrived! Your event chats now live under the Chat tab.", createdAt: iso(120) },
  { id: "a2", system: true, body: "Reminder: complete your profile to get better event matches.", createdAt: iso(30) },
];

const RE = {
  list: /\/api\/v1\/me\/conversations/,
  messages: /\/api\/v1\/conversations\/[^/]+\/messages/,
  read: /\/api\/v1\/conversations\/[^/]+\/read/,
};
const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

// Route the mark-read POST on every page (idempotent no-op) so opening a thread never hits the network.
async function mockRead(page) {
  await page.route(RE.read, (route) =>
    json(route, { conversationId: "x", lastReadAt: new Date().toISOString(), unreadCount: 0 }));
}

// Boot the real SPA, settle to the signed-out gate, then reveal the chat surface without real auth.
async function bootChatShell(page) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  // Wait for the app's module graph (incl. chat.js + chat-tab-badge.js QA seams) to be live.
  await page.waitForFunction(() => window.tmChat && window.tmChatTabBadge, { timeout: 30_000 });
  // Let the first auth-state render settle (signed-out → login card) so it can't re-hide us afterwards.
  await page.waitForSelector("#auth-signed-out", { state: "attached", timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(300);
  // Bypass the auth guard for a pure VISUAL capture: hide the signed-out/home shells, show the chat
  // view + the mobile tab bar (the router would do this for a signed-in, un-gated user). Faithful — it
  // only flips the same `hidden`/body-class seams router.js flips; the chat DOM + CSS are untouched.
  await page.evaluate(() => {
    document.getElementById("boot-screen")?.remove();
    for (const id of ["auth-signed-out", "auth-signed-in"]) {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    }
    const chat = document.getElementById("chat-view");
    if (chat) chat.hidden = false;
    const bar = document.getElementById("app-tabbar");
    if (bar) bar.hidden = false;
    document.body.classList.add("tm-has-tabbar");
    document.getElementById("tab-chat")?.setAttribute("aria-current", "page");
  });
}

async function settle(page) {
  await page.evaluate(() => (document.fonts ? document.fonts.ready : Promise.resolve()));
  await page.waitForTimeout(450);
}

async function shot(page, name) {
  await settle(page);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
  console.log(`  ✓ ${name}.png`);
}

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  // Spawn the static web server (serves web/src with the e2e runtime config injected).
  const server = spawn(process.execPath, [join(HERE, "serve.mjs")], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: "inherit",
  });
  const stopServer = () => { try { server.kill("SIGTERM"); } catch { /* already gone */ } };
  process.on("exit", stopServer);

  const browser = await chromium.launch();
  const context = await browser.newContext({ ...devices["Pixel 5"] });

  try {
    // Wait until the server answers.
    for (let i = 0; i < 40; i++) {
      try { const r = await context.request.get(`${BASE}/`); if (r.ok()) break; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }

    // 1) Populated unified LIST — event + admin threads, type badges, per-row unread pills.
    {
      const page = await context.newPage();
      await page.route(RE.list, (route) => json(route, envelope(CONVERSATIONS)));
      await mockRead(page);
      await bootChatShell(page);
      await page.evaluate(() => window.tmChat.enterChat());
      await page.waitForSelector('[data-testid="chat-row"]', { timeout: 15_000 });
      await shot(page, "01-chat-list-populated");
      await page.close();
    }

    // 2) EVENT THREAD — chronological messages, a system notice, read-only reaction pills.
    {
      const page = await context.newPage();
      await page.route(RE.list, (route) => json(route, envelope(CONVERSATIONS)));
      await page.route(RE.messages, (route) => json(route, envelope(EVENT_THREAD)));
      await mockRead(page);
      await bootChatShell(page);
      // Render the list first so the thread header can name the conversation from the cache.
      await page.evaluate(() => window.tmChat.enterChat());
      await page.waitForSelector('[data-testid="chat-row"]');
      await page.evaluate(() => window.tmChat.enterChat("evt-201"));
      await page.waitForSelector('[data-testid="chat-system"]', { timeout: 15_000 });
      await shot(page, "02-chat-thread-event");
      await page.close();
    }

    // 3) ADMIN-BROADCAST THREAD — the "from TeamMarhaba" system voice (system notices).
    {
      const page = await context.newPage();
      await page.route(RE.list, (route) => json(route, envelope(CONVERSATIONS)));
      await page.route(RE.messages, (route) => json(route, envelope(ADMIN_THREAD)));
      await mockRead(page);
      await bootChatShell(page);
      await page.evaluate(() => window.tmChat.enterChat());
      await page.waitForSelector('[data-testid="chat-row"]');
      await page.evaluate(() => window.tmChat.enterChat("adm-1"));
      await page.waitForSelector('[data-testid="chat-system"]', { timeout: 15_000 });
      await shot(page, "03-chat-thread-admin-teammarhaba");
      await page.close();
    }

    // 4) Unread Chat-tab BADGE — sum of per-thread unread (12 → capped "9+") over the Chat tab.
    {
      const page = await context.newPage();
      await page.route(RE.list, (route) => json(route, envelope(CONVERSATIONS)));
      await mockRead(page);
      await bootChatShell(page);
      await page.evaluate(() => window.tmChat.enterChat());
      await page.waitForSelector('[data-testid="chat-row"]');
      // Drive the badge exactly as router.js's render() does for a signed-in, un-gated session.
      await page.evaluate(() => window.tmChatTabBadge.update({ signedIn: true, gated: false }));
      await page.waitForFunction(() => {
        const b = document.getElementById("tab-chat-badge");
        return b && !b.hidden && b.textContent.trim().length > 0;
      }, { timeout: 15_000 });
      await shot(page, "04-chat-tab-unread-badge");
      // A tight crop of just the bottom tab bar so the "9+" pill over Chat is unmistakable.
      await settle(page);
      const bar = await page.$("#app-tabbar");
      if (bar) await bar.screenshot({ path: join(OUT, "05-chat-tab-badge-closeup.png") });
      console.log("  ✓ 05-chat-tab-badge-closeup.png");
      await page.close();
    }

    // 6) EMPTY state — no conversations (what a live backend currently returns pre-seeding).
    {
      const page = await context.newPage();
      await page.route(RE.list, (route) => json(route, envelope([])));
      await mockRead(page);
      await bootChatShell(page);
      await page.evaluate(() => window.tmChat.enterChat());
      await page.waitForSelector('[data-testid="chat-list-empty"]', { timeout: 15_000 });
      await shot(page, "06-chat-list-empty");
      await page.close();
    }

    // 7) LOADING state — the fetch is held briefly so the loading beat is captured mid-flight.
    {
      const page = await context.newPage();
      await page.route(RE.list, async (route) => {
        await new Promise((r) => setTimeout(r, 3000));
        await json(route, envelope(CONVERSATIONS));
      });
      await mockRead(page);
      await bootChatShell(page);
      await page.evaluate(() => window.tmChat.enterChat());
      await page.waitForSelector('[data-testid="chat-loading"]', { timeout: 15_000 });
      await shot(page, "07-chat-list-loading");
      await page.close();
    }

    // 8) ERROR state — the list fetch 500s → the retryable error block.
    {
      const page = await context.newPage();
      await page.route(RE.list, (route) => json(route, { message: "boom" }, 500));
      await mockRead(page);
      await bootChatShell(page);
      await page.evaluate(() => window.tmChat.enterChat());
      await page.waitForSelector('[data-testid="chat-error"]', { timeout: 15_000 });
      await shot(page, "08-chat-list-error");
      await page.close();
    }

    console.log(`\nAll shots written to ${OUT}`);
  } finally {
    await context.close();
    await browser.close();
    stopServer();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
