// Shared UI component library (TM-511) — the approved wireframe's building blocks as reusable,
// framework-free components, so screens are assembled from consistent parts instead of bespoke markup.
//
// WHAT THIS IS
// A single import surface for the components the TM-377 wireframes use: buttons (primary / ghost /
// danger / neutral), tags + chips, a segmented control, a toggle switch, a labelled text field,
// progress, avatar + reaction, badges (incl. a count bubble), read-receipt ticks — including the
// triple-tick "whole-group-read" state (TM-433) — plus bottom sheets and modals.
//
// TWO HARD RULES (the ticket's ACs):
//   • Tokens only. Every visual is driven by the reconciled design tokens (TM-510) via the CSS in
//     styles.css; NOTHING here hard-codes a colour/shadow/radius. A theme flip (clean ⇄ doodle ⇄
//     sketch) is therefore a pure token swap — these components restyle with zero JS changes (AC2).
//   • Same idiom as the rest of the app. Built on the XSS-safe `el()` DOM builder from ui.js (text
//     only ever set via textContent), mirroring account-badges.js: a PURE descriptor where there is
//     real logic (read receipts, avatar initials) that unit-tests without a DOM, plus thin renderers.
//
// Guarded by web/tools/component-library.test.mjs (render + token-driven-restyle) and previewable in
// the storybook at web/src/design-kit/showcase-paper.html.

import { el } from "./ui.js";

// Re-export the two overlay primitives ui.js already owns so the component library is one entry
// point (a screen imports modals/confirms + the new components from the same module).
export { modal, confirmDialog } from "./ui.js";

/* ═══════════════════════════════════════════════ Buttons ═══════════════════════════════════════ */

// The variant → CSS-class map. `neutral` is the bare `.tm-btn` surface button; the others layer a
// fill/ghost modifier on top. `ghost` is the new transparent-accent variant TM-511 adds (the
// primary/danger fills already ship in styles.css).
const BUTTON_VARIANTS = {
  primary: "tm-btn-primary",
  danger: "tm-btn-danger",
  ghost: "tm-btn-ghost",
  neutral: "",
};

/**
 * A button. Renders `.tm-btn` + the variant modifier.
 * @param {string} label visible text (set via textContent — safe for untrusted strings)
 * @param {{variant?: "primary"|"ghost"|"danger"|"neutral", size?: "sm", type?: string,
 *   onClick?: Function, disabled?: boolean, ariaLabel?: string}} [opts]
 * @returns {HTMLButtonElement}
 */
export function button(label, { variant = "primary", size, type = "button", onClick, disabled = false, ariaLabel } = {}) {
  const cls = ["tm-btn", BUTTON_VARIANTS[variant] ?? "", size === "sm" ? "tm-btn-sm" : ""]
    .filter(Boolean)
    .join(" ");
  return el("button", { class: cls, type, disabled, onClick, "aria-label": ariaLabel }, label);
}

/* ══════════════════════════════════════════ Tags & chips ═══════════════════════════════════════ */

/**
 * A tag — a small, STATIC category label (non-interactive). Distinct from a chip: no click, no state.
 * @param {string} label
 * @param {{variant?: "default"|"accent"|"muted"}} [opts]
 * @returns {HTMLSpanElement}
 */
export function tag(label, { variant = "default" } = {}) {
  return el("span", { class: `tm-tag tm-tag-${variant}` }, label);
}

/**
 * A chip — an INTERACTIVE pill: selectable (filter chip, toggles `aria-pressed`) and/or removable
 * (input chip with an ✕). Selection state is reflected on the DOM (aria-pressed) so it restyles via
 * the `[aria-pressed="true"]` token rule — no JS colour logic.
 * @param {string} label
 * @param {{selected?: boolean, value?: string, onToggle?: (selected:boolean, value:string)=>void,
 *   removable?: boolean, onRemove?: (value:string)=>void}} [opts]
 * @returns {HTMLButtonElement}
 */
