// Notification bell — DOM view (TM-455).
//
// The bell + unread badge in the top-right header, on EVERY screen for a signed-in, onboarded user
// (web + mobile-web + the native WebView). It reads the caller's unread count from the notification
// feed API (GET /api/v1/me/notifications/badge, TM-454), paints a capped "9+" badge, and on click
// marks everything seen (clearing the badge) and opens the notification PANEL — which is TM-456's job,
// so this only wires the OPEN to a seam TM-456 fills; it does NOT build the panel.
//
// Router-driven, like the bottom tab bar (tabbar.js): router.js already computes the single source of
// truth (signedIn / gated / route) each render() and calls `updateNotificationBell()` here, so the
// bell rides that one state machine rather than running a second, drifting auth/route listener. That
// gives the visibility gate AND the "refresh on route change" AC for free (render runs on every
// hashchange + auth change). On top of that we refresh on a gentle poll while visible, and on a
// foreground-push signal — the `tm:notification` window event notification-center.js fires on the
// TM-374 foreground path — so a push that lands while the app is open BUMPS the badge immediately (the
// TM-374 "foreground push missed" fix, now reflected on the primary header bell too).
//
// The static markup (the #nav-notif-bell button + its .tm-notif-badge chip) lives in index.html so it
// inherits the .app-nav quiet-action look and stays in the top-right next to the hamburger when the
// nav collapses on narrow screens; this module owns only its behaviour. All the count/badge maths
// lives in the pure, node-tested notification-bell-core.js. XSS-safe: textContent only, no innerHTML.
//
// Relationship to notification-center.js (TM-374): that is the native-only foreground-push RECOVERY
// bell (a localStorage inbox for pushes received while foregrounded). THIS is the primary, always-on
// header bell backed by the server feed. The two are reconciled by the panel work (TM-456); until
// then the plain web build shows only this bell (push.js is inert there), and on the native shell the
// recovery bell continues to serve its localStorage inbox.

import { getNotificationBadge, markNotificationsSeen } from "./api.js";
import {
  badgeTotal,
  badgeText,
  hasBadge,
  bellAriaLabel,
  shouldShowBell,
  createBadgeSync,
} from "./notification-bell-core.js";

const BELL_ID = "nav-notif-bell";
const BADGE_SELECTOR = ".tm-notif-badge";
const NOTIFICATIONS_ROUTE = "#/notifications";
// Gentle background refresh while the bell is visible — "poll/refresh sensibly" (build hint). Long
// enough to be near-free, short enough that a notification written elsewhere surfaces without a nav.
const POLL_MS = 60000;

let visible = false; // whether the bell is currently shown (signed-in + un-gated)
let pollTimer = null; // the visible-only poll interval handle
let wired = false; // the click + push listeners are attached exactly once

/** The bell button, or null if the markup isn't present / no DOM (defensive — never throw). */
function bellEl() {
  return typeof document !== "undefined" ? document.getElementById(BELL_ID) : null;
}

/**
 * Paint the bell's badge chip + accessible label from a total unread count. The chip is hidden at
 * zero (AC "hidden at zero"), shows the capped "9+" text otherwise, and stays aria-hidden so its
 * text isn't double-announced — the exact count already rides the bell's own aria-label.
 * @param {number} total
 */
function paintCount(total) {
  const bell = bellEl();
  if (!bell) return;
  bell.setAttribute("aria-label", bellAriaLabel(total));
  const chip = bell.querySelector(BADGE_SELECTOR);
  if (!chip) return;
  const show = hasBadge(total);
  chip.hidden = !show;
  chip.textContent = show ? badgeText(total) : "";
}

/** Paint from a feed-API badge payload ({ unseen, unread }). */
function paintBadge(badge) {
  paintCount(badgeTotal(badge));
}

