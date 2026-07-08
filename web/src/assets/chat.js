// Event group chat — DOM view (TM-515 / TM-433).
//
// The Chat section, refreshed to the approved paper wireframes (paper-chat-list, paper-chat-thread,
// paper-chat-empty, paper-reaction-picker) at the production default theme, inside the bottom-nav
// shell (TM-434). Replaces the TM-434 "coming soon" placeholder that used to live here — the router
// wiring, the Chat tab and the nav are unchanged (that was the whole point of the placeholder seam).
//
// Two views, mounted into the same #chat-view container by the router (mirrors events.js list/detail):
//   • #/chat        → the chat LIST  (renderList)   — a top-level tab, no back button
//   • #/chat/{id}   → the chat THREAD (renderThread) — back to the list, or the empty state
//
// Built from the SHARED component library (TM-511) so it restyles from tokens with the theme (clean /
// doodle / sketch) and matches the gallery/showcase: `avatar` (list + —), `badge` (unread count),
// `readReceipt` (the single/double/TRIPLE-tick delivery ladder — ✓ / ✓✓ / ✓✓✓ whole-group-read, the
// TM-433 semantics), and `reaction` (the inline 👍 3 pill). All decision logic (seed conversations,
// thread lookup, and the receipt-state derivation) lives in the pure, unit-tested chat-core.js; this
// module is the thin DOM shell around it.
//
// XSS-safe: every node is built via ui.js `el()` (textContent only, no innerHTML), so message text,
// names and previews — untrusted once TM-433 wires a real backend — can never inject markup.

import { clear, el } from "./ui.js";
import { avatar, badge, reaction, readReceipt } from "./components.js";
import { lineIcon } from "./icons.js";
import * as core from "./chat-core.js";

const $ = (id) => document.getElementById(id);

/**
 * Router entry (TM-109). `threadId` is the conversation id parsed from `#/chat/{id}`, or null/empty
 * for the `#/chat` list. Re-invoked on every entry so list↔thread↔another-thread navigation always
 * repaints (mirrors enterEvents).
 * @param {?string} threadId
 */
export function enterChat(threadId) {
  const view = $("chat-view");
  if (!view) return;
  if (threadId != null && threadId !== "") renderThread(view, String(threadId));
  else renderList(view);
}

/* ─────────────────────────────── Chat list (#/chat) ───────────────────────────────────────────── */

function renderList(view) {
  clear(view).append(
    el("header", { class: "tm-chat-head" }, [el("h2", { class: "tm-chat-title", text: "Chats" })]),
    el(
      "div",
      { class: "tm-chat-list", "data-testid": "chat-list" },
      core.listConversations().map(listRow),
    ),
  );
}

/** One chat-list row — a link into the thread. Matches paper-chat-list `.row`. */
function listRow(conv) {
  // The preview line: a self ("You: …") preview shows a leading read-receipt tick (the wireframe's
  // "✓✓ You: …" / "✓ …"); an incoming preview is just the text.
  const preview = el("span", { class: "tm-chat-row-preview" });
  if (conv.preview.self && conv.preview.receipt) preview.append(readReceipt(conv.preview.receipt));
  preview.append(el("span", { class: "tm-chat-row-preview-text", text: conv.preview.text }));

  return el(
    "a",
    {
      class: "tm-chat-row",
      href: `#/chat/${encodeURIComponent(conv.id)}`,
      "data-testid": "chat-row",
      dataset: { threadId: conv.id },
    },
    [
      avatar(conv.avatar),
      el("div", { class: "tm-chat-row-mid" }, [
        el("div", { class: "tm-chat-row-name", text: conv.name }),
        preview,
      ]),
      el("div", { class: "tm-chat-row-meta" }, [
        el("span", { class: "tm-chat-row-time", text: conv.preview.time || conv.day }),
        conv.unread > 0 ? badge(conv.unread) : null,
      ]),
    ],
  );
}

/* ─────────────────────────────── Chat thread (#/chat/{id}) ────────────────────────────────────── */

