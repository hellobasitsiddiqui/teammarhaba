// Chat section — DOM view (TM-438 read + TM-448 compose + TM-445 one-way admin render), reading/writing
// the F2 conversation API.
//
// TM-445 layers the one-way ADMIN_BROADCAST presentation on top: an admin thread carries the "Admin"
// type badge in its head, its messages render as centred "from TeamMarhaba" notices (not bubbles) with
// the optional in-app deep-link surfaced as a tap-through CTA, and the composer stays disabled (TM-448
// already returns it read-only for the admin type) — so a user can re-read + act on a broadcast in the
// chat section after the push is gone. The "from TeamMarhaba" attribution + CTA are driven per-message
// by the `system` flag (senderId == null), so they're robust even on a cold deep-link where the
// conversation `type` isn't cached; the head badge is type-driven from the cached list row.
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

import { clear, el, modal, toast } from "./ui.js";
import { avatar, badge, reaction, tag } from "./components.js";
import { lineIcon } from "./icons.js";
import {
  listMyConversations,
  getConversationMessages,
  getConversationMembers,
  markConversationRead,
  postConversationMessage,
  postConversationAnnouncement,
  getMe,
  editConversationMessage,
  deleteConversationMessage,
  signalTyping,
  openConversationStream,
  muteConversation,
  unmuteConversation,
  leaveConversation,
  rejoinConversation,
  reactToMessage,
  unreactFromMessage,
  getLinkPreview,
} from "./api.js";
// TM-736: the admin-flag cache resets on every auth change (see viewerAdminFlag below), so a flag
// resolved before the ADMIN claim was live — or for a previous user — can't stick for the session.
import { onAuthChanged } from "./auth.js";
import * as core from "./chat-core.js";
// TM-470 link previews: pure URL-detection + response-normalisation core (see the delimited
// `=== TM-470 link preview ===` hook further down, which mounts the card and calls the endpoint).
import * as linkPreview from "./chat-linkpreview-core.js";
// @mentions (TM-469): the pure parse/segment/autocomplete core. The composer autocomplete + the
// in-message highlight below are the DOM half; all the mention LOGIC (who's mentioned, how to rank
// candidates, how to splice a pick back in) lives in this framework-free module.
import * as mentions from "./chat-mentions-core.js";
// In-thread search (TM-690, rich-chat v1): the pure client-side match/highlight core. The header
// "Search" toggle + results panel below are the DOM half; all the search LOGIC lives in this
// framework-free, node-tested module.
import { searchMessages, queryTokens, highlightSegments, snippet } from "./chat-search-core.js";
// TM-585: drive the Chat-tab unread badge's drop from the mark-read path itself. Opening a thread marks
// it read, but the router's concurrent unread-total GET races that POST and re-reads the pre-mark total,
// so we drop the badge optimistically the moment a thread is read, then reconcile once the POST commits.
import { noteThreadRead, refreshChatTabBadge } from "./chat-tab-badge.js";

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
// It is the belt-and-braces backstop under the TM-464 live stream: when the SSE stream is up, new
// messages arrive instantly; the poll still runs so a dropped/refused stream self-heals within a tick.
const THREAD_POLL_MS = 15000;

// The currently-open thread's live state. `messages` is the server-authoritative list (replaced on load
// + each poll, folded into by each live SSE frame); `pending` holds optimistic bubbles awaiting their
// POST; `mineIds` remembers the ids we posted this session so they keep rendering as out-going (the read
// API can't tell us which are "mine", so this is best-effort within the session). `sending` pauses the
// poll during a send so it can't race the optimistic echo. `bodyEl` is repainted on change; the composer
// input persists across body repaints.
const thread = { id: null, messages: [], pending: [], mineIds: new Set(), sending: false, poll: null, bodyEl: null,
  // Reply / quote (TM-466): `replyTo` is the composer's active reply target ({ id, excerpt, ... } from
  // core.replyTargetFrom) or null; `composerInput` / `replyPreviewEl` are refs so beginReply/clearReply
  // can toggle the composer's quoted-preview bar and re-focus the input across body repaints.
  replyTo: null, composerInput: null, replyPreviewEl: null,
  // Reactions (TM-462): in-flight `${messageId}:${emoji}` keys, so a rapid double-tap on the same chip
  // is ignored while its react/un-react round-trip is pending (the optimistic paint already reflects it).
  reacting: new Set(),
  // Edit own message (TM-467): `editingId` is the id of the message whose inline editor is open (null =
  // none), `editDraft` its in-progress text (kept off the DOM so a background repaint doesn't lose it),
  // `savingEdit` guards a double-submit + pauses the poll while an edit is in flight (like `sending`).
  editingId: null, editDraft: "", savingEdit: false,
  // Typing indicators (TM-465): `typists` is the live "who's typing" list folded from received `typing`
  // SSE events (each { userId, name, expiresAt }, expired by the ticker); `typingEl` is the persistent
  // indicator line under the body; `typingTimer` is the 1s expiry ticker; `lastTypingSentAt` debounces
  // our OWN outgoing signal (epoch-ms of the last one we sent, 0 = none this composing burst).
  typists: [], typingEl: null, typingTimer: null, lastTypingSentAt: 0,
  // @mentions (TM-469): `members` is the thread's mentionable roster ([{ userId, displayName, role }]
  // from GET /conversations/{id}/members), loaded best-effort once per thread open. It feeds BOTH the
  // composer's @mention autocomplete and the in-message highlight (a mention only chips up if its member
  // is in this list). `mentionBox` is the live autocomplete dropdown element (null when closed).
  members: [], mentionBox: null,
  // Admin announcements (TM-710): `announceMode` is whether the admin composer is currently set to post
  // an ANNOUNCEMENT (vs an ordinary message). Only ever true for an admin viewer on an event group chat;
  // toggled by the composer's announcement switch and reset on each thread open.
  announceMode: false };
let pushWired = false; // the foreground-push → poll listener is attached exactly once

// The viewer's admin flag (TM-710), cached per signed-in user — drives whether the event-chat composer
// offers the "Send as announcement" affordance. Resolved best-effort from GET /me so a failed lookup
// simply hides the affordance (a non-admin can't post an announcement anyway — the server gate is
// authoritative). TM-736: the cache is INVALIDATED on every auth change (mirroring appearance-sync.js /
// nav-avatar.js) — a flag resolved before the ADMIN claim was live (a boot/auth race), or under a
// previous user on the same session, must not stick as a stale `false` and suppress the toggle. The
// pure cache logic lives in chat-core.createAdminFlagCache (node-tested); this is just the wiring.
const viewerAdminFlag = core.createAdminFlagCache(getMe);
onAuthChanged(() => viewerAdminFlag.invalidate());

/** Resolve whether the viewer is an admin, best-effort — a failure leaves the affordance hidden. */
const resolveViewerIsAdmin = viewerAdminFlag.resolve;

// The live chat stream (TM-464) for the OPEN thread, or null. A thread view opens one so new messages
// appear instantly without waiting for the poll; navigating away (or into another thread) closes it.
// Best-effort and purely additive over the poll: if it never connects, the fetched history + the 15s
// poll re-sync is the graceful fallback, so nothing is ever delivered ONLY over the socket.
let liveStream = null;

/** End the live chat stream if one is open — called on every navigation so a left thread stops streaming. */
function closeLiveStream() {
  if (liveStream) {
    liveStream.close();
    liveStream = null;
  }
  // Tear down the typing indicator too (TM-465): stop the expiry ticker and forget any typists, so a
  // left thread neither keeps ticking nor carries a stale "X is typing…" into the next view.
  stopTypingExpiry();
  thread.typists = [];
  thread.lastTypingSentAt = 0;
}

/**
 * Router entry (TM-109). `threadId` is the conversation id parsed from `#/chat/{id}`, or null/empty
 * for the `#/chat` list. Re-invoked on every entry so list↔thread↔another-thread navigation always
 * repaints with fresh data (mirrors enterEvents).
 * @param {?string} threadId
 */
export function enterChat(threadId) {
  const view = $("chat-view");
  if (!view) return;
  closeLiveStream(); // a fresh navigation ends any prior thread's live stream before repainting
  if (threadId != null && threadId !== "") renderThread(view, String(threadId));
  else renderList(view);
}

/* ─────────────────────────────── Shared chrome / states ───────────────────────────────────────── */

/** The list top bar: just the "Chats" title (a top-level tab, no back button). */
function listHeader() {
  return el("header", { class: "tm-chat-head" }, [el("h2", { class: "tm-chat-title", text: "Chats" })]);
}

/**
 * The thread top bar: back to the list + the conversation title + a type sub-line, and — on the loaded
 * thread — the self-service actions (mute / leave, TM-471). For a known admin broadcast (TM-445) the
 * head also carries the "Admin" type badge next to the title and an accent modifier class, so the
 * one-way "from TeamMarhaba" channel is visibly distinct from an event chat (mirrors the type badge the
 * unified list already shows on each row). `actions` is a node or null (the loading/error states pass
 * none, as does an admin thread which has no self-service controls), and `el()` skips null children so
 * it's safely optional.
 */
