// Chat placeholder view (TM-434) — the `#/chat` "coming soon" stub.
//
// The bottom tab bar (TM-434) ships a Chat tab NOW, but the chat section itself is a separate epic
// (TM-433 — Event group chat). So this is a deliberate PLACEHOLDER: a signed-in user who taps the
// Chat tab lands on a friendly "coming soon" card instead of a dead route. When TM-433 lands it
// swaps in the real chat by rewriting THIS module's enterChat() (and the #chat-view content) — the
// router wiring, the tab, and the nav need no change (that's the whole point of the seam).
//
// Mounting mirrors the other view modules (help.js / profile.js / events.js): router.js owns
// #chat-view visibility and the protected-route gate, and calls enterChat() on entry; this builds
// the content into that container once and is idempotent on re-entry. It's a protected route, so the
// onboarding/terms gates already apply upstream in the router guard.
//
// XSS-safe (every node via ui.js `el()`, textContent only — no innerHTML) and theme-token styled
// (see the .chat-view rules in styles.css), so it renders under clean / doodle / sketch and inside
// the Android WebView with no per-theme work. The chat doodle motif inks with `currentColor`, so it
// picks up the active theme's foreground.

import { clear, el } from "./ui.js";
import { doodle } from "./doodles.js";

const $ = (id) => document.getElementById(id);

/** Build the (idempotent) "Chat — coming soon" stub into #chat-view. */
export function enterChat() {
  const view = $("chat-view");
  if (!view) return;

  // The hand-drawn chat/speech-bubble motif (TM-214). Sized + inked here so it renders in every
  // theme (currentColor), not only the doodle skin; title makes it an accessible <img>.
  const icon = doodle("chat", { size: 96, title: "Chat", class: "chat-coming-icon" });

  clear(view).append(
    el("div", { class: "chat-view-card tm-empty" }, [
      icon,
      el("h2", { text: "Chat" }),
      el("p", { class: "chat-coming-badge", text: "Coming soon" }),
      el("p", {
        class: "chat-coming-lead",
        text:
          "Group chat for your events is on its way. Soon you'll be able to talk to everyone " +
          "who's going — sort out the details, share plans, and keep the conversation in one place.",
      }),
      el("p", {
        class: "chat-coming-hint",
        text: "For now, head to Events to find something to go to.",
      }),
    ]),
  );
}
