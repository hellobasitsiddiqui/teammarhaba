// Chat section — pure logic core (TM-438, reads the F2 conversation API / TM-436).
//
// The framework-free web SPA is the single source for all four surfaces (web / mobile-web / Android
// WebView / iOS WebView). Following the codebase's established core/renderer split (events-core.js,
// notifications-core.js, tabbar-core.js — see AGENTIC-LESSONS "extract the pure logic to test it"),
// this module holds ONLY the pure data transforms the Chat screens need — mapping the backend's
// conversation read API (TM-436) response shapes into the small view-models the DOM layer renders,
// plus the read-receipt derivation kept from the wireframe work. It has NO DOM, Firebase or Capacitor
// imports, so it is import-safe in a plain Node test (`node --test web/tools/*.test.mjs`, the CI
// web-build gate). The DOM-mounting half lives in `chat.js`; the styling lives in styles.css.
//
// WHAT CHANGED (TM-438): the earlier TM-515 wireframe refresh drove these screens off static SEED
// conversations while the backend was unbuilt. TM-436 landed the real read API, so this module now
// adapts the live API instead — exactly the swap TM-515's own comments predicted ("when the backend
// lands, the same DOM shell reads real messages from the API in place of the seed"). The list is now
// UNIFIED: event group chats (`EVENT_GROUP`) and admin broadcasts (`ADMIN_BROADCAST`) come back in one
// feed, each carrying a `type` we turn into a display badge so the two are distinguishable in one list.
//
// API shapes consumed (see web/src/api-docs/openapi.json):
//   • ConversationSummaryResponse — { id, type, title, eventId, lastMessagePreview, lastMessageAt,
//                                     lastActiveAt, unreadCount }  → toConversationRow()
//   • ConversationMessageResponse — { id, senderId, body, deepLink, system, reactions[], createdAt }
//                                    → toThreadMessage()
// Both arrive inside the shared page envelope `{ items, page, size, totalElements, totalPages }`, so
// the DOM layer passes `data.items` straight into toConversationRows() / toThreadMessages().

/**
 * The five reaction emoji the (future) reaction picker offers. Kept here as the single source of truth
 * shared by any reaction UI and its tests. Reactions themselves are read-only in TM-438 — the API
 * returns a per-message `reactions` array we DISPLAY; adding/removing a reaction is a later ticket.
 */
export const REACTION_EMOJIS = Object.freeze(["👍", "❤️", "😂", "🎉", "🙌"]);

/**
 * The inline reaction-pill data produced when a picker emoji is chosen for a message. A fresh react is
 * always `{ emoji, count: 1 }` (single-select, replaces any prior pill). Kept as a pure, unit-tested
 * rule so a future reactions ticket wires the DOM to one tested source rather than re-deriving it.
 * @param {string} emoji the chosen glyph (one of REACTION_EMOJIS).
 * @returns {{emoji: string, count: number}}
 */
export function pickReaction(emoji) {
  return { emoji: String(emoji ?? ""), count: 1 };
}

/**
 * Derive the read-receipt tick state for an out-going message from how many group members have read
 * it (the delivery ladder, kept as a pure util for a future ticket that surfaces receipts once the
 * API carries read counts):
 *   readBy <= 0            → "sent"   (✓   — delivered, nobody has read it)
 *   0 < readBy < members   → "read"   (✓✓  — read by some, not all)
 *   readBy >= members      → "group"  (✓✓✓ — read by everyone: whole-group-read)
 * `members` is clamped to at least 1 so a degenerate 0-member group can't make every message "group".
 * @param {number} readBy how many OTHER members have read the message.
 * @param {number} members the group's member count.
 * @returns {"sent"|"read"|"group"}
 */
export function receiptState(readBy, members) {
  const read = Math.max(0, Math.trunc(Number(readBy) || 0));
  const total = Math.max(1, Math.trunc(Number(members) || 0));
  if (read <= 0) return "sent";
  if (read >= total) return "group";
  return "read";
}

/* ─────────────────────────────── Conversation type badge ───────────────────────────────────────
 * The unified list mixes event group chats and admin broadcasts, so each row needs a small badge that
 * says which kind it is. `key` drives the CSS accent (`.tm-chat-type--event` / `--admin`); `label` is
 * the human text. An unknown/absent type falls back to the common event case rather than throwing.
 * ---------------------------------------------------------------------------------------------- */

/** Map a backend conversation `type` to its display badge. */
export function conversationBadge(type) {
  if (type === "ADMIN_BROADCAST") return { key: "admin", label: "Admin" };
  return { key: "event", label: "Event" };
}

/**
 * The avatar glyph for a list row: admin broadcasts get a megaphone (they have no per-event identity);
 * event chats get their title's first letter (the `avatar()` component upper-cases a single letter, or
 * passes an emoji straight through). Falls back to a neutral chat glyph when there's no title.
 * @param {{type?: string, title?: string}} summary
 * @returns {string}
 */
export function avatarGlyph(summary) {
  if (summary?.type === "ADMIN_BROADCAST") return "📣";
  const title = String(summary?.title ?? "").trim();
  return title ? title[0] : "💬";
}

/**
 * Format an ISO instant into a compact list/message time label, in the viewer's LOCAL time:
 *   • same calendar day  → "HH:MM"        (e.g. "14:05")
 *   • same calendar year → "D Mon"        (e.g. "3 Jul")
 *   • otherwise          → "D Mon YYYY"   (e.g. "3 Jul 2025")
 * A missing/unparseable instant returns "" so the DOM simply omits the stamp.
 * @param {string} iso an ISO-8601 timestamp (or nullish).
 * @param {Date} [now] the reference "now" (injectable for deterministic tests).
 * @returns {string}
 */