function threadHeader(meta, actions = null) {
  const admin = meta.typeKey === "admin";
  const heading = el("div", { class: "tm-chat-thread-heading" }, [
    el("div", { class: "tm-chat-thread-titlerow" }, [
      el("h2", { class: "tm-chat-thread-title", text: meta.title }),
      admin ? typeBadge(core.conversationBadge("ADMIN_BROADCAST")) : null,
    ]),
    el("p", { class: "tm-chat-thread-sub", text: meta.sub }),
  ]);
  return el("header", { class: admin ? "tm-chat-thread-head tm-chat-thread-head--admin" : "tm-chat-thread-head" }, [
    el("a", { class: "tm-chat-back", href: "#/chat", "aria-label": "Back to chats" }, [
      el("span", { class: "tm-chat-back-glyph", "aria-hidden": "true", text: "←" }),
    ]),
    heading,
    actions,
  ]);
}

/**
 * The thread self-service controls (TM-471): a mute/unmute toggle, plus (for an event chat) a leave
 * button. State is seeded from the cached list row (best-effort on a cold deep-link — the endpoints are
 * the source of truth and each returns the fresh state, so a wrong-way default self-corrects on the
 * first action). Muting keeps the caller a full member (this thread's push is just silenced); leaving
 * hides the thread and returns the caller to the list (their event RSVP is untouched).
 */
function buildThreadActions(id, typeKey) {
  const row = state.rows.find((r) => r.id === String(id));
  const controls = core.membershipControls({ muted: row?.muted, left: row?.left });
  let muted = controls.muted;

  const muteText = el("span", { class: "tm-chat-thread-action-text", text: muted ? "Unmute" : "Mute" });
  const muteBtn = el(
    "button",
    {
      class: "tm-chat-thread-action",
      type: "button",
      "data-testid": "chat-mute",
      "aria-label": muted ? "Unmute notifications" : "Mute notifications",
      onClick: () => toggleMute(),
    },
    [muteText],
  );

  async function toggleMute() {
    muteBtn.disabled = true;
    try {
      const fresh = muted ? await unmuteConversation(id) : await muteConversation(id);
      muted = Boolean(fresh.notificationsMuted);
      if (row) row.muted = muted;
      muteText.textContent = muted ? "Unmute" : "Mute";
      muteBtn.setAttribute("aria-label", muted ? "Unmute notifications" : "Mute notifications");
      toast(muted ? "Notifications muted for this chat." : "Notifications back on.", { type: "success" });
    } catch (err) {
      toast("Couldn't update notifications. Please try again.", { type: "error" });
      console.warn("[chat] mute toggle failed:", err?.status ?? "", err?.message ?? err);
    } finally {
      muteBtn.disabled = false;
    }
  }

  // Leaving an announcements channel makes no sense (you can only mute it), so the leave button is
  // event-chat-only; a cold deep-link (unknown type) still offers it since it's most likely an event.
  const leaveBtn =
    typeKey === "admin"
      ? null
      : el(
          "button",
          {
            class: "tm-chat-thread-action tm-chat-thread-action--leave",
            type: "button",
            "data-testid": "chat-leave",
            "aria-label": "Leave this chat",
            onClick: (e) => doLeave(e.currentTarget),
          },
          [el("span", { class: "tm-chat-thread-action-text", text: "Leave" })],
        );

  async function doLeave(btn) {
    btn.disabled = true;
    try {
      await leaveConversation(id);
      if (row) row.left = true;
      toast("You left this chat. You're still going to the event.", { type: "success" });
      if (typeof location !== "undefined") location.hash = "#/chat"; // back to the list (now a rejoin row)
    } catch (err) {
      btn.disabled = false;
      // A 409 carries an honest reason (e.g. the organiser can't leave their own thread).
      toast(err?.message || "Couldn't leave this chat. Please try again.", { type: "error" });
      console.warn("[chat] leave failed:", err?.status ?? "", err?.message ?? err);
    }
  }

  return el("div", { class: "tm-chat-thread-actions", "data-testid": "chat-thread-actions" }, [muteBtn, leaveBtn]);
}

/**
 * In-thread search (TM-690, rich-chat v1). A header "Search" toggle reveals a panel that filters THIS
 * thread's already-loaded messages (client-side, via chat-search-core) and lists the hits with the
 * match highlighted; tapping a result jumps to it in the thread (reusing scrollToMessage's smooth-scroll
 * + flash). Purely additive: it reads `thread.messages` and touches nothing in the render / SSE
 * pipeline. Covers the loaded thread only — global / full-history search is a separate backend-index
 * ticket (TM-692). Returns { button, panel } so renderThread can put the toggle in the header actions
 * and the panel just below the header.
 */
function createThreadSearch() {
  const input = el("input", {
    class: "tm-chat-search-input",
    type: "search",
    placeholder: "Search this chat…",
    "aria-label": "Search this chat",
    autocomplete: "off",
    enterkeyhint: "search",
    "data-testid": "chat-search-input",
  });
  const count = el("p", { class: "tm-chat-search-count", "data-testid": "chat-search-count" });
  const results = el("ul", { class: "tm-chat-search-results", "data-testid": "chat-search-results" });
  const panel = el("div", { class: "tm-chat-search", hidden: true, "data-testid": "chat-search" }, [input, count, results]);

  function renderResults() {
    const query = input.value;
    const tokens = queryTokens(query);
    clear(results);
    if (!tokens.length) {
      count.textContent = "";
      return;
    }
    const hits = searchMessages(thread.messages, query);
    if (!hits.length) {
      count.textContent = "";
      results.append(el("li", { class: "tm-chat-search-empty", text: "No messages found." }));
      return;
    }
    count.textContent = hits.length === 1 ? "1 match" : `${hits.length} matches`;
    for (const m of hits) {
      const line = el(
        "span",
        { class: "tm-chat-search-snippet" },
        highlightSegments(snippet(m.body, tokens), tokens).map((s) =>
          s.hit ? el("mark", { text: s.text }) : el("span", { text: s.text }),
        ),
      );
      results.append(
        el("li", {}, [
          el(
            "button",
            {
              class: "tm-chat-search-result",
              type: "button",
              onClick: () => {
                close();
                scrollToMessage(m.id);
              },
            },
            [line, m.timeLabel ? el("span", { class: "tm-chat-search-time", text: m.timeLabel }) : null],
          ),
        ]),
      );
    }
  }

  function open() {
    panel.hidden = false;
    button.setAttribute("aria-expanded", "true");
    input.focus();
    renderResults();
  }
  function close() {
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
  }

  input.addEventListener("input", renderResults);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      input.value = "";
      close();
    }
  });

  const button = el(
    "button",
    {
      class: "tm-chat-thread-action tm-chat-thread-action--search",
      type: "button",
      "data-testid": "chat-search-toggle",
      "aria-label": "Search this chat",
      "aria-expanded": "false",
      onClick: () => (panel.hidden ? open() : close()),
    },
    [el("span", { class: "tm-chat-thread-action-text", text: "Search" })],
  );

  return { button, panel };
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
  // A thread the caller has self-left (TM-471) is rendered as a de-emphasised "you left — rejoin" row
  // (the AC's rejoin affordance) rather than an openable link — opening it would 403 until they rejoin.
  if (row.left) return leftRow(row);
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
        // A muted thread (TM-471) shows a small bell-off glyph so the silence is discoverable.
        row.muted
          ? el("span", {
              class: "tm-chat-row-muted",
              "aria-label": "Notifications muted",
              title: "Notifications muted",
              text: "🔕",
            })
          : null,
        row.timeLabel ? el("span", { class: "tm-chat-row-time", text: row.timeLabel }) : null,
        // Per-row unread count. This IN-LIST badge caps at 99+ (the shared `badge()` component's
        // convention) — DELIBERATELY higher than the bottom-nav Chat-tab badge + the header notification
        // bell, which cap at 9+ (BADGE_CAP, notification-bell-core.js). The difference is intentional
        // (TM-586): the tab/bell are glanceable NAV CHROME pills where a low 9+ cap keeps a tiny chip
        // readable and the two stay in deliberate parity, whereas a per-conversation row shows a fuller
        // count (e.g. "42") because the extra precision is useful when scanning the list itself.
        row.unread > 0 ? badge(row.unread) : null,
      ]),
    ],
  );
}

/** A row for a thread the caller has self-left (TM-471): shows the title + a Rejoin button, not a link. */
function leftRow(row) {
  const rejoinBtn = el(
    "button",
    { class: "tm-btn tm-chat-rejoin", type: "button", "data-testid": "chat-rejoin", onClick: (e) => rejoin(row, e.currentTarget) },
    "Rejoin",
  );
  return el(
    "div",
    { class: "tm-chat-row tm-chat-row--left", "data-testid": "chat-row-left", dataset: { threadId: row.id, type: row.type.key } },
    [
      avatar(row.avatar),
      el("div", { class: "tm-chat-row-mid" }, [
        el("div", { class: "tm-chat-row-name" }, [
          el("span", { class: "tm-chat-row-name-text", text: row.title }),
          typeBadge(row.type),
        ]),
        el("span", { class: "tm-chat-row-preview" }, [
          el("span", { class: "tm-chat-row-preview-text", text: "You left this chat" }),
        ]),
      ]),
      el("div", { class: "tm-chat-row-meta" }, [rejoinBtn]),
    ],
  );
}

