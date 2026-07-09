// Notification panel — pure logic core (TM-456).
//
// The bell-opened notification PANEL (the seam TM-455's bell hands off to via
// `window.tmNotificationPanel`). This module is the pure half — it turns the raw notification feed
// (GET /api/v1/me/notifications, TM-454) into the two kinds of row the panel renders, with NO
// DOM/Firebase/fetch imports, so it is import-safe in a plain Node test (`node --test
// web/tools/*.test.mjs`, the CI web gate) — the same core/renderer split the codebase uses
// everywhere (tabbar-core.js / notifications-core.js / notification-bell-core.js). The DOM half lives
// in `notification-panel.js`; the styling lives in styles.css.
//
// THE TWO KINDS (AC).
//   • CHAT groups — one per event thread. Chat activity in the same event thread is collapsed into a
//     single row ("3 new in Coffee & Code") with an unread count + the latest message preview; tapping
//     opens that event's thread (#/chat/{id}) and marks the group's notifications read. A group is
//     "read" once all its members are read, so it clears once the thread has been read (the AC).
//   • ADMIN + SYSTEM items — ungrouped. Every non-chat notification (an admin broadcast, an event
//     reminder/cancellation/RSVP/waitlist offer) is its own row with a per-type icon, title/body and
//     timestamp; tapping deep-links (TM-285-style safe route) and marks that one item read.
//
// WHY CLASSIFY CLIENT-SIDE. The feed API (TM-454) currently serves the admin/system store only, so in
// today's system `buildPanel` yields only ungrouped items and no chat groups — the correct, graceful
// degrade. The chat-unread half rides the conversation model and is delivered by a sibling ticket;
// when its notifications land (a CHAT-family type, or a #/chat/{id} deep-link) the grouping kicks in
// automatically with no change here — exactly how notification-bell-core.js already sums a chat count
// in ahead of that work.
//
// TRUST BOUNDARY. A deep-link is only ever accepted through `safeRoute` — the same contract as
// push-deeplink.js's `normaliseRoute` (TM-285): reject scheme'd / scheme-relative / external targets,
// coerce the rest to an in-app hash route, and accept only a known app route (extended here with the
// events/chat DETAIL routes the panel legitimately links to, which the push allow-list omits). A
// notification body is server data but the panel renders it via textContent only (the DOM half), so
// this module never has to escape anything.

/** Section kinds the DOM half switches on. */
export const CHAT_GROUP = "chat";
export const ITEM = "item";

/**
 * Per-type glyphs for an ungrouped admin/system row, using the icons.js line-icon names (the only
 * theme-safe glyph set that inks in both toggle states — doodles are decorative/hidden in clean
 * Paper). Kept small and semantic against the available set (spot=bell, people, clock, welcome=home,
 * chat=speech): an announcement/alert reads as the bell, an attendance change as people, a
 * time-related change as the clock. An unknown/future type falls back to the bell so a row is never
 * icon-less. Mirrors the enum in backend NotificationType.
 */
export const TYPE_ICONS = Object.freeze({
  ADMIN_MESSAGE: "spot", // an admin announcement → the bell glyph
  EVENT_UPDATED: "clock", // schedule/detail change → clock
  EVENT_CANCELLED: "spot", // an alert → the bell glyph
  WAITLIST_OFFER: "spot", // "a spot opened up" → the bell glyph (matches the wireframe copy)
  RSVP_CONFIRMED: "people", // you're going / attendance → people
  EVENT_REMINDER: "clock", // "starts in 1 hour" → clock (matches the wireframe)
});

/** Fallback glyph for an unknown/absent type — a generic bell, so no row renders icon-less. */
export const DEFAULT_ITEM_ICON = "spot";

/** Glyph for a chat group row — the speech-bubble, matching the wireframe's chat note. */
export const CHAT_ICON = "chat";

/** The in-app routes a notification may deep-link to (static set). Mirrors router.js's known views. */
const STATIC_ROUTES = new Set([
  "#/home",
  "#/profile",
  "#/profile/public",
  "#/admin",
  "#/admin/events",
  "#/help",
  "#/onboarding",
  "#/terms",
  "#/diagnostics",
  "#/notifications",
  "#/events",
  "#/chat",
  "#/login",
]);

