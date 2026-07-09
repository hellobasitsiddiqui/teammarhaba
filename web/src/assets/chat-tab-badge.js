// Chat-tab unread badge — DOM view (TM-439).
//
// The unread-count pill over the bottom-nav Chat tab, for a signed-in, onboarded user on the mobile
// primary nav (the CSS breakpoint keeps the whole tab bar mobile-only). It reads the caller's total
// unread from the read API (`GET /api/v1/me/conversations`, TM-436) by SUMMING each thread's
// `unreadCount` (the pure `sumUnread`), and paints a capped "9+" chip onto the `#tab-chat-badge` seam
// TM-434 left in index.html — with NO nav rework (the markup + `.app-tab-badge` styling already exist).
//
// Router-driven, exactly like the bottom tab bar (tabbar.js) and the header notification bell
// (notification-bell.js): router.js already computes the single source of truth (signedIn / gated /
// route) on every render() and calls `updateChatTabBadge()` here, so this badge rides that one state
// machine instead of running a second, drifting auth/route listener. That gives two ACs for free:
//   • "refreshes on route change" — render() runs on every hashchange, so navigating anywhere (and in
//     particular INTO a thread `#/chat/{id}`, which marks it read) re-reads the list and the count drops.
//   • "clears as threads are read" — the server total is the source of truth; a mark-read lowers that
//     thread's unreadCount, and the very next refresh reflects it. No local mutation to keep in sync.
// On top of that we refresh on a gentle poll while visible (a message arriving elsewhere surfaces
// without a nav) and on a foreground-push signal (the `tm:notification` window event notification-
// center.js fires on the TM-374 foreground path) so a chat push that lands while the app is open bumps
// the badge immediately ("refreshes on push receipt").
//
// The visibility gate is the SAME `shouldShowTabbar` rule the bar itself uses (signed-in + un-gated),
// so the count is only fetched when the bar can be shown. All the count/label maths lives in the pure,
// node-tested chat-tab-badge-core.js. XSS-safe: textContent only, never innerHTML. Best-effort — a
// failed fetch (offline / transient 5xx) leaves the last painted count and logs quietly; the badge
// must never break navigation.

import { listMyConversations } from "./api.js";
import { shouldShowTabbar } from "./tabbar-core.js";
import { sumUnread, chatTabAriaLabel, badgeText, hasBadge } from "./chat-tab-badge-core.js";

const TAB_ID = "tab-chat"; // the Chat tab <a> — carries the aria-label announcing the count
const BADGE_ID = "tab-chat-badge"; // the .app-tab-badge chip seam inside it (TM-434)
// Fetch a single generous page: the badge only needs a total and caps at "9+", so summing the first
// page of the caller's conversations is ample (nobody is in enough active group chats to matter, and
// even if they were, the visible cap makes an exact >page total irrelevant). Trade-off noted on the PR.
const PAGE_SIZE = 100;
// Gentle background refresh while the badge is active — long enough to be near-free, short enough that
// a message written to a thread elsewhere surfaces without a manual nav. Mirrors the bell's cadence.
const POLL_MS = 60000;

let active = false; // whether the badge is currently live (signed-in + un-gated)
let inFlight = false; // a conversations GET is running — dedupe overlapping refreshes
let epoch = 0; // monotonic generation, bumped on sign-out so a late in-flight result is dropped
let pollTimer = null; // the active-only poll interval handle
let wired = false; // the foreground-push listener is attached exactly once

/** The Chat tab <a>, or null if the markup isn't present / no DOM (defensive — never throw). */
function tabEl() {
  return typeof document !== "undefined" ? document.getElementById(TAB_ID) : null;
}

/** The badge chip inside the Chat tab, or null (defensive). */
function badgeEl() {
  return typeof document !== "undefined" ? document.getElementById(BADGE_ID) : null;
}

/**
 * Paint the badge chip + the tab's accessible label from a total unread count. The chip is hidden at
 * zero (AC "hidden at zero"), shows the capped "9+" text otherwise, and stays aria-hidden so its text
 * isn't double-announced — the exact count already rides the tab's aria-label. At zero we REMOVE the
 * aria-label so the tab's natural visible "Chat" label stands (no redundant override).
 * @param {number} total
 */
function paintCount(total) {
  const chip = badgeEl();
  if (chip) {
    const show = hasBadge(total);
    chip.hidden = !show;
    chip.textContent = show ? badgeText(total) : "";
  }
  const tab = tabEl();
  if (tab) {
    if (hasBadge(total)) tab.setAttribute("aria-label", chatTabAriaLabel(total));
    else tab.removeAttribute("aria-label");
  }
}

/**
 * Fetch the latest conversations, sum the unread, and repaint. Deduped (one GET at a time) and
 * epoch-guarded: if a sign-out/re-gate bumps the epoch (or clears `active`) while this GET is in
 * flight, its result is dropped rather than repainting a stale count after we've cleared. Never
 * throws — a failure leaves the last painted count and logs quietly.
 */
async function refresh() {
  if (!active || inFlight) return;
  inFlight = true;
  const gen = epoch;
  try {
    const page = await listMyConversations({ size: PAGE_SIZE });
    if (gen === epoch && active) paintCount(sumUnread(page)); // still current → paint; else drop
  } catch (err) {
    console.warn("[chat-tab-badge] refresh failed:", err?.message ?? err);
  } finally {
    if (gen === epoch) inFlight = false; // don't stomp a newer owner if a supersede happened mid-fetch
  }
}

/** Attach the foreground-push listener exactly once (retries if the DOM/window wasn't ready). */
function wire() {
  if (wired || typeof window === "undefined") return;
  // A foreground push (TM-374) dispatches this window event; refresh so the badge bumps while open.
  window.addEventListener("tm:notification", refresh);
  wired = true;
}

function startPoll() {
  if (pollTimer || typeof window === "undefined") return;
  pollTimer = window.setInterval(refresh, POLL_MS);
}

function stopPoll() {
  if (pollTimer && typeof window !== "undefined") window.clearInterval(pollTimer);
  pollTimer = null;
}

/**
 * Reflect the current session state onto the Chat-tab badge — called by router.js's render() (the
 * single source of truth). Handles activation (the auth/onboarding/terms gate), the first fetch, the
 * on-route-change refresh, and stopping the poll + clearing a stale count on sign-out/re-gate. Same
 * `shouldShowTabbar` gate as the bar, so the count is only fetched when the bar can be shown.
 * @param {{signedIn?: boolean, gated?: boolean}} state
 */
export function updateChatTabBadge({ signedIn, gated } = {}) {
  wire();

  const show = shouldShowTabbar({ signedIn, gated });
  if (show && !active) {
    // Just became eligible (sign-in / onboarding cleared): fetch the count and start polling.
    active = true;
    refresh();
    startPoll();
  } else if (show) {
    // Still eligible on a route change — refresh (the "refresh on route change" AC; also clears the
    // count moments after navigating into a thread marks it read).
    refresh();
  } else if (active) {
    // Signed out / re-gated: stop polling, bump the epoch so any in-flight refresh's result is dropped
    // rather than repainting after we clear, and clear the count so a stale badge can't flash.
    active = false;
    stopPoll();
    epoch += 1;
    inFlight = false;
    paintCount(0);
  }
}

// Debug/QA seam (mirrors window.tmNotificationBell): drive a refresh / update without a real message.
if (typeof window !== "undefined") {
  window.tmChatTabBadge = { refresh, update: updateChatTabBadge };
}
