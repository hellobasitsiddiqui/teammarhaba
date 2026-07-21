// TM-736 — before/after visual evidence: the admin "Send as announcement" composer toggle survives a
// transient boot-time GET /me failure.
//
// Mock-mode only (pattern: capture-chat-foundation.mjs / capture-tm882.mjs). Boots the real SPA via
// serve.mjs, mocks the API with Playwright page.route, reveals the chat view through the app's own QA
// seam (window.tmChat.enterChat), and shoots the composer area at an Android-mobile viewport (390x844).
//
// The scenario (the transient-failure-then-recovery path — see TM-736):
//   1. GET /api/v1/me FAILS on its FIRST call (HTTP 500), then SUCCEEDS as {role:"ADMIN"} on every call
//      after. (createAdminFlagCache.resolve() drives the toggle.)
//   2. An ADMIN opens an EVENT_GROUP thread. The first admin-flag resolve fails. Then the thread is
//      re-opened (re-render / re-enter), which calls maybeMountAnnounceToggle -> resolveViewerIsAdmin
//      again.
//        • OLD code (origin/main): the first failure CACHED `false`, so the re-resolve returns false from
//          cache -> the announce toggle is STILL ABSENT.  (BEFORE)
//        • NEW code (this branch): the failure was NOT cached, so the re-resolve re-fetches /me (now
//          ADMIN) -> the "Send as announcement" toggle IS PRESENT.  (AFTER)
//
// PHASE selects which is expected, but the SCENARIO is identical — the ONLY difference is which version
// of chat-core.js is served. The runner (see the surrounding harness) shoots PHASE=after on this branch,
// then swaps chat-core.js to its origin/main version and shoots PHASE=before, then restores the fix.
//
// Usage:  PHASE=after  node capture-tm736.mjs   (this branch — toggle present after re-open)
//         PHASE=before node capture-tm736.mjs   (origin/main chat-core.js swapped in — toggle absent)
//         CAPTURE_OUT=/abs/path CAPTURE_PORT=8210 PHASE=... node capture-tm736.mjs

import { chromium, devices } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm736");
const PORT = Number(process.env.CAPTURE_PORT || 8210);
const PHASE = process.env.PHASE || "after"; // "after" (this branch) | "before" (origin/main chat-core.js)
const BASE = `http://127.0.0.1:${PORT}`;

const ENVELOPE = (items) => ({ items, page: 0, size: 100, totalElements: items.length, totalPages: 1 });
const iso = (minsAgo) => new Date(Date.now() - minsAgo * 60_000).toISOString();

// The unified list carries ONE EVENT_GROUP thread — so threadMeta() resolves typeKey "event" (the
// composer is enabled and the announce toggle is eligible) with a real title in the header.
const CONVERSATIONS = [
  { id: "evt-736", type: "EVENT_GROUP", title: "Sunday Morning Dog Walk", eventId: 736,
    lastMessagePreview: "Priya: See you all at the north gate at 9!", lastMessageAt: iso(4), lastActiveAt: iso(4), unreadCount: 0 },
];

// A short event thread so the composer has context above it.
const THREAD = [
  { id: "m1", system: true, body: "You joined Sunday Morning Dog Walk", createdAt: iso(240) },
  { id: "m2", senderId: 55, body: "Morning all! Weather looks perfect for a walk ☀️", createdAt: iso(120) },
  { id: "m3", senderId: 61, body: "See you all at the north gate at 9!", createdAt: iso(4) },
];

// The mentionable roster (GET /members) — the composer's @mention feed; kept small.
const MEMBERS = [
  { userId: 55, displayName: "Priya", role: "USER" },
  { userId: 61, displayName: "Sam", role: "USER" },
];

// The ADMIN identity /me returns AFTER the first (failed) call.
const ADMIN_ME = {
  uid: "admin-uid", email: "admin@example.com", displayName: "Admin", firstName: "Aisha", lastName: "Khan",
  role: "ADMIN", enabled: true,
  accountState: { emailVerified: true, mfaEnabled: false, phoneVerified: false, photoURL: null, lastLoginAt: null },
};

const RE = {
  unreadTotal: /\/api\/v1\/me\/conversations\/unread-total/,
  meMembership: /\/api\/v1\/me\/membership/,
  me: /\/api\/v1\/me$/,
  listConversations: /\/api\/v1\/me\/conversations(\?|$)/,
  members: /\/api\/v1\/conversations\/[^/]+\/members/,
  messages: /\/api\/v1\/conversations\/[^/]+\/messages/,
  read: /\/api\/v1\/conversations\/[^/]+\/read/,
};

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

// GET /me: FAIL ONCE (HTTP 500), then ADMIN on every subsequent call — the transient boot-time blip.
function mockMeFailOnce(page) {
  let calls = 0;
  return page.route(RE.me, (route) => {
    calls += 1;
    if (calls === 1) return json(route, { title: "Internal Server Error" }, 500);
    return json(route, ADMIN_ME);
  });
}

