// Shared UI component library — DOM factories (TM-511).
//
// The thin DOM half of the component library: each factory turns a pure descriptor from
// `components-core.js` into a real, accessible node via ui.js `el()` (XSS-safe — text only, no
// innerHTML). The pure logic (variants, states, ARIA text, formatting) is tested without a DOM in
// web/tools/components-core.test.mjs; this file just assembles nodes + wires interaction, so there is
// almost nothing here to get wrong.
//
// Every component reproduces its tile in design-kit/showcase-paper.html and is styled from the
// reconciled design tokens (TM-510) via `.tm-c-*` rules in styles.css, so the whole set restyles when
// the theme flips (clean / doodle / sketch) with no per-component work — that's the AC. Import-safe on
// the web only (needs `document`); the gallery page (gallery.js) is the primary consumer, and screen
// modules can import individual factories as the screen-refresh tickets land.

import { el } from "./ui.js";
import {
  buttonSpec,
  tagSpec,
  pillSpec,
  chipSpec,
  inputSpec,
  segmentedSpec,
  toggleSpec,
  progressSpec,
  badgeSpec,
  unreadDotSpec,
  avatarSpec,
  reactionSpec,
  readReceiptSpec,
  overlaySpec,
} from "./components-core.js";

/* ─────────────────────────────── Buttons ──────────────────────────────────────────────────── */

/**
 * A button. `variant`: "primary" | "ghost" | "danger" | "soon" (soon = disabled placeholder).
 * @param {string} label
 * @param {{variant?: string, onClick?: Function, type?: string, disabled?: boolean}} [opts]
 */
export function button(label, { variant = "primary", onClick, type = "button", disabled } = {}) {
  const spec = buttonSpec(variant);
  return el("button", {
    class: spec.classes.join(" "),
    type,
    // `soon` is inherently disabled; an explicit `disabled` can also force it on any variant.
    disabled: spec.disabled || Boolean(disabled),
    text: label,
    onClick: onClick && !(spec.disabled || disabled) ? onClick : null,
  });
}

/* ─────────────────────────────── Tags & pills ─────────────────────────────────────────────── */

/** A faint category tag, e.g. "Dog walks". */
export function tag(text) {
  return el("span", { class: tagSpec().classes.join(" "), text });
}

/** A count/status pill, e.g. "12 going"; `full: true` gives the muted at-capacity look. */
export function pill(text, { full = false } = {}) {
  return el("span", { class: pillSpec({ full }).classes.join(" "), text });
}

/* ─────────────────────────────── Interest chips ───────────────────────────────────────────── */

/** A selectable interest chip (aria-pressed toggle button). Returns the button node. */
export function chip(label, { selected = false, onChange } = {}) {
  const btn = el("button", {
    class: chipSpec({ selected }).classes.join(" "),
    type: "button",
    "aria-pressed": selected ? "true" : "false",
    text: label,
  });
  // Self-manage the pressed state + class on click, and notify the caller of the new state.
  btn.addEventListener("click", () => {
    const now = btn.getAttribute("aria-pressed") !== "true";
    btn.setAttribute("aria-pressed", now ? "true" : "false");
    btn.classList.toggle("tm-c-chip--selected", now);
    if (typeof onChange === "function") onChange(now);
  });
  return btn;
}

/* ─────────────────────────────── Text input ───────────────────────────────────────────────── */

/**
 * A labelled text input. Returns a `<label class="tm-c-field">` wrapping the caption + `<input>`
 * (the caption is visually hidden when `hideLabel` so the field still matches the bare tile).
 * @param {{label?: string, value?: string, placeholder?: string, type?: string, invalid?: boolean,
 *   hideLabel?: boolean, onInput?: Function}} [opts]
 */