export function chip(label, { selected = false, value = label, onToggle, removable = false, onRemove } = {}) {
  const node = el("button", {
    class: "tm-chip",
    type: "button",
    "aria-pressed": String(!!selected),
    dataset: { value },
    onClick: () => {
      const next = node.getAttribute("aria-pressed") !== "true";
      node.setAttribute("aria-pressed", String(next));
      if (typeof onToggle === "function") onToggle(next, value);
    },
  }, label);
  if (removable) {
    node.append(el("span", {
      class: "tm-chip-remove",
      role: "button",
      "aria-label": `Remove ${label}`,
      // Stop the remove ✕ from also toggling selection; then detach + notify.
      onClick: (e) => {
        if (e && typeof e.stopPropagation === "function") e.stopPropagation();
        node.remove();
        if (typeof onRemove === "function") onRemove(value);
      },
    }, "×")); // × multiplication sign
  }
  return node;
}

/* ════════════════════════════════════════ Segmented control ════════════════════════════════════ */

/**
 * A segmented control — a radiogroup of mutually-exclusive segments (e.g. "Upcoming / Past"). The
 * selected segment carries `aria-checked="true"`, which the token rule paints as the accent fill.
 * @param {{value:string, label:string}[]} options
 * @param {{value?: string, ariaLabel?: string, onChange?: (value:string)=>void}} [opts]
 * @returns {HTMLDivElement} the group; read the live selection from `dataset.value`.
 */
export function segmented(options, { value, ariaLabel = "Options", onChange } = {}) {
  const selected = value ?? (options[0] && options[0].value);
  const group = el("div", { class: "tm-segmented", role: "radiogroup", "aria-label": ariaLabel, dataset: { value: selected } });
  const segments = options.map((opt) =>
    el("button", {
      class: "tm-segment",
      type: "button",
      role: "radio",
      "aria-checked": String(opt.value === selected),
      dataset: { value: opt.value },
      onClick: () => {
        if (group.dataset.value === opt.value) return; // no-op re-select
        group.dataset.value = opt.value;
        for (const s of segments) s.setAttribute("aria-checked", String(s.dataset.value === opt.value));
        if (typeof onChange === "function") onChange(opt.value);
      },
    }, opt.label),
  );
  for (const s of segments) group.append(s);
  return group;
}

/* ═══════════════════════════════════════════ Toggle switch ═════════════════════════════════════ */

/**
 * A toggle switch (role="switch"). Reflects on/off via `aria-checked` (token-styled track + thumb);
 * the thumb is the one sanctioned always-white chrome (`var(--white)`, per the token doc).
 * @param {{checked?: boolean, label?: string, ariaLabel?: string, onChange?: (checked:boolean)=>void}} [opts]
 * @returns {HTMLElement} the switch, or a label wrapping text + switch when `label` is given.
 */
export function toggle({ checked = false, label, ariaLabel, onChange } = {}) {
  const sw = el("button", {
    class: "tm-toggle",
    type: "button",
    role: "switch",
    "aria-checked": String(!!checked),
    "aria-label": label ? null : (ariaLabel || "Toggle"),
    onClick: () => {
      const next = sw.getAttribute("aria-checked") !== "true";
      sw.setAttribute("aria-checked", String(next));
      if (typeof onChange === "function") onChange(next);
    },
  }, [el("span", { class: "tm-toggle-thumb", "aria-hidden": "true" })]);
  if (!label) return sw;
  return el("label", { class: "tm-toggle-field" }, [el("span", { class: "tm-toggle-label", text: label }), sw]);
}

/* ═══════════════════════════════════════════ Text field ════════════════════════════════════════ */

let fieldSeq = 0;

/**
 * A labelled text input. Wires `<label for>`↔`<input id>` for a11y, reuses the shared `.tm-input`
 * chrome, and hangs an optional hint off `aria-describedby`.
 * @param {{label?: string, id?: string, type?: string, name?: string, value?: string,
 *   placeholder?: string, required?: boolean, hint?: string, autocomplete?: string,
 *   onInput?: Function}} [opts]
 * @returns {HTMLDivElement} field wrapper; the `<input>` is `.querySelector(".tm-input")`.
 */
export function textInput({ label, id, type = "text", name, value, placeholder, required = false, hint, autocomplete, onInput } = {}) {
  const inputId = id || `tm-field-${++fieldSeq}`;
  const hintId = hint ? `${inputId}-hint` : null;
  const input = el("input", {
    class: "tm-input",
    id: inputId,
    type,
    name,
    value,
    placeholder,
    required,
    autocomplete,
    "aria-describedby": hintId,
    onInput,
  });
  return el("div", { class: "tm-field" }, [
    label ? el("label", { class: "tm-field-label", for: inputId, text: label }) : null,
    input,
    hint ? el("p", { class: "tm-field-hint", id: hintId, text: hint }) : null,
  ]);
}

