// Chat section — DOM view (TM-438 read + TM-448 compose), reading/writing the F2 conversation API.
//
// The Chat section inside the bottom-nav shell (TM-434): a UNIFIED conversation list (event group
// chats + admin broadcasts together, each with a type badge) and a per-conversation thread view.
// Replaces the earlier TM-515 seed-driven wireframe: the list + thread read the live backend
// (GET /api/v1/me/conversations, GET /api/v1/conversations/{id}/messages), opening a thread marks it
// read (POST /api/v1/conversations/{id}/read, TM-438), and — new in TM-448 — the thread now has a
// COMPOSE box that posts to the member-gated endpoint (POST /api/v1/conversations/{id}/messages,
// TM-447), with an optimistic echo, a near-live poll, and a composer that locks itself with a clear
// reason when the caller is muted / removed or the thread is closed.
//
// Two views, mounted into the same #chat-view container by the router (mirrors events.js list/detail):
//   • #/chat        → the conversation LIST  (renderList)   — a top-level tab, no back button
//   • #/chat/{id}   → the message THREAD      (renderThread) — back to the list, with a composer
//
// It follows the events.js house pattern for an API-backed view: a monotonic `renderToken` so a slow
// fetch can't paint over a newer navigation, a shared loading state, and a retryable error state. All
// decision logic (mapping the API shapes to view-models, the type badge, time labels, ordering, draft
// validation, post-error → lock classification, the optimistic-echo maths) lives in the pure,
// unit-tested chat-core.js; this module is the thin DOM shell around it.
//
// Theming is inherited: the shared component library (avatar / badge / tag / reaction) and the
// .tm-chat-* rules restyle from CSS tokens with the theme, so no per-theme code lives here. XSS-safe:
// every node is built via ui.js `el()` (textContent only, no innerHTML), so untrusted titles, previews
// and message bodies can never inject markup.

import { clear, el, toast } from "./ui.js";
import { avatar, badge, reaction, tag } from "./components.js";
import { lineIcon } from "./icons.js";
import {
  listMyConversations,
  getConversationMessages,
  markConversationRead,
  postConversationMessage,
} from "./api.js";
import * as core from "./chat-core.js";

const $ = (id) => document.getElementById(id);

// The last loaded list, cached so a thread deep-link (#/chat/{id}) can name its conversation + type
// without a second round-trip, and so marking a thread read can clear that row's unread badge for the
// instant back-nav. Best-effort — a cache miss just weakens the thread header (falls back to "Chat").
const state = { rows: [] };

// Monotonic guard: a fetch that resolves after the user has navigated away must not paint stale
// content over the new view (mirrors events.js / the router's settle-or-fallback discipline).
let renderToken = 0;

// Near-live refresh cadence for an OPEN thread — gentle enough to be near-free, short enough that a
// message posted by someone else surfaces without a manual reload. A foreground push (tm:notification)
// also triggers an immediate poll, so this is the fallback for the no-push path (mirrors the badge poll).
const THREAD_POLL_MS = 15000;

// The currently-open thread's live state. `messages` is the server-authoritative list (replaced on load
// + each poll); `pending` holds optimistic bubbles awaiting their POST; `mineIds` remembers the ids we
// posted this session so they keep rendering as out-going (the read API can't tell us which are "mine",
// so this is best-effort within the session). `sending` pauses the poll during a send so it can't race
// the optimistic echo. `bodyEl` is repainted on change; the composer input persists across body repaints.
const thread = { id: null, messages: [], pending: [], mineIds: new Set(), sending: false, poll: null, bodyEl: null };
let pushWired = false; // the foreground-push → poll listener is attached exactly once

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
  stopThreadPoll(); // leaving any open thread → stop its near-live poll
  thread.id = null;
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
  id = String(id);
  stopThreadPoll(); // a previous thread's poll must not keep firing under this one
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

  // Fresh thread state — a new open resets the optimistic queue + the "mine" memory.
  thread.id = id;
  thread.messages = core.toThreadMessages(data?.items);
  thread.pending = [];
  thread.mineIds = new Set();
  thread.sending = false;

  const body = el("div", { class: "tm-chat-body", "data-testid": "chat-thread" });
  thread.bodyEl = body;
  const compose = buildComposer(id, meta);

  clear(view).append(threadHeader(meta), body, compose);
  repaintBody(); // paints the loaded messages (or the empty state) + scrolls to the newest
  wirePush(); // foreground-push → immediate poll while a thread is open
  startThreadPoll(id);
  markThreadRead(id);
}

