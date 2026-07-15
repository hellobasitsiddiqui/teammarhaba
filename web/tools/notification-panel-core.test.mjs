// Unit tests for the Notification panel pure core (TM-456) — the feed→sections transform: chat
// grouping, ungrouped admin/system items, the TM-285-style safe-route allow-list, type→icon mapping,
// newest-activity ordering, and the read/clear semantics.
//
// Framework-free — Node's built-in test runner, picked up by the CI glob `node --test
// web/tools/*.test.mjs` (ci.yml web-build job). No DOM/Firebase/fetch, like the other cores.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildPanel,
  chatGroupLabel,
  chatThreadRoute,
  isChatNotification,
  panelUnreadTotal,
  recalledItemLabel,
  safeRoute,
  typeIcon,
  RECALLED_BY_ADMIN,
  TYPE_ICONS,
  DEFAULT_ITEM_ICON,
  CHAT_ICON,
  CHAT_GROUP,
  ITEM,
} from "../src/assets/notification-panel-core.js";
// icons.js is import-safe in Node (createElementNS is only called inside lineIcon()), so we can assert
// every icon the core maps to really exists without a DOM.
import { ICON_NAMES } from "../src/assets/icons.js";

/* ─────────────────────────────── safeRoute (the trust boundary) ──────────────────────────────── */

test("safeRoute coerces the accepted shapes to a hash route", () => {
  assert.equal(safeRoute("#/home"), "#/home");
  assert.equal(safeRoute("/profile"), "#/profile");
  assert.equal(safeRoute("events"), "#/events");
  assert.equal(safeRoute("#events"), "#/events");
  assert.equal(safeRoute("#/events/"), "#/events"); // trailing slash beyond root dropped
});

test("safeRoute allows events/chat DETAIL routes and preserves the id's case", () => {
  assert.equal(safeRoute("/events/42"), "#/events/42");
  assert.equal(safeRoute("#/chat/Ab12"), "#/chat/Ab12"); // id case preserved, base lower-cased
  assert.equal(safeRoute("#/EVENTS/7"), "#/events/7");
});

test("safeRoute rejects off-app / unknown targets (returns null)", () => {
  assert.equal(safeRoute("https://evil.example/x"), null);
  assert.equal(safeRoute("//evil"), null);
  assert.equal(safeRoute("javascript:alert(1)"), null);
  assert.equal(safeRoute("#/chat/1/2"), null); // two segments — not a known detail route
  assert.equal(safeRoute("#/nope"), null);
  assert.equal(safeRoute(""), null);
  assert.equal(safeRoute(null), null);
});

test("chatThreadRoute is only a #/chat/{id} thread, not the list or an events link", () => {
  assert.equal(chatThreadRoute("/chat/9"), "#/chat/9");
  assert.equal(chatThreadRoute("#/chat"), null); // the list, no thread id
  assert.equal(chatThreadRoute("#/events/9"), null);
  assert.equal(chatThreadRoute("https://x"), null);
});

/* ─────────────────────────────── classification + icons ──────────────────────────────────────── */

test("isChatNotification: CHAT-family type OR a chat-thread deep-link", () => {
  assert.equal(isChatNotification({ type: "CHAT_MESSAGE" }), true);
  assert.equal(isChatNotification({ type: "chat" }), true); // case-insensitive
  assert.equal(isChatNotification({ type: "ADMIN_MESSAGE", deepLink: "/chat/5" }), true); // link wins
  assert.equal(isChatNotification({ type: "EVENT_REMINDER", deepLink: "/events/5" }), false);
  assert.equal(isChatNotification({ type: "ADMIN_MESSAGE" }), false);
  assert.equal(isChatNotification(null), false);
});