/** Rejoin a self-left thread (TM-471), then open it. A 409 (no longer attending) surfaces as a toast. */
async function rejoin(row, btn) {
  btn.disabled = true;
  try {
    await rejoinConversation(row.id);
    row.left = false;
    if (typeof location !== "undefined") location.hash = `#/chat/${encodeURIComponent(row.id)}`;
  } catch (err) {
    btn.disabled = false;
    toast(err?.message || "Couldn't rejoin this chat. Please try again.", { type: "error" });
    console.warn("[chat] rejoin failed:", err?.status ?? "", err?.message ?? err);
  }
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

  // Fresh thread state — a new open resets the optimistic queue + the "mine" memory + any reply target.
  thread.id = id;
  thread.messages = core.toThreadMessages(data?.items);
  thread.pending = [];
  thread.mineIds = new Set();
  thread.sending = false;
  thread.replyTo = null; // no reply-in-progress carried across a thread open (TM-466)
  thread.canCompose = false; // set by buildComposer; gates the per-message reply + react affordances
  thread.composerInput = null;
  thread.replyPreviewEl = null;
  thread.reacting = new Set(); // no in-flight reaction toggles carried across a thread open (TM-462)
  thread.editingId = null; // no inline edit carried across a thread open (TM-467)
  thread.editDraft = "";
  thread.savingEdit = false;
  thread.typists = []; // no typists carried across a thread open (TM-465)
  thread.lastTypingSentAt = 0; // fresh debounce window for our own outgoing typing signal
  thread.members = []; // @mention roster (TM-469) — loaded best-effort just below
  thread.mentionBox = null; // no autocomplete open on a fresh thread

  const body = el("div", { class: "tm-chat-body", "data-testid": "chat-thread" });
  thread.bodyEl = body;
  const typingIndicator = buildTypingIndicator();
  thread.typingEl = typingIndicator;
  const compose = buildComposer(id, meta);

  // The loaded thread carries the self-service actions (mute / leave, TM-471) in its header. The typing
  // indicator (TM-465) sits between the message body and the composer, so "X is typing…" reads directly
  // above where you're about to reply.
  // In-thread search (TM-690): the "Search" toggle joins the header actions; its results panel sits
  // directly under the header, above the message body.
  const searchUi = createThreadSearch();
  const actions = buildThreadActions(id, meta.typeKey);
  actions.insertBefore(searchUi.button, actions.firstChild);
  clear(view).append(threadHeader(meta, actions), searchUi.panel, body, typingIndicator, compose);
  repaintBody(); // paints the loaded messages (or the empty state) + scrolls to the newest
  wirePush(); // foreground-push → immediate poll while a thread is open
  startThreadPoll(id);
  startTypingExpiry(); // TM-465: expire stale typists on a 1s ticker while the thread is open
  markThreadRead(id);
  openLiveThread(id, mine); // TM-464: live SSE append on top of the poll (best-effort)
  loadMentionRoster(id, mine); // TM-469: fetch the mentionable member list for autocomplete + highlight
}

/**
 * Load the thread's mentionable roster (TM-469) in the background and, once it arrives, repaint the body
 * so already-rendered messages pick up their mention highlights (a message referencing a member can only
 * chip up once we know that member). Best-effort and race-guarded by the render token: a stale response
 * from a thread we've since navigated away from is dropped, and any failure (e.g. a 403 the gate should
 * never produce for a member) just leaves `members` empty — the composer autocomplete then offers only
 * @everyone/@here and mentions render as plain text, so the thread never breaks on this.
 */
async function loadMentionRoster(id, mine) {
  let roster;
  try {
    roster = await getConversationMembers(id);
  } catch (err) {
    console.warn("[chat] mention roster load failed:", err?.message ?? err);
    return;
  }
  if (mine !== renderToken || thread.id !== String(id)) return; // navigated away — drop the stale roster
  thread.members = Array.isArray(roster) ? roster : [];
  repaintBody(); // re-render so loaded messages gain their mention highlights now the roster is known
}

/**
 * Open the live SSE stream (TM-464) for the just-rendered thread, folding each broadcast message into
 * the thread's authoritative state as it arrives. Best-effort — a stream that never connects simply
 * leaves the fetched history + the 15s poll in place (graceful fallback), so this never surfaces an
 * error to the user and nothing is ever delivered ONLY over the socket.
 *
 * Integration with TM-448's optimistic-echo + poll model: rather than appending straight to the DOM
 * with its own "seen" set (which would double-render against the poll's repaint and a confirmed own
 * send), a live frame is folded into `thread.messages` via {@link core.upsertMessage} — which replaces
 * any existing copy BY ID — and the body is then repainted from the single source of truth
 * (`thread.messages` + `thread.pending`). So the poster's own broadcast echo, a reconnect replay, and a
 * poll that also fetched the message all collapse to one bubble. `repaintBody` preserves scroll + the
 * persistent composer, so a live append can't yank someone reading history. The renderToken + thread.id
 * guards drop any frame that arrives after the user has navigated away.
 *
 * @param {string} id the open conversation id.
 * @param {number} token the renderToken snapshot for this render (stale frames are dropped).
 */
function openLiveThread(id, token) {
  liveStream = openConversationStream(id, {
    onMessage: (raw) => {
      // Drop late frames: a navigation away (new renderToken) or a switch to another thread.
      if (token !== renderToken || thread.id !== String(id)) return;
      const m = core.toThreadMessage(raw);
      if (!m.id) return; // a frame without an id can't be de-duped safely — skip it
      // De-dupe by id: upsertMessage replaces any existing copy, so an own-echo, a replay, or a
      // poll-fetched duplicate never renders twice. Then repaint from the one source of truth.
      thread.messages = core.upsertMessage(thread.messages, m);
      repaintBody();
    },
    // Live edit (TM-467): an author reworded a message — apply it as a body/editedAt PATCH to the copy we
    // already hold (preserving its reactions / receipt / reply quote), never a whole-row replace. Skip if
    // we're mid-edit on that same message (our own optimistic edit already reflects it).
    onEdited: (raw) => {
      if (token !== renderToken || thread.id !== String(id)) return; // drop late/other-thread frames
      const patchId = String(raw?.id ?? "");
      if (!patchId || thread.editingId === patchId) return;
      thread.messages = core.applyMessageEdit(thread.messages, {
        id: patchId, body: raw?.body, editedAt: raw?.editedAt,
      });
      repaintBody();
    },
    // Live delete (TM-467): an author took a message back — drop it from the open thread by id. If we were
    // editing that message, close the editor too so it doesn't dangle over a now-gone message.
    onDeleted: (raw) => {
      if (token !== renderToken || thread.id !== String(id)) return; // drop late/other-thread frames
      const goneId = String(raw?.messageId ?? raw?.id ?? "");
      if (!goneId) return;
      if (thread.editingId === goneId) { thread.editingId = null; thread.editDraft = ""; }
      thread.mineIds.delete(goneId);
      thread.messages = core.removeMessageById(thread.messages, goneId);
      repaintBody();
    },
    // Typing indicator (TM-465): fold each received `typing` signal into the typist list (keyed + expiring
    // in chat-core) and repaint the "X is typing…" line. Ephemeral — never touches thread.messages, so it
    // can't affect the durable timeline. The typist is excluded server-side, so this is never our own.
    onTyping: (raw) => {
      if (token !== renderToken || thread.id !== String(id)) return; // drop late/other-thread frames
      thread.typists = core.applyTypingEvent(thread.typists, raw, Date.now());
      paintTyping();
    },
    // A dropped/refused stream is non-fatal: the history is already loaded and re-syncs via the poll.
    onError: (err) => console.warn("[chat] live stream unavailable:", err?.message ?? err),
  });
}

/* ─────────────────────────────── Typing indicator (TM-465) ─────────────────────────────────────── */

/** The persistent "X is typing…" line under the thread body — hidden until someone's typing. */
function buildTypingIndicator() {
  return el("div", { class: "tm-chat-typing", "data-testid": "chat-typing", hidden: true, "aria-live": "polite" }, [
    el("span", { class: "tm-chat-typing-text" }),
  ]);
}

/**
 * Repaint the typing line from `thread.typists`: the aggregated label ("X is typing…", "X and Y are
 * typing…", "X, Y and N others are typing…") from chat-core, or hidden when nobody is typing. Pure
 * reflection of state, so both a received signal and the expiry ticker route through here.
 */
function paintTyping() {
  const box = thread.typingEl;
  if (!box) return;
  const label = core.typingLabel(thread.typists, Date.now());
  const text = box.querySelector(".tm-chat-typing-text");
  if (text) text.textContent = label;
  box.hidden = label === "";
}

/** Start the 1s ticker that expires stale typists and repaints (idempotent — clears any prior first). */
function startTypingExpiry() {
  stopTypingExpiry();
  if (typeof window === "undefined") return;
  thread.typingTimer = window.setInterval(() => {
    const before = thread.typists.length;
    thread.typists = core.pruneTypists(thread.typists, Date.now());
    // Only repaint when the set actually shrank — an unchanged tick leaves the DOM (and label) alone.
    if (thread.typists.length !== before) paintTyping();
  }, 1000);
}

/** Stop the typing-expiry ticker. */
function stopTypingExpiry() {
  if (thread.typingTimer != null && typeof window !== "undefined") window.clearInterval(thread.typingTimer);
  thread.typingTimer = null;
}

