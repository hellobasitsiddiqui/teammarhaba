// Foreground-push notification centre (TM-374) — the DOM-mounting half.
//
// THE BUG. A push arriving while the app is FOREGROUND never reaches the Android system tray —
// Capacitor hands it to push.js's `pushNotificationReceived` listener instead, which (pre-TM-374)
// showed a transient toast that auto-dismissed in seconds. Delivered ≠ seen: the reporter missed
// his own broadcast. Background/closed-app deliveries still post a real tray notification — that
// native path is untouched by this module.
//
// THE FIX — three layers, all built from the existing UX kit so there's no new visual language:
//   1. PERSISTENT CARD: the foreground push renders as a ui.js toast card with `timeout: 0`, so it
//      STAYS until explicitly dismissed (×) or its "View" action is tapped (View deep-links to the
//      push's route — exactly the behaviour the old transient toast's action had). Multiple pushes
//      stack in the existing #tm-toasts host, which already handles safe-area insets + theming.
//   2. INBOX: every foreground push is recorded in a small localStorage-backed list (last 20, see
//      notification-inbox.js — the pure, node-tested core), so a push that got no interaction
//      (e.g. app killed while the card was up) is STILL recoverable on the next launch.
//   3. UNREAD BADGE: a bell button in the nav shows the unread count. It is only mounted once the
//      device has ever received a foreground push, so the plain web build (where push.js is inert)
//      renders exactly as before. Tapping the bell opens the inbox in the existing ui.js modal;
//      opening it marks everything read.
//
// READ SEMANTICS (documented decision): an entry counts as SEEN when the user interacts with it —
// View-tapped, ×-dismissed (the text was on screen and they acted on it), or the inbox was opened.
// An entry with NO interaction (app quit/reloaded while its card was up) stays unread, which is
// precisely the "missed it" case the badge exists to recover.
//
// Theme-safe: ui.js primitives + theme tokens only (see the TM-374 block in styles.css), so clean /
// doodle / sketch all render it natively. XSS-safe: only textContent via el(), never innerHTML.
// Storage-safe: localStorage access is guarded — private mode / quota just makes the inbox
// session-only, it never breaks push handling.

import { el, modal, relativeTime, toast } from "./ui.js";
import {
  addEntry,
  bannerMessage,
  entryFromNotification,
  loadEntries,
  markAllRead,
  markRead,
  saveEntries,
  unreadCount,
} from "./notification-inbox.js";

const BELL_ID = "tm-notif-bell";

// The in-memory inbox (newest first), hydrated from localStorage on init. The pure module owns all
// list transforms; this module just holds the current value and repaints.
let entries = [];

/** localStorage, or null when unavailable (Safari private mode can throw on ACCESS). */
function storage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Best-effort persist of the current inbox (failure = session-only inbox, by design). */
function persist() {
  saveEntries(entries, storage());
}

/**
 * Navigate the hash router to `route` — same single-line contract as push.js's navigateTo: setting
 * the hash re-runs the router's full auth/onboarding/admin guard, and routes only ever come out of
 * push-deeplink's allow-list (enforced again on load by notification-inbox's sanitiser).
 * @param {string} route a safe in-app hash route (e.g. "#/home").
 */
function navigateTo(route) {
  try {
    if (window.location && window.location.hash !== route) {
      window.location.hash = route;
    }
  } catch (err) {
    console.warn("[notif] could not navigate to notification route:", err?.message ?? err);
  }
}

/**
 * The nav bell button, created on demand as a DIRECT child of the account nav (not inside
 * #nav-items) so it stays visible next to the hamburger when the nav collapses on narrow screens —
 * where the native shell (the only surface that gets foreground pushes) always is. Self-mounting
 * like ui.js's toastHost / verify-banner's host, so index.html needs no changes; router.js never
 * touches it (it only manages its own known ids).
 * @param {boolean} create whether to create the bell if it doesn't exist yet.
 * @returns {?HTMLElement}
 */
function bellHost(create) {
  let bell = document.getElementById(BELL_ID);
  if (bell || !create) return bell;
  const nav = document.querySelector("nav.app-nav");
  if (!nav) return null;
  bell = el(
    "button",
    { id: BELL_ID, class: "tm-notif-bell", type: "button", "aria-label": "Notifications", onClick: openInbox },
    [
      el("span", { class: "tm-notif-bell-icon", "aria-hidden": "true", text: "🔔" }),
      el("span", { class: "tm-notif-badge", hidden: true }),
    ],
  );
  nav.append(bell);
  return bell;
}

/**
 * Reconcile the bell + unread badge with the current inbox. The bell only exists once the inbox
 * has ever had an entry (so the web build stays untouched); the count chip only shows when
 * something is unread. Also mirrors the count into the accessible label.
 */
