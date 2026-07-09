// Notification panel — DOM view (TM-456).
//
// The bell-opened notification PANEL. TM-455's header bell marks everything seen then hands off to
// `window.tmNotificationPanel.open()` — the seam it deliberately left for this ticket (falling back to
// the #/notifications screen until this module registers). This is that panel: a Paper-themed dropdown
// from the bell listing the caller's notifications from the feed API (GET /api/v1/me/notifications,
// TM-454), in the two kinds the design splits (AC):
//   • CHAT groups — one row per event thread ("3 new in Coffee & Code" + latest preview); tapping opens
//     the thread (#/chat/{id}) and marks the group's notifications read, so the group clears once read.
//   • ADMIN + SYSTEM items — ungrouped, each a per-type icon + title/body + timestamp; tapping deep-links
//     (a TM-285-safe route) and marks that one item read (POST .../{id}/read).
//
// All the classification / grouping / safe-route logic lives in the pure, node-tested
// notification-panel-core.js; this module is the thin DOM shell + network glue. It self-registers on
// import (index.html loads it as a module script), so the bell's open-seam is filled without the bell
// or router.js importing it — the two stay decoupled through the `window.tmNotificationPanel` global,
// exactly as TM-455 designed.
//
// Themed: theme tokens + the `.tm-wobble` hand-drawn edge only, so clean/sketch (the surviving Paper
// axes, TM-529) both render it natively — no hard-coded colours. XSS-safe: every node via ui.js `el()`
// (textContent only, never innerHTML). Distinct from the full-screen #/notifications feed
// (notifications.js) and the native foreground-push inbox (notification-center.js).

import { clear, el, relativeTime } from "./ui.js";
import { unreadDot } from "./components.js";
import { lineIcon } from "./icons.js";
import { listNotifications, markNotificationRead } from "./api.js";
import { buildPanel, chatGroupLabel, CHAT_GROUP } from "./notification-panel-core.js";

const PANEL_ID = "tm-notif-panel";
const BACKDROP_ID = "tm-notif-panel-backdrop";

// The current overlay backdrop element while the panel is open (null when closed), the element to
// restore focus to on close (the bell that opened us), and a monotonically increasing request token so
// a slow in-flight load can't paint over a newer one / a closed panel.
let backdrop = null;
let restoreFocusTo = null;
let loadToken = 0;

/** The panel's scrollable body element, or null when the panel isn't mounted. */
function bodyEl() {
  return typeof document !== "undefined" ? document.getElementById(`${PANEL_ID}-body`) : null;
}

/**
 * Navigate the hash router to `route` — the same one-line contract push.js / notification-center.js
 * use: setting the hash re-runs the router's full auth/onboarding guard, and `route` has already been
 * through the core's `safeRoute` allow-list, so this can only ever go to a known in-app view.
 * @param {string} route a safe in-app hash route (e.g. "#/chat/42").
 */
function navigateTo(route) {
  try {
    if (window.location && window.location.hash !== route) {
      window.location.hash = route;
    }
  } catch (err) {
    console.warn("[notif-panel] could not navigate:", err?.message ?? err);
  }
}

/**
 * Mark a set of notification ids read — best-effort and fire-and-forget. The mark-read endpoint is
 * one-way + idempotent, so re-marking is harmless; a failure (offline, transient 5xx) is swallowed
 * because the panel re-fetches fresh state on its next open anyway, and reaching the target screen
 * matters more than the read flag. `ids` is filtered to the ones actually present.
 * @param {Array<number|string>} ids
 */
function markRead(ids) {
  const list = Array.isArray(ids) ? ids.filter((id) => id != null) : [];
  for (const id of list) {
    Promise.resolve(markNotificationRead(id)).catch((err) => {
      console.warn("[notif-panel] mark-read failed for", id, err?.message ?? err);
    });
  }
}

/** A themed icon circle holding the named line-icon (falls back to the bell so it's never empty). */
function iconCircle(name) {
  return el("span", { class: "tm-np-icon", "aria-hidden": "true" }, [
    lineIcon(name, { size: 18 }) || lineIcon("spot", { size: 18 }),
  ]);
}

/**
 * One CHAT group row: a button that opens the event thread. Shows the unread/read dot, the chat
 * glyph, the "{n} new in {title}" label + latest preview, a relative timestamp, and — while unread — a
 * count chip. Tapping marks the group's unread members read and deep-links to the thread.
 * @param {object} group a CHAT_GROUP section from buildPanel().
 * @returns {HTMLElement}
 */
function chatGroupRow(group) {
  const when = relativeTime(group.createdAt);
  return el(
    "button",
    {
      class: `tm-np-row${group.read ? "" : " tm-np-row--unread"}`,
      type: "button",
      "data-testid": "notif-panel-chat-group",
      dataset: { kind: "chat", read: group.read ? "true" : "false" },
      onClick: () => onTapGroup(group),
    },
    [
      unreadDot(group.read),
      iconCircle(group.icon),
      el("span", { class: "tm-np-text" }, [
        el("span", { class: "tm-np-title", text: chatGroupLabel(group) }),
        group.preview ? el("span", { class: "tm-np-body", text: group.preview }) : null,
        el("span", { class: "tm-np-time", text: when.text, title: when.title }),
      ]),
      group.unread > 0
        ? el("span", { class: "tm-np-count", "aria-hidden": "true", text: group.unread > 9 ? "9+" : String(group.unread) })
        : null,
    ],
  );
}

/**
 * One ungrouped ADMIN/SYSTEM item row. A row with a safe deep-link is a real button (tap = mark-read +
 * navigate); a route-less row is still a button so tapping it marks it read (interaction = seen), it
 * just doesn't navigate. Shows the unread/read dot, the per-type icon, title/body and timestamp.
 * @param {object} item an ITEM section from buildPanel().
 * @returns {HTMLElement}
 */
