// Notifications feed — DOM view (TM-515).
//
// The grouped Notifications SCREEN, refreshed to the approved paper-notifications wireframe at the
// production default theme, inside the bottom-nav shell (TM-434). A framework-free view module in the
// events.js / chat.js mould: the router (TM-109) owns the #/notifications route + visibility and calls
// enterNotifications() on entry; this builds into #notifications-view.
//
// Distinct from the foreground-push inbox (notification-center.js): that is a native-only bell + modal
// recovery net for pushes received while the app is foregrounded. THIS is the full event-grouped feed
// from the wireframe, reached from the top nav "Notifications" link.
//
// Built from the SHARED component library (TM-511): `unreadDot` for the per-note read/unread status
// dot. Group icons reuse the doodles.js social-events motif pack (currentColor line-art) so they ink
// with the theme. All data + transforms (the seed feed, the unread count, the immutable mark-all-read)
// live in the pure, unit-tested notifications-core.js; this module is the thin DOM shell.
//
// XSS-safe: every node via ui.js `el()` (textContent only, no innerHTML).

import { clear, el, toast } from "./ui.js";
import { unreadDot } from "./components.js";
import { lineIcon } from "./icons.js";
import * as core from "./notifications-core.js";

const $ = (id) => document.getElementById(id);

// The current feed (its own mutable copy from the seed factory). "Mark all read" swaps it for the
// immutable-transformed result and repaints — the pure core never mutates this in place.
let feed = core.buildFeed();

/** Router entry (TM-109). Rebuilds the feed each entry so it reflects the latest state on return. */
export function enterNotifications() {
  const view = $("notifications-view");
  if (!view) return;
  feed = core.buildFeed();
  render(view);
}

/** Paint the whole screen: header (back + "Mark all read") then the event-grouped notes. */
function render(view) {
  clear(view).append(header(view), body());
}

/** Top bar: back to Home, the "Notifications" title, and the "Mark all read" action. */
function header(view) {
  const hasUnread = core.unreadCount(feed) > 0;
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

/** The grouped feed: an event group header, then each notification note. */
function body() {
  const wrap = el("div", { class: "tm-notifs", "data-testid": "notifications" });
  for (const group of feed) {
    wrap.append(el("h3", { class: "tm-notifs-group", text: group.title }));
    for (const note of group.notes) wrap.append(noteRow(note));
  }
  return wrap;
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
        el("span", { class: "tm-notifs-time", text: note.time }),
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