/** Coerce anything to a trimmed display string ("" when unusable) — tolerant of a malformed payload. */
function asText(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/**
 * The sortable epoch-ms for a createdAt value (ISO string or Date), used to order the panel
 * newest-activity-first. A missing/unparseable time sorts oldest (0) rather than throwing.
 * @param {string|Date|null|undefined} value
 * @returns {number}
 */
function timeValue(value) {
  const t = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? t : 0;
}

/** A numeric id for stable tiebreaking (0 when the id isn't a finite number). */
function idValue(id) {
  const n = Number(id);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Normalise an untrusted deep-link to a SAFE in-app hash route, or null if it can't be — the panel's
 * trust boundary (reuses TM-285's contract; see the class doc). `#/events/42`, `/events/42`,
 * `events/42` all map to `#/events/42`; an off-app or unknown route yields null so a bad link is inert
 * rather than navigated blindly. The route BASE is lower-cased (routes are lower-case) while a dynamic
 * id segment keeps its original case (ids can be case-sensitive).
 * @param {string|null|undefined} raw
 * @returns {string|null}
 */
export function safeRoute(raw) {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (s === "") return null;
  // Reject absolute / scheme-relative / scheme'd targets outright — must stay in-app (javascript:,
  // http:, //host, etc. all caught here before any hash coercion).
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith("//")) return null;
  // Coerce shapes to a leading "#/" hash route: "#/x" stays, "#x" → "#/x", "/x" → "#/x", "x" → "#/x".
  if (s.startsWith("#/")) {
    // already a hash route
  } else if (s.startsWith("#")) {
    s = "#/" + s.slice(1).replace(/^\/+/, "");
  } else if (s.startsWith("/")) {
    s = "#" + s;
  } else {
    s = "#/" + s;
  }
  // Drop any trailing slash beyond the root ("#/events/" → "#/events").
  s = s.replace(/\/+$/, (m, off) => (off <= 2 ? m : ""));
  const lower = s.toLowerCase();
  if (STATIC_ROUTES.has(lower)) return lower;
  // Events / chat DETAIL: exactly one non-empty segment after the base (#/events/{id}, #/chat/{id}).
  // Lower-case the base but preserve the id segment's case.
  const detail = /^(#\/(?:events|chat)\/)([^/]+)$/i.exec(s);
  if (detail) return detail[1].toLowerCase() + detail[2];
  return null;
}

/**
 * The safe chat-THREAD route for a deep-link, i.e. `#/chat/{id}` with a non-empty id — or null when
 * the link isn't a chat thread (the bare `#/chat` list, an events link, an off-app link, …). Used
 * both to classify a notification as chat and as a chat group's tap target.
 * @param {string|null|undefined} deepLink
 * @returns {string|null}
 */
export function chatThreadRoute(deepLink) {
  const route = safeRoute(deepLink);
  return route && /^#\/chat\/[^/]+$/.test(route) ? route : null;
}

/**
 * Is this notification chat activity (→ grouped by event thread) rather than an admin/system item?
 * True when its type is a CHAT-family type (forward-compatible with the sibling chat-notification
 * ticket — matched case-insensitively so CHAT / CHAT_MESSAGE both count) OR when it deep-links to a
 * chat thread (#/chat/{id}). Everything else — admin broadcasts and the event-lifecycle types — is an
 * ungrouped admin/system item.
 * @param {{type?: string, deepLink?: string}|null|undefined} n
 * @returns {boolean}
 */
export function isChatNotification(n) {
  if (!n || typeof n !== "object") return false;
  const type = typeof n.type === "string" ? n.type.toUpperCase() : "";
  if (type.includes("CHAT")) return true;
  return chatThreadRoute(n.deepLink) != null;
}

/** The glyph name for an ungrouped item's type (see TYPE_ICONS; falls back to the bell). */
export function typeIcon(type) {
  const key = typeof type === "string" ? type.toUpperCase() : "";
  return TYPE_ICONS[key] || DEFAULT_ITEM_ICON;
}

/**
 * The header label for a chat group: "{unread} new in {title}" while it has unread messages (the AC's
 * '3 new in Coffee & Code'), or just the event title once it's all read.
 * @param {{unread?: number, title?: string}} group
 * @returns {string}
 */
export function chatGroupLabel(group) {
  const unread = group && Number.isFinite(group.unread) ? group.unread : 0;
  const title = (group && group.title) || "Chat";
  return unread > 0 ? `${unread} new in ${title}` : title;
}

/**
 * Turn a raw feed page into the ordered list of panel SECTIONS, newest-activity first.
 *
 * Each returned section is one of:
 *   • Chat group — { kind: "chat", key, title, route, icon, ids, unreadIds, unread, preview,
 *                    createdAt, read }. `ids`/`unreadIds` drive mark-read; `route` is the thread tap
 *                    target; `read` is true once every member is read (so the group clears — the AC).
 *   • Item       — { kind: "item", id, type, icon, title, body, route, createdAt, read, sticky }.
 *
 * Grouping key for chat: the safe thread route (all messages in one thread share `#/chat/{id}`), or —
 * when a chat notification carries no thread link — its title, so same-titled chat notes still merge.
 * The newest member of a group drives its title/preview/timestamp. Pure: no input mutation, tolerant
 * of a junk/absent item (skipped) so a malformed payload can't break the panel.
 *
 * @param {Array<object>|null|undefined} items the feed page's `items` (NotificationResponse[]).
 * @returns {Array<object>} sections, newest-activity first (chat groups + ungrouped items interleaved).
 */
export function buildPanel(items) {
  const list = Array.isArray(items) ? items.filter((n) => n && typeof n === "object") : [];
  /** @type {Map<string, object>} chat groups keyed by thread route (or title fallback). */
  const groups = new Map();
  const others = [];

  for (const n of list) {
    if (isChatNotification(n)) {
      const route = chatThreadRoute(n.deepLink);
      const title = asText(n.title);
      // Key by the thread route when we have one (the canonical per-event identity); otherwise by the
      // title so same-titled chat notes without a link still collapse into one group.
      const key = route || `title:${title}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          kind: CHAT_GROUP,
          key,
          title: title || "Chat",
          route,
          icon: CHAT_ICON,
          ids: [],
          unreadIds: [],
          unread: 0,
          preview: "",
          createdAt: null,
          at: -Infinity, // latest member's epoch-ms (for ordering)
          maxId: 0, // largest member id (stable tiebreak)
        };
        groups.set(key, group);
      }
      const at = timeValue(n.createdAt);
      const unread = n.read !== true;
      group.ids.push(n.id);
      if (unread) {
        group.unread += 1;
        group.unreadIds.push(n.id);
      }
      group.maxId = Math.max(group.maxId, idValue(n.id));
      // The newest member sets the group's shown title/preview/timestamp.
      if (at >= group.at) {
        group.at = at;
        group.title = title || group.title;
        group.preview = asText(n.body) || title || group.title;
        group.createdAt = n.createdAt ?? group.createdAt;
      }
    } else {
      others.push({
        kind: ITEM,
        id: n.id,
        type: typeof n.type === "string" ? n.type : "",
        icon: typeIcon(n.type),
        title: asText(n.title),
        body: asText(n.body),
        route: safeRoute(n.deepLink),
        createdAt: n.createdAt ?? null,
        at: timeValue(n.createdAt),
        maxId: idValue(n.id),
        read: n.read === true,
        sticky: n.sticky === true,
      });
    }
  }

  // A chat group is read once none of its members are unread — this is what clears it (the AC).
  for (const group of groups.values()) group.read = group.unread === 0;

  const sections = [...groups.values(), ...others];
  // Newest-activity first; a same-timestamp tie breaks by the larger id so the order is deterministic
  // (stable for tests, and a just-arrived higher-id row wins a tie).
  sections.sort((a, b) => b.at - a.at || b.maxId - a.maxId);
  return sections;
}

/**
 * The total unread the panel represents — chat groups' unread members plus unread ungrouped items.
 * Handy for a header count / a test assertion; the bell's own badge maths stays in
 * notification-bell-core.js.
 * @param {Array<object>} sections the output of {@link buildPanel}.
 * @returns {number}
 */
export function panelUnreadTotal(sections) {
  if (!Array.isArray(sections)) return 0;
  return sections.reduce((sum, s) => {
    if (!s) return sum;
    if (s.kind === CHAT_GROUP) return sum + (Number.isFinite(s.unread) ? s.unread : 0);
    return sum + (s.read === true ? 0 : 1);
  }, 0);
}
