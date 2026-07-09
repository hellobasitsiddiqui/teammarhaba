// Notification bell — pure logic core (TM-455).
//
// The header bell's unread BADGE maths, with NO DOM/Firebase imports so it is import-safe in a plain
// Node test (`node --test web/tools/*.test.mjs`, the CI web gate) — the same core/renderer split the
// codebase uses everywhere (tabbar-core.js / notifications-core.js / chat-core.js). The DOM half lives
// in `notification-bell.js`; the styling lives in styles.css.
//
// WHAT THE BADGE COUNTS. The bell shows the caller's TOTAL unread across the two sources the design
// combines (AC): the admin/system notification store (the feed API, TM-454) and chat. The feed API
// returns `{ unseen, unread }` for the admin/system store only (see the backend `NotificationBadge`):
//   • `unseen` — the bell BADGE. It's what opening the bell (mark-seen) clears, so it drops to 0 the
//     moment the panel is viewed. This is the admin/system contribution to the bell count.
//   • `unread` — per-item; survives a mark-seen and only drops as items are individually read. NOT
//     the badge (kept here only for completeness / the future panel).
// The chat-unread half rides the conversation model and is delivered by a sibling ticket; until it is
// wired the bell shows just the admin/system `unseen`, and `badgeTotal` already sums a chat count in
// when a caller passes one — so no rework is needed when it lands.

/** The badge cap (AC + the TM-439 chat-tab-badge clarification): exact up to 9, then "9+". */
export const BADGE_CAP = 9;

/**
 * Coerce anything to a safe, non-negative integer count — junk / negatives / NaN / a fractional
 * value all normalise to a sensible whole count (0 for anything not a positive finite number). Keeps
 * every downstream helper tolerant of a malformed API payload without each having to re-guard.
 * @param {*} value
 * @returns {number}
 */
function safeCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

/**
 * The total unread the bell shows = admin/system `unseen` (the feed-API badge) + chat unread.
 * @param {{unseen?: number, unread?: number}|null|undefined} badge the feed-API `NotificationBadge`.
 * @param {number} [chatUnread=0] the chat-unread count, summed in once the sibling ticket wires it.
 * @returns {number} a non-negative integer.
 */
export function badgeTotal(badge, chatUnread = 0) {
  const unseen = safeCount(badge && badge.unseen);
  return unseen + safeCount(chatUnread);
}

/**
 * The visible chip TEXT for a count: "" at (or below) zero so the chip is hidden, the exact number
 * from 1..cap, then "cap+" above it (default "9+") so a big count never renders a raw multi-digit
 * number in the corner pill.
 * @param {number} count
 * @param {number} [cap=BADGE_CAP]
 * @returns {string}
 */
export function badgeText(count, cap = BADGE_CAP) {
  const n = safeCount(count);
  if (n === 0) return "";
  return n > cap ? `${cap}+` : String(n);
}

/** Whether the count chip should be shown at all (i.e. there is something unread). */
export function hasBadge(count) {
  return safeCount(count) > 0;
}

/**
 * The bell's accessible label. Announces the EXACT (uncapped) count so a screen-reader user hears
 * "12 unread", not the visually-capped "9+" — satisfying the AC's `aria-label` 'N unread'. A zero
 * count reads as a plain "Notifications".
 * @param {number} count
 * @returns {string}
 */
export function bellAriaLabel(count) {
  const n = safeCount(count);
  return n > 0 ? `Notifications, ${n} unread` : "Notifications";
}

/**
 * Whether the bell should be shown for the current session state. The SAME auth/onboarding gate as
 * the bottom tab bar (tabbar-core.js `shouldShowTabbar`): a signed-in, un-gated user only — hidden
 * signed-out and on the onboarding / terms gates (router's `gated` = signedIn && (!onboarded ||
 * needsTerms)), so a gated user can't reach notifications from the header and side-step the gate.
 * Unlike the tab bar the bell also shows on desktop (it's the header, not the mobile-only primary
 * nav) — but that's a CSS concern, not this pure rule.
 * @param {{signedIn?: boolean, gated?: boolean}} state
 * @returns {boolean}
 */
export function shouldShowBell({ signedIn, gated } = {}) {
  return Boolean(signedIn) && !gated;
}
