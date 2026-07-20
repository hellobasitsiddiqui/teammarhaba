// TM-853 — before/after visual evidence capture for the event-detail "Open chat" deep-link when the
// event's conversation thread sits BEYOND the first page of GET /api/v1/me/conversations.
//
// Mock-mode only (pattern: capture-tm882.mjs). Boots the real SPA via serve.mjs, mocks
//   • GET /api/v1/me                      → a signed-in member (role USER)
//   • GET /api/v1/events/{id}             → an EventDetail with myState="GOING" (an event-chat member,
//                                            so eventChatEntryModel is eligible)
//   • GET /api/v1/me/conversations?page=N → a PAGED list of 25 EVENT_GROUP conversations across 2 pages
//                                            (size 20). The TARGET event's thread is deliberately the
//                                            LAST item on page 1 (zero-based) — item #21 overall — so
//                                            it is NOT in page 0 (the first ~20 the old code scanned).
// then reveals #events-view and calls window.tmEvents.enterEvents(id) — the same seam router.js flips.
//
//   • PHASE=after  (this branch, fix present) → collectConversationsForEvent() pages to page 1, finds
//     the thread → the "Open chat" entry renders as an ENABLED <a> (data-testid=event-chat-open, an
//     anchor with href=#/chat/{id}). BUTTON PRESENT.
//   • PHASE=before (events.js + events-core.js swapped to origin/main) → only page 0 is scanned, the
//     thread is missed → the entry renders DISABLED with the "chat isn't ready yet" hint. The live
//     "Open chat" link (the <a>) is ABSENT. (The runner in the shell does the source swap + restore.)
//
// Usage:  PHASE=after  node capture-tm853.mjs
//         PHASE=before node capture-tm853.mjs   (run AFTER cp-ing the origin/main sources over the two files)
//         CAPTURE_OUT=/abs/path CAPTURE_PORT=8197 PHASE=... node capture-tm853.mjs

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.CAPTURE_OUT || join(HERE, "capture-out-tm853");
const PORT = Number(process.env.CAPTURE_PORT || 8197);
const PHASE = process.env.PHASE || "after"; // "before" (main sources) | "after" (this branch)
const BASE = `http://127.0.0.1:${PORT}`;

const EVENT_ID = 4200; // the target event whose chat thread lives on page 1 (beyond page 0)

// A signed-in member (role USER). Eligibility for the chat entry comes from the event's myState="GOING".
const ME = {
  uid: "capture-uid",
  email: "member@example.com",
  displayName: "Layla Ahmed",
  firstName: "Layla",
  lastName: "Ahmed",
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
  accountState: { emailVerified: true, mfaEnabled: false, phoneVerified: true, photoURL: null, lastLoginAt: null },
};

// The EventDetail for the target event. myState="GOING" → isEventChatMember() true → the chat entry is
// eligible, so the resolver actually pages the conversations list (the whole point of TM-853).
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const EVENT = {
  id: EVENT_ID,
  heading: "Community Iftar & Games Night",
  description: "Come along for food, board games and good company. Everyone going shares the event chat.",
  locationText: "Marhaba Community Hall, 1 Test Street",
  city: "London",
  timezone: "Europe/London",
  startAt: iso(NOW + 3 * 864e5), // +3 days → booking open, upcoming
  endAt: iso(NOW + 3 * 864e5 + 3 * 36e5),
  visibilityStart: iso(NOW - 36e5),
  visibilityEnd: iso(NOW + 30 * 864e5),
  imagePath: null,
  capacity: 40,
  goingCount: 21,
  waitlistCount: 0,
  attendees: [],
  myState: "GOING", // ← member: eligible for the event chat
  ageMin: null,
  ageMax: null,
  ageEligible: null,
  pricePence: 0,
  cancelled: false,
};

// 25 conversations across 2 pages (size 20). The TARGET event's EVENT_GROUP thread is the LAST item of
// page 0's *logical* list — but we put it at overall index 20 (the FIRST item of page 1), so it is only
// ever returned on page=1 and never on page=0. Every other conversation is a decoy EVENT_GROUP for a
// DIFFERENT eventId (so findEventConversation only matches on page 1).
const SIZE = 20;
const TOTAL = 25;
const TARGET_INDEX = 20; // zero-based → sits on page 1 (indices 20..24)
const ALL_CONVERSATIONS = Array.from({ length: TOTAL }, (_, i) => {
  const isTarget = i === TARGET_INDEX;
  return {
    id: isTarget ? 99042 : 5000 + i,
    type: "EVENT_GROUP",
    title: isTarget ? EVENT.heading : `Other event #${i + 1}`,
    eventId: isTarget ? EVENT_ID : 6000 + i, // decoys point at OTHER events
    lastMessagePreview: isTarget ? "See you all there!" : "…",
    lastMessageAt: iso(NOW - (i + 1) * 36e5),
    lastActiveAt: iso(NOW - (i + 1) * 36e5),
    unreadCount: 0,
  };
});
const TOTAL_PAGES = Math.ceil(TOTAL / SIZE); // 2