export function formatTimeLabel(iso, now = new Date()) {
  if (!iso) return "";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const sameDay =
    t.getFullYear() === now.getFullYear() &&
    t.getMonth() === now.getMonth() &&
    t.getDate() === now.getDate();
  if (sameDay) {
    return `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
  }
  const dayMonth = `${t.getDate()} ${months[t.getMonth()]}`;
  return t.getFullYear() === now.getFullYear() ? dayMonth : `${dayMonth} ${t.getFullYear()}`;
}

/** Epoch-ms of an ISO instant for ordering, or 0 when absent/unparseable (sorts oldest). */
function epoch(iso) {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/* ─────────────────────────────── Conversation list adapters ───────────────────────────────────── */

/**
 * Map one ConversationSummaryResponse to the row view-model the list renders. Everything the DOM needs
 * is pre-derived here (badge, avatar glyph, time label, clamped unread) so chat.js stays a dumb shell.
 * @param {Object} summary a ConversationSummaryResponse.
 * @param {Date} [now] reference "now" for the time label.
 * @returns {{id: string, title: string, type: {key: string, label: string}, preview: string,
 *            unread: number, timeLabel: string, sortAt: number, avatar: string}}
 */
export function toConversationRow(summary, now = new Date()) {
  const s = summary || {};
  const at = s.lastMessageAt || s.lastActiveAt || null;
  return {
    id: String(s.id ?? ""),
    title: String(s.title ?? "").trim() || "Conversation",
    type: conversationBadge(s.type),
    preview: String(s.lastMessagePreview ?? ""),
    unread: Math.max(0, Math.trunc(Number(s.unreadCount) || 0)),
    timeLabel: formatTimeLabel(at, now),
    sortAt: epoch(at),
    avatar: avatarGlyph(s),
  };
}

/**
 * Order conversation rows for the unified list: newest activity first, so event chats and admin
 * broadcasts interleave by recency (the "unified" requirement). Stable for equal timestamps. Returns a
 * NEW array — never mutates the input.
 * @param {Array<{sortAt: number}>} rows
 * @returns {Array} the rows, newest-first.
 */
export function sortConversations(rows) {
  return [...(rows || [])].sort((a, b) => (b?.sortAt || 0) - (a?.sortAt || 0));
}

/**
 * The end-to-end list adapter: map every API summary to a row, then order newest-first. This is what
 * the DOM layer calls with `data.items` from GET /api/v1/me/conversations.
 * @param {Array<Object>} items ConversationSummaryResponse[] (the page envelope's `items`).
 * @param {Date} [now]
 * @returns {Array} ordered row view-models.
 */
export function toConversationRows(items, now = new Date()) {
  return sortConversations((Array.isArray(items) ? items : []).map((s) => toConversationRow(s, now)));
}

/** Total unread across a set of conversation rows (or raw summaries) — a single tested reducer. */
export function totalUnread(rowsOrItems) {
  return (Array.isArray(rowsOrItems) ? rowsOrItems : []).reduce(
    (sum, c) => sum + Math.max(0, Math.trunc(Number(c?.unread ?? c?.unreadCount) || 0)),
    0,
  );
}

/* ─────────────────────────────── Thread message adapters ──────────────────────────────────────── */

/**
 * Map one ConversationMessageResponse to the message view-model the thread renders. The read API does
 * not expose the caller's own numeric id (GET /api/v1/me has no id), so TM-438 cannot mark a message
 * as "mine" / draw out-going ticks — it renders a flat, chronological message list. `system` messages
 * (e.g. "You joined the event") render as a centred notice rather than a bubble. Reactions are carried
 * through for read-only display.
 * @param {Object} msg a ConversationMessageResponse.
 * @param {Date} [now]
 * @returns {{id: string, body: string, system: boolean, deepLink: (string|null),
 *            reactions: Array<{emoji: string, count: number, mine: boolean}>, timeLabel: string,
 *            sortAt: number}}
 */
export function toThreadMessage(msg, now = new Date()) {
  const m = msg || {};
  const reactions = (Array.isArray(m.reactions) ? m.reactions : [])
    .filter((r) => r && r.emoji)
    .map((r) => ({
      emoji: String(r.emoji),
      count: Math.max(0, Math.trunc(Number(r.count) || 0)),
      mine: Boolean(r.mine),
    }));
  return {
    id: String(m.id ?? ""),
    body: String(m.body ?? ""),
    system: Boolean(m.system),
    deepLink: m.deepLink ? String(m.deepLink) : null,
    reactions,
    timeLabel: formatTimeLabel(m.createdAt, now),
    sortAt: epoch(m.createdAt),
  };
}

/**
 * The end-to-end thread adapter: map every API message, then order OLDEST-first (chat reads top→bottom,
 * newest at the foot) regardless of the server's page order. Returns a new array.
 * @param {Array<Object>} items ConversationMessageResponse[] (the page envelope's `items`).
 * @param {Date} [now]
 * @returns {Array} ordered message view-models.
 */
export function toThreadMessages(items, now = new Date()) {
  return (Array.isArray(items) ? items : [])
    .map((m) => toThreadMessage(m, now))
    .sort((a, b) => a.sortAt - b.sortAt);
}