function paintBadge() {
  if (typeof document === "undefined") return;
  const bell = bellHost(entries.length > 0);
  if (!bell) return;
  bell.hidden = entries.length === 0;
  const count = unreadCount(entries);
  bell.setAttribute("aria-label", count > 0 ? `Notifications (${count} unread)` : "Notifications");
  const chip = bell.querySelector(".tm-notif-badge");
  if (chip) {
    chip.hidden = count === 0;
    chip.textContent = count > 9 ? "9+" : String(count);
  }
}

/** Mark one entry read (banner dismissed / View tapped) and repaint + persist. */
function setRead(id) {
  entries = markRead(entries, id);
  persist();
  paintBadge();
}

/**
 * One inbox row: title, optional body, relative time. Unread rows carry the same accent side-stripe
 * the toasts/banners use. A row whose entry has a route is a real button — tapping it closes the
 * inbox and deep-links, the same behaviour as the banner's View action; route-less rows are static.
 * @param {object} entry the inbox entry (read state as it was when the inbox was OPENED).
 * @param {Function} close closes the hosting modal.
 * @returns {HTMLElement}
 */
function inboxRow(entry, close) {
  const when = relativeTime(new Date(entry.receivedAt));
  const children = [
    el("span", { class: "tm-notif-item-title", text: entry.title }),
    entry.body ? el("span", { class: "tm-notif-item-body", text: entry.body }) : null,
    el("span", { class: "tm-notif-item-time", text: when.text, title: when.title }),
  ];
  const cls = `tm-notif-item${entry.read ? "" : " tm-notif-item-unread"}`;
  if (entry.route) {
    return el(
      "button",
      {
        class: cls,
        type: "button",
        onClick: () => {
          close();
          navigateTo(entry.route);
        },
      },
      children,
    );
  }
  return el("div", { class: cls }, children);
}

/**
 * Open the recent-notifications inbox in the existing ui.js modal. Rows are built from the
 * pre-open read state (so just-unread items still show their stripe), then everything is marked
 * read — opening the inbox IS seeing it, which clears the badge.
 */
function openInbox() {
  const snapshot = entries;
  const { close } = modal(
    "Notifications",
    el(
      "div",
      { class: "tm-notif-list" },
      snapshot.length
        ? snapshot.map((entry) => inboxRow(entry, () => close()))
        : [el("p", { class: "tm-notif-empty", text: "No notifications yet." })],
    ),
  );
  entries = markAllRead(entries);
  if (entries !== snapshot) persist();
  paintBadge();
}

/**
 * Record + surface a FOREGROUND push. Called by push.js's `pushNotificationReceived` listener (so
 * only ever fires inside the native shell). Stores the entry (deduped — a duplicated delivery is
 * neither re-stored nor re-shown), updates the bell, and shows the PERSISTENT card: a ui.js toast
 * with `timeout: 0`, which stays until the user dismisses it (×) or taps View (deep-link to the
 * push's route — identical to the old transient toast's action). Either interaction marks the
 * entry read; no interaction leaves it unread for the badge to surface later.
 * @param {object|null|undefined} notification the Capacitor notification.
 */
export function notifyForegroundPush(notification) {
  const entry = entryFromNotification(notification);
  const { entries: next, added } = addEntry(entries, entry);
  if (!added) return; // duplicated delivery — already stored and already on screen.
  entries = next;
  persist();
  paintBadge();
  toast(bannerMessage(entry), {
    type: "info",
    timeout: 0, // persistent — the whole point of TM-374; never auto-dismisses.
    action: entry.route
      ? {
          label: "View",
          onClick: () => {
            setRead(entry.id);
            navigateTo(entry.route);
          },
        }
      : null,
    onDismiss: () => setRead(entry.id),
  });
}

/**
 * Hydrate the inbox from localStorage and paint the bell/badge, so a push missed in a PREVIOUS
 * session is surfaced on this one. Inert on the plain web build: push.js never records anything
 * there, so the store stays empty and no bell is ever mounted. Runs at import (push.js imports
 * this module); exported for tests/manual refresh.
 * @returns {boolean} whether a document existed to (potentially) mount into.
 */
export function initNotificationCenter() {
  if (typeof document === "undefined") return false;
  entries = loadEntries(storage());
  paintBadge();
  return true;
}

initNotificationCenter();

// Debug/QA seam (mirrors window.tmVerifyBanner): lets emulator QA drive the flow without a real
// FCM send — e.g. `tmNotifications.record({ title: "Test", data: { route: "#/home" } })` — and
// TM-380 screenshot runs open the inbox directly.
if (typeof window !== "undefined") {
  window.tmNotifications = { record: notifyForegroundPush, open: openInbox, refresh: initNotificationCenter };
}