/* ════════════════════════════════════════════ Progress ═════════════════════════════════════════ */

/**
 * A progress bar (role="progressbar"). Determinate by default; `indeterminate` drops the value and
 * animates. The fill width is the only inline style (a data value, not a theme value).
 * @param {{value?: number, max?: number, label?: string, indeterminate?: boolean}} [opts]
 * @returns {HTMLDivElement}
 */
export function progress({ value = 0, max = 100, label = "Progress", indeterminate = false } = {}) {
  const pct = indeterminate ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  const fill = el("div", { class: "tm-progress-fill" });
  if (!indeterminate) fill.setAttribute("style", `width: ${pct}%`);
  return el("div", {
    class: `tm-progress${indeterminate ? " tm-progress-indeterminate" : ""}`,
    role: "progressbar",
    "aria-label": label,
    "aria-valuemin": indeterminate ? null : "0",
    "aria-valuemax": indeterminate ? null : String(max),
    "aria-valuenow": indeterminate ? null : String(value),
  }, [fill]);
}

/* ═════════════════════════════════════════ Avatar & reaction ═══════════════════════════════════ */

/**
 * Up-to-two-letter initials for a display name (pure — unit-tested). Falls back to "?" for empties.
 * @param {string} name
 * @returns {string}
 */
export function initials(name) {
  const words = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/**
 * An avatar — a circular initials chip, or a photo when `src` is given.
 * @param {string} name used for initials + the image alt / aria-label
 * @param {{src?: string, size?: "sm"|"md"|"lg"}} [opts]
 * @returns {HTMLSpanElement}
 */
export function avatar(name, { src, size = "md" } = {}) {
  const cls = `tm-avatar${size && size !== "md" ? ` tm-avatar-${size}` : ""}`;
  if (src) {
    return el("span", { class: cls, role: "img", "aria-label": name || "Avatar" }, [
      el("img", { src, alt: name || "", loading: "lazy" }),
    ]);
  }
  return el("span", { class: cls, role: "img", "aria-label": name || "Avatar" }, initials(name));
}

/**
 * A reaction pill — an emoji + count, pressable (toggles `aria-pressed`, token-styled).
 * @param {string} emoji
 * @param {{count?: number, reacted?: boolean, onClick?: (reacted:boolean)=>void}} [opts]
 * @returns {HTMLButtonElement}
 */
export function reaction(emoji, { count = 0, reacted = false, onClick } = {}) {
  const node = el("button", {
    class: "tm-reaction",
    type: "button",
    "aria-pressed": String(!!reacted),
    onClick: () => {
      const next = node.getAttribute("aria-pressed") !== "true";
      node.setAttribute("aria-pressed", String(next));
      if (typeof onClick === "function") onClick(next);
    },
  }, [
    el("span", { class: "tm-reaction-emoji", "aria-hidden": "true", text: emoji }),
    el("span", { class: "tm-reaction-count", text: String(count) }),
  ]);
  return node;
}

/* ═════════════════════════════════════════════ Badges ══════════════════════════════════════════ */

// Semantic badge variants → the classes already defined in styles.css (TM-133/TM-168), so a badge is
// one call rather than remembering the modifier names.
const BADGE_VARIANTS = {
  default: "",
  ok: "tm-badge-ok",
  off: "tm-badge-off",
  unknown: "tm-badge-unknown",
  admin: "tm-badge-role-admin",
};

/**
 * A pill badge (status / label).
 * @param {string} label
 * @param {{variant?: "default"|"ok"|"off"|"unknown"|"admin"}} [opts]
 * @returns {HTMLSpanElement}
 */
export function badge(label, { variant = "default" } = {}) {
  const cls = ["tm-badge", BADGE_VARIANTS[variant] ?? ""].filter(Boolean).join(" ");
  return el("span", { class: cls }, label);
}

/**
 * A count / notification bubble (e.g. an unread count). Renders "9+" past `max`.
 * @param {number} count
 * @param {{max?: number, ariaLabel?: string}} [opts]
 * @returns {HTMLSpanElement}
 */
export function countBadge(count, { max = 99, ariaLabel } = {}) {
  const n = Number(count) || 0;
  const text = n > max ? `${max}+` : String(n);
  return el("span", { class: "tm-badge-count", "aria-label": ariaLabel || `${n} unread` }, text);
}

/* ══════════════════════════════════════ Read-receipt ticks ═════════════════════════════════════ */
//
// The messaging read state (TM-376 / TM-433). Four states, drawn as 1–3 ✓ glyphs:
//   • sent       — ✓    delivered to the server, muted ink
//   • delivered  — ✓✓   delivered to the recipient's device, muted ink
//   • read       — ✓✓   the recipient READ it → accent ink (the "read" colour)
//   • group-read — ✓✓✓  the WHOLE GROUP has read it (TM-433 triple-tick), accent ink
// The number of ticks and the read/unread colour are DATA-DRIVEN off the state, expressed as a pure
// descriptor so the whole-group-read rule is unit-tested without a DOM.

const RECEIPT_DESCRIPTORS = {
  sent: { ticks: 1, read: false, label: "Sent" },
  delivered: { ticks: 2, read: false, label: "Delivered" },
  read: { ticks: 2, read: true, label: "Read" },
  "group-read": { ticks: 3, read: true, label: "Read by everyone" },
};

/** The ordered, valid receipt states. */
export const RECEIPT_STATES = Object.keys(RECEIPT_DESCRIPTORS);

/**
 * PURE descriptor for a read-receipt state (unit-tested). Unknown states fall back to "sent" so a
 * bad value never throws or renders blank.
 * @param {"sent"|"delivered"|"read"|"group-read"} state
 * @returns {{state:string, ticks:1|2|3, read:boolean, label:string}}
 */
export function readReceiptState(state) {
  const d = RECEIPT_DESCRIPTORS[state] || RECEIPT_DESCRIPTORS.sent;
  const resolved = RECEIPT_DESCRIPTORS[state] ? state : "sent";
  return { state: resolved, ticks: d.ticks, read: d.read, label: d.label };
}

/**
 * Render the read-receipt ticks for a message. Colour + tick-count come from `readReceiptState`, so
 * the whole-group-read triple-tick is one code path, not a special case in the view.
 * @param {"sent"|"delivered"|"read"|"group-read"} state
 * @returns {HTMLSpanElement}
 */
export function readReceipt(state) {
  const d = readReceiptState(state);
  const ticks = [];
  for (let i = 0; i < d.ticks; i++) {
    ticks.push(el("span", { class: "tm-tick", "aria-hidden": "true", text: "✓" })); // ✓
  }
  return el("span", {
    class: `tm-ticks${d.read ? " tm-ticks-read" : ""}`,
    role: "img",
    dataset: { state: d.state },
    "aria-label": d.label,
  }, ticks);
}

/* ═══════════════════════════════════════════ Bottom sheet ══════════════════════════════════════ */

/**
 * A bottom sheet — a mobile-first drawer docked to the bottom edge that becomes a centred card on
 * wider viewports (CSS media query). Mirrors ui.js `modal` semantics: closes on the ✕, Escape, or a
 * backdrop click. Reuses the shared `.tm-backdrop` overlay token.
 * @param {string} title
 * @param {(Node|string|null)[]|Node|string} content
 * @param {{onClose?: Function}} [opts]
 * @returns {{el: HTMLElement, close: Function}} the backdrop node + a programmatic close.
 */
export function bottomSheet(title, content, { onClose } = {}) {
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  const close = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
    if (typeof onClose === "function") onClose();
  };
  const sheet = el("div", { class: "tm-sheet", role: "dialog", "aria-modal": "true", "aria-label": title }, [
    el("div", { class: "tm-sheet-handle", "aria-hidden": "true" }),
    el("div", { class: "tm-modal-head" }, [
      el("h2", { class: "tm-dialog-title", text: title }),
      el("button", { class: "tm-toast-close", type: "button", "aria-label": "Close", onClick: close }, "×"),
    ]),
    el("div", { class: "tm-sheet-body" }, content),
  ]);
  const backdrop = el("div", {
    class: "tm-backdrop tm-backdrop-sheet",
    onClick: (e) => {
      if (e.target === backdrop) close();
    },
  }, [sheet]);
  document.body.append(backdrop);
  document.addEventListener("keydown", onKey);
  return { el: backdrop, close };
}