test("typeIcon maps every known type, falls back to the bell, and only uses real icons", () => {
  assert.equal(typeIcon("ADMIN_MESSAGE"), "spot");
  assert.equal(typeIcon("event_reminder"), "clock"); // case-insensitive
  assert.equal(typeIcon("SOMETHING_NEW"), DEFAULT_ITEM_ICON);
  assert.equal(typeIcon(undefined), DEFAULT_ITEM_ICON);
  for (const name of [...Object.values(TYPE_ICONS), DEFAULT_ITEM_ICON, CHAT_ICON]) {
    assert.ok(ICON_NAMES.includes(name), `panel icon "${name}" must exist in icons.js ICON_NAMES`);
  }
});

/* ─────────────────────────────── chatGroupLabel ──────────────────────────────────────────────── */

test("chatGroupLabel reads '{n} new in {title}' while unread, the title once read", () => {
  assert.equal(chatGroupLabel({ unread: 3, title: "Coffee & Code" }), "3 new in Coffee & Code");
  assert.equal(chatGroupLabel({ unread: 1, title: "Dog Walk" }), "1 new in Dog Walk");
  assert.equal(chatGroupLabel({ unread: 0, title: "Dog Walk" }), "Dog Walk");
});

/* ─────────────────────────────── buildPanel ──────────────────────────────────────────────────── */

// A representative feed: two chat notes in the same event thread (one unread, one read), a chat note
// in a second thread, an admin message, and an event reminder — deliberately out of time order.
function sampleFeed() {
  return [
    { id: 1, type: "CHAT_MESSAGE", title: "Coffee & Code", body: "Sarah: see you there", deepLink: "/chat/7", createdAt: "2026-07-09T09:00:00Z", read: true },
    { id: 5, type: "CHAT_MESSAGE", title: "Coffee & Code", body: "Ali: bring your laptop", deepLink: "/chat/7", createdAt: "2026-07-09T10:30:00Z", read: false },
    { id: 3, type: "CHAT_MESSAGE", title: "Dog Walk", body: "New message", deepLink: "/chat/8", createdAt: "2026-07-09T09:30:00Z", read: false },
    { id: 4, type: "ADMIN_MESSAGE", title: "Welcome", body: "Find your first meetup", deepLink: "/home", createdAt: "2026-07-09T08:00:00Z", read: false, sticky: true },
    { id: 2, type: "EVENT_REMINDER", title: "Starts soon", body: "In 1 hour", deepLink: "/events/42", createdAt: "2026-07-09T11:00:00Z", read: false },
  ];
}

test("buildPanel groups chat by thread and leaves admin/system ungrouped", () => {
  const sections = buildPanel(sampleFeed());
  const chat = sections.filter((s) => s.kind === CHAT_GROUP);
  const items = sections.filter((s) => s.kind === ITEM);
  assert.equal(chat.length, 2); // thread 7 + thread 8
  assert.equal(items.length, 2); // admin message + event reminder

  const coffee = chat.find((g) => g.route === "#/chat/7");
  assert.equal(coffee.title, "Coffee & Code");
  assert.deepEqual(coffee.ids.sort(), [1, 5]);
  assert.equal(coffee.unread, 1);
  assert.deepEqual(coffee.unreadIds, [5]);
  assert.equal(coffee.preview, "Ali: bring your laptop"); // newest member drives the preview
  assert.equal(coffee.icon, CHAT_ICON);
  assert.equal(coffee.read, false);
});

test("buildPanel orders sections newest-activity first (across groups and items)", () => {
  const sections = buildPanel(sampleFeed());
  // Newest activity: reminder 11:00 → coffee thread 10:30 → dog-walk 09:30 → admin 08:00.
  assert.deepEqual(
    sections.map((s) => (s.kind === CHAT_GROUP ? `chat:${s.route}` : `item:${s.id}`)),
    ["item:2", "chat:#/chat/7", "chat:#/chat/8", "item:4"],
  );
});

