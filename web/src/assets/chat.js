// Chat section — DOM view (TM-438), reading the F2 conversation API (TM-436).
//
// The Chat section inside the bottom-nav shell (TM-434): a UNIFIED conversation list (event group
// chats + admin broadcasts together, each with a type badge) and a per-conversation thread view.
// Replaces the earlier TM-515 seed-driven wireframe: the list + thread now read the live backend
// (GET /api/v1/me/conversations, GET /api/v1/conversations/{id}/messages), and opening a thread marks
// it read (POST /api/v1/conversations/{id}/read). Message POSTING is a later ticket (TM-447), so this
// view is read-only — there is no composer yet.
//
// Two views, mounted into the same #chat-view container by the router (mirrors events.js list/detail):
//   • #/chat        → the conversation LIST  (renderList)   — a top-level tab, no back button
//   • #/chat/{id}   → the message THREAD      (renderThread) — back to the list
//
// It follows the events.js house pattern for an API-backed view: a monotonic `renderToken` so a slow
// fetch can't paint over a newer navigation, a shared loading state, and a retryable error state. All
// decision logic (mapping the API shapes to view-models, the type badge, time labels, ordering) lives
// in the pure, unit-tested chat-core.js; this module is the thin DOM shell around it.
//
// Theming is inherited: the shared component library (avatar / badge / tag / reaction) and the
// .tm-chat-* rules restyle from CSS tokens with the theme (clean / doodle / sketch), so no per-theme
// code lives here. XSS-safe: every node is built via ui.js `el()` (textContent only, no innerHTML), so
// untrusted titles, previews and message bodies can never inject markup.

import { clear, el } from "./ui.js";
import { avatar, badge, reaction, tag } from "./components.js";
import { lineIcon } from "./icons.js";
import { listMyConversations, getConversationMessages, markConversationRead } from "./api.js";
import * as core from "./chat-core.js";

const $ = (id) => document.getElementById(id);

// The last loaded list, cached so a thread deep-link (#/chat/{id}) can name its conversation + type
// without a second round-trip, and so marking a thread read can clear that row's unread badge for the
// instant back-nav. Best-effort — a cache miss just weakens the thread header (falls back to "Chat").
const state = { rows: [] };

// Monotonic guard: a fetch that resolves after the user has navigated away must not paint stale
// content over the new view (mirrors events.js / the router's settle-or-fallback discipline).
let renderToken = 0;

/**
 * Router entry (TM-109). `threadId` is the conversation id parsed from `#/chat/{id}`, or null/empty
 * for the `#/chat` list. Re-invoked on every entry so list↔thread↔another-thread navigation always
 * repaints with fresh data (mirrors enterEvents).
 * @param {?string} threadId
 */
export function enterChat(threadId) {
  const view = $("chat-view");
  if (!view) return;
  if (threadId != null && threadId !== "") renderThread(view, String(threadId));
  else renderList(view);
}

/* ─────────────────────────────── Shared chrome / states ───────────────────────────────────────── */

/** The list top bar: just the "Chats" title (a top-level tab, no back button). */
function listHeader() {
  return el("header", { class: "tm-chat-head" }, [el("h2", { class: "tm-chat-title", text: "Chats" })]);
}

/** The thread top bar: back to the list + the conversation title + a type sub-line. */
function threadHeader(meta) {
  return el("header", { class: "tm-chat-thread-head" }, [
    el("a", { class: "tm-chat-back", href: "#/chat", "aria-label": "Back to chats" }, [
      el("span", { class: "tm-chat-back-glyph", "aria-hidden": "true", text: "←" }),
    ]),
    el("div", { class: "tm-chat-thread-heading" }, [
      el("h2", { class: "tm-chat-thread-title", text: meta.title }),
      el("p", { class: "tm-chat-thread-sub", text: meta.sub }),
    ]),
  ]);
}

/**
 * A one-line view state (loading / error), optionally with a retry button — reuses the shared
 * .tm-empty / .tm-muted / .tm-btn styles the events + notifications views use, so it themes for free.
 */
function stateBlock(message, { testid, muted = false, onRetry } = {}) {
  return el("div", { class: muted ? "tm-chat-state tm-muted" : "tm-chat-state tm-empty", "data-testid": testid || null }, [
    el("p", { class: "tm-chat-state-text", text: message }),
    onRetry ? el("button", { class: "tm-btn", type: "button", onClick: onRetry }, "Retry") : null,
  ]);
}

/* ─────────────────────────────── Conversation list (#/chat) ───────────────────────────────────── */

async function renderList(view) {
  const mine = ++renderToken;
  clear(view).append(listHeader(), stateBlock("Loading your chats…", { testid: "chat-loading", muted: true }));

  let data;
  try {
    data = await listMyConversations();
  } catch (err) {
    if (mine !== renderToken) return;
    clear(view).append(
      listHeader(),
      stateBlock("Couldn't load your chats. Please try again.", {
        testid: "chat-error",
        onRetry: () => renderList(view),
      }),
    );
    console.warn("[chat] list load failed:", err?.message ?? err);
    return;
  }
  if (mine !== renderToken) return;

  state.rows = core.toConversationRows(data?.items);
  paintList(view);
}

/** Paint the (already fetched) list — the unified rows, or the empty state, inside the list region. */
function paintList(view) {
  const list = el("div", { class: "tm-chat-list", "data-testid": "chat-list" });
  if (state.rows.length === 0) list.append(emptyList());
  else for (const row of state.rows) list.append(listRow(row));
  clear(view).append(listHeader(), list);
}

