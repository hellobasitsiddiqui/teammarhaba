// Event group chat — pure logic core (TM-515 / TM-433).
//
// The framework-free web SPA is the single source for all four surfaces (web / mobile-web / Android
// WebView / iOS WebView). Following the codebase's established core/renderer split (tabbar-core.js,
// events-core.js, notifications-core.js, components-core.js — see AGENTIC-LESSONS "extract the pure
// logic to test it"), this module holds ONLY the pure data + rules the Chat screens need — the seed
// conversations, thread lookup, and the read-receipt state derivation — with NO DOM, Firebase or
// Capacitor imports, so it is import-safe in a plain Node test (`node --test web/tools/*.test.mjs`,
// the CI web-build gate). The DOM-mounting half lives in `chat.js`; the styling lives in styles.css.
//
// WHY seed data (not a backend): the Event group chat backend is a later epic (TM-433 is not yet
// built). TM-515 is the wireframe REFRESH — bringing the live Chat list + thread in line with the
// approved paper wireframes (paper-chat-list / paper-chat-thread / paper-chat-empty) at the
// production default theme, built from the shared component library. So this module reproduces the
// exact wireframe conversations as static seed content; when TM-433 lands, the same DOM shell reads
// real messages from the API in place of `CONVERSATIONS` with no change to the screen layout.
//
// READ-RECEIPT SEMANTICS (TM-433, surfaced with the TM-511 triple-tick component):
//   • sent  → ✓    delivered to the server, read by nobody yet
//   • read  → ✓✓   read by at least one, but not all, group members
//   • group → ✓✓✓  read by EVERYONE in the group (the whole-group-read state)
// The screen derives the tick state from each out-going message's `readBy` count against the group's
// member count via `receiptState()`, rather than hard-coding a glyph — so the meaning is the data,
// and it survives the grayscale sketch theme (the tick COUNT carries it, not colour).

/**
 * The five reaction emoji the long-press picker offers, plus the "＋ more" affordance — verbatim from
 * the paper-reaction-picker wireframe (👍 ❤️ 😂 🎉 🙌 ＋) and the HANDOFF "chat reactions only" set.
 * Exported so the picker DOM and its test share one source of truth.
 */
export const REACTION_EMOJIS = Object.freeze(["👍", "❤️", "😂", "🎉", "🙌"]);

/**
 * Derive the read-receipt tick state for an out-going message from how many group members have read
 * it. This is the TM-433 delivery ladder made a pure function so it can be unit-tested without a DOM:
 *   readBy <= 0            → "sent"   (✓   — delivered, nobody has read it)
 *   0 < readBy < members   → "read"   (✓✓  — read by some, not all)
 *   readBy >= members      → "group"  (✓✓✓ — read by everyone: whole-group-read)
 * `members` is clamped to at least 1 so a degenerate 0-member group can't make every message "group".
 * @param {number} readBy how many OTHER members have read the message.
 * @param {number} members the group's member count.
 * @returns {"sent"|"read"|"group"}
 */
export function receiptState(readBy, members) {
  const read = Math.max(0, Math.trunc(Number(readBy) || 0));
  const total = Math.max(1, Math.trunc(Number(members) || 0));
  if (read <= 0) return "sent";
  if (read >= total) return "group";
  return "read";
}

