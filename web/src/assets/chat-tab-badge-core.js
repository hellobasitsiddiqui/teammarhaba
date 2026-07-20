// Chat-tab unread badge — pure logic core (TM-439).
//
// The framework-free web SPA is the single source for all four surfaces (web / mobile-web / Android
// WebView / iOS WebView). Following the codebase's established core/renderer split (tabbar-core.js,
// notification-bell-core.js, chat-core.js — see AGENTIC-LESSONS "extract the pure logic to test it"),
// this module holds ONLY the pure count + label rules the bottom-nav Chat-tab badge needs, with NO
// DOM / Firebase / Capacitor imports, so it is import-safe in a plain Node test
// (`node --test web/tools/*.test.mjs`, the CI web gate). The DOM-mounting half lives in
// `chat-tab-badge.js`; the badge chip markup (`#tab-chat-badge`) + its styling (`.app-tab-badge`) are
// the TM-434 seam already in `index.html` + `styles.css` — this ticket only fills the count.
//
// WHAT THE BADGE COUNTS. The Chat tab shows the caller's TOTAL unread across all their threads. The
// number is the server-authoritative aggregate from `GET /api/v1/me/conversations/unread-total`
// (TM-582), which returns `{ total }` summed over EVERY one of the caller's non-removed threads.
// `unreadTotalOf()` just reads that `total` safely. This replaces the earlier approach of summing the
// paged conversation LIST's per-thread `unreadCount`, which only ever saw the first page and so
// UNDERCOUNTED a caller with more than one page of threads (the TM-439 badge gap this ticket closes).
// It clears as threads are read because marking a thread read (POST /conversations/{id}/read) lowers
// that thread's unread on the server, and the badge re-reads the total on the next refresh (poll /
// foreground-push / a route change that doesn't race the mark-read). The server total stays the source
// of truth; on the SAME open that marks a thread read, the DOM half also applies a clamped OPTIMISTIC
// decrement (decrementUnreadTotal) so the badge drops immediately rather than waiting for that POST to
// commit + the next poll — the TM-585 GET/POST race — then reconciles against the server total.
//
// The visible chip TEXT (capped "9+") + the show/hide gate are the SAME badge primitive the header
// notification bell uses, so the two badges cap identically (the TM-439 clarification the bell core's
// BADGE_CAP doc-comment already anticipates). We reuse `badgeText` / `hasBadge` / `BADGE_CAP` from
// notification-bell-core.js rather than re-implement the "exact up to 9, then 9+" rule twice, and
// re-export them so the DOM half + the tests import the whole Chat-tab-badge surface from here.

import { badgeText, hasBadge, BADGE_CAP } from "./notification-bell-core.js";

// Re-export the shared pill primitive so `chat-tab-badge.js` and the tests have one import surface.
export { badgeText, hasBadge, BADGE_CAP };

/**
 * Coerce anything to a safe, non-negative integer count — junk / negatives / NaN / a fractional value
 * all normalise to a sensible whole count (0 for anything not a positive finite number). Keeps the
 * badge tolerant of a malformed API payload (a missing or non-numeric `total`).
 * @param {*} value
 * @returns {number}
 */
function safeCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

/**
 * The caller's total unread across all their conversations — the number the Chat-tab badge shows.
 * Reads the `total` field from the aggregate endpoint's `{ total }` response (`GET
 * /api/v1/me/conversations/unread-total`, TM-582), which the server computes over EVERY one of the
 * caller's threads (so it's correct past the first page, unlike the old list-sum). Tolerates a
 * missing/malformed payload (→ 0) so a transient bad response can never throw into the render pass.
 * @param {{total?: number}|null|undefined} payload the unread-total response envelope.
 * @returns {number} a non-negative integer total.
 */
export function unreadTotalOf(payload) {
  return safeCount(payload && payload.total);
}

