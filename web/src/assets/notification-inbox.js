// Foreground-push notification inbox — the pure, browser-free half (TM-374).
//
// Split out of notification-center.js for the same reason verify-banner-state.js / push-deeplink.js
// were split out of their mounting modules: this is the unit-testable core — turn a raw Capacitor
// notification into a storable entry, keep a small capped list of recent entries (dedupe duplicate
// deliveries, newest first), count unread, and (de)serialise the list — with zero DOM, Capacitor or
// Firebase dependencies, so `node --test web/tools/*.test.mjs` (the PR gate) can guard the behaviour
// without a browser.
//
// WHY THIS EXISTS. A push arriving while the app is FOREGROUND never reaches the system tray on
// Android — Capacitor hands it to the JS `pushNotificationReceived` listener instead. Pre-TM-374
// that surfaced only a transient toast, so "delivered" ≠ "seen" (the reporter missed his own
// broadcast). The fix keeps a small persistent inbox of the last MAX_ENTRIES foreground pushes in
// localStorage so a missed one is recoverable after the banner is gone — even across app restarts.
//
// TRUST BOUNDARY. Routes are only ever accepted through push-deeplink.js's normaliseRoute (the
// existing allow-list of same-app hash routes) — both when a live notification arrives AND when
// re-loading persisted entries, because localStorage is user-writable (devtools) and must not become
// a way to smuggle an off-origin/javascript: navigation back into the app.

import { normaliseRoute, rawRouteFromNotification } from "./push-deeplink.js";

/** How many recent notifications the inbox keeps. Small on purpose — it's a "did I miss something
 *  just now?" recovery net, not a message history; the cap also bounds localStorage use. */
export const MAX_ENTRIES = 20;

/** Two content-identical notifications inside this window are treated as one duplicated delivery
 *  (FCM occasionally re-delivers); outside it they're two genuine messages (e.g. the same "Dinner
 *  at 8" broadcast re-sent an hour later) and both are kept. */
export const DEDUPE_WINDOW_MS = 30_000;

/** localStorage key (matches the `tm.` prefix convention, e.g. router.js's `tm.intendedRoute`). */
export const STORAGE_KEY = "tm.notifications";

// Cap stored strings so a hostile/buggy payload can't bloat localStorage; long titles/bodies are
// truncated for storage + display (the tray shows the full text on background deliveries anyway).
const MAX_TEXT_LENGTH = 300;

/** Coerce an untrusted value to a trimmed, length-capped display string ("" when unusable). */
function asText(value) {
  if (typeof value === "string") return value.trim().slice(0, MAX_TEXT_LENGTH);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/**
 * Normalise a raw title/body pair to what the inbox displays: `title` always non-empty (falls back
 * to the body, then a generic label — mirroring the pre-TM-374 toast's `title || body` fallback),
 * and `body` cleared when it would just repeat the title.
 * @returns {{title: string, body: string}}
 */
function normaliseTexts(rawTitle, rawBody) {
  let title = asText(rawTitle);
  let body = asText(rawBody);
  if (!title) {
    title = body || "New notification";
    body = "";
  }
  if (body === title) body = "";
  return { title, body };
}

/**
 * Build an inbox entry from a Capacitor `pushNotificationReceived` notification.
 *
 * Fields: `title`/`body` (see normaliseTexts; `data.title`/`data.body` are tolerated as fallbacks
 * for data-style payloads), `route` (a SAFE in-app hash route via push-deeplink, or null),
 * `sourceId` (the platform's notification id when it sent one — the strongest duplicate signal),
 * `id` (entry identity for mark-read: the sourceId, else deterministic from time + content),
 * `receivedAt` (ms epoch, injectable for tests) and `read: false`.
 *
 * @param {object|null|undefined} notification the Capacitor notification.
 * @param {number} [receivedAt=Date.now()] arrival time in ms (injectable for deterministic tests).
 * @returns {{id: string, sourceId: ?string, title: string, body: string, route: ?string,
 *            receivedAt: number, read: boolean}}
 */
export function entryFromNotification(notification, receivedAt = Date.now()) {
  const n = notification && typeof notification === "object" ? notification : {};
  const data = n.data && typeof n.data === "object" ? n.data : {};
  const { title, body } = normaliseTexts(n.title ?? data.title, n.body ?? data.body);
  const route = normaliseRoute(rawRouteFromNotification(n));
  const sourceId = asText(n.id) || null;
  const id = sourceId || `${receivedAt}:${`${title}|${body}|${route ?? ""}`.slice(0, 120)}`;
  return { id, sourceId, title, body, route, receivedAt, read: false };
}

/**
 * Are two entries the same underlying message? When BOTH carry a platform notification id, the ids
 * decide (a re-delivery reuses its id; two distinct sends never share one). Otherwise fall back to
 * content equality within the dedupe window — identical title/body/route arriving twice in ~30s is
 * a duplicated delivery, while the same content re-sent later is a genuine new message.
 * @param {object} a candidate entry.
 * @param {object} b candidate entry.
 * @param {number} [windowMs=DEDUPE_WINDOW_MS]
 * @returns {boolean}
 */
export function isSameMessage(a, b, windowMs = DEDUPE_WINDOW_MS) {
  if (!a || !b) return false;
  if (a.sourceId && b.sourceId) return a.sourceId === b.sourceId;
  return (
    a.title === b.title &&
    a.body === b.body &&
    a.route === b.route &&
    Math.abs((a.receivedAt ?? 0) - (b.receivedAt ?? 0)) <= windowMs
  );
}

/**
 * Add an entry to the inbox: newest first, duplicate deliveries dropped (see isSameMessage), capped
 * at MAX_ENTRIES (oldest fall off). Pure — returns a NEW list and never mutates the input, plus an
 * `added` flag so the caller can skip re-showing a banner for a duplicate.
 * @param {object[]} entries current inbox, newest first.
 * @param {object} entry the candidate entry.
 * @returns {{entries: object[], added: boolean}}
 */
export function addEntry(entries, entry) {
  const list = Array.isArray(entries) ? entries : [];
  if (!entry || list.some((existing) => isSameMessage(existing, entry))) {
    return { entries: list, added: false };
  }
  return { entries: [entry, ...list].slice(0, MAX_ENTRIES), added: true };
}

/**
 * How many entries are unread — drives the nav bell's badge.
 * @param {object[]} entries
 * @returns {number}
 */
export function unreadCount(entries) {
  return Array.isArray(entries) ? entries.filter((e) => e && e.read !== true).length : 0;
}

/**
 * Mark every entry read (opening the inbox = seeing everything in it). Pure: returns a new list,
 * or the SAME list when nothing was unread so callers can cheaply skip a repaint/persist.
 * @param {object[]} entries
 * @returns {object[]}
 */
export function markAllRead(entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.some((e) => e && e.read !== true)) return list;
  return list.map((e) => (e && e.read !== true ? { ...e, read: true } : e));
}

