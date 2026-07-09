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
// that thread's unread on the server, and the badge re-reads the total on the next refresh (route
// change / poll / foreground-push) — no local mutation needed, the server total is the source of truth.
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