// The async-paint coordinator (TM-556). It owns the dedup + a monotonic epoch guard so a stale
// in-flight refresh (started with the pre-seen count) can't repaint over the freshly-zeroed badge
// after the user opens the bell. The race-safe logic is pure + node-tested in the core; here we just
// inject the real feed-API calls and the DOM paint.
const badgeSync = createBadgeSync({
  fetchBadge: getNotificationBadge,
  markSeen: markNotificationsSeen,
  paint: paintBadge,
  onError: (label, err) => console.warn(`[notif-bell] ${label} failed:`, err?.message ?? err),
});

/**
 * Fetch the latest counts and repaint. Best-effort: a failure (offline, transient 5xx) leaves the
 * last painted count and logs quietly — the bell must never break navigation. Deduped + epoch-guarded
 * by the coordinator so overlapping triggers (a route change mid-poll) don't stack requests and a
 * stale result can't overwrite a fresher one.
 */
async function refresh() {
  if (!visible) return;
  await badgeSync.refresh();
}

/**
 * Open the bell: mark everything seen (which clears the badge), then hand off to the panel. mark-seen
 * returns the refreshed (now zero-unseen) counts, so the badge clears from the response with no
 * follow-up GET; if it fails we still open the panel (reaching notifications matters more than the
 * count). The coordinator supersedes any in-flight refresh first, so a racing pre-seen GET resolving
 * afterwards can't repaint the stale badge (TM-556).
 */
async function open() {
  await badgeSync.markSeenAndPaint();
  openPanel();
}

/**
 * Hand off to the notification PANEL — the ONLY seam TM-456 needs. TM-456 builds the panel and
 * registers `window.tmNotificationPanel` with an `open()`; until then we fall back to the existing
 * grouped notifications screen (#/notifications) so the bell is never a dead end. This deliberately
 * does NOT build any panel UI here.
 */
function openPanel() {
  const panel = typeof window !== "undefined" ? window.tmNotificationPanel : null;
  if (panel && typeof panel.open === "function") {
    panel.open();
    return;
  }
  try {
    if (window.location && window.location.hash !== NOTIFICATIONS_ROUTE) {
      window.location.hash = NOTIFICATIONS_ROUTE;
    }
  } catch (err) {
    console.warn("[notif-bell] could not open notifications:", err?.message ?? err);
  }
}

/**
 * Attach the click handler (the button is static in index.html) and the foreground-push listener,
 * exactly once. Retries on a later call if the DOM wasn't ready the first time.
 */
function wire() {
  if (wired) return;
  const bell = bellEl();
  if (!bell) return; // markup not parsed yet — try again on the next updateNotificationBell()
  bell.addEventListener("click", open);
  // A foreground push (TM-374) dispatches this window event; refresh so the badge bumps while open.
  if (typeof window !== "undefined") {
    window.addEventListener("tm:notification", refresh);
  }
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
 * Reflect the current session state onto the bell — called by router.js's render() (the single
 * source of truth). Handles visibility (the auth/onboarding/terms gate), the first-visible fetch,
 * the on-route-change refresh, and stopping the poll + clearing a stale count on sign-out/re-gate.
 * @param {{signedIn?: boolean, gated?: boolean}} state
 */
export function updateNotificationBell({ signedIn, gated } = {}) {
  wire();
  const bell = bellEl();
  if (!bell) return;

  const show = shouldShowBell({ signedIn, gated });
  bell.hidden = !show;

  if (show && !visible) {
    // Just became visible (sign-in / onboarding cleared): reveal, fetch the count, start polling.
    visible = true;
    refresh();
    startPoll();
  } else if (show) {
    // Still visible on a route change — refresh (the "refresh on route change" AC).
    refresh();
  } else if (visible) {
    // Signed out / re-gated: stop polling, supersede any in-flight refresh (so its result is dropped
    // rather than repainting after we clear), and clear the count so a stale badge can't flash.
    visible = false;
    stopPoll();
    badgeSync.supersede();
    paintCount(0);
  }
}

// Debug/QA seam (mirrors window.tmNotifications): drive a refresh / open without a real send.
if (typeof window !== "undefined") {
  window.tmNotificationBell = { refresh, open, update: updateNotificationBell };
}
