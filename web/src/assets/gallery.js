// Component gallery / storybook (TM-511) — the "renders every component for visual review" AC.
//
// A standalone review page (gallery.html) that mounts one tile per shared component from the
// COMPONENTS catalogue, each reproducing its design-kit/showcase-paper.html "Design elements · paper"
// tile. It also wires the two live Paper controls (TM-529) — the wavy/sketchy toggle + the curated
// accent swatches — so a reviewer can watch the WHOLE set restyle from tokens alone. Nothing here
// hard-codes a colour; flipping `data-sketchy` on <html> or re-pointing the `--accent` token re-skins
// every tile. Framework-free: built from the same ui.js `el()` + the component factories the real
// screens import, and the same appearance-core palette the app uses.

import { el, clear } from "./ui.js";
import { COMPONENTS } from "./components-core.js";
import { PAPER_PALETTE, applyAppearance, accentById } from "./appearance-core.js";
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

/** Wire the sketchy toggle + curated accent swatches so the reviewer can watch the tokens re-skin. */
function wireControls() {
  const htmlEl = document.documentElement;

  // Wavy/sketchy toggle: flips [data-sketchy] between on/off (the whole hand-drawn skin).
  const sketchyBtn = document.getElementById("g-sketchy");
  if (sketchyBtn) {
    sketchyBtn.addEventListener("click", () => {
      const on = htmlEl.getAttribute("data-sketchy") !== "on";
      htmlEl.setAttribute("data-sketchy", on ? "on" : "off");
      sketchyBtn.setAttribute("aria-pressed", String(on));
      sketchyBtn.textContent = `Wavy / sketchy: ${on ? "on" : "off"}`;
    });
  }

  // Curated accent swatches (the fixed palette) — picking one re-points --accent/--on-accent.
  const swatches = document.getElementById("g-accent-swatches");
  if (swatches) {
    clear(swatches);
    for (const swatch of PAPER_PALETTE) {
      const btn = el("button", {
        type: "button",
        class: "tm-swatch",
        "data-accent": swatch.id,
        style: `--tm-swatch: ${swatch.hex}`,
        "aria-label": swatch.label,
        title: swatch.label,
      });
      btn.addEventListener("click", () => {
        const applied = accentById(swatch.id);
        htmlEl.style.setProperty("--accent", applied.hex);
        htmlEl.style.setProperty("--on-accent", applied.onAccent);
        swatches
          .querySelectorAll("[data-accent]")
          .forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
      });
      swatches.append(btn);
    }
  }

  // Start from the app's default appearance so the gallery matches a fresh user.
  applyAppearance(document, {});
}

document.addEventListener("DOMContentLoaded", () => {
  const root = document.getElementById("gallery");
  if (root) renderGallery(root);
  wireControls();
});
