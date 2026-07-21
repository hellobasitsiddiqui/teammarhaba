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
//   • ConversationMessageResponse — { id, senderId, body, deepLink, system, reactions[], createdAt,
//                                     readReceipt? } → toThreadMessage()  (readReceipt present only on
//                                     the caller's OWN messages — TM-463, see normaliseReceipt below)
// Both arrive inside the shared page envelope `{ items, page, size, totalElements, totalPages }`, so
// the DOM layer passes `data.items` straight into toConversationRows() / toThreadMessages().
//
// ── ONE-WAY ADMIN MESSAGES (TM-445) ──────────────────────────────────────────────────────────────
// Admin broadcasts (ConversationType.ADMIN_BROADCAST) are one-way "from TeamMarhaba" announcements a
// user can re-read in the chat section after the push is gone. The backend marks every such line with
// `senderId == null` → the convenience `system` flag (ConversationMessageResponse doc: "drives the
// 'from TeamMarhaba' render"), and may attach an in-app `deepLink` (e.g. `/events/42`) the client
// surfaces as a tap-through CTA. So the one-way presentation is driven PER MESSAGE by `system` (robust
// even on a cold deep-link where the conversation `type` isn't cached), while the thread-level
// affordances TM-448 already ships — the Admin type badge + the disabled composer (announcements are
// read-only, see composeAvailability) — stay type-driven. This module adds the pure pieces that render
// needs: ADMIN_AUTHOR (the attribution name) + deepLinkCta() (the untrusted-link → safe CTA rule).
//
// The deep-link CTA reuses the notification panel's TM-285 trust boundary (safeRoute) rather than
// re-deriving it, so an admin's link can only ever navigate WITHIN the app (a scheme'd / off-app /
// unknown target is dropped and the CTA simply isn't drawn). Importing one pure core from another is an
// established pattern here (calendar-core←events-core, chat-tab-badge-core←notification-bell-core), and
// keeps this module import-safe in a plain Node test (no DOM / Firebase / Capacitor reaches it).
import { safeRoute } from "./notification-panel-core.js";

/**
 * The five reaction emoji the picker offers (TM-462), in display order. The single source of truth
 * shared by the reaction UI and its tests. A "like" is deliberately just a common emoji — 👍 leads and
 * ❤️ follows, offered prominently at the head of the picker — so there is NO special like gesture; the
 * react button + this set is the whole affordance (the AC's "no double-tap-to-like").
 */
export const REACTION_EMOJIS = Object.freeze(["👍", "❤️", "😂", "🎉", "🙌"]);

/**
 * The inline reaction-pill data produced when a picker emoji is chosen for a message. A fresh react is
 * always `{ emoji, count: 1 }`. Retained as a pure, unit-tested primitive; the interactive toggle UI
 * (TM-462) drives the richer {@link applyReactionToggle} below, which also carries the `mine` flip and
 * the multi-chip optimistic maths.
 * @param {string} emoji the chosen glyph (one of REACTION_EMOJIS).
 * @returns {{emoji: string, count: number}}
 */
export function pickReaction(emoji) {
  return { emoji: String(emoji ?? ""), count: 1 };
}

/**
 * Normalise a raw reactions array into the clean chip view-models the thread renders: drop entries with
 * no emoji, clamp `count` to a non-negative integer, coerce `mine` to a boolean. Both the loaded thread
 * (a ConversationMessageResponse's `reactions[]`) and the react/un-react endpoints' reply (TM-461's
 * MessageReactionSummary `reactions[]`) carry the SAME EmojiReactionCount shape, so {@link toThreadMessage}
 * and the toggle's server-reconcile step both derive chips from this ONE tested rule.
 * @param {Array<{emoji?: string, count?: number, mine?: boolean}>} raw
 * @returns {Array<{emoji: string, count: number, mine: boolean}>}
 */
export function normaliseReactions(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((r) => r && r.emoji)
    .map((r) => ({
      emoji: String(r.emoji),
      count: Math.max(0, Math.trunc(Number(r.count) || 0)),
      mine: Boolean(r.mine),
    }));
}

/**
 * The OPTIMISTIC chip math for tapping a reaction `emoji` on a message (TM-462): applied immediately —
 * before the react/un-react round-trip (TM-461) — then reconciled with the server's authoritative summary
 * on success, or rolled back to the prior chips on failure. Returns the NEW chip list to paint plus which
 * endpoint the DOM must call:
 *   • the emoji is already the caller's (`mine`) → un-react: DELETE; count−1 and `mine`→false, and the
 *                                                   chip DISAPPEARS if that was its last count (→ 0).
 *   • the emoji is present but not the caller's   → react:   POST;  count+1 and `mine`→true.
 *   • the emoji is absent entirely                → react:   POST;  a fresh `{emoji, count:1, mine:true}` chip.
 * Multi-select is allowed — a caller may hold several DISTINCT reactions on one message — so chips for the
 * OTHER emoji are left untouched; only the tapped emoji's chip changes. Pure + non-mutating (returns a new
 * array); an empty/blank glyph is a no-op (never creates an empty chip).
 * @param {Array<{emoji, count, mine}>} reactions the message's current reaction chips.
 * @param {string} emoji the tapped glyph (a picker choice, or an existing chip).
 * @returns {{reactions: Array<{emoji: string, count: number, mine: boolean}>, action: ("react"|"unreact")}}
 */
export function applyReactionToggle(reactions, emoji) {
  const glyph = String(emoji ?? "");
  const list = normaliseReactions(reactions);
  if (!glyph) return { reactions: list, action: "react" }; // defensive: never toggle on a blank glyph
  const existing = list.find((r) => r.emoji === glyph);
  const mine = Boolean(existing && existing.mine);
  const action = mine ? "unreact" : "react";
  if (!existing) {
    return { reactions: [...list, { emoji: glyph, count: 1, mine: true }], action };
  }
  const next = list
    .map((r) => (r.emoji === glyph
      ? { emoji: r.emoji, count: mine ? r.count - 1 : r.count + 1, mine: !mine }
      : r))
    .filter((r) => r.count > 0); // a chip decremented to zero is removed entirely
  return { reactions: next, action };
}