/**
 * Optimistically lower the painted tab total by a just-opened thread's own unread, clamped at zero
 * (TM-585). Opening a thread marks it read (POST /conversations/{id}/read) — but the router's concurrent
 * unread-total GET usually resolves BEFORE that POST commits, so it re-reads the PRE-mark total and the
 * badge doesn't drop on that navigation (it self-heals only on the next 60s poll). Subtracting the
 * thread's cached unread from the current total lets the badge drop straight away, before the round-trip.
 * Both inputs are coerced to safe non-negative integers and the result is floored at 0, so a stale /
 * duplicate open (a thread already counted as read) can never push the total negative — the AC's "no
 * negative total under repeated open/close". The server aggregate (`unread-total`) still reconciles the
 * badge on the next refresh, so any local drift self-corrects (no double-count over time).
 * @param {number} total the currently-painted tab total.
 * @param {number} threadUnread the opened thread's cached unread (its per-row badge count).
 * @returns {number} the new non-negative total.
 */
export function decrementUnreadTotal(total, threadUnread) {
  return Math.max(0, safeCount(total) - safeCount(threadUnread));
}

/**
 * The just-loaded thread's own unread, read from the mark-read POST's MarkReadResponse (TM-855). Opening
 * a thread POSTs `/conversations/{id}/read`, which returns `{ conversationId, lastReadAt, unreadCount }`
 * where `unreadCount` is the thread's server-authoritative unread AT THE MOMENT it was marked read (the
 * PRE-mark count — the endpoint is idempotent, so a second open returns 0). This is the FETCHED-THREAD
 * source the deep-link path needs: on a push / notification-center open the paged conversation LIST was
 * never rendered, so the `state.rows` cache is empty and the list-row unread is 0 — the optimistic drop
 * would no-op and the badge would linger (TM-855). Tolerates a missing/malformed response (→ 0) so a
 * fire-and-forget mark-read that returns junk never throws into the drop.
 * @param {{unreadCount?: number}|null|undefined} markReadResponse the MarkReadResponse envelope.
 * @returns {number} a non-negative integer — the thread's pre-mark unread.
 */
export function markReadThreadUnread(markReadResponse) {
  return safeCount(markReadResponse && markReadResponse.unreadCount);
}

/**
 * The ADDITIONAL unread to drop from the tab total once a thread's mark-read POST resolves (TM-855),
 * over and above whatever the on-open optimistic decrement already dropped from the `state.rows` cache.
 *
 * The on-open drop subtracts the thread's CACHED list-row unread (`cachedUnread`). On the list-tap path
 * that cache is warm and already correct, so the POST's authoritative `unreadCount` equals what we
 * dropped and there is nothing left to do (→ 0 — no double-drop). On the DEEP-LINK path the list was
 * never loaded, so `cachedUnread` is 0 and the on-open drop no-op'd; the POST's `unreadCount` is then
 * the real unread this returns so the caller can drop it (belatedly but before the 60s poll). Computed
 * as `authoritative − alreadyDropped`, clamped at zero, so it can only ever TOP UP the drop, never add
 * back or over-subtract. The server aggregate (`unread-total`) still reconciles afterward regardless.
 * @param {number} cachedUnread the list-row unread already dropped optimistically on open (0 on deep-link).
 * @param {{unreadCount?: number}|null|undefined} markReadResponse the MarkReadResponse envelope.
 * @returns {number} the extra unread to drop now (0 when the on-open drop already covered it).
 */
export function deepLinkUnreadTopUp(cachedUnread, markReadResponse) {
  return Math.max(0, markReadThreadUnread(markReadResponse) - safeCount(cachedUnread));
}

/**
 * The Chat tab's accessible label. The tab already has a visible "Chat" text label, so at zero unread
 * we return just "Chat" (let the natural label stand — the DOM half removes the aria-label override);
 * when there IS unread we announce the EXACT (uncapped) count — "Chat, 12 unread" — so a screen-reader
 * user hears the true number, not the visually-capped "9+" (satisfies the AC `aria-label` "N unread").
 * @param {number} count
 * @returns {string}
 */
export function chatTabAriaLabel(count) {
  const n = safeCount(count);
  return n > 0 ? `Chat, ${n} unread` : "Chat";
}