/**
 * Repaint just the message list from `thread.messages` + `thread.pending`, preserving the composer (a
 * separate, persistent node) and the caller's scroll position: it only re-pins to the bottom if they
 * were already there, so a background poll can't yank someone reading history back down. A message is
 * drawn as out-going when it's a pending echo or one we posted this session (`mineIds`).
 */
function repaintBody() {
  const body = thread.bodyEl;
  if (!body) return;
  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 48;
  clear(body);
  const all = [...thread.messages, ...thread.pending];
  if (all.length === 0) {
    body.append(emptyThread());
    return;
  }
  for (const m of all) body.append(messageRow(m, Boolean(m.pending) || thread.mineIds.has(m.id)));
  if (atBottom) requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
}

/* ─────────────────────────────── Composer (post a message — TM-448) ───────────────────────────── */

/**
 * Build the compose box for a thread. Admin-broadcast conversations (announcements) come back disabled
 * up-front with a clear reason (`composeAvailability`); an event group chat gets a live input + send
 * button that posts via the endpoint. Enter (form submit) or the send button sends; the button is
 * disabled until the draft is valid (non-blank, ≤500 — the same rule the backend enforces).
 */
function buildComposer(id, meta) {
  const avail = core.composeAvailability({ type: meta.typeKey });
  if (!avail.canPost) return disabledComposer(avail.reason);

  const input = el("input", {
    class: "tm-chat-input",
    type: "text",
    maxlength: String(core.MAX_MESSAGE_LENGTH),
    placeholder: "Message the group…",
    "aria-label": "Write a message",
    autocomplete: "off",
    "data-testid": "chat-input",
  });
  const sendBtn = el(
    "button",
    { class: "tm-chat-send", type: "submit", "aria-label": "Send", disabled: true, "data-testid": "chat-send" },
    [el("span", { class: "tm-chat-send-glyph", "aria-hidden": "true" }, [lineIcon("send", { size: 20 })])],
  );
  const form = el("form", { class: "tm-chat-composer", "data-testid": "chat-composer" }, [input, sendBtn]);

  const syncEnabled = () => { sendBtn.disabled = !core.validateDraft(input.value).canSend; };
  input.addEventListener("input", syncEnabled);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    send(id, form, input, sendBtn);
  });
  return form;
}

/** The disabled compose state: a clear, quiet reason line in place of the input (muted/removed/closed/admin). */
function disabledComposer(reason) {
  return el("div", { class: "tm-chat-composer tm-chat-composer--off", "data-testid": "chat-composer-disabled" }, [
    lineIcon("chat", { size: 18, strokeWidth: 1.6 }),
    el("p", { class: "tm-chat-composer-reason", text: reason || "You can't post in this conversation." }),
  ]);
}

/**
 * Send the current draft: validate, show an optimistic bubble immediately, POST, then either confirm
 * (swap the echo for the server's message) or handle the failure. A permanent rejection (muted / removed
 * / closed / gone) LOCKS the composer with the backend's reason; a transient blip keeps the draft and
 * offers a retry toast. Guards against double-send (Enter held / rapid clicks) via `thread.sending`.
 */
async function send(id, form, input, sendBtn) {
  if (thread.sending || thread.id !== String(id)) return;
  const draft = core.validateDraft(input.value);
  if (!draft.canSend) return;

  thread.sending = true;
  sendBtn.disabled = true;
  input.value = "";
  const localId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  thread.pending.push(core.pendingMessage(draft.value, { localId }));
  repaintBody(); // optimistic echo, dimmed + "Sending…"

  try {
    const saved = await postConversationMessage(id, draft.value);
    if (thread.id !== String(id)) return; // navigated away mid-send — drop silently
    thread.pending = thread.pending.filter((p) => p.id !== localId);
    const model = core.toThreadMessage(saved);
    thread.mineIds.add(model.id); // keep it out-going for the rest of the session
    thread.messages = core.upsertMessage(thread.messages, model);
    repaintBody();
  } catch (err) {
    if (thread.id !== String(id)) return;
    thread.pending = thread.pending.filter((p) => p.id !== localId); // roll the echo back
    const outcome = core.classifyPostError(err);
    if (outcome.locked) {
      lockComposer(form, outcome.reason);
    } else {
      input.value = draft.value; // restore the draft so the caller can retry / fix
      sendBtn.disabled = !core.validateDraft(input.value).canSend;
      toast(outcome.message, { type: "error" });
    }
    repaintBody();
    console.warn("[chat] post failed:", err?.status ?? "", err?.message ?? err);
  } finally {
    // Only clear the guard if we're still on this thread — a mid-send nav to another thread already
    // reset it for that thread, and this late resolver must not stomp the new thread's send state.
    if (thread.id === String(id)) thread.sending = false;
  }
}

