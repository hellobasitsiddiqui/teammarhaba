// Tests for the foreground-push notification inbox's pure core (TM-374). Framework-free — Node's
// built-in test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// notification-inbox.js has zero DOM/Capacitor/Firebase deps (its only import is the equally pure
// push-deeplink.js), so the whole store behaviour is assertable here: payload → entry mapping,
// dedupe of duplicated deliveries, the 20-entry cap, unread counting / mark-read transitions, the
// banner text, and the tolerant localStorage (de)serialisation with its re-applied route
// allow-list (localStorage is user-writable, so persisted routes are NOT trusted on re-load).

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_ENTRIES,
  DEDUPE_WINDOW_MS,
  STORAGE_KEY,
  entryFromNotification,
  isSameMessage,
  addEntry,
  unreadCount,
  markAllRead,
  markRead,
  bannerMessage,
  loadEntries,
  saveEntries,
} from "../src/assets/notification-inbox.js";

/** A Storage-like fake over a Map — what the DOM half passes localStorage for. */
function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    raw: map,
  };
}

const T0 = 1_750_000_000_000; // fixed "now" so entries are deterministic.

/** The TM-368 evidence payload shape: top-level title/body + FCM data carrying the route. */
function flashEvent(overrides = {}) {
  return {
    title: "Flash event",
    body: "Free dinner",
    data: { route: "#/home" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------
// entryFromNotification — payload → entry
// ---------------------------------------------------------------------------------------------

test("entryFromNotification: maps the real TM-368 payload shape", () => {
  const entry = entryFromNotification(flashEvent({ id: "fcm-1" }), T0);
  assert.equal(entry.title, "Flash event");
  assert.equal(entry.body, "Free dinner");
  assert.equal(entry.route, "#/home", "data.route resolved through push-deeplink");
  assert.equal(entry.sourceId, "fcm-1");
  assert.equal(entry.id, "fcm-1", "platform id doubles as the entry id");
  assert.equal(entry.receivedAt, T0);
  assert.equal(entry.read, false, "a fresh push is unread");
});

test("entryFromNotification: title falls back to body, then to a generic label", () => {
  const bodyOnly = entryFromNotification({ body: "Free dinner" }, T0);
  assert.equal(bodyOnly.title, "Free dinner", "body promoted to title (mirrors the old toast)");
  assert.equal(bodyOnly.body, "", "no duplicated line once promoted");

  const empty = entryFromNotification({}, T0);
  assert.equal(empty.title, "New notification");
  assert.equal(empty.body, "");
  assert.equal(entryFromNotification(null, T0).title, "New notification", "null payload survives");
});

test("entryFromNotification: body identical to title is collapsed", () => {
  const entry = entryFromNotification({ title: "Ping", body: "Ping" }, T0);
  assert.equal(entry.title, "Ping");
  assert.equal(entry.body, "");
});

test("entryFromNotification: tolerates data-style payloads (title/body under data)", () => {
  const entry = entryFromNotification({ data: { title: "Flash event", body: "Free dinner" } }, T0);
  assert.equal(entry.title, "Flash event");
  assert.equal(entry.body, "Free dinner");
});

test("entryFromNotification: route stays on the push-deeplink allow-list", () => {
  assert.equal(entryFromNotification(flashEvent({ data: { route: "/profile" } }), T0).route, "#/profile");
  assert.equal(
    entryFromNotification(flashEvent({ data: { route: "https://evil.example" } }), T0).route,
    null,
    "absolute URL rejected",
  );
  assert.equal(entryFromNotification(flashEvent({ data: {} }), T0).route, null, "no route → null");
});

test("entryFromNotification: long texts are capped, entry stays usable", () => {
  const entry = entryFromNotification({ title: "t".repeat(2000), body: "b".repeat(2000) }, T0);
  assert.ok(entry.title.length <= 300, "title capped");
  assert.ok(entry.body.length <= 300, "body capped");
});

test("entryFromNotification: without a platform id the entry id is deterministic", () => {
  const a = entryFromNotification(flashEvent(), T0);
  const b = entryFromNotification(flashEvent(), T0);
  assert.equal(a.id, b.id, "same payload + same time → same id");
  assert.equal(a.sourceId, null);
  const later = entryFromNotification(flashEvent(), T0 + 1);
  assert.notEqual(a.id, later.id, "time participates in the synthetic id");
});

// ---------------------------------------------------------------------------------------------
// isSameMessage / addEntry — dedupe + cap
// ---------------------------------------------------------------------------------------------

test("isSameMessage: platform ids decide when both sides have one", () => {
  const a = entryFromNotification(flashEvent({ id: "m-1" }), T0);
  const redelivery = entryFromNotification(flashEvent({ id: "m-1" }), T0 + 60_000);
  const different = entryFromNotification(flashEvent({ id: "m-2" }), T0 + 1);
  assert.equal(isSameMessage(a, redelivery), true, "same id → same message even beyond the window");
  assert.equal(isSameMessage(a, different), false, "distinct sends never collapse, even with equal content");
});

test("isSameMessage: without ids, identical content inside the window is a duplicate", () => {
  const a = entryFromNotification(flashEvent(), T0);
  const dup = entryFromNotification(flashEvent(), T0 + DEDUPE_WINDOW_MS);
  const resent = entryFromNotification(flashEvent(), T0 + DEDUPE_WINDOW_MS + 1);
  const other = entryFromNotification(flashEvent({ body: "Different" }), T0 + 1);
  assert.equal(isSameMessage(a, dup), true, "inside the window → duplicated delivery");
  assert.equal(isSameMessage(a, resent), false, "outside the window → a genuine re-send, kept");
  assert.equal(isSameMessage(a, other), false, "different content is never deduped");
});

test("addEntry: prepends newest first and reports added", () => {
  const first = entryFromNotification(flashEvent(), T0);
  const second = entryFromNotification(flashEvent({ title: "Second" }), T0 + 1000);
  const one = addEntry([], first);
  assert.equal(one.added, true);
  const two = addEntry(one.entries, second);
  assert.equal(two.added, true);
  assert.deepEqual(two.entries.map((e) => e.title), ["Second", "Flash event"]);
  assert.equal(one.entries.length, 1, "input list untouched (pure)");
});

test("addEntry: a duplicated delivery is not re-added (so no second banner shows)", () => {
  const first = entryFromNotification(flashEvent({ id: "m-1" }), T0);
  const { entries } = addEntry([], first);
  const again = addEntry(entries, entryFromNotification(flashEvent({ id: "m-1" }), T0 + 5000));
  assert.equal(again.added, false);
  assert.equal(again.entries, entries, "same list handed back");
});

test("addEntry: caps the inbox at MAX_ENTRIES, dropping the oldest", () => {
  let entries = [];
  for (let i = 0; i < MAX_ENTRIES + 5; i++) {
    // Distinct minute-apart sends (well outside the dedupe window), each with its own content.
    const res = addEntry(entries, entryFromNotification({ title: `Push ${i}` }, T0 + i * 60_000));
    assert.equal(res.added, true, `push ${i} accepted`);
    entries = res.entries;
  }
  assert.equal(entries.length, MAX_ENTRIES);
  assert.equal(entries[0].title, `Push ${MAX_ENTRIES + 4}`, "newest kept at the front");
  assert.equal(entries.at(-1).title, "Push 5", "oldest five fell off");
});

// ---------------------------------------------------------------------------------------------
// unread / mark-read
// ---------------------------------------------------------------------------------------------

test("unreadCount: counts only unread entries", () => {
  const a = entryFromNotification({ title: "A" }, T0);
  const b = { ...entryFromNotification({ title: "B" }, T0 + 60_000), read: true };
  assert.equal(unreadCount([a, b]), 1);
  assert.equal(unreadCount([]), 0);
  assert.equal(unreadCount(null), 0, "junk in → 0 out");
});

test("markAllRead: flips everything once, without mutating the input", () => {
  const list = [entryFromNotification({ title: "A" }, T0), entryFromNotification({ title: "B" }, T0 + 60_000)];
  const read = markAllRead(list);
  assert.equal(unreadCount(read), 0);
  assert.equal(unreadCount(list), 2, "original list untouched");
  assert.equal(markAllRead(read), read, "nothing unread → same reference (cheap no-op for callers)");
});

test("markRead: flips exactly the matching id", () => {
  const a = entryFromNotification({ title: "A", id: "id-a" }, T0);
  const b = entryFromNotification({ title: "B", id: "id-b" }, T0 + 60_000);
  const next = markRead([a, b], "id-a");
  assert.deepEqual(next.map((e) => e.read), [true, false]);
  assert.equal(a.read, false, "input entry not mutated");
  const unchanged = markRead(next, "missing-id");
  assert.equal(unchanged, next, "unknown id → same reference");
});

// ---------------------------------------------------------------------------------------------
// bannerMessage
// ---------------------------------------------------------------------------------------------

test("bannerMessage: joins title and body, or shows the title alone", () => {
  assert.equal(bannerMessage(entryFromNotification(flashEvent(), T0)), "Flash event — Free dinner");
  assert.equal(bannerMessage(entryFromNotification({ title: "Just title" }, T0)), "Just title");
  assert.equal(bannerMessage(null), "");
});

// ---------------------------------------------------------------------------------------------
// loadEntries / saveEntries — tolerant persistence
// ---------------------------------------------------------------------------------------------

test("save → load round-trips the inbox through a Storage-like object", () => {
  const storage = fakeStorage();
  const entries = [
    entryFromNotification(flashEvent({ id: "m-1" }), T0),
    { ...entryFromNotification({ title: "Older", data: { route: "/profile" } }, T0 - 60_000), read: true },
  ];
  assert.equal(saveEntries(entries, storage), true);
  assert.deepEqual(loadEntries(storage), entries);
});

test("loadEntries: junk storage contents never crash — they yield an empty inbox", () => {
  assert.deepEqual(loadEntries(fakeStorage({ [STORAGE_KEY]: "not json{{" })), []);
  assert.deepEqual(loadEntries(fakeStorage({ [STORAGE_KEY]: '{"an":"object"}' })), [], "non-array → []");
  assert.deepEqual(loadEntries(fakeStorage()), [], "nothing stored → []");
  assert.deepEqual(loadEntries(null), [], "no storage at all (private mode) → []");
  const throwing = { getItem: () => { throw new Error("denied"); } };
  assert.deepEqual(loadEntries(throwing), [], "throwing storage → []");
});

test("loadEntries: persisted routes are re-validated (localStorage is user-writable)", () => {
  const storage = fakeStorage({
    [STORAGE_KEY]: JSON.stringify([
      { id: "1", title: "Evil", route: "javascript:alert(1)", receivedAt: T0, read: false },
      { id: "2", title: "Fine", route: "#/profile", receivedAt: T0, read: false },
    ]),
  });
  const [evil, fine] = loadEntries(storage);
  assert.equal(evil.route, null, "off-allow-list route stripped — entry kept but not clickable");
  assert.equal(fine.route, "#/profile");
});

test("loadEntries: entries with no displayable text are dropped; fields are coerced", () => {
  const storage = fakeStorage({
    [STORAGE_KEY]: JSON.stringify([
      { id: "1", receivedAt: T0 }, // no title/body → dropped
      "not-an-object", // → dropped
      { title: "Kept", receivedAt: "soon", read: "yes" }, // coerced
    ]),
  });
  const loaded = loadEntries(storage);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].title, "Kept");
  assert.equal(loaded[0].receivedAt, 0, "non-numeric timestamp coerced");
  assert.equal(loaded[0].read, false, "only a literal true counts as read");
});

test("loadEntries/saveEntries: the cap holds on both sides of the boundary", () => {
  const many = Array.from({ length: MAX_ENTRIES + 10 }, (_, i) =>
    entryFromNotification({ title: `P${i}` }, T0 + i * 60_000),
  );
  const storage = fakeStorage();
  saveEntries(many, storage);
  assert.equal(JSON.parse(storage.raw.get(STORAGE_KEY)).length, MAX_ENTRIES, "never persists more than the cap");
  const oversized = fakeStorage({ [STORAGE_KEY]: JSON.stringify(many) });
  assert.equal(loadEntries(oversized).length, MAX_ENTRIES, "an oversized hand-edited store is clamped on load");
});

test("saveEntries: quota/private-mode failures are contained", () => {
  const throwing = { setItem: () => { throw new Error("QuotaExceededError"); } };
  assert.equal(saveEntries([entryFromNotification(flashEvent(), T0)], throwing), false);
  assert.equal(saveEntries([], null), false, "no storage → false, never throws");
});