/**
 * Handle a keystroke in the composer (TM-465): while there's text, send a DEBOUNCED "I'm typing" signal
 * (at most one every core.TYPING_DEBOUNCE_MS, decided by core.shouldSignalTyping); when the box is
 * cleared, send an explicit "stopped" so others' indicators clear at once. Best-effort — signalTyping
 * never throws.
 */
function handleTypingInput(id, value) {
  if (value.trim().length === 0) {
    stopOutgoingTyping(id); // box emptied → clear others' indicator immediately
    return;
  }
  const now = Date.now();
  if (core.shouldSignalTyping(thread.lastTypingSentAt, now)) {
    thread.lastTypingSentAt = now;
    signalTyping(id, true); // fire-and-forget; the debounce keeps this to ~one call per window
  }
}

/** Send an explicit "stopped typing" signal if we'd started one this burst, and reset the debounce. */
function stopOutgoingTyping(id) {
  if (!thread.lastTypingSentAt) return; // never signalled this burst — nothing to stop
  thread.lastTypingSentAt = 0;
  signalTyping(id, false);
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
  // A message renders out-going when it's a pending echo, one we posted this session (`mineIds`), the
  // server flagged it `mine` (TM-589 — the direct own-message signal), OR it carries a read receipt
  // (which the server only attaches to the caller's OWN messages, TM-463). Any of these is an authoritative
  // "mine" signal for a loaded message (not just this session); it also gates the edit/delete affordances.
  for (const m of all) {
    const mine = Boolean(m.pending) || thread.mineIds.has(m.id) || Boolean(m.mine) || Boolean(m.readReceipt);
    body.append(messageRow(m, mine));
  }
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
  thread.canCompose = avail.canPost; // gates the per-message reply affordance (TM-466)
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
  // Admin announcements (TM-710): an admin viewing an EVENT group chat gets a "Send as announcement"
  // toggle. Off = an ordinary message (the member-gated post); on = an ANNOUNCEMENT via the admin
  // endpoint. Wired asynchronously (the role lookup is a promise) and purely additive — it's absent for
  // a non-admin or an admin-broadcast thread, so the ordinary composer is untouched for everyone else.
  // The server gate is authoritative regardless of what this toggle shows.
  thread.announceMode = false; // reset per composer build (per thread open)
  const announceBar = el("div", { class: "tm-chat-announce-bar", hidden: true, "data-testid": "chat-announce-bar" });
  maybeMountAnnounceToggle(id, meta, announceBar);
  const sendBtn = el(
    "button",
    { class: "tm-chat-send", type: "submit", "aria-label": "Send", disabled: true, "data-testid": "chat-send" },
    [el("span", { class: "tm-chat-send-glyph", "aria-hidden": "true" }, [lineIcon("send", { size: 20 })])],
  );
  // Reply / quote (TM-466): a quoted-preview bar shown above the input while replying; hidden otherwise.
  // Kept as a persistent node (like the input) so it survives message-list repaints.
  const replyPreview = el("div", { class: "tm-chat-reply-bar", hidden: true, "data-testid": "chat-reply-bar" });
  // @mentions (TM-469): the autocomplete dropdown, absolutely positioned above the input (see the CSS
  // block). Kept in the form so it survives message-list repaints; empty + hidden until an '@token' opens
  // it. `role=listbox` + child `role=option` buttons make it keyboard- and screen-reader-navigable.
  const mentionBox = el("div", {
    class: "tm-chat-mention-box", hidden: true, role: "listbox",
    "aria-label": "Mention a member", "data-testid": "chat-mention-box",
  });
  const form = el("form", { class: "tm-chat-composer", "data-testid": "chat-composer" }, [announceBar, mentionBox, replyPreview, input, sendBtn]);
  thread.composerInput = input;
  thread.replyPreviewEl = replyPreview;
  thread.mentionBox = mentionBox;
  paintReplyPreview(); // reflect any pre-existing reply target (normally none on a fresh composer)

  const syncEnabled = () => { sendBtn.disabled = !core.validateDraft(input.value).canSend; };
  // TM-469: drive the @mention autocomplete from the same input. `mentionAutocomplete` owns the dropdown
  // state (candidates / active row / the '@token' span being edited) and returns the handlers the input
  // needs; keeping it a small controller keeps buildComposer readable.
  const ac = mentionAutocomplete(id, input, mentionBox, syncEnabled);
  input.addEventListener("input", () => {
    syncEnabled();
    handleTypingInput(id, input.value); // TM-465: debounced typing signal while composing
    ac.refresh(); // TM-469: (re)open/close + rank the mention dropdown for the token under the caret
  });
  // TM-469: keyboard nav of the open dropdown — Arrow/Enter/Escape. When the dropdown is open, Enter
  // picks the active candidate (and must NOT submit the form); when it's closed the keydown is inert and
  // Enter submits as before.
  input.addEventListener("keydown", ac.onKeydown);
  // Close the dropdown when focus leaves the composer (a short delay lets a candidate mousedown land first).
  input.addEventListener("blur", () => window.setTimeout(ac.close, 150));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    ac.close(); // never submit with the dropdown still showing
    send(id, form, input, sendBtn);
  });
  return form;
}

/**
 * Mount the admin "Send as announcement" toggle (TM-710) into the composer, best-effort and async.
 * Only for an ADMIN viewer on an EVENT group chat (typeKey !== "admin"): an admin-broadcast thread is
 * already read-only/announcement-only, and a non-admin can't post an announcement (the server gates it).
 * Resolving the role is a promise, so this mutates the (already-mounted) `bar` once it settles; if the
 * viewer isn't an admin, or the thread was left meanwhile, it leaves the bar hidden — the ordinary
 * composer is entirely unchanged for everyone else.
 */
async function maybeMountAnnounceToggle(id, meta, bar) {
  if (meta.typeKey === "admin") return; // admin-broadcast threads have no attendee composer to augment
  const isAdmin = await resolveViewerIsAdmin();
  if (!isAdmin || thread.id !== String(id)) return; // not an admin, or navigated away mid-resolve
  const checkbox = el("input", {
    type: "checkbox", class: "tm-chat-announce-check", id: `chat-announce-${id}`,
    "data-testid": "chat-announce-toggle",
    onChange: (e) => {
      thread.announceMode = Boolean(e.target.checked);
      if (thread.composerInput) {
        thread.composerInput.placeholder = thread.announceMode ? "Post an announcement…" : "Message the group…";
      }
    },
  });
  bar.append(el("label", { class: "tm-chat-announce-label", for: `chat-announce-${id}` }, [
    checkbox,
    el("span", { class: "tm-chat-announce-glyph", "aria-hidden": "true", text: "📣" }),
    el("span", { text: "Send as announcement" }),
  ]));
  bar.hidden = false;
}

/* === TM-469 mentions === */

/**
 * The composer's @mention autocomplete controller. Wires the pure core (detect the '@token' under the
 * caret → rank candidates → splice a pick back in) to the DOM dropdown `box` over the compose `input`.
 * Returns the three handlers buildComposer attaches: {@code refresh} (on input), {@code onKeydown}
 * (Arrow/Enter/Escape nav) and {@code close} (blur/submit). State (the ranked candidates, the active
 * row, and the token range being replaced) is closure-scoped, so each composer owns its own dropdown.
 */