/** Replace the live composer with the disabled reason state, in place — the caller is muted/removed/closed. */
function lockComposer(form, reason) {
  const off = disabledComposer(reason);
  if (form && form.parentNode) form.replaceWith(off);
}

/* ─────────────────────────────── Near-live refresh (poll — TM-448) ────────────────────────────── */

/** Start the open-thread poll (idempotent — clears any prior timer first). */
function startThreadPoll(id) {
  stopThreadPoll();
  if (typeof window === "undefined") return;
  thread.poll = window.setInterval(() => pollThread(id), THREAD_POLL_MS);
}

/** Stop the open-thread poll. */
function stopThreadPoll() {
  if (thread.poll != null && typeof window !== "undefined") window.clearInterval(thread.poll);
  thread.poll = null;
}

/**
 * One poll tick / push-triggered refresh: refetch the thread and repaint ONLY if it changed (cheap
 * signature compare, so scroll + typing survive an unchanged tick). Self-heals: stops itself if we've
 * navigated off this thread, and skips while a send is in flight so it can't race the optimistic echo.
 * Best-effort — a transient failure just leaves the last paint (never throws, never breaks nav).
 */
async function pollThread(id) {
  id = String(id);
  const onThread = typeof location === "undefined" || location.hash.startsWith("#/chat/");
  if (thread.id !== id || !onThread) return stopThreadPoll();
  if (thread.sending) return;
  let data;
  try {
    data = await getConversationMessages(id);
  } catch (err) {
    console.warn("[chat] thread poll failed:", err?.message ?? err);
    return;
  }
  if (thread.id !== id) return;
  const next = core.toThreadMessages(data?.items);
  if (core.threadSignature(next) === core.threadSignature(thread.messages)) return; // nothing new
  thread.messages = next;
  repaintBody();
}

/** Attach the foreground-push → immediate poll listener exactly once (mirrors the tab-badge's wire()). */
function wirePush() {
  if (pushWired || typeof window === "undefined") return;
  // A foreground chat push (TM-374) dispatches this; refresh the open thread so a new message lands now.
  window.addEventListener("tm:notification", () => { if (thread.id) pollThread(thread.id); });
  pushWired = true;
}

/**
 * The conversation title + sub-line for the thread header, resolved from the cached list when we have
 * it (e.g. arrived via a list tap) and degrading to a neutral "Chat" on a cold deep-link.
 */
function threadMeta(id) {
  const row = state.rows.find((r) => r.id === String(id));
  // typeKey drives the composer's up-front availability (admin broadcasts are read-only). On a cold
  // deep-link (cache miss) it's null → the composer defaults to enabled and any post-time block
  // (muted / removed / closed / admin) surfaces via classifyPostError on the first send.
  if (!row) return { title: "Chat", sub: "", typeKey: null };
  return { title: row.title, sub: row.type.key === "admin" ? "Admin messages" : "Event chat", typeKey: row.type.key };
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
 * messages render as a bubble with the body, a time stamp and any read-only reaction pills. `mine`
 * (a pending echo, or a message we posted this session) draws it out-going (right-aligned, accent wash)
 * — best-effort, since the read API can't tell us which loaded messages are ours. A pending echo is
 * dimmed and stamped "Sending…" until its POST confirms.
 * @param {Object} m the message view-model (from chat-core).
 * @param {boolean} mine whether to render it as an out-going bubble.
 */
function messageRow(m, mine = false) {
  if (m.system) {
    return el("div", { class: "tm-chat-system", "data-testid": "chat-system" }, [
      el("span", { class: "tm-chat-system-text", text: m.body }),
    ]);
  }

  const side = mine ? "tm-chat-msg tm-chat-msg--out" : "tm-chat-msg tm-chat-msg--in";
  const row = el("div", {
    class: m.pending ? `${side} tm-chat-msg--pending` : side,
    "data-testid": m.pending ? "chat-msg-pending" : "chat-msg",
  });
  row.append(el("div", { class: "tm-chat-bub", text: m.body }));
  if (m.pending) row.append(el("div", { class: "tm-chat-stamp" }, [el("span", { text: "Sending…" })]));
  else if (m.timeLabel) row.append(el("div", { class: "tm-chat-stamp" }, [el("span", { text: m.timeLabel })]));
  // Read-only reaction pills (no picker yet): surface whatever the API returned.
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