export function textInput({
  label = "",
  value = "",
  placeholder = "",
  type = "text",
  invalid = false,
  hideLabel = false,
  onInput,
} = {}) {
  const input = el("input", {
    class: inputSpec({ invalid }).classes.join(" "),
    type,
    value,
    placeholder,
    "aria-invalid": invalid ? "true" : null,
    onInput: onInput ? (e) => onInput(e.target.value, e) : null,
  });
  return el("label", { class: `tm-c-field${hideLabel ? " tm-c-field--nolabel" : ""}` }, [
    label ? el("span", { class: "tm-c-field-label", text: label }) : null,
    input,
  ]);
}

/* ─────────────────────────────── Segmented control ────────────────────────────────────────── */

/**
 * A segmented control over `options` (an array of labels). Clicking a segment updates the active
 * one and calls `onChange(index, label)`. Built as a radiogroup for accessibility.
 * @param {string[]} options
 * @param {{active?: number, onChange?: Function, ariaLabel?: string}} [opts]
 */
export function segmented(options, { active = 0, onChange, ariaLabel = "Segmented control" } = {}) {
  const spec = segmentedSpec(options, active);
  const group = el("div", { class: "tm-c-seg tm-wobble-soft", role: "radiogroup", "aria-label": ariaLabel });
  const buttons = spec.options.map((opt) =>
    el("button", {
      class: `tm-c-seg__opt${opt.on ? " tm-c-seg__opt--on" : ""}`,
      type: "button",
      role: "radio",
      "aria-checked": opt.on ? "true" : "false",
      text: opt.label,
      onClick: () => select(opt.index),
    }),
  );
  function select(index) {
    buttons.forEach((b, i) => {
      const on = i === index;
      b.classList.toggle("tm-c-seg__opt--on", on);
      b.setAttribute("aria-checked", on ? "true" : "false");
    });
    if (typeof onChange === "function") onChange(index, spec.options[index]?.label);
  }
  group.append(...buttons);
  return group;
}

/* ─────────────────────────────── Toggle ───────────────────────────────────────────────────── */

/**
 * An on/off switch (role="switch" button). Calls `onChange(on)` when flipped.
 * @param {{on?: boolean, onChange?: Function, ariaLabel?: string}} [opts]
 */
export function toggle({ on = false, onChange, ariaLabel = "Toggle" } = {}) {
  const spec = toggleSpec(on);
  const btn = el("button", {
    class: spec.classes.join(" "),
    type: "button",
    role: "switch",
    "aria-checked": spec.ariaChecked,
    "aria-label": ariaLabel,
  });
  // The sliding thumb is a child element so the wobble filter can warp the track edge without the
  // thumb (::after would work too, but an element keeps it inspectable/animatable).
  btn.append(el("span", { class: "tm-c-toggle__thumb" }));
  btn.addEventListener("click", () => {
    const now = btn.getAttribute("aria-checked") !== "true";
    btn.setAttribute("aria-checked", now ? "true" : "false");
    btn.classList.toggle("tm-c-toggle--on", now);
    if (typeof onChange === "function") onChange(now);
  });
  return btn;
}

/* ─────────────────────────────── Progress ─────────────────────────────────────────────────── */

/** A progress bar. `value` is a 0..1 fraction. Returns a role="progressbar" node. */
export function progress(value = 0, { ariaLabel = "Progress" } = {}) {
  const spec = progressSpec(value);
  const fill = el("i", { class: "tm-c-progress__fill" });
  fill.style.width = `${spec.pct}%`;
  return el(
    "div",
    {
      class: "tm-c-progress tm-wobble-soft",
      role: "progressbar",
      "aria-label": ariaLabel,
      "aria-valuemin": "0",
      "aria-valuemax": "100",
      "aria-valuenow": String(spec.ariaValueNow),
    },
    [fill],
  );
}

/* ─────────────────────────────── Badges & dots ────────────────────────────────────────────── */

/** A count badge (e.g. 2, or 99+ for large counts). */
export function badge(count) {
  const spec = badgeSpec(count);
  return el("span", { class: spec.classes.join(" "), text: spec.text });
}