function renderThread(view, id) {
  const conv = core.getConversation(id);
  if (!conv) {
    // Unknown thread id (e.g. a stale deep link) — degrade to the list rather than a blank screen.
    renderList(view);
    return;
  }

  // The scrolling message column. Empty conversation → the paper-chat-empty state; otherwise the day
  // separator + the messages (out-going ones already carry their derived receipt state from the core).
  const body = el("div", { class: "tm-chat-body", "data-testid": "chat-thread" });
  const messages = core.threadMessages(id);
  if (messages.length === 0) {
    body.append(emptyState());
  } else {
    body.append(el("div", { class: "tm-chat-day", text: conv.day }));
    for (const m of messages) body.append(messageRow(m));
  }

  clear(view).append(threadHeader(conv), body, composer(conv, body));
  // Land at the newest message (bottom), like every chat app.
  requestAnimationFrame(() => {
    body.scrollTop = body.scrollHeight;
  });
}

/** Thread top bar: back to the list + the group name + its "N going" sub-line. */
function threadHeader(conv) {
  return el("header", { class: "tm-chat-thread-head" }, [
    el("a", { class: "tm-chat-back", href: "#/chat", "aria-label": "Back to chats" }, [
      el("span", { class: "tm-chat-back-glyph", "aria-hidden": "true", text: "←" }),
    ]),
    el("div", { class: "tm-chat-thread-heading" }, [
      el("h2", { class: "tm-chat-thread-title", text: conv.name }),
      el("p", { class: "tm-chat-thread-sub", text: `${conv.going} going` }),
    ]),
  ]);
}

/** The paper-chat-empty "No messages yet / Be the first to say hi 👋" first-message prompt. */
function emptyState() {
  return el("div", { class: "tm-chat-empty", "data-testid": "chat-empty" }, [
    el("div", { class: "tm-chat-empty-icon", "aria-hidden": "true" }, [lineIcon("chat", { size: 44, strokeWidth: 1.6 })]),
    el("h3", { class: "tm-chat-empty-title", text: "No messages yet" }),
    el("p", { class: "tm-chat-empty-lead", text: "Be the first to say hi 👋 — break the ice with the group." }),
  ]);
}

/**
 * One message bubble. Incoming (`in`) messages show the sender name and are INTERACTIVE — tapping the
 * bubble opens the reaction picker (paper-reaction-picker); outgoing (`out`) messages show the time +
 * the read-receipt ticks. Both may carry an inline reaction pill.
 */
function messageRow(m) {
  const out = m.from === "me";
  const row = el("div", { class: `tm-chat-msg ${out ? "tm-chat-msg--out" : "tm-chat-msg--in"}` });

  if (!out && m.who) row.append(el("div", { class: "tm-chat-who", text: m.who }));

  if (out) {
    // The user's own message: a static bubble + a stamp of "time · <ticks>".
    row.append(el("div", { class: "tm-chat-bub", text: m.text }));
    row.append(
      el("div", { class: "tm-chat-stamp" }, [
        m.at ? el("span", { text: `${m.at} ` }) : null,
        readReceipt(m.receipt),
      ]),
    );
  } else {
    // An incoming message: a button bubble so a tap / keyboard activation opens the reaction picker.
    const bubble = el(
      "button",
      { class: "tm-chat-bub tm-chat-bub--react", type: "button", "aria-label": `React to ${m.who || "message"}` },
      m.text,
    );
    bubble.addEventListener("click", () => openReactionPicker(row, bubble));
    row.append(bubble);
  }

  if (m.reaction) row.append(reactionPill(row, m.reaction.emoji, m.reaction.count));
  return row;
}

/** An inline reaction pill (the `reaction` component), tracked so the picker can replace it. */
function reactionPill(row, emoji, count) {
  const pill = reaction(emoji, count);
  pill.classList.add("tm-chat-reaction");
  row.dataset.hasReaction = "true";
  return pill;
}

/**
 * The composer — a real text field + send button (paper-chat-thread / paper-chat-empty). With no
 * backend yet (TM-433), Send optimistically ECHOES the typed message into the thread as a just-sent
 * (✓) out-going bubble and clears the field — so the "Be the first to say hi" first-message flow
 * actually works and is testable. A <form> so Enter submits; the field is a real <input> so the
 * bottom-nav keyboard guard (tabbar.js) hides the tab bar while typing.
 */