/**
 * Should a FAILED reaction toggle roll its optimistic paint back? (TM-854.) Only when the message's
 * CURRENT chips are still exactly the optimistic value that toggle wrote — if a concurrent poll/SSE
 * reconcile replaced them while the request was in flight, that newer server truth must NOT be
 * clobbered by the toggle's stale pre-request snapshot. Note the poll applies a whole fresh page
 * without bumping `thread.rev` (rev only tracks live/SSE mutations — TM-721), so this is a VALUE
 * comparison (emoji/count/mine, in order), not a rev check: a wholesale array replace with identical
 * content still counts as "untouched by anyone else".
 * @param {Array<{emoji, count, mine}>} current the message's reaction chips at failure time.
 * @param {Array<{emoji, count, mine}>} optimistic the chips the toggle wrote before its request.
 * @returns {boolean} true → safe to restore the pre-toggle chips; false → leave the newer state alone.
 */
export function shouldRollbackReaction(current, optimistic) {
  const now = normaliseReactions(current);
  const wrote = normaliseReactions(optimistic);
  if (now.length !== wrote.length) return false;
  return now.every((r, i) => r.emoji === wrote[i].emoji && r.count === wrote[i].count && r.mine === wrote[i].mine);
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
 *            unread: number, timeLabel: string, sortAt: number, avatar: string, muted: boolean,
 *            left: boolean}}
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
    // The caller's own self-service membership flags (TM-471): `muted` → show a muted indicator on the
    // row; `left` → the caller has self-left this thread, so the row is rendered as a de-emphasised
    // "you left — rejoin" affordance rather than an openable thread.
    muted: Boolean(s.notificationsMuted),
    left: Boolean(s.left),
  };
}

/**
 * The self-service controls to offer for a thread, from the caller's own membership flags (TM-471).
 * Pure so chat.js renders one tested source: which mute action + label to show, and whether the thread
 * is in the "left" state (rendered as a rejoin affordance rather than an open thread). Defaults are the
 * cold-deep-link fallback (not muted, not left) — the endpoints are the source of truth and each
 * returns the fresh state, so a wrong-way default self-corrects on the first action.
 * @param {{muted?: boolean, left?: boolean}} [membership]
 * @returns {{muted: boolean, left: boolean, muteAction: ("mute"|"unmute"), muteLabel: string}}
 */