/** An unread (accent) / read (hollow) status dot with an accessible label. */
export function unreadDot(read = false) {
  const spec = unreadDotSpec(read);
  return el("span", { class: spec.classes.join(" "), role: "img", "aria-label": spec.ariaLabel });
}

/* ─────────────────────────────── Avatar & reaction ────────────────────────────────────────── */

/** A round avatar showing an initial (from a name) or a passed-through emoji. */
export function avatar(label = "") {
  const spec = avatarSpec(label);
  return el("span", { class: spec.classes.join(" "), "aria-label": spec.label || "Avatar", role: "img" }, [
    el("span", { class: "tm-c-avatar__glyph", text: spec.glyph }),
  ]);
}

/** A reaction pill, e.g. 👍 3. */
export function reaction(emoji, count = 0, { onClick } = {}) {
  const spec = reactionSpec({ emoji, count });
  const tagName = onClick ? "button" : "span";
  return el(
    tagName,
    {
      class: spec.classes.join(" "),
      type: onClick ? "button" : null,
      "aria-label": spec.ariaLabel,
      onClick: onClick || null,
    },
    [el("span", { class: "tm-c-reaction__emoji", text: spec.emoji }), el("span", { text: String(spec.count) })],
  );
}

/* ─────────────────────────────── Read-receipt ticks ───────────────────────────────────────── */

/**
 * A read-receipt tick group. `state`: "sent" (✓) | "read" (✓✓) | "group" (✓✓✓ = whole-group-read).
 * The glyph is aria-hidden and the meaning is exposed via aria-label so screen readers announce
 * "Read by everyone" rather than a run of check marks.
 */
export function readReceipt(state) {
  const spec = readReceiptSpec(state);
  return el(
    "span",
    { class: spec.classes.join(" "), role: "img", "aria-label": spec.ariaLabel, dataset: { state: spec.state } },
    [el("span", { "aria-hidden": "true", text: spec.glyph })],
  );
}

/* ─────────────────────────────── Bottom sheet / modal ─────────────────────────────────────── */

/**
 * Open an overlay (a centred `modal` card or a bottom `sheet`) holding arbitrary content over a
 * dimmed backdrop. Closes on the × button, Escape, or a backdrop click. Returns `{ close, backdrop }`.
 * Mirrors ui.js `modal()`'s focus/Escape handling, adding the bottom-sheet shape the paper screens use.
 * @param {string} title
 * @param {(Node|string)[]|Node|string} content
 * @param {{kind?: "modal"|"sheet", onClose?: Function}} [opts]
 */
export function openOverlay(title, content, { kind = "modal", onClose } = {}) {
  const spec = overlaySpec(kind);
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  const close = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
    if (typeof onClose === "function") onClose();
  };
  const surface = el(
    "div",
    { class: `${spec.surfaceClass} tm-wobble`, role: "dialog", "aria-modal": "true", "aria-label": title },
    [
      // Bottom sheets show a grab handle; both show a title + close button.
      spec.kind === "sheet" ? el("span", { class: "tm-c-sheet__handle", "aria-hidden": "true" }) : null,
      el("div", { class: "tm-c-overlay-head" }, [
        el("h2", { class: "tm-c-overlay-title", text: title }),
        el("button", { class: "tm-toast-close", type: "button", "aria-label": "Close", onClick: close }, "×"),
      ]),
      el("div", { class: "tm-c-overlay-body" }, content),
    ],
  );
  const backdrop = el(
    "div",
    {
      class: spec.backdropClass,
      onClick: (e) => {
        if (e.target === backdrop) close();
      },
    },
    [surface],
  );
  document.body.append(backdrop);
  document.addEventListener("keydown", onKey);
  return { close, backdrop };
}

/** Convenience: a bottom sheet (the report/venue-suggestion shape). */
export function bottomSheet(title, content, opts = {}) {
  return openOverlay(title, content, { ...opts, kind: "sheet" });
}
