// Component gallery / storybook (TM-511) — the "renders every component for visual review" AC.
//
// A standalone review page (gallery.html) that mounts one tile per shared component from the
// COMPONENTS catalogue, each reproducing its design-kit/showcase-paper.html "Design elements · paper"
// tile. It also wires a live theme switcher (clean / doodle / sketch) + accent override so a reviewer
// can watch the WHOLE set restyle from tokens alone (the "restyle automatically when the theme flips"
// AC) — nothing here hard-codes a colour; flipping `data-theme` on <html> or the `--accent` token
// re-skins every tile. Framework-free: built from the same ui.js `el()` + the component factories the
// real screens will import.

import { el, clear } from "./ui.js";
import { COMPONENTS } from "./components-core.js";
import {
  button,
  tag,
  pill,
  chip,
  textInput,
  segmented,
  toggle,
  progress,
  badge,
  unreadDot,
  avatar,
  reaction,
  readReceipt,
  openOverlay,
  bottomSheet,
} from "./components.js";

/** A labelled demo tile wrapping a component sample (mirrors the showcase-paper `.tile`). */
function tile(id, title, ...samples) {
  return el("section", { class: "g-tile", id: `tile-${id}` }, [
    el("div", { class: "g-tile__label", text: title }),
    el("div", { class: "g-tile__row" }, samples),
  ]);
}

/** A small stacked group inside a tile (label above a row of samples). */
function group(label, ...nodes) {
  return el("div", { class: "g-group" }, [el("span", { class: "g-group__cap", text: label }), ...nodes]);
}

/** Build the demo content for one component id. Each returns an array of sample nodes. */
const BUILDERS = {
  buttons: () => [
    button("Primary", { variant: "primary" }),
    button("Ghost", { variant: "ghost" }),
    button("Delete", { variant: "danger" }),
    button("Soon", { variant: "soon" }),
  ],
  "tags-pills": () => [tag("Dog walks"), pill("12 going"), pill("Full · waitlist 2", { full: true })],
  chips: () => [
    chip("Coffee", { selected: true }),
    chip("Hiking", { selected: true }),
    chip("Dogs"),
    chip("Sport"),
  ],
  input: () => [textInput({ label: "Email", placeholder: "you@example.com", type: "email", hideLabel: true })],
  segmented: () => [segmented(["Going", "Waitlist"], { active: 0, ariaLabel: "RSVP state" })],
  toggle: () => [
    group("On", toggle({ on: true, ariaLabel: "Notifications" })),
    group("Off", toggle({ on: false, ariaLabel: "Email digest" })),
  ],
  progress: () => [progress(0.62, { ariaLabel: "Profile completeness" })],
  "avatar-reaction": () => [avatar("Basit"), avatar("🐕"), reaction("👍", 3), reaction("❤️", 2)],
  "badges-dots": () => [
    badge(2),
    badge(5),
    badge(120),
    group("Unread", unreadDot(false)),
    group("Read", unreadDot(true)),
  ],
  // The delivery ladder — including the TM-511 triple-tick whole-group-read state.
  "read-ticks": () => [
    group("Sent", readReceipt("sent")),
    group("Read", readReceipt("read")),
    group("Read by all", readReceipt("group")),
  ],
  "sheet-modal": () => [
    button("Open modal", {
      variant: "primary",
      onClick: () =>
        openOverlay("You're here?", [
          el("p", { text: "Coffee & Code is happening now. Confirm your attendance." }),
          button("Confirm with location", { variant: "primary" }),
        ]),
    }),
    button("Open bottom sheet", {
      variant: "ghost",
      onClick: () =>
        bottomSheet("Report a person", [
          el("p", { text: "Reports are anonymous." }),
          button("Block this person", { variant: "danger" }),
        ]),
    }),
  ],
};

/** Render every catalogued component into the gallery grid. */
export function renderGallery(root) {
  clear(root);
  for (const c of COMPONENTS) {
    const build = BUILDERS[c.id];
    // Every catalogued component must have a builder — this is asserted in the test too, so the
    // gallery can never silently omit a component the catalogue promises.
    root.append(tile(c.id, c.title, ...(build ? build() : [el("em", { text: "—" })])));
  }
}

/** Wire the theme + accent controls so the reviewer can watch the tokens re-skin every tile. */
function wireControls() {
  const htmlEl = document.documentElement;
  document.querySelectorAll("[data-theme-btn]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const theme = btn.getAttribute("data-theme-btn");
      htmlEl.setAttribute("data-theme", theme);
      document.querySelectorAll("[data-theme-btn]").forEach((b) =>
        b.setAttribute("aria-pressed", b === btn ? "true" : "false"),
      );
    });
  });
  const accent = document.getElementById("g-accent");
  if (accent) {
    accent.addEventListener("input", () => htmlEl.style.setProperty("--accent", accent.value));
  }
  const reset = document.getElementById("g-accent-reset");
  if (reset) reset.addEventListener("click", () => htmlEl.style.removeProperty("--accent"));
}

document.addEventListener("DOMContentLoaded", () => {
  const root = document.getElementById("gallery");
  if (root) renderGallery(root);
  wireControls();
});