async function mockApi(page) {
  // NOTE: Playwright checks routes newest-registered first, so register broad matchers BEFORE narrow
  // ones. `me` (…/api/v1/me$) is registered separately (fail-once) and its $-anchor keeps it distinct
  // from the list/membership URLs, but order still matters for the substring-y ones.
  await page.route(/\/api\/v1\/.*/, (route) => json(route, { title: "Not found" }, 404));
  await page.route(RE.listConversations, (route) => json(route, ENVELOPE(CONVERSATIONS)));
  await page.route(RE.unreadTotal, (route) => json(route, { total: 0 }));
  await page.route(RE.messages, (route) => json(route, ENVELOPE(THREAD)));
  await page.route(RE.members, (route) => json(route, MEMBERS));
  await page.route(RE.read, (route) =>
    json(route, { conversationId: "evt-736", lastReadAt: new Date().toISOString(), unreadCount: 0 }));
  await mockMeFailOnce(page);
}

// Boot the real SPA, settle to the signed-out gate, then reveal the chat surface without real auth —
// flips ONLY the same hidden/body-class seams router.js flips for a signed-in, un-gated user.
async function bootChatShell(page) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.tmChat, { timeout: 30_000 });
  await page.waitForSelector("#auth-signed-out", { state: "attached", timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(300);
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

// Enter the thread and wait for the composer + the async admin-flag resolve to SETTLE (the toggle mounts
// asynchronously after resolveViewerIsAdmin()). Returns whether the toggle is present after settling.
async function enterThreadAndSettle(page) {
  await page.evaluate(() => window.tmChat.enterChat("evt-736"));
  await page.waitForSelector('[data-testid="chat-composer"]', { timeout: 15_000 });
  // Let the async maybeMountAnnounceToggle() resolve/settle (a /me round-trip via the mock).
  await page.waitForTimeout(600);
  return page.evaluate(() => Boolean(document.querySelector('[data-testid="chat-announce-toggle"]')));
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
  // The mandated Android-mobile viewport for ticket evidence (~390x844).
  const context = await browser.newContext({
    ...devices["Pixel 5"],
    viewport: { width: 390, height: 844 },
  });

  let toggleAfterReopen = null;
  try {
    for (let i = 0; i < 40; i++) {
      try { const r = await context.request.get(`${BASE}/`); if (r.ok()) break; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }

    const page = await context.newPage();
    await mockApi(page);
    await bootChatShell(page);

    // Render the list first so the thread header names the conversation from cache and typeKey resolves.
    await page.evaluate(() => window.tmChat.enterChat());
    await page.waitForSelector('[data-testid="chat-row"]', { timeout: 15_000 });

    // FIRST open — the first admin-flag resolve hits the failing /me (HTTP 500). The toggle can't mount.
    const toggleFirst = await enterThreadAndSettle(page);
    console.log(`  first-open toggle present: ${toggleFirst} (expected false — /me failed)`);

    // Go back to the list, then RE-OPEN the thread (the re-render / re-enter). This re-runs
    // maybeMountAnnounceToggle -> resolveViewerIsAdmin. On this branch (NEW) the earlier failure was NOT
    // cached, so /me is re-fetched (now ADMIN) and the toggle mounts; on origin/main (OLD) the cached
    // `false` sticks and the toggle stays absent.
    await page.evaluate(() => window.tmChat.enterChat()); // back to list
    await page.waitForSelector('[data-testid="chat-row"]', { timeout: 15_000 });
    toggleAfterReopen = await enterThreadAndSettle(page);
    console.log(`  re-open  toggle present: ${toggleAfterReopen}`);

    // Shoot the composer area (the composer node carries [data-testid=chat-announce-toggle] when mounted).
    await page.evaluate(() => (document.fonts ? document.fonts.ready : Promise.resolve()));
    await page.waitForTimeout(300);
    const composer = page.locator('[data-testid="chat-composer"]');
    await composer.scrollIntoViewIfNeeded();
    await composer.screenshot({ path: join(OUT, `TM-736-${PHASE}.png`) });
    // A full-viewport shot too, for context.
    await page.screenshot({ path: join(OUT, `TM-736-${PHASE}-full.png`) });
    console.log(`  ✓ TM-736-${PHASE}.png (composer) + TM-736-${PHASE}-full.png`);

    await page.close();
  } finally {
    await context.close();
    await browser.close();
    stopServer();
  }

  // Guard: fail loudly if the captured frame contradicts the phase's expectation, so a wrong frame can
  // never be attached as evidence.
  const expected = PHASE === "before" ? false : true;
  if (toggleAfterReopen !== expected) {
    console.error(
      `\nEVIDENCE MISMATCH: PHASE=${PHASE} expected announce toggle present=${expected}, ` +
      `but after re-open present=${toggleAfterReopen}. Not a valid ${PHASE} frame.`,
    );
    process.exit(2);
  }
  console.log(`\nShots written to ${OUT} (PHASE=${PHASE}, toggle present after re-open = ${toggleAfterReopen})`);
}

main().catch((err) => { console.error(err); process.exit(1); });