function itemRow(item) {
  const when = relativeTime(item.createdAt);
  return el(
    "button",
    {
      class: `tm-np-row${item.read ? "" : " tm-np-row--unread"}`,
      type: "button",
      "data-testid": "notif-panel-item",
      dataset: { kind: "item", read: item.read ? "true" : "false" },
      onClick: () => onTapItem(item),
    },
    [
      unreadDot(item.read),
      iconCircle(item.icon),
      el("span", { class: "tm-np-text" }, [
        item.title ? el("span", { class: "tm-np-title", text: item.title }) : null,
        item.body ? el("span", { class: "tm-np-body", text: item.body }) : null,
        el("span", { class: "tm-np-time", text: when.text, title: when.title }),
      ]),
    ],
  );
}

/** Tap a chat group: mark its unread notifications read, open the thread, close the panel. */
function onTapGroup(group) {
  markRead(group.unreadIds);
  close();
  if (group.route) navigateTo(group.route);
}

/** Tap an admin/system item: mark it read (if unread), open its deep-link, close the panel. */
function onTapItem(item) {
  if (!item.read) markRead([item.id]);
  close();
  if (item.route) navigateTo(item.route);
}

/** A one-line state message (loading / empty / error), optionally with an action button. */
function stateMessage(text, { testid, action } = {}) {
  return el("div", { class: "tm-np-state", "data-testid": testid || null }, [
    el("p", { class: "tm-np-state-text", text }),
    action ? el("button", { class: "tm-np-retry", type: "button", onClick: action.onClick }, action.label) : null,
  ]);
}

/** Paint the sections (or the empty state) into the panel body. */
function renderSections(sections) {
  const body = bodyEl();
  if (!body) return;
  if (!sections.length) {
    clear(body).append(
      stateMessage("You're all caught up.", { testid: "notif-panel-empty" }),
    );
    return;
  }
  const list = el("div", { class: "tm-np-list", "data-testid": "notif-panel-list" });
  for (const section of sections) {
    list.append(section.kind === CHAT_GROUP ? chatGroupRow(section) : itemRow(section));
  }
  clear(body).append(list);
}

/**
 * Load the feed and render it. Guards against a stale paint: each call takes the next token and only
 * writes if it's still the latest AND the panel is still open, so a slow request that resolves after a
 * newer load / a close is dropped. Loading → list/empty on success, → a retryable error state on
 * failure (the panel must never be a blank dead end).
 */
async function load() {
  const token = ++loadToken;
  const body = bodyEl();
  if (body) clear(body).append(stateMessage("Loading notifications…", { testid: "notif-panel-loading" }));
  try {
    const page = await listNotifications();
    if (token !== loadToken || !backdrop) return; // superseded or closed while loading
    renderSections(buildPanel(page && page.items));
  } catch (err) {
    console.warn("[notif-panel] could not load notifications:", err?.message ?? err);
    if (token !== loadToken || !backdrop) return;
    const target = bodyEl();
    if (target) {
      clear(target).append(
        stateMessage("Couldn't load your notifications.", {
          testid: "notif-panel-error",
          action: { label: "Try again", onClick: load },
        }),
      );
    }
  }
}

/** Close on Escape (attached only while the panel is open). */
function onKey(e) {
  if (e.key === "Escape") close();
}

/**
 * Close the panel: tear down the overlay, detach the key handler, and return focus to the bell that
 * opened it. Idempotent — safe to call when already closed (Escape + backdrop + a tap can race).
 */
export function close() {
  loadToken++; // invalidate any in-flight load so it can't paint after we've gone
  if (backdrop) {
    backdrop.remove();
    backdrop = null;
  }
  if (typeof document !== "undefined") document.removeEventListener("keydown", onKey);
  if (restoreFocusTo && typeof restoreFocusTo.focus === "function") {
    try {
      restoreFocusTo.focus();
    } catch {
      /* focus is best-effort */
    }
  }
  restoreFocusTo = null;
}

/**
 * Open the panel (the seam TM-455's bell calls). If it's already open, just re-load (the bell can call
 * open() again on a repeat click). Builds the overlay: a click-catching backdrop + a top-right dropdown
 * card anchored under the header bell, then loads the feed. No-op without a document (import-safe).
 */
export function open() {
  if (typeof document === "undefined") return;
  if (backdrop) {
    load(); // already open — refresh contents
    return;
  }
  // Remember what to restore focus to (the bell), so closing returns the user where they were.
  restoreFocusTo = document.activeElement && typeof document.activeElement.focus === "function"
    ? document.activeElement
    : null;

  const panel = el(
    "div",
    {
      id: PANEL_ID,
      class: "tm-np-panel tm-wobble",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": "Notifications",
    },
    [
      el("div", { class: "tm-np-head" }, [
        el("h2", { class: "tm-np-title-head", text: "Notifications" }),
        el("button", { class: "tm-toast-close", type: "button", "aria-label": "Close", onClick: close }, "×"),
      ]),
      el("div", { id: `${PANEL_ID}-body`, class: "tm-np-body-scroll" }),
    ],
  );
  backdrop = el(
    "div",
    {
      id: BACKDROP_ID,
      class: "tm-np-backdrop",
      onClick: (e) => {
        if (e.target === backdrop) close();
      },
    },
    [panel],
  );
  document.body.append(backdrop);
  document.addEventListener("keydown", onKey);
  panel.focus?.();
  load();
}

// Register on the TM-455 seam so the bell opens THIS panel instead of falling back to #/notifications.
// A plain global keeps the bell/router decoupled from this module (they never import it).
if (typeof window !== "undefined") {
  window.tmNotificationPanel = { open, close, refresh: load };
}
