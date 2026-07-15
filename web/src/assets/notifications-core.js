// Notifications feed — pure logic core (TM-515, TM-745).
//
// The grouped-notifications SCREEN (the paper-notifications wireframe): activity with a "Mark all
// read" action. Following the codebase's core/renderer split (events-core.js / tabbar-core.js /
// chat-core.js), this module holds ONLY the pure data + transforms — the feed mapping, the unread
// count, and the immutable mark-all-read — with NO DOM/Firebase/fetch imports, so it is import-safe
// in a plain Node test (`node --test web/tools/*.test.mjs`, the CI web gate). The DOM half lives in
// `notifications.js`; the styling lives in styles.css.
//
// NOT the same thing as the foreground-push inbox (notification-center.js / notification-inbox.js):
// that is a native-only recovery net for pushes that arrive while the app is foregrounded, shown in a
// bell + modal. THIS is the full grouped Notifications feed screen from the approved wireframe. The
// two are deliberately separate surfaces (different data, different entry points) and share no state.
//
// REAL FEED (TM-745). This screen previously rendered a HARDCODED seed of 5 fabricated notifications
// ("A spot opened up", "3 new people are going", "Sarah commented in the chat", …) as if they were
// real activity — misleading a real user into thinking real events needed action. A real
// notifications backend now exists (GET /api/v1/me/notifications, TM-454) and the bell-opened panel
// already consumes it (notification-panel.js). This module now MAPS that same real feed into the
// screen's group model instead of fabricating data, so NOTHING FAKE renders — an empty feed yields
// zero groups and the DOM half shows an honest empty state.
//
// RIGHT-SIZED (not a full screen rewrite). To keep the change small and honest we render the caller's
// real items under a single "Notifications" group (the same admin/system feed the bell shows),
// reusing the bell panel's shared per-type icon table (`typeIcon`) so there is one source of truth for
// glyphs. Full parity with the wireframe's per-event grouping + chat collapsing is a follow-up — the
// point of THIS change is only that no fabricated data can ever render on the live screen.

import { typeIcon } from "./notification-panel-core.js";

/** The single group heading the mapped real items live under (no fabricated per-event titles). */
export const FEED_GROUP_TITLE = "Notifications";

/** Coerce anything to a trimmed display string ("" when unusable) — tolerant of a malformed payload. */
function asText(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/**
 * Map the real notifications feed page (GET /api/v1/me/notifications items — NotificationResponse[],
 * `{ id, type, title, body, deepLink, sticky, createdAt, seen, read }`) into the screen's group model.
 *
 * Pure: no fetch/DOM, no input mutation, tolerant of a junk/absent item (skipped) so a malformed
 * payload can't break the screen. Returns [] for an empty/absent feed so the DOM half shows the honest
 * empty state rather than any fabricated content.
 *
 * Each mapped note carries the SAME shape the DOM renderer + mark-all-read already expect:
 *   id    — the server notification id (stable identity for list keys / a future per-item mark-read)
 *   icon  — an icons.js line-icon name chosen from the notification TYPE via the bell panel's shared
 *           `typeIcon` table (one source of truth; falls back to the bell glyph for an unknown type)
 *   text  — the notification's real title (falling back to its body) — server data, rendered by the
 *           DOM half via textContent only (no innerHTML), so no escaping is needed here
 *   time  — the raw `createdAt` (ISO string / epoch); the DOM half formats it with ui.js relativeTime
 *   read  — the server's read flag (false → unread row wash + accent dot; true → plain read row)
 *
 * @param {Array<object>|null|undefined} items the feed page's `items` (NotificationResponse[]).
 * @returns {Array<{title: string, notes: Array<{id,icon,text,time,read}>}>} zero or one group.
 */
export function mapFeed(items) {
  const list = Array.isArray(items) ? items.filter((n) => n && typeof n === "object") : [];
  const notes = list.map((n) => ({
    id: n.id,
    icon: typeIcon(n.type),
    text: asText(n.title) || asText(n.body),
    time: n.createdAt ?? null,
    read: n.read === true,
  }));
  return notes.length ? [{ title: FEED_GROUP_TITLE, notes }] : [];
}

/**
 * How many notifications across all groups are unread — drives whether "Mark all read" does anything
 * (and a future feed badge). Tolerant of a missing/!array `notes`.
 * @param {Array<{notes?: Array<{read?: boolean}>}>} groups
 * @returns {number}
 */
export function unreadCount(groups) {
  if (!Array.isArray(groups)) return 0;
  return groups.reduce(
    (sum, g) => sum + (Array.isArray(g?.notes) ? g.notes.filter((n) => n && n.read !== true).length : 0),
    0,
  );
}

/**
 * Mark every notification read (the "Mark all read" action). Pure: returns a NEW group list with new
 * note objects, never mutating the input — so the caller repaints from the returned value and the
 * mapped feed is untouched. Returns the SAME reference when nothing was unread, so a caller can
 * cheaply skip a redundant repaint.
 * @param {Array} groups
 * @returns {Array}
 */
export function markAllRead(groups) {
  if (!Array.isArray(groups) || unreadCount(groups) === 0) return groups;
  return groups.map((g) => ({
    ...g,
    notes: Array.isArray(g?.notes) ? g.notes.map((n) => (n && n.read !== true ? { ...n, read: true } : n)) : g?.notes,
  }));
}