function mentionAutocomplete(id, input, box, syncEnabled) {
  let candidates = [];
  let active = -1;
  let range = null; // the { start, end } of the "@query" span the pick replaces

  function close() {
    candidates = [];
    active = -1;
    range = null;
    box.hidden = true;
    clear(box);
  }

  function paint() {
    clear(box);
    if (candidates.length === 0) {
      box.hidden = true;
      return;
    }
    candidates.forEach((c, i) => {
      const label = c.kind === "user" ? c.name : "@" + c.name;
      const hint = c.kind === "everyone" ? "Everyone in this chat" : c.kind === "here" ? "People online now" : null;
      box.append(el(
        "button",
        {
          class: i === active ? "tm-chat-mention-item is-active" : "tm-chat-mention-item",
          type: "button", role: "option", "aria-selected": i === active, "data-testid": "chat-mention-item",
          // mousedown (not click) so the pick fires BEFORE the input's blur closes the dropdown.
          onMousedown: (e) => { e.preventDefault(); choose(i); },
        },
        [
          el("span", { class: "tm-chat-mention-item-label", text: label }),
          hint ? el("span", { class: "tm-chat-mention-item-hint", text: hint }) : null,
        ],
      ));
    });
    box.hidden = false;
  }

  function choose(i) {
    const candidate = candidates[i];
    if (!candidate || !range) return;
    const spliced = mentions.applyMention(input.value, range, candidate);
    input.value = spliced.text;
    // Restore the caret just after the inserted "@name " so the user keeps typing inline.
    if (typeof input.setSelectionRange === "function") input.setSelectionRange(spliced.caret, spliced.caret);
    input.focus();
    close();
    syncEnabled();
    handleTypingInput(id, input.value); // keep the typing signal honest after the programmatic edit
  }

  function refresh() {
    const caret = typeof input.selectionStart === "number" ? input.selectionStart : input.value.length;
    const token = mentions.detectMentionQuery(input.value, caret);
    if (!token) {
      close();
      return;
    }
    // Offer @here alongside @everyone: the backend resolves it against live presence (TM-464) at post time.
    candidates = mentions.mentionCandidates(thread.members, token.query, { online: true });
    range = token;
    active = candidates.length ? 0 : -1;
    paint();
  }

  function onKeydown(e) {
    if (box.hidden || candidates.length === 0) return; // dropdown closed — let Enter submit as normal
    if (e.key === "ArrowDown") {
      e.preventDefault();
      active = (active + 1) % candidates.length;
      paint();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      active = (active - 1 + candidates.length) % candidates.length;
      paint();
    } else if (e.key === "Enter") {
      e.preventDefault(); // pick the candidate instead of submitting the message
      choose(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  return { refresh, onKeydown, close };
}

/**
 * Build a message bubble that highlights any @mentions in `body` (TM-469). Splits the text into
 * text + mention segments ({@link mentions.mentionSegments}) against the loaded thread roster and renders
 * each mention as a highlighted chip; falls back to the plain text bubble when there are no mentions (or
 * the roster hasn't loaded yet). All nodes are text-only (el() → textContent), so it stays XSS-safe.
 */
function mentionBubble(body) {
  const segments = mentions.mentionSegments(body, thread.members);
  // Fast path: nothing to highlight → the exact original bubble (a single flat text node).
  if (segments.length === 1 && segments[0].type === "text") {
    return el("div", { class: "tm-chat-bub", text: body });
  }
  const nodes = segments.map((seg) => {
    if (seg.type === "text") return seg.text; // el() turns a string child into a text node
    const cls = seg.kind === "user" ? "tm-chat-mention tm-chat-mention--user" : "tm-chat-mention tm-chat-mention--group";
    return el("span", {
      class: cls,
      "data-testid": "chat-mention",
      "data-mention-kind": seg.kind,
      "data-user-id": seg.userId != null ? String(seg.userId) : null,
      text: seg.label,
    });
  });
  return el("div", { class: "tm-chat-bub" }, nodes);
}

/* === end TM-469 mentions === */

/**
 * Begin replying to a thread message (TM-466): set the composer's reply target, show the quoted-preview
 * bar and focus the input. A no-op if the message can't be resolved to a target.
 */
function beginReply(m) {
  const target = core.replyTargetFrom(m);
  if (!target) return;
  thread.replyTo = target;
  paintReplyPreview();
  if (thread.composerInput) thread.composerInput.focus();
}

/** Cancel the in-progress reply (TM-466) — clear the target and hide the quoted-preview bar. */
function clearReply() {
  thread.replyTo = null;
  paintReplyPreview();
}

/**
 * Render (or hide) the composer's quoted-preview bar from `thread.replyTo`: the quoted excerpt plus a
 * cancel (✕) button. Purely reflects state, so beginReply/clearReply just repaint through here.
 */
function paintReplyPreview() {
  const bar = thread.replyPreviewEl;
  if (!bar) return;
  clear(bar);
  const target = thread.replyTo;
  if (!target) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  bar.append(
    el("span", { class: "tm-chat-reply-bar-glyph", "aria-hidden": "true" }, [lineIcon("chat", { size: 14, strokeWidth: 1.6 })]),
    el("div", { class: "tm-chat-reply-bar-text" }, [
      el("span", { class: "tm-chat-reply-bar-label", text: "Replying to" }),
      el("span", { class: "tm-chat-reply-bar-excerpt", text: target.excerpt || core.MESSAGE_UNAVAILABLE }),
    ]),
    el("button", {
      class: "tm-chat-reply-cancel", type: "button", "aria-label": "Cancel reply",
      "data-testid": "chat-reply-cancel", onClick: clearReply, text: "✕",
    }),
  );
}

/** Scroll the thread to the quoted original (TM-466) and briefly highlight it, if it's currently loaded. */
function scrollToMessage(messageId) {
  const body = thread.bodyEl;
  if (!body || !messageId) return;
  const target = body.querySelector(`[data-msg-id="${CSS && CSS.escape ? CSS.escape(String(messageId)) : messageId}"]`);
  if (!target) return; // the original isn't on this page (older message) — nothing to scroll to
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.classList.add("tm-chat-msg--flash");
  window.setTimeout(() => target.classList.remove("tm-chat-msg--flash"), 1200);
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

  // Capture (and clear) the reply target for this send (TM-466): the id goes to the POST, and a local
  // quote preview rides the optimistic echo so the quote shows immediately. Cleared up-front so a second
  // send doesn't inadvertently re-quote; a failure restores it below so the caller can retry the reply.
  const replyTarget = thread.replyTo;
  clearReply();

  thread.sending = true;
  sendBtn.disabled = true;
  input.value = "";
  stopOutgoingTyping(id); // TM-465: the message is sent → clear our typing signal for the others
  const localId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  thread.pending.push(core.pendingMessage(draft.value, { localId, replyTo: replyTarget }));
  repaintBody(); // optimistic echo, dimmed + "Sending…"

  try {
    // Admin announcement (TM-710): when the admin toggle is on, post via the announcement endpoint
    // (kind ANNOUNCEMENT, not member-gated). Otherwise the ordinary member-gated message post. An
    // announcement is a top-level post, so any reply target is ignored for it.
    const saved = thread.announceMode
      ? await postConversationAnnouncement(id, draft.value)
      : await postConversationMessage(id, draft.value, { replyToMessageId: replyTarget?.id });
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
      if (replyTarget) { thread.replyTo = replyTarget; paintReplyPreview(); } // restore the reply target too (TM-466)
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

/**
 * Replace the live composer with the disabled reason state, in place — the caller is muted/removed/closed.
 *
 * Also flips `thread.canCompose` false and drops any in-progress reply (TM-727): the per-message reply +
 * react affordances gate on `canCompose` (see messageRow), so without clearing it they keep rendering
 * after the composer is gone — a "Reply" tap would call beginReply → paintReplyPreview against a detached
 * composer, a silent dead-end. Turning the flag off makes the very next repaint drop those affordances so
 * the thread reads as read-only, matching the disabled composer the caller now sees.
 */
function lockComposer(form, reason) {
  const off = disabledComposer(reason);
  if (form && form.parentNode) form.replaceWith(off);
  thread.canCompose = false; // stop the reply/react affordances that target the now-locked composer
  thread.replyTo = null; // abandon any reply-in-progress — its target composer is gone
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
  // Pause while a send OR an inline edit (TM-467) is in flight/open, so the poll's repaint can't race the
  // optimistic echo or clobber the open editor's in-progress text.
  if (thread.sending || thread.savingEdit || thread.editingId) return;
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
  const wasUnread = row ? row.unread : 0; // this thread's contribution to the Chat-tab total (TM-585)
  if (row) row.unread = 0;
  // TM-585: drop the Chat-tab badge straight away by this thread's own unread (optimistic), so it falls on
  // THIS navigation instead of waiting for the POST to commit + the next 60s poll. Without it the router's
  // concurrent unread-total GET re-reads the pre-mark total (the GET/POST race) and the badge doesn't drop.
  noteThreadRead(wasUnread);
  Promise.resolve(markConversationRead(id))
    // Once the mark-read has COMMITTED, reconcile the badge with the authoritative server total (this GET
    // now reflects the drop, unlike the router's concurrent pre-mark one) — this also self-corrects any
    // local decrement drift over repeated open/close, so the total never double-counts or goes negative.
    .then(() => refreshChatTabBadge())
    .catch((err) => {
      // Non-fatal: the optimistic drop stands and the next poll reconciles. Never surfaces to the user.
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
 * One message row. A `system` message (senderId == null — an admin broadcast, or an in-thread notice)
 * renders as a centred, one-way "from TeamMarhaba" notice (TM-445): the app attribution, the body, its
 * stamp, and — when the message carries a safe in-app deep-link — a tap-through CTA, so a broadcast can
 * be re-read and acted on after the push is gone. A regular message renders as a bubble with the body,
 * a time stamp and any read-only reaction pills. `mine` (a pending echo, or a message we posted this
 * session) draws it out-going (right-aligned, accent wash) — best-effort, since the read API can't tell
 * us which loaded messages are ours. A pending echo is dimmed and stamped "Sending…" until its POST
 * confirms.
 * @param {Object} m the message view-model (from chat-core).
 * @param {boolean} mine whether to render it as an out-going bubble.
 */
function messageRow(m, mine = false) {
  // Admin/host announcement (TM-710): the auto-posted opening message or an admin-sent announcement.
  // Rendered as a distinct, centred announcement block — attributed as an announcement (host / admin) —
  // whether it's a system "from TeamMarhaba" post or an admin-authored one, so it never renders as an
  // ordinary attendee bubble. Checked BEFORE the plain system branch (an announcement subsumes it).
  if (m.announcement) return announcementNotice(m);
  if (m.system) return systemNotice(m);

  const side = mine ? "tm-chat-msg tm-chat-msg--out" : "tm-chat-msg tm-chat-msg--in";
  const row = el("div", {
    class: m.pending ? `${side} tm-chat-msg--pending` : side,
    "data-testid": m.pending ? "chat-msg-pending" : "chat-msg",
    // Anchor for tap-to-scroll from a reply's quote (TM-466).
    "data-msg-id": m.id || null,
  });
  // Reply / quote (TM-466): render the quoted parent above the body — tap it to scroll to the original;
  // a removed original shows "message unavailable" (core already substitutes the copy) and isn't tappable.
  if (m.replyTo) row.append(quoteBlock(m.replyTo));

  // Edit own message (TM-467): while this message's inline editor is open, the bubble is replaced by an
  // edit box (save / cancel). Everything else (stamp, reactions, affordances) is suppressed until the
  // edit resolves, so the row is unambiguously "you're editing this".
  if (thread.editingId === m.id && !m.pending) {
    row.append(messageEditor(m));
    return row;
  }

  /* === TM-469 mentions === */
  // The message bubble. Instead of one flat text node, split the body into text + mention segments so
  // any @mention (an individual on this thread's roster, or @everyone/@here) renders as a highlighted
  // chip. `mentionBubble` falls back to the plain text node when the body has no mentions (or the roster
  // hasn't loaded yet), so this is a pure, additive enhancement of the existing `text: m.body` bubble —
  // the renderer is otherwise untouched. All nodes are built via el() (textContent only), so a body that
  // merely LOOKS like markup can never inject it.
  row.append(mentionBubble(m.body));
  /* === end TM-469 mentions === */
  // Stamp line: the time label plus — new in TM-467 — an "edited" tag when the author has edited it.
  if (m.pending) {
    row.append(el("div", { class: "tm-chat-stamp" }, [el("span", { text: "Sending…" })]));
  } else if (m.timeLabel || m.edited) {
    row.append(el("div", { class: "tm-chat-stamp", "data-testid": "chat-stamp" }, [
      m.timeLabel ? el("span", { text: m.timeLabel }) : null,
      m.edited ? el("span", { class: "tm-chat-edited", "data-testid": "chat-edited", title: "Edited", text: core.EDITED_TAG }) : null,
    ]));
  }
  if (m.cta) row.append(messageCta(m.cta)); // an in-app deep-link on a normal message → same CTA affordance
  /* === TM-470 link preview === */
  // If the body contains an http(s) URL, lazily fetch its OpenGraph card from the dedicated,
  // SSRF-safe server endpoint (GET /api/v1/link-preview) and render it under the bubble. A fetch
  // failure / no metadata simply shows no card — the raw URL stays as plain text in the bubble (the
  // AC's "fall back to a plain link"). Deliberately additive + self-contained: it appends its own node
  // and mutates nothing else in this renderer, keeping clear of the sibling @mentions work.
  maybeMountLinkPreview(m, row);
  /* === end TM-470 link preview === */
  // Reactions (TM-462): the chip row + the interactive react affordance. A confirmed message in a thread
  // the caller can post to gets toggleable chips + a "react" button that opens the emoji picker; a pending
  // echo (no server id yet) or a read-only thread falls back to read-only chips. `interactive` reuses the
  // same gate as the reply button — you can only react where you can post.
  const reactions = reactionBar(m, !m.pending && Boolean(m.id) && thread.canCompose);
  if (reactions) row.append(reactions);
  // Read receipt (TM-463): a "read by N" indicator (not a tick) on the caller's OWN messages — the
  // server sends `readReceipt` only for those, so its presence gates this. Tap it to see who's read it.
  if (m.readReceipt && !m.pending) row.append(readReceiptIndicator(m.readReceipt));
  // Reply affordance (TM-466): a tap target on a confirmed message that starts a reply quoting it.
  // Not on a pending echo (no server id yet), and only where the caller can actually post (an
  // admin-broadcast/announcement thread is read-only, so replying there is pointless).
  if (!m.pending && m.id && thread.canCompose) {
    row.append(el("button", {
      class: "tm-chat-reply-btn", type: "button", "aria-label": "Reply",
      "data-testid": "chat-reply", onClick: () => beginReply(m),
    }, [lineIcon("chat", { size: 15, strokeWidth: 1.6 })]));
  }
  // Edit / delete affordances (TM-467): only on the caller's OWN confirmed, non-system message. Delete is
  // offered anytime (an author can always take a message back); edit only while still inside the ~5-minute
  // window (a best-effort client hint via core.canEditWithinWindow — the backend re-checks and returns a
  // 409 if it's actually past the window, so the gate is never trusted from the client alone).
  if (mine && !m.pending && m.id && !m.system) {
    row.append(ownMessageActions(m));
  }
  return row;
}

/**
 * The edit + delete controls for the caller's OWN message (TM-467). Edit opens the inline editor and is
 * shown only within the edit window (client hint); delete confirms then soft-deletes. Both are real
 * buttons (keyboard + screen-reader accessible).
 */
function ownMessageActions(m) {
  const actions = el("div", { class: "tm-chat-own-actions", "data-testid": "chat-own-actions" });
  if (core.canEditWithinWindow(m.sortAt)) {
    actions.append(el("button", {
      class: "tm-chat-edit-btn", type: "button", "aria-label": "Edit message",
      title: "Edit", "data-testid": "chat-edit", onClick: () => beginEdit(m),
    }, [el("span", { class: "tm-chat-action-glyph", "aria-hidden": "true", text: "✎" })]));
  }
  actions.append(el("button", {
    class: "tm-chat-delete-btn", type: "button", "aria-label": "Delete message",
    title: "Delete", "data-testid": "chat-delete", onClick: () => deleteOwnMessage(m),
  }, [el("span", { class: "tm-chat-action-glyph", "aria-hidden": "true", text: "🗑" })]));
  return actions;
}

/**
 * The inline editor shown in place of a message's bubble while it's being edited (TM-467): a seeded text
 * input plus Save / Cancel. The draft lives in `thread.editDraft` (not just the DOM) so a background
 * repaint — a live frame, or the resumed poll — re-seeds it rather than losing typed text. Enter saves,
 * Escape cancels; Save is disabled while the draft is blank / unchanged / too long, matching the backend
 * rule (validateDraft). Focus lands in the input.
 */
function messageEditor(m) {
  const input = el("input", {
    class: "tm-chat-edit-input", type: "text", value: thread.editDraft,
    maxlength: String(core.MAX_MESSAGE_LENGTH), "aria-label": "Edit your message",
    autocomplete: "off", "data-testid": "chat-edit-input",
  });
  const saveBtn = el("button", {
    class: "tm-btn tm-chat-edit-save", type: "button", "data-testid": "chat-edit-save",
    text: "Save",
  });
  const cancelBtn = el("button", {
    class: "tm-btn tm-btn--ghost tm-chat-edit-cancel", type: "button",
    "data-testid": "chat-edit-cancel", text: "Cancel", onClick: cancelEdit,
  });
  const syncSave = () => {
    const draft = core.validateDraft(input.value);
    // Nothing to save if the text is blank / too long, or unchanged from the original.
    saveBtn.disabled = !draft.canSend || draft.value === m.body;
  };
  input.addEventListener("input", () => { thread.editDraft = input.value; syncSave(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); if (!saveBtn.disabled) saveEdit(m); }
    else if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
  });
  saveBtn.addEventListener("click", () => saveEdit(m));
  syncSave();
  // Focus after mount so the caret lands in the box (deferred so it's in the DOM first).
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => input.focus());
  return el("div", { class: "tm-chat-edit", "data-testid": "chat-edit-form" }, [
    input,
    el("div", { class: "tm-chat-edit-actions" }, [cancelBtn, saveBtn]),
  ]);
}

/**
 * Open the inline editor for the caller's own message (TM-467): seed the draft with its current body and
 * repaint so the editor renders in place. A no-op for a message with no id (an unconfirmed echo).
 */
function beginEdit(m) {
  if (!m || !m.id) return;
  thread.editingId = m.id;
  thread.editDraft = m.body;
  repaintBody();
}

/** Cancel the in-progress edit (TM-467): drop the draft + editor and repaint the message as it was. */
function cancelEdit() {
  thread.editingId = null;
  thread.editDraft = "";
  repaintBody();
}

/**
 * Save an inline edit (TM-467): validate, apply the new body optimistically (so it updates instantly),
 * PATCH it, then RECONCILE with the server's confirmed body/editedAt — or ROLL BACK to the original on
 * failure (surfacing the honest reason: 403 not yours / 409 closed-or-window-passed / 404 gone). Guards a
 * double-save via `thread.savingEdit`, and drops the reconcile if the caller navigated away mid-flight.
 */
async function saveEdit(m) {
  if (thread.savingEdit) return;
  const threadId = thread.id;
  const draft = core.validateDraft(thread.editDraft);
  if (!draft.canSend) return;
  if (draft.value === m.body) { cancelEdit(); return; } // nothing changed — just close the editor

  const prev = thread.messages.find((x) => x.id === m.id);
  const snapshot = prev ? { ...prev } : null; // for rollback on failure

  thread.savingEdit = true;
  thread.editingId = null; // close the editor immediately; the optimistic body renders in the bubble
  thread.editDraft = "";
  thread.messages = core.applyMessageEdit(thread.messages, {
    id: m.id, body: draft.value, editedAt: new Date().toISOString(),
  });
  repaintBody();

  try {
    const saved = await editConversationMessage(threadId, m.id, draft.value);
    if (thread.id !== threadId) return; // navigated away mid-edit — drop the reconcile
    thread.messages = core.applyMessageEdit(thread.messages, {
      id: m.id, body: saved?.body, editedAt: saved?.editedAt,
    });
    repaintBody();
  } catch (err) {
    if (thread.id === threadId && snapshot) {
      thread.messages = core.upsertMessage(thread.messages, snapshot); // restore the original body
      repaintBody();
    }
    toast(err?.message || "Couldn't edit your message. Please try again.", { type: "error" });
    console.warn("[chat] edit failed:", err?.status ?? "", err?.message ?? err);
  } finally {
    if (thread.id === threadId) thread.savingEdit = false;
  }
}

/**
 * Delete the caller's own message (TM-467): confirm, then remove it optimistically (it drops from the
 * timeline immediately) and DELETE it. On failure, restore it and surface the honest reason. Allowed
 * anytime, so there's no window / closed-thread guard here — the backend soft-delete accepts it.
 */
async function deleteOwnMessage(m) {
  if (!m || !m.id) return;
  const threadId = thread.id;
  const ok = typeof window === "undefined" || typeof window.confirm !== "function"
    ? true
    : window.confirm("Delete this message? This can't be undone.");
  if (!ok) return;

  const snapshot = thread.messages.find((x) => x.id === m.id);
  const restore = snapshot ? { ...snapshot } : null;
  if (thread.editingId === m.id) { thread.editingId = null; thread.editDraft = ""; }
  thread.mineIds.delete(m.id);
  thread.messages = core.removeMessageById(thread.messages, m.id); // optimistic drop
  repaintBody();

  try {
    await deleteConversationMessage(threadId, m.id);
  } catch (err) {
    if (thread.id === threadId && restore) {
      thread.mineIds.add(m.id); // it's still ours — keep it out-going after the restore
      thread.messages = core.upsertMessage(thread.messages, restore);
      repaintBody();
    }
    toast(err?.message || "Couldn't delete your message. Please try again.", { type: "error" });
    console.warn("[chat] delete failed:", err?.status ?? "", err?.message ?? err);
  }
}

/* ─────────────────────────────── Reactions (react button + picker — TM-462) ──────────────────────
 * The interactive layer over TM-438's read-only chips: each message carries a visible react button (the
 * affordance — no tap-gesture shortcut) that opens an emoji picker, and each existing chip toggles the
 * caller's own reaction. All the DECISIONS (which emoji, react-vs-un-react, the optimistic count/`mine`
 * maths) live in chat-core (`REACTION_EMOJIS`, `applyReactionToggle`, `normaliseReactions`); this half is
 * the DOM shell + the endpoint calls (TM-461) with an optimistic paint that reconciles on the server's
 * authoritative summary or rolls back on failure. Everything is a real <button>, so it's keyboard- and
 * screen-reader-accessible by default. */

/**
 * The reaction row under a message: the existing chips plus (when interactive) the react button. Returns
 * null when there's nothing to draw (a read-only context with no reactions), so the row stays clean.
 * @param {Object} m the message view-model.
 * @param {boolean} interactive whether the caller can toggle/add reactions here (a confirmed message in a
 *   thread they can post to). When false the chips render read-only (no picker, no toggle).
 */
function reactionBar(m, interactive) {
  const chips = Array.isArray(m.reactions) ? m.reactions : [];
  if (chips.length === 0 && !interactive) return null;
  const bar = el("div", { class: "tm-chat-reactions", "data-testid": "chat-reactions" });
  for (const r of chips) bar.append(interactive ? reactionChip(m, r) : readonlyChip(r));
  if (interactive) bar.append(reactButton(m));
  return bar;
}

/** A read-only reaction chip (a pending echo / an announcement thread): the pill, highlighted if `mine`. */
function readonlyChip(r) {
  const pill = reaction(r.emoji, r.count);
  pill.classList.add("tm-chat-reaction");
  if (r.mine) pill.classList.add("tm-chat-reaction--mine");
  return pill;
}

/**
 * A toggleable reaction chip: tapping it adds or removes the caller's own reaction with that emoji. It's
 * highlighted (`--mine`) and marked `aria-pressed` when the caller has reacted, so the toggle state is
 * announced to screen readers and doesn't depend on colour alone.
 */
function reactionChip(m, r) {
  const pill = reaction(r.emoji, r.count, { onClick: () => toggleReaction(m, r.emoji) });
  pill.classList.add("tm-chat-reaction");
  if (r.mine) pill.classList.add("tm-chat-reaction--mine");
  pill.setAttribute("aria-pressed", String(Boolean(r.mine)));
  pill.setAttribute("data-testid", "chat-reaction");
  pill.dataset.emoji = r.emoji;
  return pill;
}

/** The visible react affordance — a real button that opens the emoji picker (the AC's sole react entry point). */
function reactButton(m) {
  return el(
    "button",
    {
      class: "tm-chat-react-btn", type: "button",
      "aria-label": "Add reaction", title: "Add reaction",
      "data-testid": "chat-react", onClick: () => openReactionPicker(m),
    },
    [el("span", { class: "tm-chat-react-btn-glyph", "aria-hidden": "true", text: "🙂" })],
  );
}

/**
 * Open the emoji picker (TM-462): a small modal offering the REACTION_EMOJIS set (a "like" — 👍 / ❤️ —
 * leads, so it's the prominent common reaction, with no special like gesture). Choosing an emoji closes
 * the picker and toggles that reaction. Reuses the shared `modal` (Escape / backdrop close, focus mgmt),
 * so it's keyboard- and screen-reader-friendly for free.
 */
function openReactionPicker(m) {
  const picker = el("div", {
    class: "tm-chat-react-picker", role: "group",
    "aria-label": "Choose a reaction", "data-testid": "chat-react-picker",
  });
  const dialog = modal("Add a reaction", [picker]);
  for (const emoji of core.REACTION_EMOJIS) {
    picker.append(
      el(
        "button",
        {
          class: "tm-chat-react-option", type: "button",
          "aria-label": `React with ${emoji}`, dataset: { emoji },
          onClick: () => { dialog.close(); toggleReaction(m, emoji); },
        },
        [el("span", { "aria-hidden": "true", text: emoji })],
      ),
    );
  }
  // Move focus into the picker so a keyboard user lands on the first option (mirrors modal focus mgmt).
  requestAnimationFrame(() => { const first = picker.querySelector("button"); if (first) first.focus(); });
}

/**
 * Toggle the caller's `emoji` reaction on message `m`: apply the optimistic chip math immediately, call
 * the react / un-react endpoint (TM-461), then RECONCILE with the server's authoritative summary — or
 * ROLL BACK to the prior chips on failure. Guards a rapid double-tap on the same chip via `thread.reacting`,
 * and drops the reconcile if the caller navigated to another thread mid-flight.
 * @param {Object} m the message view-model (lives in `thread.messages`, so mutating its reactions there
 *   is what `repaintBody` re-reads).
 * @param {string} emoji the reaction glyph.
 */
async function toggleReaction(m, emoji) {
  const id = m && m.id ? String(m.id) : "";
  if (!id || !emoji) return;
  const key = `${id}:${emoji}`;
  if (thread.reacting.has(key)) return; // a toggle for this chip is already in flight — ignore the double-tap
  const threadId = thread.id;
  const { reactions: optimistic, action } = core.applyReactionToggle(m.reactions, emoji);
  const prev = m.reactions; // the untouched prior chips, kept for rollback
  thread.reacting.add(key);
  setReactionsOnMessage(id, optimistic);
  repaintBody(); // optimistic paint: chip in/decrements + highlights instantly, before the round-trip

  try {
    const summary = action === "unreact"
      ? await unreactFromMessage(id, emoji)
      : await reactToMessage(id, emoji);
    if (thread.id !== threadId) return; // navigated away mid-toggle — drop the reconcile
    setReactionsOnMessage(id, core.normaliseReactions(summary && summary.reactions)); // reconcile with server truth
    repaintBody();
  } catch (err) {
    if (thread.id === threadId) {
      setReactionsOnMessage(id, prev); // roll the optimistic change back
      repaintBody();
    }
    toast("Couldn't update your reaction. Please try again.", { type: "error" });
    console.warn("[chat] reaction toggle failed:", err?.status ?? "", err?.message ?? err);
  } finally {
    thread.reacting.delete(key);
  }
}

/** Set a loaded message's reactions in place (by id) so the next `repaintBody` reflects it. */
function setReactionsOnMessage(id, reactions) {
  const msg = thread.messages.find((x) => x.id === String(id));
  if (msg) msg.reactions = reactions;
  return Boolean(msg);
}

/**
 * A one-way "from TeamMarhaba" system notice (TM-445) — the shape an admin broadcast takes in a thread.
 * Distinct from an event bubble: a centred card with a megaphone + attribution line, the message body,
 * a time stamp, and the optional deep-link CTA. All of it text-only nodes via el(), so an admin-authored
 * body / link can never inject markup.
 */
/**
 * An admin/host ANNOUNCEMENT (TM-710): the auto-posted event opening message, or a message an admin
 * sent through the announcement composer. Rendered as a centred, visually-distinct announcement block —
 * a "📣 Announcement" attribution, the body, its stamp, and a tap-through CTA when it carries a safe
 * in-app deep-link — so it reads unmistakably differently from an attendee bubble, whoever authored it.
 */
function announcementNotice(m) {
  const notice = el("div", { class: "tm-chat-system tm-chat-announcement", "data-testid": "chat-announcement" }, [
    el("div", { class: "tm-chat-from" }, [
      el("span", { class: "tm-chat-from-glyph", "aria-hidden": "true", text: "📣" }),
      el("span", { class: "tm-chat-from-name", text: "Announcement" }),
    ]),
    el("p", { class: "tm-chat-system-text", text: m.body }),
  ]);
  if (m.timeLabel) notice.append(el("div", { class: "tm-chat-system-stamp" }, [el("span", { text: m.timeLabel })]));
  if (m.cta) notice.append(messageCta(m.cta));
  return notice;
}

function systemNotice(m) {
  const notice = el("div", { class: "tm-chat-system tm-chat-system--admin", "data-testid": "chat-system" }, [
    el("div", { class: "tm-chat-from" }, [
      el("span", { class: "tm-chat-from-glyph", "aria-hidden": "true", text: "📣" }),
      el("span", { class: "tm-chat-from-name", text: `from ${core.ADMIN_AUTHOR}` }),
    ]),
    el("p", { class: "tm-chat-system-text", text: m.body }),
  ]);
  if (m.timeLabel) notice.append(el("div", { class: "tm-chat-system-stamp" }, [el("span", { text: m.timeLabel })]));
  if (m.cta) notice.append(messageCta(m.cta));
  return notice;
}

/**
 * The deep-link CTA drawn under a message that carries one (TM-445). `cta` is already the pre-derived,
 * SAFE `{ href, label }` from chat-core.deepLinkCta (an unsafe/off-app link never reaches here — it's
 * dropped in the core, so no CTA is drawn). The href is a same-app hash route, so a tap navigates via
 * the existing hash router with no extra JS.
 */
function messageCta(cta) {
  return el("a", { class: "tm-chat-cta", href: cta.href, "data-testid": "chat-cta" }, [
    el("span", { class: "tm-chat-cta-label", text: cta.label }),
    el("span", { class: "tm-chat-cta-arrow", "aria-hidden": "true", text: "→" }),
  ]);
}

/* ─────────────────────────────── TM-470 link preview ────────────────────────────────────────────
 * A self-contained render hook: detect a URL in a message body (via the pure chat-linkpreview-core),
 * ask the SSRF-safe backend endpoint for its OpenGraph card, and mount a preview under the bubble.
 * Kept in its own delimited section so it doesn't entangle with the message renderer or the sibling
 * @mentions work — messageRow only calls maybeMountLinkPreview(m, row).
 *
 * Failure is invisible by design (the AC's "fall back to a plain link"): if there's no URL, the fetch
 * fails, or the page has no usable metadata, nothing is appended and the raw URL simply stays as plain
 * text in the bubble. The card renders a title (always), an optional description, and an optional image.
 * ---------------------------------------------------------------------------------------------- */

// Per-session URL→preview memo, so the near-live poll / SSE repaints of a thread don't re-fetch (or
// re-flicker) a link's card every tick. Stores the resolving Promise so concurrent repaints of the same
// message share one in-flight request; the backend also caches by URL, this just avoids redundant calls.
const linkPreviewCache = new Map();

/**
 * If message `m`'s body contains a previewable URL, mount its link-preview card under the bubble in
 * `row`. System notices (admin broadcasts) already carry their own deep-link CTA, so they're skipped.
 * Asynchronous + best-effort: appends a card only once a preview with real content resolves.
 * @param {Object} m the message view-model.
 * @param {HTMLElement} row the message row element to append the card to.
 */
function maybeMountLinkPreview(m, row) {
  if (!m || m.system) return;
  const url = linkPreview.firstPreviewableUrl(m.body);
  if (!url) return;

  // Anchor node so an async resolve mounts the card in the right place even if the row was appended
  // after this returns; also lets a repaint tell "already handled this row" apart from "not yet".
  const slot = el("div", { class: "tm-chat-link-preview-slot", "data-testid": "chat-link-preview-slot" });
  row.append(slot);

  resolveLinkPreview(url)
    .then((preview) => {
      // Guard: the row may have been discarded by a repaint before the fetch resolved, or the preview
      // may carry no title (nothing worth a card) — in both cases leave the plain link as-is.
      if (!preview || !preview.hasContent || !slot.isConnected) return;
      slot.append(linkPreviewCard(preview));
    })
    .catch(() => {
      /* best-effort: a failed preview shows no card (the plain link stays in the bubble) */
    });
}

/** Resolve (and memoise) the normalised preview for a URL; a failure memoises `null` (don't refetch). */
function resolveLinkPreview(url) {
  if (linkPreviewCache.has(url)) return Promise.resolve(linkPreviewCache.get(url));
  const promise = getLinkPreview(url)
    .then((raw) => {
      const preview = raw ? linkPreview.normalisePreview(raw, url) : null;
      linkPreviewCache.set(url, preview);
      return preview;
    })
    .catch(() => {
      linkPreviewCache.set(url, null);
      return null;
    });
  linkPreviewCache.set(url, promise); // dedupe concurrent in-flight fetches for the same URL
  return promise;
}

/**
 * Build the preview card DOM: an accessible link wrapping an optional image, the title, an optional
 * description, and the link's host as a source line. All fields are rendered as TEXT / an image `src`
 * (never HTML), and the card links to the previewed URL (opens in a new tab).
 * @param {{url: string, title: string, description: string, imageUrl: (string|null)}} preview
 * @returns {HTMLElement}
 */
function linkPreviewCard(preview) {
  const children = [];
  if (preview.imageUrl) {
    children.push(el("img", {
      class: "tm-chat-link-preview-img",
      src: preview.imageUrl,
      alt: "",
      loading: "lazy",
      // If the image 404s / is blocked, hide it rather than showing a broken-image glyph.
      onError: (e) => { e.target.style.display = "none"; },
    }));
  }
  const body = [el("div", { class: "tm-chat-link-preview-title", text: preview.title })];
  if (preview.description) {
    body.push(el("div", { class: "tm-chat-link-preview-desc", text: preview.description }));
  }
  body.push(el("div", { class: "tm-chat-link-preview-host", text: previewHost(preview.url) }));
  children.push(el("div", { class: "tm-chat-link-preview-body" }, body));

  return el("a", {
    class: "tm-chat-link-preview",
    href: preview.url,
    target: "_blank",
    rel: "noopener noreferrer nofollow",
    "data-testid": "chat-link-preview",
  }, children);
}

/** The host of the previewed URL for the card's source line (falls back to the raw URL if unparseable). */
function previewHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url ?? "");
  }
}

/**
 * The read-receipt indicator for one own-message: a small "Read by N" (or "Sent" when nobody's read it
 * yet) control. When at least one member has read it, it's a button that opens the "who read it" list;
 * with zero readers there's no list to show, so it renders as a quiet, non-interactive label.
 * @param {{count: number, readerIds: string[]}} receipt a normalised receipt (chat-core).
 */
function readReceiptIndicator(receipt) {
  const label = core.readReceiptLabel(receipt); // "Sent" | "Read by N"
  if (receipt.count <= 0) {
    return el("div", { class: "tm-chat-receipt tm-chat-receipt--empty", "data-testid": "chat-receipt" }, [
      el("span", { class: "tm-chat-receipt-text", text: label }),
    ]);
  }
  return el(
    "button",
    {
      class: "tm-chat-receipt",
      type: "button",
      "data-testid": "chat-receipt",
      "aria-label": `${label}. Tap to see who has read this message.`,
      onClick: () => showReaders(receipt),
    },
    [el("span", { class: "tm-chat-receipt-text", text: label })],
  );
}

/**
 * Open the "who has read this" list for a message (TM-463). The read API returns reader ids, not names,
 * and the chat surface has no id→name resolver yet, so each reader shows as a neutral member row — the
 * list length is the read count. Humanising the rows to display names is a follow-up (needs a members
 * endpoint); the receipt count + list are already correct and member-gated.
 * @param {{count: number, readerIds: string[]}} receipt
 */
function showReaders(receipt) {
  const list = el("ul", { class: "tm-chat-readers", "data-testid": "chat-readers" });
  for (const id of receipt.readerIds) {
    list.append(
      el("li", { class: "tm-chat-reader", dataset: { readerId: id } }, [
        avatar("👤"),
        el("span", { class: "tm-chat-reader-name", text: "Member" }),
      ]),
    );
  }
  modal(core.readReceiptLabel(receipt), [list]);
}

/**
 * The quoted-parent block shown above a reply (TM-466): the quoted excerpt, tappable to scroll to the
 * original when it's still available. A removed original renders as a muted, non-interactive "message
 * unavailable" (the excerpt already carries that copy from core.toQuotedPreview).
 */
function quoteBlock(preview) {
  const gone = !preview.available;
  const block = el("div", {
    class: gone ? "tm-chat-quote tm-chat-quote--gone" : "tm-chat-quote",
    "data-testid": "chat-quote",
    role: gone ? null : "button",
    tabindex: gone ? null : "0",
    "aria-label": gone ? "Quoted message unavailable" : "Show quoted message",
  }, [el("span", { class: "tm-chat-quote-excerpt", text: preview.excerpt || core.MESSAGE_UNAVAILABLE })]);
  if (!gone && preview.id) {
    const jump = () => scrollToMessage(preview.id);
    block.addEventListener("click", jump);
    block.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); jump(); }
    });
  }
  return block;
}

// Bridge for the router (which imports this) + ad-hoc use / QA.
if (typeof window !== "undefined") {
  window.tmChat = { enterChat };
}