test("buildPanel builds a safe deep-link + type icon for each ungrouped item", () => {
  const sections = buildPanel(sampleFeed());
  const admin = sections.find((s) => s.kind === ITEM && s.id === 4);
  assert.equal(admin.route, "#/home");
  assert.equal(admin.icon, "spot");
  assert.equal(admin.sticky, true);
  const reminder = sections.find((s) => s.kind === ITEM && s.id === 2);
  assert.equal(reminder.route, "#/events/42");
  assert.equal(reminder.icon, "clock");
});

test("a chat group clears (read=true, unread=0) once all its members are read", () => {
  const feed = [
    { id: 1, type: "CHAT_MESSAGE", title: "Dog Walk", body: "hi", deepLink: "/chat/8", createdAt: "2026-07-09T09:00:00Z", read: true },
    { id: 2, type: "CHAT_MESSAGE", title: "Dog Walk", body: "yo", deepLink: "/chat/8", createdAt: "2026-07-09T09:30:00Z", read: true },
  ];
  const [group] = buildPanel(feed);
  assert.equal(group.kind, CHAT_GROUP);
  assert.equal(group.unread, 0);
  assert.deepEqual(group.unreadIds, []);
  assert.equal(group.read, true);
  assert.equal(chatGroupLabel(group), "Dog Walk");
});

test("buildPanel is tolerant of junk and never mutates its input", () => {
  const feed = [null, 42, { id: 1, type: "ADMIN_MESSAGE", title: "Hi", createdAt: "2026-07-09T09:00:00Z", read: false }];
  const snapshot = JSON.stringify(feed);
  const sections = buildPanel(feed);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].id, 1);
  assert.equal(sections[0].route, null); // no deepLink → not navigable
  assert.equal(JSON.stringify(feed), snapshot); // input untouched
  assert.deepEqual(buildPanel(null), []);
  assert.deepEqual(buildPanel(undefined), []);
});

test("panelUnreadTotal sums unread chat members and unread items", () => {
  assert.equal(panelUnreadTotal(buildPanel(sampleFeed())), 4); // coffee(1) + dogwalk(1) + admin(1) + reminder(1)
  assert.equal(panelUnreadTotal([]), 0);
  assert.equal(panelUnreadTotal(null), 0);
});

/* ── TM-733: a chat/mention group keeps a valid deep link even when it isn't a #/chat/{id} thread ── */

// An event-group-chat mention's deep link is the EVENT detail (`#/events/{id}`) — PushRoutes.eventDetail,
// see MentionNotifier.deepLinkFor — not a chat-thread route. It's still classified as chat (CHAT_MENTION
// type includes "CHAT"), so it must group AND stay tappable to the event, not navigate nowhere.
test("buildPanel keeps a chat/mention group's tap route when the deep link is an event detail (TM-733)", () => {
  const feed = [
    { id: 9, type: "CHAT_MENTION", title: "Coffee & Code", body: "Ali mentioned you", deepLink: "#/events/42", createdAt: "2026-07-09T12:00:00Z", read: false },
  ];
  const [group] = buildPanel(feed);
  assert.equal(group.kind, CHAT_GROUP);
  assert.equal(group.route, "#/events/42"); // the valid deep link is preserved, NOT discarded to null
  assert.equal(group.unread, 1);
  assert.equal(group.icon, CHAT_ICON);
});

// The strict thread route stays the merge key: a mention (event-detail link) and a thread message for a
// DIFFERENT event must not collapse into one group just because neither yields a chat-thread route.
test("buildPanel groups mention-by-title but still resolves each group's own tap route (TM-733)", () => {
  const feed = [
    { id: 1, type: "CHAT_MENTION", title: "Coffee & Code", body: "Ali mentioned you", deepLink: "#/events/42", createdAt: "2026-07-09T10:00:00Z", read: false },
    { id: 2, type: "CHAT_MENTION", title: "Coffee & Code", body: "Sam mentioned you", deepLink: "#/events/42", createdAt: "2026-07-09T11:00:00Z", read: false },
    { id: 3, type: "CHAT_MENTION", title: "Dog Walk", body: "Jo mentioned you", deepLink: "#/events/8", createdAt: "2026-07-09T09:00:00Z", read: false },
  ];
  const groups = buildPanel(feed).filter((s) => s.kind === CHAT_GROUP);
  assert.equal(groups.length, 2); // Coffee (2 members merged by title) + Dog Walk
  const coffee = groups.find((g) => g.title === "Coffee & Code");
  assert.equal(coffee.route, "#/events/42");
  assert.equal(coffee.unread, 2);
  assert.equal(groups.find((g) => g.title === "Dog Walk").route, "#/events/8");
});

