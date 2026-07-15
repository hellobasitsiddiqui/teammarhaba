// Notifications feed — DOM view (TM-515, TM-745).
//
// The grouped Notifications SCREEN, refreshed to the approved paper-notifications wireframe at the
// production default theme, inside the bottom-nav shell (TM-434). A framework-free view module in the
// events.js / chat.js mould: the router (TM-109) owns the #/notifications route + visibility and calls
// enterNotifications() on entry; this builds into #notifications-view.
//
// Distinct from the foreground-push inbox (notification-center.js): that is a native-only bell + modal
// recovery net for pushes received while the app is foregrounded. THIS is the full grouped feed from
// the wireframe, reached from the top nav "Notifications" link.
//
// REAL FEED (TM-745). This screen previously painted a HARDCODED seed of 5 fabricated notifications as
// if they were real activity. It now loads the caller's REAL feed from the notifications backend (GET
// /api/v1/me/notifications, TM-454) — the SAME API the bell-opened panel (notification-panel.js) reads
// — via the shared `listNotifications` api.js helper, and maps it with the pure `core.mapFeed`. So an
// empty feed shows the honest empty state and nothing fabricated ever renders. Loading/empty/error are
// all real states (the screen must never be a blank dead end).
//
// Built from the SHARED component library (TM-511): `unreadDot` for the per-note read/unread status
// dot. All data + transforms (the feed mapping, the unread count, the immutable mark-all-read) live in
// the pure, unit-tested notifications-core.js; this module is the thin DOM shell.
//
// XSS-safe: every node via ui.js `el()` (textContent only, no innerHTML) — notification title/body are
// server data and are only ever set as textContent.

import { clear, el, toast, relativeTime } from "./ui.js";
import { unreadDot } from "./components.js";
import { lineIcon } from "./icons.js";
import { listNotifications } from "./api.js";
import * as core from "./notifications-core.js";

const $ = (id) => document.getElementById(id);

// The current feed (its own mutable copy from the last mapped load). "Mark all read" swaps it for the
// immutable-transformed result and repaints — the pure core never mutates this in place.
let feed = [];

// A load token guards against a stale async paint: each entry takes the next token and only writes if
// it's still the latest, so a slow /me/notifications response that resolves after a newer entry (or a
// navigation away) can't overwrite fresher content — mirrors notification-panel.js's guard.
let loadToken = 0;

/**
 * Router entry (TM-109). Loads the caller's real feed each entry so it reflects the latest state on
 * return. Paints a loading state immediately, then the mapped feed (or an empty/error state).
 */
export function enterNotifications() {
  const view = $("notifications-view");
  if (!view) return;
  load(view);
}

/** Fetch the real feed, map it, and repaint. Loading → list/empty on success, → error on failure. */
async function load(view) {
  const token = ++loadToken;
  feed = [];
  renderLoading(view);
  try {
    const page = await listNotifications();
    if (token !== loadToken) return; // superseded by a newer entry — drop this paint
    feed = core.mapFeed(page && page.items);
    render(view);
  } catch (err) {
    console.warn("[notifications] could not load notifications:", err?.message ?? err);
    if (token !== loadToken) return;
    renderError(view);
  }
}

/** Loading placeholder while the feed request is in flight. */
function renderLoading(view) {
  clear(view).append(
    header(view, { hasUnread: false }),
    stateMessage("Loading notifications…", { testid: "notifications-loading" }),
  );
}

/** Retryable error state — the screen must never be a blank dead end if the request fails. */
function renderError(view) {
  clear(view).append(
    header(view, { hasUnread: false }),
    stateMessage("Couldn't load your notifications.", {
      testid: "notifications-error",
      action: { label: "Try again", onClick: () => load(view) },
    }),
  );
}

/** Paint the whole screen: header (back + "Mark all read") then the feed (or the empty state). */
function render(view) {
  clear(view).append(header(view, { hasUnread: core.unreadCount(feed) > 0 }), body());
}

/** Top bar: back to Home, the "Notifications" title, and the "Mark all read" action. */
function header(view, { hasUnread }) {
  return el("header", { class: "tm-notifs-head" }, [
    el("a", { class: "tm-chat-back", href: "#/home", "aria-label": "Back to home" }, [
      el("span", { class: "tm-chat-back-glyph", "aria-hidden": "true", text: "←" }),
    ]),
    el("h2", { class: "tm-notifs-title", text: "Notifications" }),
    el(
      "button",
      {
        class: "tm-notifs-markall",
        type: "button",
        "data-testid": "notifs-mark-all",
        disabled: !hasUnread,
        onClick: () => markAll(view),
      },
      "Mark all read",
    ),
  ]);
}

/** The feed body: the empty state when there's nothing, else the grouped notes. */
function body() {
  if (!feed.length) {
    return stateMessage("You're all caught up.", { testid: "notifications-empty" });
  }
  const wrap = el("div", { class: "tm-notifs", "data-testid": "notifications" });
  for (const group of feed) {
    wrap.append(el("h3", { class: "tm-notifs-group", text: group.title }));
    for (const note of group.notes) wrap.append(noteRow(note));
  }
  return wrap;
}

/** A one-line state message (loading / empty / error), optionally with a retry action button. */
function stateMessage(text, { testid, action } = {}) {
  return el("div", { class: "tm-notifs-state", "data-testid": testid || null }, [
    el("p", { class: "tm-notifs-state-text", text }),
    action ? el("button", { class: "tm-notifs-retry", type: "button", onClick: action.onClick }, action.label) : null,
  ]);
}

/** One notification: unread/read dot · themed icon circle · text + relative time. */
function noteRow(note) {
  return el(
    "div",
    {
      class: `tm-notifs-note${note.read ? "" : " tm-notifs-note--unread"}`,
      "data-testid": "notification",
      dataset: { read: note.read ? "true" : "false" },
    },
    [
      unreadDot(note.read),
      el("span", { class: "tm-notifs-icon", "aria-hidden": "true" }, [
        // Theme-agnostic line icon (doodles are doodle-theme-only). Fall back to the chat glyph for an
        // unknown name so the circle is never empty.
        lineIcon(note.icon, { size: 18 }) || lineIcon("chat", { size: 18 }),
      ]),
      el("span", { class: "tm-notifs-text" }, [
        el("span", { class: "tm-notifs-text-body", text: note.text }),
        // `time` is the raw server createdAt (ISO/epoch) — format it here; relativeTime returns "—" for
        // a missing/unparseable value rather than throwing.
        el("span", { class: "tm-notifs-time", text: relativeTime(note.time).text }),
      ]),
    ],
  );
}

/** "Mark all read": apply the pure transform, repaint, and confirm with a toast. */
function markAll(view) {
  if (core.unreadCount(feed) === 0) return;
  feed = core.markAllRead(feed);
  render(view);
  toast("All notifications marked as read.", { type: "success" });
}

// Bridge for the router (which imports this) + ad-hoc use / QA.
if (typeof window !== "undefined") {
  window.tmNotificationsScreen = { enterNotifications };
}
