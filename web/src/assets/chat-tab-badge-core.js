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
// number is sourced from the read API (TM-436): `GET /api/v1/me/conversations` returns a page of
// ConversationSummaryResponse, each carrying a per-thread `unreadCount`. `sumUnread()` adds those up.
// It clears as threads are read because marking a thread read (POST /conversations/{id}/read) lowers
// that thread's `unreadCount`, and the badge re-reads the list on the next refresh (route change /
// poll / foreground-push) — so no local mutation is needed, the server total is the source of truth.
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
 * sum tolerant of a malformed API payload (a missing or non-numeric `unreadCount` on any thread).
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
 * Sums each thread's `unreadCount` from the read API's conversation list (TM-436). Accepts either the
 * raw page envelope (`{ items: [...] }`) or a bare array of summaries, and tolerates a
 * missing/malformed payload (→ 0) so a transient bad response can never throw into the render pass.
 * @param {{items?: Array<{unreadCount?: number}>}|Array<{unreadCount?: number}>|null|undefined} conversations
 * @returns {number} a non-negative integer total.
 */
export function sumUnread(conversations) {
  // Unwrap the shared page envelope ({ items, page, size, ... }) or take a bare array as-is.
  const list = Array.isArray(conversations)
    ? conversations
    : Array.isArray(conversations && conversations.items)
      ? conversations.items
      : [];
  return list.reduce((total, thread) => total + safeCount(thread && thread.unreadCount), 0);
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