// A genuinely link-less chat note still has no tap target (grouped by title, route stays null).
test("buildPanel leaves a link-less chat group's route null (nothing to open) (TM-733)", () => {
  const [group] = buildPanel([
    { id: 1, type: "CHAT_MESSAGE", title: "Coffee & Code", body: "hi", createdAt: "2026-07-09T10:00:00Z", read: false },
  ]);
  assert.equal(group.kind, CHAT_GROUP);
  assert.equal(group.route, null);
});

/* ────────────────────────── recalled (tombstoned) admin message — TM-473 ─────────────────────── */

test("buildPanel carries the recalled tombstone state + time on a seen, recalled admin message", () => {
  // The SEEN half of the HYBRID recall: the row is kept in the feed and flagged recalled, so the DOM
  // half renders it struck-through instead of a live row.
  const feed = [
    {
      id: 7,
      type: "ADMIN_MESSAGE",
      title: "Venue changed",
      body: "The venue moved to Hall B.",
      createdAt: "2026-07-09T09:00:00Z",
      seen: true,
      read: true,
      recalled: true,
      recalledAt: "2026-07-09T10:30:00Z",
    },
  ];
  const [item] = buildPanel(feed);
  assert.equal(item.kind, ITEM);
  assert.equal(item.recalled, true);
  assert.equal(item.recalledAt, "2026-07-09T10:30:00Z");
  assert.equal(item.title, "Venue changed"); // still shown (struck-through) so the recipient sees WHAT was recalled
});

test("buildPanel also treats a present recalledAt (without an explicit flag) as recalled", () => {
  const [item] = buildPanel([
    { id: 8, type: "ADMIN_MESSAGE", title: "Hi", createdAt: "2026-07-09T09:00:00Z", recalledAt: "2026-07-09T10:00:00Z" },
  ]);
  assert.equal(item.recalled, true);
  assert.equal(item.recalledAt, "2026-07-09T10:00:00Z");
});

test("buildPanel leaves a live item un-recalled (recalled=false, recalledAt=null)", () => {
  const [item] = buildPanel([
    { id: 9, type: "ADMIN_MESSAGE", title: "Live", createdAt: "2026-07-09T09:00:00Z", read: false },
  ]);
  assert.equal(item.recalled, false);
  assert.equal(item.recalledAt, null);
});

test("buildPanel treats a blank/whitespace recalledAt as still-live", () => {
  const [item] = buildPanel([
    { id: 10, type: "ADMIN_MESSAGE", title: "Blank", createdAt: "2026-07-09T09:00:00Z", recalledAt: "   " },
  ]);
  assert.equal(item.recalled, false);
  assert.equal(item.recalledAt, null);
});

test("recalledItemLabel composes 'Recalled by admin · <time>' (and degrades without a time)", () => {
  assert.equal(recalledItemLabel("3m ago"), `${RECALLED_BY_ADMIN} · 3m ago`);
  assert.equal(recalledItemLabel(""), RECALLED_BY_ADMIN); // no dangling separator when time is absent
  assert.equal(recalledItemLabel("   "), RECALLED_BY_ADMIN);
  assert.equal(recalledItemLabel(undefined), RECALLED_BY_ADMIN);
  assert.equal(RECALLED_BY_ADMIN, "Recalled by admin");
});