function composer(conv, body) {
  const input = el("input", {
    class: "tm-chat-input",
    type: "text",
    placeholder: conv.messages.length === 0 ? "Say hi…" : "Message…",
    "aria-label": "Message",
    autocomplete: "off",
    "data-testid": "chat-composer-input",
  });
  const form = el(
    "form",
    { class: "tm-chat-composer", "data-testid": "chat-composer" },
    [
      input,
      el(
        "button",
        { class: "tm-chat-send", type: "submit", "aria-label": "Send" },
        [
          // A paper-plane send glyph (matches the wireframe's send button); inks with currentColor.
          el("span", { class: "tm-chat-send-glyph", "aria-hidden": "true" }, [lineIcon("send", { size: 18, strokeWidth: 2 })]),
        ],
      ),
    ],
  );
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    appendOutgoing(body, text);
    input.value = "";
    input.focus();
  });
  return form;
}

/** Append a just-sent outgoing message (✓) to the thread, replacing the empty state on the first one. */
function appendOutgoing(body, text) {
  const empty = body.querySelector(".tm-chat-empty");
  if (empty) {
    // First message in a previously-empty thread: swap the empty state for a day separator.
    empty.remove();
    body.append(el("div", { class: "tm-chat-day", text: "Today" }));
  }
  const now = new Date();
  const at = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  // A freshly-sent message is read by nobody yet → "sent" (single tick), per chat-core's ladder.
  body.append(messageRow({ from: "me", text, at, receipt: "sent" }));
  body.scrollTop = body.scrollHeight;
}

/* ─────────────────────────────── Reaction picker (paper-reaction-picker) ──────────────────────── */

/**
 * Open the long-press emoji reaction picker over a dimmed backdrop, anchored above the tapped message
 * (paper-reaction-picker: 👍 ❤️ 😂 🎉 🙌 ＋, with the target bubble highlighted). Picking an emoji sets
 * / replaces that message's inline reaction pill and closes; the backdrop or Escape closes it too.
 * @param {HTMLElement} row the message row.
 * @param {HTMLElement} bubble the tapped bubble (gets the accent selection ring while open).
 */
function openReactionPicker(row, bubble) {
  bubble.classList.add("tm-chat-bub--selected");

  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  const close = () => {
    backdrop.remove();
    bubble.classList.remove("tm-chat-bub--selected");
    document.removeEventListener("keydown", onKey);
  };

  const picker = el(
    "div",
    { class: "tm-chat-picker", role: "menu", "aria-label": "Add a reaction" },
    [
      ...core.REACTION_EMOJIS.map((emoji) =>
        el(
          "button",
          {
            class: "tm-chat-picker-emoji",
            type: "button",
            role: "menuitem",
            "aria-label": `React ${emoji}`,
            onClick: () => {
              setReaction(row, emoji);
              close();
            },
          },
          emoji,
        ),
      ),
      // The "＋ more" affordance from the wireframe (a fuller picker is a later concern).
      el("button", { class: "tm-chat-picker-emoji tm-chat-picker-more", type: "button", "aria-label": "More reactions", text: "＋" }),
    ],
  );

  const backdrop = el(
    "div",
    {
      class: "tm-backdrop tm-chat-picker-backdrop",
      onClick: (e) => {
        if (e.target === backdrop) close();
      },
    },
    [picker],
  );
  document.body.append(backdrop);
  document.addEventListener("keydown", onKey);
  picker.querySelector("button")?.focus();
}

/** Set / replace a message's inline reaction pill with the picked emoji (count 1 for a fresh react). */
function setReaction(row, emoji) {
  row.querySelector(".tm-chat-reaction")?.remove();
  row.append(reactionPill(row, emoji, 1));
}

// Bridge for the router (which imports this) + ad-hoc use / QA.
if (typeof window !== "undefined") {
  window.tmChat = { enterChat };
}
