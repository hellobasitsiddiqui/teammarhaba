// Chat-tab unread badge — DOM view (TM-439).
//
// The unread-count pill over the bottom-nav Chat tab, for a signed-in, onboarded user on the mobile
// primary nav (the CSS breakpoint keeps the whole tab bar mobile-only). It reads the caller's total
// unread from the server-authoritative aggregate endpoint (`GET /api/v1/me/conversations/unread-total`,
// TM-582), which returns `{ total }` over ALL the caller's threads (the pure `unreadTotalOf` reads that
// field), and paints a capped "9+" chip onto the `#tab-chat-badge` seam TM-434 left in index.html —
// with NO nav rework (the markup + `.app-tab-badge` styling already exist). It used to SUM the first
// page of the paged conversation list, which undercounted past one page — the TM-439 gap TM-582 closes.
//
// Router-driven, exactly like the bottom tab bar (tabbar.js) and the header notification bell
// (notification-bell.js): router.js already computes the single source of truth (signedIn / gated /
// route) on every render() and calls `updateChatTabBadge()` here, so this badge rides that one state
// machine instead of running a second, drifting auth/route listener:
//   • "refreshes on route change" — render() runs on every hashchange, so navigating anywhere re-reads
//     the server total and the count reflects any threads read elsewhere.
//   • "clears as threads are read" — the server total is the source of truth. BUT the route-change
//     refresh alone does NOT reliably drop the badge on the SAME navigation that opens a thread: opening
//     `#/chat/{id}` fires the mark-read POST and this GET concurrently, and the GET usually resolves
//     BEFORE the POST commits, so it re-reads the PRE-mark total (the TM-585 GET/POST race — the drop
//     used to self-heal only on the next 60s poll). So chat.js drives the drop explicitly on open:
//     `noteThreadRead()` decrements this total optimistically the moment a thread is read, and
//     `refreshChatTabBadge()` reconciles with the authoritative server total once the POST has committed.
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

import { getConversationsUnreadTotal } from "./api.js";
import { shouldShowTabbar } from "./tabbar-core.js";
import { unreadTotalOf, decrementUnreadTotal, chatTabAriaLabel, badgeText, hasBadge } from "./chat-tab-badge-core.js";

const TAB_ID = "tab-chat"; // the Chat tab <a> — carries the aria-label announcing the count
const BADGE_ID = "tab-chat-badge"; // the .app-tab-badge chip seam inside it (TM-434)
// Gentle background refresh while the badge is active — long enough to be near-free, short enough that
// a message written to a thread elsewhere surfaces without a manual nav. Mirrors the bell's cadence.
const POLL_MS = 60000;

let active = false; // whether the badge is currently live (signed-in + un-gated)
let inFlight = false; // a conversations GET is running — dedupe overlapping refreshes
let epoch = 0; // monotonic generation, bumped on sign-out so a late in-flight result is dropped
let pollTimer = null; // the active-only poll interval handle
let wired = false; // the foreground-push listener is attached exactly once
let painted = 0; // the last total we painted — the base the optimistic mark-read decrement subtracts from (TM-585)
let readMark = 0; // bumped on each optimistic mark-read so a stale in-flight (pre-mark) GET can't raise the count back

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
  painted = total; // remember what we last showed so an optimistic mark-read can decrement from it (TM-585)
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
 * Fetch the caller's aggregate unread total (TM-582) and repaint. Deduped (one GET at a time) and
 * epoch-guarded: if a sign-out/re-gate bumps the epoch (or clears `active`) while this GET is in
 * flight, its result is dropped rather than repainting a stale count after we've cleared. Never
 * throws — a failure leaves the last painted count and logs quietly.
 */
async function refresh() {
  if (!active || inFlight) return;
  inFlight = true;
  const gen = epoch;
  const readGen = readMark; // TM-585: snapshot the mark-read generation before the GET goes out
  try {
    const payload = await getConversationsUnreadTotal();
    // Paint only if still current (not signed-out) AND no thread was marked read while this GET was in
    // flight — a mark-read that raced this fetch means its total predates the mark (the GET/POST race),
    // so dropping it here avoids re-raising the count the optimistic decrement just dropped (TM-585).
    if (gen === epoch && active && readGen === readMark) paintCount(unreadTotalOf(payload));
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

/**
 * Optimistically drop the Chat-tab badge when a thread is opened + marked read (TM-585), BEFORE the
 * mark-read POST commits. chat.js's markThreadRead calls this with the thread's cached unread; we
 * subtract it from the painted total (clamped at zero) and repaint straight away, and bump `readMark`
 * so the router's concurrent unread-total GET — which read the PRE-mark server total (the GET/POST
 * race this fixes) — can't raise the count back when it resolves. The POST-resolve reconcile
 * ({@link refreshChatTabBadge}) then re-reads the authoritative server total. A no-op when the badge
 * isn't active (signed-out / gated), so it's always safe to call.
 * @param {number} threadUnread the opened thread's cached unread (its per-row badge count).
 */
export function noteThreadRead(threadUnread) {
  if (!active) return;
  readMark += 1; // invalidate any in-flight pre-mark GET before we drop the count
  paintCount(decrementUnreadTotal(painted, threadUnread));
}

/**
 * Reconcile the Chat-tab badge with the authoritative server unread-total (TM-585). Called by chat.js
 * once a thread's mark-read POST has COMMITTED, so this GET now reflects the lowered total (unlike the
 * router's concurrent pre-mark GET). Delegates to the shared, deduped, epoch-guarded {@link refresh}.
 */
export function refreshChatTabBadge() {
  refresh();
}

// Debug/QA seam (mirrors window.tmNotificationBell): drive a refresh / update without a real message.
if (typeof window !== "undefined") {
  window.tmChatTabBadge = { refresh, update: updateChatTabBadge, noteThreadRead, refreshChatTabBadge };
}