// The seed conversations, in the wireframe's order. Each conversation is one event's group chat:
//   id        — stable slug (also the #/chat/{id} thread route segment)
//   name      — the group/event name (paper-chat-list `.nm`, paper-chat-thread `<h1>`)
//   avatar    — the list avatar glyph (an emoji or a name initial), per the wireframe
//   going     — the "N going" member count shown under the thread title + used for receiptState()
//   unread    — the chat-list unread count badge (0 = no badge)
//   preview   — the last-message preview for the list row: { text, self, receipt }
//               (self:true rows show a leading tick — the wireframe's "✓✓ You: …" / "✓ …")
//   messages  — the thread messages (empty array → the paper-chat-empty state)
//
// Message shape:
//   { from: "them"|"me", who?: string, text: string, at?: string,
//     readBy?: number,               // out-going only → drives receiptState() against `going`
//     reaction?: { emoji, count } }  // an inline reaction pill (paper-chat-thread `.react`)
const CONVERSATIONS = Object.freeze([
  {
    id: "sunday-dog-walk",
    name: "Sunday Dog Walk",
    avatar: "🐕",
    going: 12,
    unread: 2,
    preview: { text: "Sarah: see you at the lake! ☀️", self: false, receipt: null },
    // The paper-chat-thread wireframe, extended so the full read-receipt ladder (sent/read/group)
    // renders per TM-433 semantics with the TM-511 component. The two out-going messages the mock
    // showed (09:58, 10:01) keep their copy + reactions; the mock predates the triple-tick, so the
    // oldest out-message — long since seen by all 12 — is now correctly whole-group-read (✓✓✓), and a
    // just-sent trailing message demonstrates the delivered-not-read (✓) end of the ladder.
    day: "Today",
    messages: [
      { from: "them", who: "Sarah", text: "Morning! Meeting at the main car park ☀️", reaction: { emoji: "👍", count: 3 } },
      { from: "them", who: "Mike", text: "Perfect — I'll bring treats for the dogs 🦴" },
      { from: "me", text: "See you all at 10!", at: "09:58", readBy: 12, reaction: { emoji: "❤️", count: 2 } },
      { from: "them", who: "Sarah", text: "Can't wait 🐶" },
      { from: "me", text: "On my way now", at: "10:01", readBy: 7 },
      { from: "me", text: "Anyone want a coffee after? ☕", at: "10:03", readBy: 0 },
    ],
  },
  {
    id: "coffee-code",
    name: "Coffee & Code",
    avatar: "C",
    going: 8,
    unread: 0,
    // A self (You:) preview read by a recipient → the list shows a two-tick prefix (✓✓).
    preview: { text: "You: I'll bring the laptop", self: true, receipt: "read" },
    day: "Today",
    messages: [
      { from: "them", who: "Priya", text: "Table booked for 6 — see you there" },
      { from: "me", text: "I'll bring the laptop", at: "08:40", readBy: 5 },
    ],
  },
  {
    id: "bouldering-social",
    name: "Bouldering Social",
    avatar: "B",
    going: 9,
    unread: 5,
    preview: { text: "Mike: who's driving on Thursday?", self: false, receipt: null },
    day: "Yesterday",
    messages: [
      { from: "them", who: "Mike", text: "Who's driving on Thursday?" },
    ],
  },
  {
    id: "marhaba-team",
    name: "Marhaba Team",
    avatar: "M",
    going: 20,
    unread: 0,
    // A self preview delivered but not yet read → a single-tick prefix (✓).
    preview: { text: "Announcement: new features live", self: true, receipt: "sent" },
    day: "Monday",
    messages: [
      { from: "me", text: "Announcement: new features live", at: "Mon", readBy: 0 },
    ],
  },
  {
    id: "park-picnic",
    name: "Park Picnic",
    avatar: "P",
    going: 6,
    unread: 0,
    preview: { text: "You joined the event — say hi 👋", self: false, receipt: null },
    day: "Today",
    // No messages yet → the paper-chat-empty "No messages yet / Be the first to say hi 👋" state.
    messages: [],
  },
]);

/** The chat-list conversations, in display order (newest-activity first, as the wireframe shows). */
export function listConversations() {
  return CONVERSATIONS;
}

/**
 * Look up one conversation by its id (the #/chat/{id} route segment).
 * @param {string} id
 * @returns {object|null} the conversation, or null when the id is unknown.
 */
export function getConversation(id) {
  if (!id) return null;
  return CONVERSATIONS.find((c) => c.id === id) || null;
}

/**
 * The thread's messages, each enriched with the derived receipt state for out-going messages so the
 * DOM layer stays dumb (it just renders `msg.receipt`). Returns [] for an empty/unknown thread.
 * @param {string} id conversation id.
 * @returns {Array<object>} messages with `receipt` set on `from === "me"` entries.
 */
export function threadMessages(id) {
  const conv = getConversation(id);
  if (!conv) return [];
  return conv.messages.map((m) =>
    m.from === "me" ? { ...m, receipt: receiptState(m.readBy, conv.going) } : { ...m },
  );
}

/** Whether a conversation has any messages (false → render the empty state). */
export function hasMessages(id) {
  const conv = getConversation(id);
  return Boolean(conv && conv.messages.length > 0);
}

/**
 * Total unread across all conversations — the number the Chat tab badge would show (TM-439 owns the
 * badge wiring; exported here so the count has a single tested source when that lands).
 * @returns {number}
 */
export function totalUnread() {
  return CONVERSATIONS.reduce((sum, c) => sum + (Number(c.unread) || 0), 0);
}