/** The "no conversations yet" empty state for the list. */
function emptyList() {
  return el("div", { class: "tm-chat-empty", "data-testid": "chat-list-empty" }, [
    el("div", { class: "tm-chat-empty-icon", "aria-hidden": "true" }, [lineIcon("chat", { size: 44, strokeWidth: 1.6 })]),
    el("h3", { class: "tm-chat-empty-title", text: "No conversations yet" }),
    el("p", { class: "tm-chat-empty-lead", text: "Join an event to start chatting — your group chats and announcements land here." }),
  ]);
}

/** One conversation row — a link into the thread, with a type badge, preview, time and unread badge. */
function listRow(row) {
  return el(
    "a",
    {
      class: "tm-chat-row",
      href: `#/chat/${encodeURIComponent(row.id)}`,
      "data-testid": "chat-row",
      dataset: { threadId: row.id, type: row.type.key },
    },
    [
      avatar(row.avatar),
      el("div", { class: "tm-chat-row-mid" }, [
        el("div", { class: "tm-chat-row-name" }, [
          el("span", { class: "tm-chat-row-name-text", text: row.title }),
          typeBadge(row.type),
        ]),
        el("span", { class: "tm-chat-row-preview" }, [
          el("span", { class: "tm-chat-row-preview-text", text: row.preview || "No messages yet" }),
        ]),
      ]),
      el("div", { class: "tm-chat-row-meta" }, [
        row.timeLabel ? el("span", { class: "tm-chat-row-time", text: row.timeLabel }) : null,
        row.unread > 0 ? badge(row.unread) : null,
      ]),
    ],
  );
}

/** The event/admin type badge — the shared `tag()` component with a per-type accent class. */
function typeBadge(type) {
  const node = tag(type.label);
  node.classList.add("tm-chat-type", `tm-chat-type--${type.key}`);
  return node;
}

/* ─────────────────────────────── Message thread (#/chat/{id}) ─────────────────────────────────── */

async function renderThread(view, id) {
  const mine = ++renderToken;
  const meta = threadMeta(id);
  clear(view).append(threadHeader(meta), stateBlock("Loading messages…", { testid: "chat-loading", muted: true }));

  let data;
  try {
    data = await getConversationMessages(id);
  } catch (err) {
    if (mine !== renderToken) return;
    clear(view).append(
      threadHeader(meta),
      stateBlock("Couldn't load this chat. Please try again.", {
        testid: "chat-error",
        onRetry: () => renderThread(view, id),
      }),
    );
    console.warn("[chat] thread load failed:", err?.message ?? err);
    return;
  }
  if (mine !== renderToken) return;

  const messages = core.toThreadMessages(data?.items);
  const body = el("div", { class: "tm-chat-body", "data-testid": "chat-thread" });
  if (messages.length === 0) body.append(emptyThread());
  else for (const m of messages) body.append(messageRow(m));

  clear(view).append(threadHeader(meta), body);
  // Land at the newest message (bottom), like every chat app.
  requestAnimationFrame(() => {
    body.scrollTop = body.scrollHeight;
  });

  markThreadRead(id);
}

/**
 * The conversation title + sub-line for the thread header, resolved from the cached list when we have
 * it (e.g. arrived via a list tap) and degrading to a neutral "Chat" on a cold deep-link.
 */
function threadMeta(id) {
  const row = state.rows.find((r) => r.id === String(id));
  if (!row) return { title: "Chat", sub: "" };
  return { title: row.title, sub: row.type.key === "admin" ? "Admin messages" : "Event chat" };
}

/** Mark the opened thread read (fire-and-forget) and clear its cached unread so back-nav reflects it. */
function markThreadRead(id) {
  const row = state.rows.find((r) => r.id === String(id));
  if (row) row.unread = 0;
  Promise.resolve(markConversationRead(id)).catch((err) => {
    // Non-fatal: the badge just stays until the next list refresh. Never surfaces to the user.
    console.warn("[chat] mark-read failed:", err?.message ?? err);
  });
}

/** The "no messages yet" empty thread state. */
function emptyThread() {
  return el("div", { class: "tm-chat-empty", "data-testid": "chat-empty" }, [
    el("div", { class: "tm-chat-empty-icon", "aria-hidden": "true" }, [lineIcon("chat", { size: 44, strokeWidth: 1.6 })]),
    el("h3", { class: "tm-chat-empty-title", text: "No messages yet" }),
    el("p", { class: "tm-chat-empty-lead", text: "Nothing here yet — messages will appear as they're posted." }),
  ]);
}

/**
 * One message row. `system` messages (e.g. "You joined the event") render as a centred notice; regular
 * messages render as a bubble with the body, a time stamp and any read-only reaction pills. The read
 * API doesn't expose the caller's own id, so messages are a flat, sender-agnostic list (out-going ticks
 * / reaction picker are later tickets).
 */
function messageRow(m) {
  if (m.system) {
    return el("div", { class: "tm-chat-system", "data-testid": "chat-system" }, [
      el("span", { class: "tm-chat-system-text", text: m.body }),
    ]);
  }

  const row = el("div", { class: "tm-chat-msg tm-chat-msg--in" });
  row.append(el("div", { class: "tm-chat-bub", text: m.body }));
  if (m.timeLabel) row.append(el("div", { class: "tm-chat-stamp" }, [el("span", { text: m.timeLabel })]));
  // Read-only reaction pills (no picker in TM-438): just surface whatever the API returned.
  for (const r of m.reactions) {
    const pill = reaction(r.emoji, r.count);
    pill.classList.add("tm-chat-reaction");
    row.append(pill);
  }
  return row;
}

// Bridge for the router (which imports this) + ad-hoc use / QA.
if (typeof window !== "undefined") {
  window.tmChat = { enterChat };
}