/**
 * Mark one entry (by id) read — used when its banner is dismissed or its View action is tapped.
 * Pure: returns a new list, or the same list when the id is absent/already read.
 * @param {object[]} entries
 * @param {string} id the entry id.
 * @returns {object[]}
 */
export function markRead(entries, id) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.some((e) => e && e.id === id && e.read !== true)) return list;
  return list.map((e) => (e && e.id === id && e.read !== true ? { ...e, read: true } : e));
}

/**
 * The one-line text the persistent banner card shows for an entry: "title — body", or just the
 * title when there's no distinct body. Pure string mapping — no DOM.
 * @param {?{title?: string, body?: string}} entry
 * @returns {string}
 */
export function bannerMessage(entry) {
  if (!entry || !entry.title) return "";
  return entry.body ? `${entry.title} — ${entry.body}` : entry.title;
}

/**
 * Re-validate one persisted entry. localStorage is user-editable, so nothing read back is trusted:
 * texts are re-normalised/re-capped, the route must re-pass the push-deeplink allow-list (else it
 * becomes null — the entry keeps rendering, it just isn't clickable), timestamps are coerced to a
 * finite number and `read` to a real boolean. An entry with no displayable text is dropped.
 * @param {*} raw one parsed array element.
 * @returns {?object} a clean entry, or null to drop it.
 */
function sanitiseEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (!asText(raw.title) && !asText(raw.body)) return null;
  const { title, body } = normaliseTexts(raw.title, raw.body);
  const route = typeof raw.route === "string" ? normaliseRoute(raw.route) : null;
  const receivedAt = Number.isFinite(raw.receivedAt) ? raw.receivedAt : 0;
  const sourceId = asText(raw.sourceId) || null;
  const id = asText(raw.id) || sourceId || `${receivedAt}:${title.slice(0, 120)}`;
  return { id, sourceId, title, body, route, receivedAt, read: raw.read === true };
}

/**
 * Load the persisted inbox. Tolerant by design — junk JSON, a non-array, or a hand-edited store
 * yields a clean (possibly empty) list rather than a crash, and every surviving entry has been
 * through sanitiseEntry. `storage` is injectable (tests pass a fake; the DOM half passes
 * localStorage); a null/throwing storage just means an empty inbox.
 * @param {?{getItem: Function}} storage a Storage-like object, or null.
 * @returns {object[]} clean entries, newest first, at most MAX_ENTRIES.
 */
export function loadEntries(storage) {
  if (!storage || typeof storage.getItem !== "function") return [];
  let raw = null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return [];
  }
  if (!raw || typeof raw !== "string") return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map(sanitiseEntry).filter(Boolean).slice(0, MAX_ENTRIES);
}

/**
 * Persist the inbox (capped at MAX_ENTRIES). Best-effort: a full/unavailable storage (private
 * mode, quota) returns false and the inbox simply lives for the session only — never throws, so a
 * storage problem can never break push handling.
 * @param {object[]} entries
 * @param {?{setItem: Function}} storage a Storage-like object, or null.
 * @returns {boolean} whether the write succeeded.
 */
export function saveEntries(entries, storage) {
  if (!storage || typeof storage.setItem !== "function") return false;
  const list = Array.isArray(entries) ? entries.slice(0, MAX_ENTRIES) : [];
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}