function pageEnvelope(page) {
  const start = page * SIZE;
  const items = ALL_CONVERSATIONS.slice(start, start + SIZE);
  return { items, page, size: SIZE, totalElements: TOTAL, totalPages: TOTAL_PAGES };
}

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function mockApi(page) {
  // Catch-all FIRST (Playwright checks routes newest-first, so specific mocks below win).
  await page.route(/\/api\/v1\/.*/, (route) => json(route, { title: "Not found" }, 404));

  // GET /me/conversations?page=N — the PAGED list. Honour the exact `page` query the code sends
  // ((page) => listMyConversations({ page }) → ?page=N, zero-based, no size param). Default page 0.
  await page.route(/\/api\/v1\/me\/conversations(\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    const page = Number(url.searchParams.get("page") ?? 0) || 0;
    return json(route, pageEnvelope(page));
  });

  // GET /api/v1/events/{id} — the target EventDetail.
  await page.route(new RegExp(`/api/v1/events/${EVENT_ID}(\\?.*)?$`), (route) => json(route, EVENT));
  // GET /api/v1/events — best-effort listing warm; the detail path tolerates its absence, but keep it clean.
  await page.route(/\/api\/v1\/events(\?.*)?$/, (route) =>
    json(route, { items: [EVENT], page: 0, size: 20, totalElements: 1, totalPages: 1 }),
  );

  await page.route(/\/api\/v1\/me$/, (route) => json(route, ME));
}

// Boot the SPA signed-out, then reveal the EVENTS detail surface — flips ONLY the same hidden/body-class
// seams router.js flips for a signed-in user, then calls the events router entry (window.tmEvents).
async function bootEventDetail(page) {
  await page.goto(`${BASE}/#/events/${EVENT_ID}`, { waitUntil: "domcontentloaded" });
  // Boot-splash holds ~3.2s — settle well past it before touching/shooting anything.
  await page.waitForFunction(() => window.tmEvents, { timeout: 30_000 });
  await page.waitForTimeout(4_000);
  await page.evaluate((eventId) => {
    document.getElementById("boot-screen")?.remove();
    for (const id of ["auth-signed-out", "auth-signed-in"]) {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    }
    const view = document.getElementById("events-view");
    if (view) view.hidden = false;
    const bar = document.getElementById("app-tabbar");
    if (bar) bar.hidden = false;
    document.body.classList.add("tm-has-tabbar");
    document.getElementById("tab-events")?.setAttribute("aria-current", "page");
    window.tmEvents.enterEvents(String(eventId));
  }, EVENT_ID);
  // Wait for the async renderDetail (fetch me + event, then page conversations) to paint the entry.
  await page.waitForSelector('[data-testid="event-chat-entry"]', { state: "attached", timeout: 15_000 });
  await page.waitForSelector('[data-testid="event-detail"]', { state: "visible", timeout: 15_000 });
  await page.evaluate(() => (document.fonts ? document.fonts.ready : Promise.resolve()));
  await page.waitForTimeout(500);
}

async function shoot(page) {
  // Report what the entry actually is, so the run self-verifies the frame (anchor = enabled/present).
  const state = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="event-chat-open"]');
    if (!el) return { present: false, tag: null };
    return { present: true, tag: el.tagName, disabled: el.disabled === true, href: el.getAttribute("href") };
  });
  console.log(`  chat-open entry: ${JSON.stringify(state)}`);

  // Scroll the chat entry into view and shoot the detail article + a full-page frame.
  const entry = page.locator('[data-testid="event-chat-entry"]');
  await entry.scrollIntoViewIfNeeded();
  const detail = page.locator('[data-testid="event-detail"]');
  await detail.screenshot({ path: join(OUT, `TM-853-${PHASE}-detail.png`) });
  await page.screenshot({ path: join(OUT, `TM-853-${PHASE}.png`) });
  console.log(`  ✓ TM-853-${PHASE}[-detail].png`);
  return state;
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
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

  try {
    for (let i = 0; i < 40; i++) {
      try { const r = await context.request.get(`${BASE}/`); if (r.ok()) break; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }

    const page = await context.newPage();
    await mockApi(page);
    await bootEventDetail(page);
    const state = await shoot(page);
    await page.close();

    // Guard: assert the frame matches the phase so a misconfigured swap can't produce a misleading shot.
    if (PHASE === "after" && !(state.present && state.tag === "A" && !state.disabled)) {
      throw new Error(`AFTER expected an enabled <a> "Open chat" link; got ${JSON.stringify(state)}`);
    }
    if (PHASE === "before" && state.present && state.tag === "A") {
      throw new Error(`BEFORE expected NO live "Open chat" link (disabled button / hint); got ${JSON.stringify(state)}`);
    }
  } finally {
    await browser.close();
    stopServer();
  }
  console.log(`\nShots written to ${OUT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