export function membershipControls(membership = {}) {
  const muted = Boolean(membership?.muted);
  return {
    muted,
    left: Boolean(membership?.left),
    muteAction: muted ? "unmute" : "mute",
    muteLabel: muted ? "Unmute notifications" : "Mute notifications",
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

/**
 * One thread's per-caller unread, read straight from the raw conversation-list summaries (TM-855). On a
 * DEEP-LINK open (push / notification-center) the paged list was never rendered, so `state.rows` is
 * empty and the on-open optimistic badge-drop reads a stale 0 and no-ops — the badge lingers until the
 * next server refresh. The fix resolves the thread's unread from the fetched list summary (the SAME
 * server-computed, per-caller `unreadCount` the list rows carry) BEFORE the mark-read POST advances the
 * cursor — the mark-read response can't supply it, since that endpoint marks the thread read first and
 * then recomputes unread against the fresh cursor (→ 0 on this path; see MarkReadResponse).
 *
 * Matches on the string id (summaries carry a numeric/string `id`; the router hands us a string). A
 * miss (thread not in the fetched page, or a malformed payload) yields 0 — the optimistic drop simply
 * no-ops and the post-commit `refreshChatTabBadge()` reconcile still corrects the total, so this is
 * never worse than before.
 * @param {Array<{id?: number|string, unreadCount?: number}>} items the raw list summaries (`data.items`).
 * @param {number|string} id the conversation id to look up.
 * @returns {number} the thread's non-negative per-caller unread, or 0 if not found.
 */
export function conversationUnreadInList(items, id) {
  const target = String(id);
  const row = (Array.isArray(items) ? items : []).find((s) => s && String(s.id) === target);
  if (!row) return 0;
  const n = Number(row.unreadCount);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/* ─────────────────────────────── Thread message adapters ──────────────────────────────────────── */

/**
 * The author label a `system` (senderId == null) message is attributed to in the thread — the app's
 * own name, so a one-way admin broadcast reads as "from TeamMarhaba" rather than an anonymous line.
 * Single source of truth shared by the render + its tests.
 */
export const ADMIN_AUTHOR = "Circle";

/**
 * Turn a message's optional `deepLink` into the tap-through CTA the thread renders, or null when there
 * is none / it isn't a safe in-app destination (TM-445). The link is UNTRUSTED (an admin typed it into
 * the compose form), so it passes through the notification panel's TM-285 trust boundary
 * ({@link safeRoute}): a scheme'd / off-app / scheme-relative / unknown target yields null and the CTA
 * is simply not drawn, so a bad link is inert rather than navigated blindly. A good link is coerced to
 * a same-app hash route (`/events/42` → `#/events/42`) and given a purpose-fit label from the route
 * family so the button reads well ("View event" / "Open chat"), defaulting to a neutral "Open".
 * @param {string|null|undefined} deepLink the raw ConversationMessageResponse.deepLink.
 * @returns {{href: string, label: string}|null}
 */
export function deepLinkCta(deepLink) {
  const href = safeRoute(deepLink);
  if (!href) return null;
  let label = "Open";
  if (/^#\/events\/[^/]+$/.test(href)) label = "View event";
  else if (/^#\/chat\/[^/]+$/.test(href)) label = "Open chat";
  else if (href === "#/events") label = "Browse events";
  return { href, label };
}

/**
 * Normalise a ConversationMessageResponse `readReceipt` (TM-463) into the view-model's receipt, or null.
 *
 * The backend attaches `readReceipt` ({ count, readerIds }) ONLY to the caller's OWN messages (only the
 * sender sees who's read their message), so its PRESENCE is the server's authoritative "this message is
 * mine" signal — the read API otherwise can't tell the client which loaded messages it authored (the
 * `toThreadMessage` note below). A nullish/absent receipt therefore means "not mine" → null (no
 * indicator). `readerIds` are stringified (they key the "who read it" rows) and `count` is clamped and
 * never allowed below the number of ids we actually hold.
 * @param {{count?: number, readerIds?: Array}} [receipt]
 * @returns {{count: number, readerIds: string[]}|null}
 */
export function normaliseReceipt(receipt) {
  if (!receipt || typeof receipt !== "object") return null;
  const readerIds = (Array.isArray(receipt.readerIds) ? receipt.readerIds : [])
    .map((id) => String(id ?? "").trim())
    .filter(Boolean);
  const count = Math.max(0, Math.trunc(Number(receipt.count) || 0), readerIds.length);
  return { count, readerIds };
}

/**
 * The "read by N" indicator label (TM-463) — NOT a tick (the AC is explicit). A receipt with no readers
 * yet reads as "Sent" (delivered, nobody's opened it); one or more readers reads as "Read by N". Empty
 * string for a message with no receipt (not the caller's own), so the DOM simply omits the indicator.
 * @param {{count: number}|null} receipt a normalised receipt (from normaliseReceipt).
 * @returns {string}
 */
export function readReceiptLabel(receipt) {
  if (!receipt) return "";
  const n = Math.max(0, Math.trunc(Number(receipt.count) || 0));
  return n === 0 ? "Sent" : `Read by ${n}`;
}

/**
 * The FRIENDLY read-by bucket label for one of the caller's own messages (TM-829) — still TEXT, never a
 * ✓/✓✓/✓✓✓ tick (the AC is explicit). Buckets how many OTHER thread members have read it against how many
 * there are:
 *   • 0 readers               → "Read by none"      (delivered, nobody's opened it)
 *   • all other members       → "Read by everyone"  (whole-group-read)
 *   • some but not all        → "Read by few"        in a larger group, or the exact "Read by N" in a
 *                                small group (2–3 others) where a specific count reads more naturally than
 *                                the vague "few".
 * `otherMemberCount` is the number of OTHER members (excluding the caller) — sourced client-side from the
 * thread roster the mentions feature already loads. When it's unknown / non-positive we can't say
 * "everyone" (we don't know the denominator), so any positive read count falls back to the exact
 * "Read by N". `readerCount` is clamped to a non-negative integer and never allowed to exceed a known
 * `otherMemberCount` (a stale roster can't make "few" read as more than "everyone").
 *
 * @param {number} readerCount how many OTHER members have read the message.
 * @param {number} [otherMemberCount] how many OTHER members the thread has (roster size minus the caller);
 *        0 / negative / omitted = unknown denominator.
 * @returns {string} the friendly label ("" is never returned — a receipt always has at least "Read by none").
 */
export function readByLabel(readerCount, otherMemberCount) {
  const total = Math.trunc(Number(otherMemberCount) || 0);
  let read = Math.max(0, Math.trunc(Number(readerCount) || 0));
  if (total > 0) read = Math.min(read, total); // clamp: a stale roster can't exceed the known denominator
  if (read <= 0) return "Read by none";
  if (total <= 0) return `Read by ${read}`; // unknown denominator → can't claim "everyone"; be exact
  if (read >= total) return "Read by everyone";
  // Some-but-not-all. In a small group (2–3 others) an exact count reads better than the vague "few".
  return total <= 3 ? `Read by ${read}` : "Read by few";
}

/**
 * The label shown for a quoted parent whose original has been moderation-removed / is missing (TM-466)
 * — the AC's "message unavailable". Kept here so the DOM and its tests share one string.
 */
export const MESSAGE_UNAVAILABLE = "Message unavailable";

/** Max length of a quote excerpt the composer builds locally (mirrors the backend's QuotedMessage cap). */
export const QUOTE_EXCERPT_MAX = 140;

/**
 * Collapse whitespace, trim, and truncate a body to a short quote excerpt (mirrors the backend's
 * QuotedMessage excerpt rule, so a composer-built preview matches what the thread will render). Empty
 * in → empty out.
 * @param {string} text
 * @param {number} [max]
 * @returns {string}
 */
export function quoteExcerpt(text, max = QUOTE_EXCERPT_MAX) {
  const collapsed = String(text ?? "").trim().replace(/\s+/g, " ");
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Map the API's `replyTo` snippet (a backend QuotedMessage, or nullish) to the quote view-model the
 * thread renders ABOVE a reply (TM-466). `null` when the message isn't a reply. A parent that's been
 * removed comes back `available: false` — we withhold its (absent) excerpt and the DOM shows
 * {@link MESSAGE_UNAVAILABLE}. `id` is always carried so a tap can scroll to the original if it's loaded.
 * @param {?Object} replyTo a QuotedMessage: { id, senderId, system, excerpt, available }.
 * @returns {?{id: string, system: boolean, available: boolean, excerpt: string}}
 */
export function toQuotedPreview(replyTo) {
  if (!replyTo) return null;
  const available = Boolean(replyTo.available);
  return {
    id: String(replyTo.id ?? ""),
    system: Boolean(replyTo.system),
    available,
    // Only a live parent carries an excerpt; a removed one shows the "unavailable" copy instead.
    excerpt: available ? String(replyTo.excerpt ?? "") : MESSAGE_UNAVAILABLE,
  };
}

/**
 * Whether a message is an admin/host ANNOUNCEMENT (TM-710) — the auto-posted event opening message, or
 * an admin-sent announcement — as classified server-side by the message `kind`. Case-insensitive and
 * defensive: only the exact {@code "ANNOUNCEMENT"} kind counts; a missing / unknown kind (every
 * pre-TM-710 message, whose kind is {@code "ATTENDEE"} or absent) is a normal attendee message. Kept
 * pure (no DOM) so the announcement-vs-attendee decision is unit-tested here, not in the DOM renderer.
 * @param {{kind?: string}} msg a ConversationMessageResponse (or its view-model).
 * @returns {boolean} true iff this is an announcement-kind message.
 */
export function isAnnouncement(msg) {
  const kind = msg?.kind;
  return typeof kind === "string" && kind.trim().toUpperCase() === "ANNOUNCEMENT";
}

/**
 * Map one ConversationMessageResponse to the message view-model the thread renders. The read API does
 * not expose the caller's own numeric id (GET /api/v1/me has no id), so TM-438 cannot mark a message
 * as "mine" / draw out-going ticks purely from the payload. `system` messages (an admin broadcast, or an
 * in-thread notice like "You joined the event") render as a centred "from TeamMarhaba" notice rather than
 * a bubble, and — new in TM-445 — carry a pre-derived `cta` when their deep-link is a safe in-app route,
 * so chat.js can draw the tap-through affordance without re-checking the link. Reactions are carried
 * through for read-only display; `replyTo` (TM-466) is the quoted-parent preview, or null for a non-reply.
 *
 * <p>TM-463: `readReceipt` is carried through (normalised, or null). Because the backend only attaches it
 * to the caller's OWN messages, a non-null `readReceipt` is one authoritative "this message is mine"
 * signal — letting the thread draw a loaded (not just in-session) own message as out-going.
 *
 * <p>TM-589 / TM-467: `mine` is the server-computed own-message flag (true only when the verified caller
 * authored it). It's the direct "is this mine" signal the edit/delete affordances (TM-467) gate on —
 * more robust than inferring ownership from a read receipt's presence. It's null on the caller-independent
 * SSE broadcast frame (which can't resolve "mine"), coerced here to a strict boolean (`=== true`), so only
 * a concrete server `true` marks a message own. `edited` / `editedAt` (TM-467) drive the "edited" tag: the
 * backend stamps `editedAt` when an author edits, and a non-null value renders the tag.
 * @param {Object} msg a ConversationMessageResponse.
 * @param {Date} [now]
 * @returns {{id: string, body: string, system: boolean, mine: boolean, deepLink: (string|null),
 *            cta: ({href: string, label: string}|null),
 *            reactions: Array<{emoji: string, count: number, mine: boolean}>,
 *            replyTo: (?{id: string, system: boolean, available: boolean, excerpt: string}),
 *            timeLabel: string, sortAt: number, edited: boolean, editedAt: (string|null),
 *            readReceipt: ({count: number, readerIds: string[]}|null)}}
 */
export function toThreadMessage(msg, now = new Date()) {
  const m = msg || {};
  const reactions = normaliseReactions(m.reactions);
  const deepLink = m.deepLink ? String(m.deepLink) : null;
  return {
    id: String(m.id ?? ""),
    body: String(m.body ?? ""),
    system: Boolean(m.system),
    // TM-828: the sender's identity for the incoming-bubble avatar + name label. `senderName` is the
    // author's display name (null on a system / admin message — no author to attribute); `senderPhotoUrl`
    // is the author's photo, currently always null (no server-side photo store — see the backend DTO
    // note), so the renderer falls back to an initial-in-circle from the name. Trimmed to "" when absent
    // so a downstream `startsSenderRun` / render only sees a real, non-blank name.
    senderName: m.senderName == null ? "" : String(m.senderName).trim(),
    senderPhotoUrl: m.senderPhotoUrl ? String(m.senderPhotoUrl) : null,
    // TM-710: an admin/host ANNOUNCEMENT (the auto-posted opening message, or an admin-sent
    // announcement) renders visually distinct + attributed as an announcement. Classified server-side
    // via the message `kind` and echoed here so the renderer never re-derives it.
    announcement: isAnnouncement(m),
    // TM-589: the server-computed own flag (strictly true only when the caller authored it); null on the
    // caller-independent broadcast frame → false here. Drives own-vs-other alignment + edit/delete gating.
    mine: m.mine === true,
    deepLink,
    cta: deepLinkCta(deepLink),
    reactions,
    replyTo: toQuotedPreview(m.replyTo),
    timeLabel: formatTimeLabel(m.createdAt, now),
    sortAt: epoch(m.createdAt),
    // TM-467: a non-null editedAt means the author edited the body → render the "edited" tag.
    edited: Boolean(m.editedAt),
    editedAt: m.editedAt ? String(m.editedAt) : null,
    readReceipt: normaliseReceipt(m.readReceipt),
  };
}

/**
 * Build the composer's active-reply target from the thread message the user chose to reply to (TM-466):
 * the parent id to send + a local quote preview (excerpt) so the composer can show what's being quoted
 * before the round-trip. System messages can be quoted too. Returns null for a message with no id.
 * @param {{id?: string, body?: string, system?: boolean}} message a thread message view-model.
 * @returns {?{id: string, excerpt: string, system: boolean, available: boolean}}
 */
export function replyTargetFrom(message) {
  const id = String(message?.id ?? "");
  if (!id) return null;
  return { id, excerpt: quoteExcerpt(message?.body), system: Boolean(message?.system), available: true };
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

/**
 * Whether {@code current} STARTS a new sender-run in the oldest→newest thread — the pure grouping
 * decision behind the Slack/WhatsApp identity header (TM-828). A run is a consecutive stretch of INCOMING
 * messages from the same author; the avatar + name label are drawn once at the TOP of the run (when this
 * returns true) and suppressed on the rest, instead of repeating on every bubble.
 *
 * <p>Returns true when {@code current} is an incoming human message AND it opens a run — i.e. there is no
 * previous message, or the previous one isn't the same author's ordinary incoming message (a different
 * sender, an own/out-going message, or a system/announcement notice all break the run). Own messages
 * (`mine`) and system/announcement messages never carry an identity header, so they always return false —
 * the caller only draws the header on incoming bubbles anyway, but keeping the rule here means the
 * "same author as the previous incoming line?" decision is one tested predicate, not inline DOM logic.
 *
 * <p>Authorship is compared by `senderId` when both messages carry one (the robust key), falling back to
 * a non-blank `senderName` match when ids are absent (e.g. a lean live frame). A message with neither is
 * treated as its own run-start (can't be grouped with confidence).
 *
 * @param {{mine?: boolean, system?: boolean, announcement?: boolean, senderId?: any, senderName?: string}} current
 *        the message being rendered (a toThreadMessage view-model, or the raw API row).
 * @param {?{mine?: boolean, system?: boolean, announcement?: boolean, senderId?: any, senderName?: string}} previous
 *        the message rendered immediately before it (oldest→newest), or null/undefined at the top.
 * @returns {boolean} true iff {@code current} should show the sender avatar + name (start of a run).
 */
export function startsSenderRun(current, previous) {
  const c = current || {};
  // Own / system / announcement messages never get an incoming identity header.
  if (c.mine === true || c.system === true || c.announcement === true) return false;
  const p = previous || null;
  // No previous, or the previous line isn't an ordinary incoming message → this opens a run.
  if (!p || p.mine === true || p.system === true || p.announcement === true) return true;
  // Same author as the previous incoming line? Prefer senderId; fall back to a non-blank name match.
  const cId = c.senderId == null ? "" : String(c.senderId);
  const pId = p.senderId == null ? "" : String(p.senderId);
  if (cId && pId) return cId !== pId;
  const cName = String(c.senderName ?? "").trim();
  const pName = String(p.senderName ?? "").trim();
  if (cName && pName) return cName !== pName;
  // Not enough identity to group with confidence → treat as its own run-start.
  return true;
}

/* ─────────────────────────────── Composer (TM-448) ─────────────────────────────────────────────
 * Posting a message (TM-448) turns the read-only thread (TM-438) into a real conversation: a compose
 * box that sends to the member-gated POST endpoint (TM-447). All the DECISIONS live here as pure,
 * node-tested rules so chat.js stays a thin DOM shell:
 *   • validateDraft  — is the typed text sendable (non-blank, ≤500)?  (also drives the send button)
 *   • composeAvailability — can the caller compose here AT ALL, from the conversation type alone?
 *       (admin broadcasts are announcements — read-only for attendees, so the box is disabled up-front)
 *   • classifyPostError — a failed POST → lock the composer with a clear reason (muted / removed /
 *       closed / gone) vs a transient blip the caller can retry. This is the ONLY place the backend's
 *       403/409/404 (there is no capability field on the read API) becomes the AC's "disabled with a
 *       clear reason" — muted/removed/closed are only knowable by attempting the write.
 *   • pendingMessage / upsertMessage / threadSignature — the optimistic-echo + near-live-refresh maths.
 * ---------------------------------------------------------------------------------------------- */

/** The backend's PostMessageRequest bound (openapi: body maxLength 500). The composer enforces it too. */
export const MAX_MESSAGE_LENGTH = 500;

/**
 * Validate a compose-box draft against the post contract (non-blank after trim, ≤ MAX_MESSAGE_LENGTH).
 * Pure so the send button's enabled state + the char counter derive from ONE tested rule rather than
 * being re-implemented inline. `value` is the trimmed text to actually send.
 * @param {string} text the raw input value.
 * @returns {{value: string, length: number, remaining: number, empty: boolean, tooLong: boolean,
 *            canSend: boolean}}
 */
export function validateDraft(text) {
  const value = String(text ?? "").trim();
  const length = value.length;
  const empty = length === 0;
  const tooLong = length > MAX_MESSAGE_LENGTH;
  return {
    value,
    length,
    remaining: MAX_MESSAGE_LENGTH - length,
    empty,
    tooLong,
    canSend: !empty && !tooLong,
  };
}

/**
 * Whether the caller can compose in this conversation AT ALL, decided from the conversation TYPE alone
 * (the only capability the read API exposes). Admin broadcasts are one-way announcements, so the box is
 * disabled up-front with a clear reason; event group chats are open to attempt (per-caller mute/removal
 * and thread closure aren't on the read API, so those surface via classifyPostError on the first send).
 * Accepts either a raw ConversationSummaryResponse (`type: "ADMIN_BROADCAST"`) or an already-mapped row
 * (`type: { key: "admin" }`).
 * @param {{type?: (string|{key?: string})}} conversation
 * @returns {{canPost: boolean, reason: (string|null)}}
 */
export function composeAvailability(conversation) {
  const type = conversation?.type;
  const key = typeof type === "string" ? type : type?.key;
  if (key === "ADMIN_BROADCAST" || key === "admin") {
    return { canPost: false, reason: "Only admins can post here — this is an announcements channel." };
  }
  return { canPost: true, reason: null };
}

/**
 * Map a FAILED post ({@link ApiError} with `.status` + backend `.message`) to a composer outcome. The
 * backend (TM-447) is the sole source of truth for muted/removed/closed (there is no capability field
 * to read up-front), so this is where the AC's "compose is disabled with a clear reason" is realised:
 *   • 403 → membership block: muted (READ_ONLY) or not-a-member/removed → LOCK, reason from the body.
 *   • 409 → the thread is closed / read-only                            → LOCK.
 *   • 404 → the conversation is gone                                    → LOCK.
 *   • 400 → the body failed validation (blank / >500)                  → surface inline, do NOT lock.
 *   • anything else (5xx / network / unknown)                          → TRANSIENT, keep the draft.
 * The backend's own copy ("You are muted in this thread and cannot post." etc.) is already user-facing,
 * so it's preferred as the reason; `reasonKey` is a stable token for styling/tests, never shown.
 * @param {{status?: number, message?: string}} error
 * @returns {{locked: boolean, transient: boolean, reasonKey: string, reason: string, message: string}}
 */
export function classifyPostError(error) {
  const status = Number(error?.status) || 0;
  const raw = String(error?.message ?? "").trim();
  const lock = (reasonKey, fallback) => ({
    locked: true,
    transient: false,
    reasonKey,
    reason: raw || fallback,
    message: raw || fallback,
  });

  if (status === 403) {
    // The copy only distinguishes muted from not-a-member; removed reads as "not a member" too.
    return /mut/i.test(raw)
      ? lock("muted", "You are muted in this thread and cannot post.")
      : lock("removed", "You are not a member of this thread.");
  }
  if (status === 409) return lock("closed", "This thread is closed; you can no longer post.");
  if (status === 404) return { locked: true, transient: false, reasonKey: "gone", reason: "This conversation is no longer available.", message: raw || "This conversation is no longer available." };
  if (status === 400) {
    const msg = raw || `Your message must be 1–${MAX_MESSAGE_LENGTH} characters.`;
    return { locked: false, transient: false, reasonKey: "invalid", reason: msg, message: msg };
  }
  // Transient: a network drop or a 5xx — the draft is kept and the caller can retry.
  return { locked: false, transient: true, reasonKey: "transient", reason: "", message: "Couldn't send your message. Please try again." };
}

/**
 * Build the optimistic-echo view-model for a just-sent message — the SAME shape {@link toThreadMessage}
 * produces so the thread renders it identically, plus `pending: true` so the DOM can dim it and label
 * it "Sending…". Replaced by the server's confirmed message (via {@link upsertMessage}) once the POST
 * resolves, or rolled back on failure. `replyTo` (TM-466) carries the quoted-parent preview so the echo
 * shows the quote immediately, exactly as the confirmed reply will.
 * @param {string} body the message text.
 * @param {{localId?: string, now?: Date, replyTo?: ?Object}} [opts]
 * @returns {{id: string, body: string, system: boolean, deepLink: null, cta: null, reactions: [],
 *            replyTo: (?Object), timeLabel: string, sortAt: number, pending: boolean,
 *            readReceipt: null}}
 */
export function pendingMessage(body, { localId = "pending", now = new Date(), replyTo = null } = {}) {
  return {
    id: String(localId),
    body: String(body ?? ""),
    system: false,
    // A pending echo is definitionally the caller's own message (they're the one sending it) — TM-589.
    mine: true,
    deepLink: null,
    cta: null,
    reactions: [],
    replyTo: replyTo || null,
    timeLabel: formatTimeLabel(now.toISOString(), now),
    sortAt: now.getTime(),
    pending: true,
    // A brand-new echo hasn't been edited; the "edited" tag only appears after an author edit (TM-467).
    edited: false,
    editedAt: null,
    // No receipt on an unconfirmed echo; the server's confirmed message carries the real one (TM-463).
    readReceipt: null,
  };
}

/**
 * Insert (or replace, by id) a message into an oldest-first message list, returning a NEW array kept in
 * `sortAt` order. Used to fold a POST's confirmed message into the loaded thread without a full refetch,
 * and to make a poll idempotent (a message already present is replaced, never duplicated).
 * @param {Array<{id: string, sortAt: number}>} messages
 * @param {{id: string, sortAt: number}} message
 * @returns {Array}
 */
export function upsertMessage(messages, message) {
  const rest = (Array.isArray(messages) ? messages : []).filter((m) => m.id !== message.id);
  return [...rest, message].sort((a, b) => a.sortAt - b.sortAt);
}

/**
 * Fold a LIVE-broadcast message frame into the loaded list WITHOUT clobbering fields the broadcast can't
 * carry (TM-731). A brand-new id is inserted exactly like {@link upsertMessage}; but when we already hold
 * the row — the common own-send case, where the direct POST response already gave us the RICH message —
 * the fan-out frame is a lean copy that omits the sender-only `readReceipt` and (for a reply) the resolved
 * `replyTo` quote. A blind whole-row replace would drop the reply quote + the read receipt (and briefly
 * double-render). So for an existing id we PATCH in the broadcast's own fields (body / reactions / edit
 * state / order) while PRESERVING the incumbent's `readReceipt` and `replyTo` whenever the frame lacks them.
 *
 * <p>Mirrors {@link applyMessageEdit}'s "field-level merge, never a whole-row replace" rule, generalised
 * to the whole broadcast frame. Returns a NEW array in `sortAt` order; a frame without an id is a no-op.
 * @param {Array<{id: string, sortAt: number}>} messages the loaded thread.
 * @param {{id: string, sortAt: number}} message the broadcast frame (a toThreadMessage view-model).
 * @returns {Array}
 */
export function mergeLiveMessage(messages, message) {
  const list = Array.isArray(messages) ? messages : [];
  if (!message || !message.id) return list.slice();
  const existing = list.find((m) => m.id === message.id);
  if (!existing) return upsertMessage(list, message);
  // Preserve the incumbent's sender-only receipt and resolved reply quote when the lean broadcast frame
  // doesn't carry them — the direct POST response is authoritative for those, the fan-out isn't.
  const merged = {
    ...message,
    readReceipt: message.readReceipt != null ? message.readReceipt : existing.readReceipt,
    replyTo: message.replyTo != null ? message.replyTo : existing.replyTo,
  };
  return upsertMessage(list, merged);
}

/**
 * A cheap change-signature for a loaded message list, so the near-live poll only repaints the thread
 * when something actually changed (a new/edited message, a reaction or a read receipt) instead of
 * clobbering scroll position + any in-progress read every tick. Count + last id + last timestamp catches
 * an appended message; the per-message folds below catch in-place changes that leave those three equal.
 * @param {Array<{id: string, sortAt: number}>} messages
 * @returns {string}
 */
export function threadSignature(messages) {
  const list = Array.isArray(messages) ? messages : [];
  if (list.length === 0) return "0";
  const last = list[list.length - 1];
  // Fold in each message's in-place state so a change that adds NO new row (count / last-id / last-sortAt
  // all unchanged) still changes the signature — otherwise the poll sees "nothing new" and never repaints:
  //   • editedAt        — someone else edited a message body (TM-467);
  //   • reactions        — another member reacted/un-reacted; the chips changed but no row was added, so
  //                        without this the poll would never render other members' reactions (TM-731);
  //   • readReceipt.count — a reader opened one of the caller's own messages, changing "Sent" → "Read by N".
  const marks = list.reduce((acc, m) => {
    let mark = "";
    if (m.editedAt) mark += `,${m.id}@${m.editedAt}`;
    if (Array.isArray(m.reactions) && m.reactions.length) {
      mark += `,${m.id}#${m.reactions.map((r) => `${r.emoji}:${r.count}:${r.mine ? 1 : 0}`).join("|")}`;
    }
    if (m.readReceipt) mark += `,${m.id}$${m.readReceipt.count}`;
    return acc + mark;
  }, "");
  return `${list.length}:${last.id}:${last.sortAt}${marks}`;
}

/* ─────────────────────────────── Author edit / delete own message (TM-467) ──────────────────────────
 * The pure maths behind editing and deleting the caller's OWN message. chat.js is the DOM shell + the
 * PATCH/DELETE endpoint calls (api.js); every DECISION lives here as a node-tested rule:
 *   • canEditWithinWindow — is a message still inside the ~5-minute edit window? (drives whether the edit
 *       affordance is offered — a best-effort client hint; the backend re-checks authoritatively);
 *   • applyMessageEdit    — fold a confirmed / live-broadcast edit (new body + editedAt) into the loaded
 *       list, in place BY ID, preserving that message's reactions / receipt / reply quote;
 *   • removeMessageById   — drop a deleted message from the loaded list BY ID (author delete + moderation
 *       both soft-delete, so the message simply leaves the timeline).
 * ---------------------------------------------------------------------------------------------- */

/** The author edit window (mirrors the backend's MessageAuthorService.EDIT_WINDOW — ~5 minutes). */
export const EDIT_WINDOW_MS = 5 * 60 * 1000;

/** The short tag rendered on an edited message (TM-467) — kept here so the DOM + its tests share one string. */
export const EDITED_TAG = "edited";

/**
 * Whether a message is still within the edit window (TM-467), so the edit affordance should be offered.
 * A best-effort CLIENT hint — the backend enforces the same ~5-minute cutoff authoritatively against the
 * DB-authoritative created_at, so a stale hint at most shows an edit control that the PATCH then rejects
 * with a 409 (never lets a real out-of-window edit through). Inclusive at the boundary, matching the
 * server. An absent / unparseable timestamp is treated as out-of-window (no edit offered).
 * @param {string|number} createdAt the message's post instant (ISO string or epoch-ms).
 * @param {number} [now] epoch-ms now (injectable for deterministic tests).
 * @param {number} [windowMs] the window length (defaults to EDIT_WINDOW_MS).
 * @returns {boolean}
 */
export function canEditWithinWindow(createdAt, now = Date.now(), windowMs = EDIT_WINDOW_MS) {
  const t = typeof createdAt === "number" ? createdAt : Date.parse(createdAt);
  if (!Number.isFinite(t)) return false;
  const ref = typeof now === "number" ? now : Number(now) || Date.now();
  return ref - t <= windowMs;
}

/**
 * Fold an edit into an oldest-first message list: find the message by id and replace ONLY its body +
 * editedAt (marking it `edited`), preserving everything else on the row (reactions, receipt, reply quote,
 * order). Returns a NEW array; the untouched messages keep their identity, only the edited one is a fresh
 * object. Used by both the author's own optimistic reconcile and a live `message-edited` broadcast — an
 * edit is a PATCH, never a whole-row replace (which is why it can't reuse {@link upsertMessage}, whose
 * broadcast frame carries empty reactions and would clobber the chips). A missing/blank id, or an id not
 * in the list, is a harmless no-op (returns a copy).
 * @param {Array<{id: string}>} messages the loaded thread.
 * @param {{id: (string|number), body?: string, editedAt?: (string|null)}} patch the edit to apply.
 * @returns {Array}
 */
export function applyMessageEdit(messages, patch) {
  const list = Array.isArray(messages) ? messages : [];
  const id = String(patch?.id ?? "");
  if (!id) return list.slice();
  return list.map((m) => (m.id === id
    ? {
        ...m,
        body: patch.body != null ? String(patch.body) : m.body,
        editedAt: patch.editedAt != null ? String(patch.editedAt) : (m.editedAt || null),
        edited: true,
      }
    : m));
}

/**
 * Drop a message from an oldest-first list BY ID — the timeline effect of a soft-delete (author delete
 * TM-467, or admin moderation): the message simply leaves the thread (the read filters deleted rows out).
 * Returns a NEW array; a blank/absent id or one not present is a harmless no-op.
 * @param {Array<{id: string}>} messages the loaded thread.
 * @param {string|number} id the message id to remove.
 * @returns {Array}
 */
export function removeMessageById(messages, id) {
  const target = String(id ?? "");
  const list = Array.isArray(messages) ? messages : [];
  if (!target) return list.slice();
  return list.filter((m) => m.id !== target);
}

/* ─────────────────────────────── Live transport — SSE frame parser (TM-464) ─────────────────────
 * The live chat stream (GET /api/v1/conversations/{id}/stream) is a Server-Sent-Events response the
 * client consumes as a byte stream. This is the PURE half of the client: it turns raw stream text
 * into dispatchable events, with NO fetch/DOM, so it is unit-testable in plain Node exactly like the
 * adapters above. api.js owns the network read + auth and feeds chunks into a parser instance; chat.js
 * turns the parsed `message` events into new bubbles.
 *
 * SSE wire format (https://html.spec.whatwg.org/multipage/server-sent-events.html): events are
 * separated by a BLANK line; within an event, `field:value` lines carry `event:` (the type, default
 * "message"), one or more `data:` lines (joined with "\n"), `id:`, `retry:`. A line starting with ":"
 * is a comment (our `:keep-alive` heartbeat) and is ignored. A leading space after the colon is
 * stripped. We tolerate CRLF or LF line endings.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Create a stateful parser for one SSE connection. Feed it decoded text chunks (which may split an
 * event across reads); it buffers the remainder and returns the events that completed in this chunk.
 * Each event is `{ event, data, id }`; a comment-only frame (heartbeat) yields nothing.
 * @returns {{push: (chunk: string) => Array<{event: string, data: string, id: (string|undefined)}>}}
 */
export function createSseParser() {
  let buffer = "";
  return {
    push(chunk) {
      // Normalise line endings so an event boundary is always exactly "\n\n" regardless of CRLF.
      buffer = (buffer + String(chunk ?? "")).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const events = [];
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseSseFrame(frame);
        if (event) events.push(event);
      }
      return events;
    },
  };
}

/**
 * Parse one raw SSE frame (the text between blank-line boundaries) into an event, or `null` when the
 * frame carries no `data` (a pure comment/heartbeat, or a stray blank). Exported for direct testing.
 * @param {string} frame the raw field lines of a single event.
 * @returns {{event: string, data: string, id: (string|undefined)}|null}
 */
export function parseSseFrame(frame) {
  let event = "message"; // the SSE default event type when no `event:` field is present
  let id;
  const dataLines = [];
  for (const line of String(frame ?? "").split("\n")) {
    if (line === "" || line.startsWith(":")) continue; // blank or comment (`:keep-alive`) — skip
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1); // spec: strip a single leading space after the colon
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
    else if (field === "id") id = value;
    // `retry:` and any unknown field are ignored — we don't drive reconnection timing from the server.
  }
  if (dataLines.length === 0) return null; // no payload -> not a dispatchable event
  return { event, data: dataLines.join("\n"), id };
}

/* ─────────────────────────────── Typing indicators (TM-465) ──────────────────────────────────────
 * "X is typing…" over the live SSE transport (TM-464), EPHEMERAL — never stored. This is the PURE half:
 * the debounce decision (how often the client signals up), and the receiver-side typist state machine
 * (fold each `typing` event in, expire it a few seconds after the last signal, and render the aggregated
 * label). No DOM/fetch, so it unit-tests in plain Node exactly like the SSE parser above; api.js owns the
 * POST + the SSE read, chat.js turns the label into a line under the thread.
 *
 * The two ends are deliberately decoupled by time: the sender DEBOUNCES to at most one signal every
 * TYPING_DEBOUNCE_MS while composing (never per-keystroke), and the receiver EXPIRES a typist
 * TYPING_TTL_MS after their last signal. TTL > debounce leaves a grace margin so a still-typing person's
 * indicator never flickers between two debounced signals, yet clears within a few seconds once they stop.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Minimum gap between typing signals the client sends UP while someone composes (the debounce). At most
 * one POST per this window, never per-keystroke — cheap on the wire and on the server fan-out.
 */
export const TYPING_DEBOUNCE_MS = 3000;

/**
 * How long a received typist stays shown after their LAST signal before expiring (the receiver-side TTL).
 * Comfortably above {@link TYPING_DEBOUNCE_MS} so a continuously-typing person (who re-signals every
 * debounce window) never lapses, while a stopped one clears within a few seconds.
 */
export const TYPING_TTL_MS = 5000;

/** A display name for a typist, falling back to a generic label when the server sent none (a nameless account). */
export function typistName(name) {
  const trimmed = (name == null ? "" : String(name)).trim();
  return trimmed || "Someone";
}

/**
 * Whether the client should send a typing signal NOW, given when it last sent one (the debounce gate).
 * True if it has never signalled ({@code lastSentAt} falsy) or at least {@code interval} ms have passed —
 * so a burst of keystrokes collapses to one signal per window.
 * @param {number} lastSentAt epoch-ms of the last sent signal (0/null = never).
 * @param {number} now epoch-ms now.
 * @param {number} [interval] the debounce window (defaults to TYPING_DEBOUNCE_MS).
 * @returns {boolean}
 */
export function shouldSignalTyping(lastSentAt, now, interval = TYPING_DEBOUNCE_MS) {
  return !lastSentAt || now - lastSentAt >= interval;
}

/**
 * Fold one received {@code typing} event into the typist list, keyed by user id (so repeated signals from
 * the same person REFRESH one entry, never stack). A start (`typing !== false`) upserts the typist with a
 * fresh expiry ({@code now + ttl}); an explicit stop (`typing === false`) removes them at once. An event
 * with no user id is ignored (can't be keyed/de-duped). Returns a NEW array (never mutates the input), so
 * a caller can compare/replace by reference.
 * @param {Array<{userId: string, name: string, expiresAt: number}>} typists the current list.
 * @param {{userId: (string|number), name?: string, typing?: boolean}} event the received typing event.
 * @param {number} now epoch-ms now.
 * @param {number} [ttl] the receiver-side TTL (defaults to TYPING_TTL_MS).
 * @returns {Array<{userId: string, name: string, expiresAt: number}>}
 */
export function applyTypingEvent(typists, event, now, ttl = TYPING_TTL_MS) {
  const list = Array.isArray(typists) ? typists : [];
  const uid = event && event.userId != null ? String(event.userId) : "";
  if (!uid) return list.slice(); // no key → can't track this signal; leave the list unchanged (copy)
  // Drop any existing entry for this person first — a start re-adds it (refreshed), a stop leaves it gone.
  const without = list.filter((t) => t.userId !== uid);
  if (event.typing === false) return without; // explicit "stopped" → remove immediately
  without.push({ userId: uid, name: typistName(event.name), expiresAt: now + ttl });
  return without;
}

/** Drop typists whose last signal has expired (expiry at/-before {@code now}). Returns a new array. */
export function pruneTypists(typists, now) {
  const list = Array.isArray(typists) ? typists : [];
  return list.filter((t) => t.expiresAt > now);
}

/**
 * The aggregated "who's typing" label for the thread, after expiring stale typists (TM-465 group
 * aggregation). Empty string when nobody is typing (the caller hides the line); otherwise:
 *   • 1 → "X is typing…"
 *   • 2 → "X and Y are typing…"
 *   • 3+ → "X, Y and N others are typing…" (N = the rest)
 * @param {Array<{userId: string, name: string, expiresAt: number}>} typists
 * @param {number} now epoch-ms now.
 * @returns {string}
 */
export function typingLabel(typists, now) {
  const active = pruneTypists(typists, now);
  const names = active.map((t) => t.name);
  if (names.length === 0) return "";
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  const extra = names.length - 2;
  return `${names[0]}, ${names[1]} and ${extra} ${extra === 1 ? "other" : "others"} are typing…`;
}

/* ── Viewer admin-flag cache (TM-710 / TM-736) ──────────────────────────────────────────────────── */

/**
 * A resettable cache of the viewer's admin flag (TM-736) — drives whether the event-chat composer
 * offers the "Send as announcement" affordance (TM-710). `resolve()` returns the cached flag, or
 * awaits `fetchMe()` once and caches `role === "ADMIN"` (case-insensitive); a fetch failure caches
 * `false` — the affordance simply stays hidden and the server gate remains authoritative.
 *
 * `invalidate()` resets the cache to unresolved. The TM-736 bug was a cache WITHOUT this: chat.js
 * held the flag in a module-level variable resolved once and never reset, so a value captured before
 * the ADMIN claim was live (a boot/auth race), or under a previous signed-in user, stuck for the whole
 * session and the toggle never mounted. The DOM layer now calls invalidate() on every auth change
 * (mirroring appearance-sync.js / nav-avatar.js), so the next resolve re-fetches the CURRENT user.
 *
 * Pure and DOM-free — `fetchMe` is injected, so a plain-Node test can drive both halves.
 * @param {() => Promise<{role?: string}>} fetchMe resolves the caller's /me (api.js getMe in prod).
 * @returns {{resolve: () => Promise<boolean>, invalidate: () => void}}
 */
export function createAdminFlagCache(fetchMe) {
  let cached = null; // null = unresolved; boolean once resolved
  return {
    async resolve() {
      if (cached !== null) return cached;
      try {
        const me = await fetchMe();
        cached = String(me?.role ?? "").toUpperCase() === "ADMIN";
      } catch {
        cached = false; // can't tell → treat as non-admin (the server still gates the endpoint)
      }
      return cached;
    },
    invalidate() {
      cached = null;
    },
  };
}
