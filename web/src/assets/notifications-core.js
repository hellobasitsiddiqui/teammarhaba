// Notifications feed — pure logic core (TM-515).
//
// The grouped-notifications SCREEN (the paper-notifications wireframe): event-grouped activity with a
// "Mark all read" action. Following the codebase's core/renderer split (events-core.js /
// tabbar-core.js / chat-core.js), this module holds ONLY the pure data + transforms — the seed
// notification groups, the unread count, and the immutable mark-all-read — with NO DOM/Firebase
// imports, so it is import-safe in a plain Node test (`node --test web/tools/*.test.mjs`, the CI web
// gate). The DOM half lives in `notifications.js`; the styling lives in styles.css.
//
// NOT the same thing as the foreground-push inbox (notification-center.js / notification-inbox.js):
// that is a native-only recovery net for pushes that arrive while the app is foregrounded, shown in a
// bell + modal. THIS is the full grouped Notifications feed screen from the approved wireframe. The
// two are deliberately separate surfaces (different data, different entry points) and share no state.
//
// WHY seed data (not a backend): there is no notifications API yet — TM-515 is the wireframe REFRESH,
// so this reproduces the exact paper-notifications content (5 notification types, grouped by event,
// verbatim copy from the HANDOFF §3 "Notifications" list). When a real feed lands, the DOM shell reads
// it in place of `GROUPS` with no change to the screen layout.

/**
 * Build the immutable seed feed. A factory (not a frozen singleton) so each caller — and each test —
 * gets its own deep copy it can hand to `markAllRead()` without mutating a shared module-level object.
 *
 * Each group is one event (or "General"); each note carries:
 *   id    — stable identity (for mark-read / list keys)
 *   icon  — an icons.js line-icon name the DOM renders in the note's icon circle (theme-safe
 *           `currentColor` glyphs reproducing paper-notifications' per-type icons: bell (spot) /
 *           people / clock / speech-bubble (chat) / home (welcome))
 *   text  — the notification copy, verbatim from the wireframe / HANDOFF §3
 *   time  — the relative timestamp string the wireframe shows
 *   read  — false → unread (accent dot + accent-light row wash); true → read (hollow dot, plain row)
 * @returns {Array<{title: string, notes: Array<{id,icon,text,time,read}>}>}
 */
export function buildFeed() {
  return [
    {
      title: "Sunday Morning Dog Walk",
      notes: [
        { id: "n1", icon: "spot", text: "A spot opened up — claim it before it's gone", time: "2 min ago", read: false },
        { id: "n2", icon: "people", text: "3 new people are going", time: "1 hour ago", read: false },
      ],
    },
    {
      title: "Coffee & Code Meetup",
      notes: [
        { id: "n3", icon: "clock", text: "Starts in 1 hour — see you there", time: "30 min ago", read: false },
        { id: "n4", icon: "chat", text: "Sarah commented in the chat", time: "3 hours ago", read: true },
      ],
    },
    {
      title: "General",
      notes: [
        { id: "n5", icon: "welcome", text: "Welcome to Marhaba — find your first meetup", time: "2 days ago", read: true },
      ],
    },
  ];
}

/**
 * How many notifications across all groups are unread — drives whether "Mark all read" does anything
 * (and a future feed badge). Tolerant of a missing/!array `notes`.
 * @param {Array<{notes?: Array<{read?: boolean}>}>} groups
 * @returns {number}
 */
export function unreadCount(groups) {
  if (!Array.isArray(groups)) return 0;
  return groups.reduce(
    (sum, g) => sum + (Array.isArray(g?.notes) ? g.notes.filter((n) => n && n.read !== true).length : 0),
    0,
  );
}

/**
 * Mark every notification read (the "Mark all read" action). Pure: returns a NEW group list with new
 * note objects, never mutating the input — so the caller repaints from the returned value and the
 * seed factory's output is untouched. Returns the SAME reference when nothing was unread, so a caller
 * can cheaply skip a redundant repaint.
 * @param {Array} groups
 * @returns {Array}
 */
export function markAllRead(groups) {
  if (!Array.isArray(groups) || unreadCount(groups) === 0) return groups;
  return groups.map((g) => ({
    ...g,
    notes: Array.isArray(g?.notes) ? g.notes.map((n) => (n && n.read !== true ? { ...n, read: true } : n)) : g?.notes,
  }));
}
