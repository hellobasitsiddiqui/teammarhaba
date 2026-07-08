// Shared UI component library — PURE logic core (TM-511).
//
// TM-511 builds the approved wireframe kit (design-kit/showcase-paper.html "Design elements · paper"
// tiles) as reusable app components for the framework-free web SPA. Following the codebase's
// established core/renderer split (tabbar-core.js / events-core.js / account-badges.js — see
// AGENTIC-LESSONS "extract the pure logic to test it"), this module holds ONLY the pure descriptor
// logic — which CSS classes, state flags, ARIA text and formatting each component resolves to — with
// NO DOM and NO imports, so it is import-safe in a plain Node test (`node --test web/tools/*.test.mjs`,
// the CI web-build gate). The DOM half (`components.js`) is a thin map from these descriptors to real
// nodes via ui.js `el()`; the visual styling lives in styles.css `.tm-c-*` (token-driven, TM-510).
//
// WHY descriptors rather than DOM here: the CI web gate runs in plain Node with no `document`, so the
// only way to unit-test "a read receipt in the group-read state shows three ticks" or "a disabled
// 'soon' button is non-interactive" is to test the pure mapping. `components.js` then has almost no
// logic of its own to get wrong.
//
// Every component matches its tile in design-kit/showcase-paper.html (the canonical wireframe) and is
// styled entirely from the reconciled design tokens (TM-510) via `.tm-c-*` rules, so it restyles with
// the theme (clean / doodle / sketch) — no hard-coded colours. See styles.css "component library".

/**
 * The component catalogue — the single list the gallery page (gallery.js) iterates to render every
 * component "for visual review" (AC3), and the list the token/spec tests assert against so a new
 * component can't be added without a gallery tile + a matching design-kit tile. `tile` names the
 * design-kit/showcase-paper.html "Design elements · paper" tile each entry reproduces.
 */
export const COMPONENTS = Object.freeze([
  { id: "buttons", title: "Buttons", tile: "Buttons" },
  { id: "tags-pills", title: "Tags & pills", tile: "Tags & pills" },
  { id: "chips", title: "Interest chips", tile: "Interest chips" },
  { id: "input", title: "Text input", tile: "Input" },
  { id: "segmented", title: "Segmented control", tile: "Segmented" },
  { id: "toggle", title: "Toggle", tile: "Toggle" },
  { id: "progress", title: "Progress", tile: "Progress" },
  { id: "avatar-reaction", title: "Avatar & reaction", tile: "Avatar & reaction" },
  { id: "badges-dots", title: "Badges & dots", tile: "Badges & dots" },
  { id: "read-ticks", title: "Read-receipt ticks", tile: "Read ticks" },
  { id: "sheet-modal", title: "Bottom sheet & modal", tile: "(screens: gps-attendance / report)" },
]);

/* ─────────────────────────────── Buttons ─────────────────────────────────────────────────────
 * Matches the "Buttons" tile: Primary (accent fill + offset shadow), Ghost (bare surface), plus the
 * destructive "Danger" variant the ticket calls for, and the disabled "Soon" (dashed, muted) variant
 * the tile shows. `soon` is inherently non-interactive, so its descriptor carries `disabled: true`. */
export const BUTTON_VARIANTS = Object.freeze(["primary", "ghost", "danger", "soon"]);

/**
 * @param {"primary"|"ghost"|"danger"|"soon"} [variant]
 * @returns {{variant: string, classes: string[], disabled: boolean}}
 */
export function buttonSpec(variant = "primary") {
  const v = BUTTON_VARIANTS.includes(variant) ? variant : "primary";
  // Base class always; a modifier for everything but the default primary. `tm-wobble-soft` opts the
  // control into the sketch/doodle hand-drawn edge (styles.css, inert under clean + reduced-motion).
  const classes = ["tm-c-btn", "tm-wobble-soft"];
  if (v !== "primary") classes.push(`tm-c-btn--${v}`);
  return { variant: v, classes, disabled: v === "soon" };
}

/* ─────────────────────────────── Tags & pills ────────────────────────────────────────────────
 * "Tags & pills" tile: a faint category `tag` ("Dog walks"), a count `pill` ("12 going"), and the
 * "full" pill state ("Full · waitlist 2") which drops the accent for a muted, at-capacity look. */
/** @returns {{classes: string[]}} */
export function tagSpec() {
  return { classes: ["tm-c-tag", "tm-wobble-soft"] };
}

/** @param {{full?: boolean}} [opts] */
export function pillSpec({ full = false } = {}) {
  const classes = ["tm-c-pill", "tm-wobble-soft"];
  if (full) classes.push("tm-c-pill--full");
  return { full: Boolean(full), classes };
}

/* ─────────────────────────────── Interest chips ──────────────────────────────────────────────
 * "Interest chips" tile: selectable pills (onboarding "pick your interests"). A selected chip fills
 * with the accent; it's a toggle button, so it announces its state via aria-pressed. */
/** @param {{selected?: boolean}} [opts] */
export function chipSpec({ selected = false } = {}) {
  const classes = ["tm-c-chip", "tm-wobble-soft"];
  if (selected) classes.push("tm-c-chip--selected");
  return { selected: Boolean(selected), classes, ariaPressed: selected ? "true" : "false" };
}

/* ─────────────────────────────── Text input ──────────────────────────────────────────────────
 * "Input" tile: a single-line field ("you@example.com"). */
/** @param {{invalid?: boolean}} [opts] */
export function inputSpec({ invalid = false } = {}) {
  const classes = ["tm-c-input", "tm-wobble-soft"];
  if (invalid) classes.push("tm-c-input--invalid");
  return { invalid: Boolean(invalid), classes, ariaInvalid: invalid ? "true" : null };
}

/* ─────────────────────────────── Segmented control ───────────────────────────────────────────
 * "Segmented" tile: a 2-up switch (Going / Waitlist) with the active segment accent-filled. Modelled
 * generically over N options + an active index so screens can reuse it (Upcoming/Past, etc.). */
/**
 * @param {string[]} options
 * @param {number} [activeIndex]
 * @returns {{activeIndex: number, options: {label: string, on: boolean, index: number}[]}}
 */
export function segmentedSpec(options, activeIndex = 0) {
  const opts = Array.isArray(options) ? options : [];
  // Clamp the active index into range so a caller can't light a non-existent segment.
  const active = opts.length ? Math.min(Math.max(0, activeIndex | 0), opts.length - 1) : -1;
  return {
    activeIndex: active,
    options: opts.map((label, index) => ({ label: String(label), index, on: index === active })),
  };
}

/* ─────────────────────────────── Toggle ──────────────────────────────────────────────────────
 * "Toggle" tile: an on/off switch (track + sliding thumb), accent-filled when on. Rendered as a
 * `role="switch"` button so it's keyboard-operable and announces aria-checked. */
/** @param {boolean} [on] */
export function toggleSpec(on = false) {
  const classes = ["tm-c-toggle", "tm-wobble-soft"];
  if (on) classes.push("tm-c-toggle--on");
  return { on: Boolean(on), classes, ariaChecked: on ? "true" : "false" };
}

/* ─────────────────────────────── Progress ────────────────────────────────────────────────────
 * "Progress" tile: a track with an accent fill (the tile shows 62%). Value is a 0..1 fraction, and
 * we clamp out-of-range input so a bad caller can never overflow the bar. */
/** @param {number} [value] fraction 0..1 */
export function progressSpec(value = 0) {
  const raw = Number(value);
  const clamped = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
  const pct = Math.round(clamped * 100);
  return { value: clamped, pct, ariaValueNow: pct };
}

/* ─────────────────────────────── Badges & dots ───────────────────────────────────────────────
 * "Badges & dots" tile: a count badge (accent pill, e.g. "2"/"5") and an unread/read dot. A count
 * over `max` collapses to "max+" (e.g. 100 → "99+") so the badge never grows unbounded. */
/** @param {number} count @param {{max?: number}} [opts] */
export function badgeSpec(count, { max = 99 } = {}) {
  const n = Math.max(0, Math.trunc(Number(count) || 0));
  return { count: n, text: n > max ? `${max}+` : String(n), classes: ["tm-c-badge"] };
}

/** @param {boolean} [read] the read (hollow) vs unread (accent-filled) dot state. */
export function unreadDotSpec(read = false) {
  const classes = ["tm-c-dot"];
  if (read) classes.push("tm-c-dot--read");
  return { read: Boolean(read), classes, ariaLabel: read ? "Read" : "Unread" };
}

/* ─────────────────────────────── Avatar & reaction ───────────────────────────────────────────
 * "Avatar & reaction" tile: a round avatar holding an initial or emoji, and a reaction pill
 * ("👍 3"). The avatar collapses its label to a single displayed glyph (initial for a name). */
/** @param {string} [label] */
export function avatarSpec(label = "") {
  const text = String(label).trim();
  // A multi-char alphanumeric label (a name) shows its first character uppercased; a single glyph /
  // emoji ("🐕") passes through unchanged.
  const glyph = text ? ([...text][0] || "").toUpperCase() : "?";
  return { label: text, glyph, classes: ["tm-c-avatar", "tm-wobble-soft"] };
}

/** @param {{emoji: string, count?: number}} opts */
export function reactionSpec({ emoji, count = 0 } = {}) {
  const n = Math.max(0, Math.trunc(Number(count) || 0));
  return {
    emoji: String(emoji || ""),
    count: n,
    classes: ["tm-c-reaction", "tm-wobble-soft"],
    ariaLabel: `${emoji} reacted ${n} ${n === 1 ? "time" : "times"}`,
  };
}

/* ─────────────────────────────── Read-receipt ticks ──────────────────────────────────────────
 * "Read ticks" tile plus the ticket's explicit requirement: the TRIPLE-tick whole-group-read state
 * (per the TM-433 group chat). The delivery ladder is:
 *   • sent  → ✓    (one tick — delivered to the server)
 *   • read  → ✓✓   (two ticks — read by a recipient)
 *   • group → ✓✓✓  (three ticks — read by EVERYONE in the group; the new whole-group-read state)
 * The tick count is the meaning (not colour), so it survives the grayscale sketch theme. */
export const READ_STATES = Object.freeze({
  sent: { ticks: 1, glyph: "✓", label: "Sent" },
  read: { ticks: 2, glyph: "✓✓", label: "Read" },
  group: { ticks: 3, glyph: "✓✓✓", label: "Read by everyone" },
});

/** Accepted state names + a couple of friendly aliases → canonical key. */
const READ_ALIASES = { delivered: "sent", "group-read": "group", all: "group", everyone: "group" };

/**
 * @param {"sent"|"read"|"group"|"delivered"|"group-read"} state
 * @returns {{state: string, ticks: number, glyph: string, label: string, classes: string[], ariaLabel: string}}
 */
export function readReceiptSpec(state) {
  const key = READ_STATES[state] ? state : READ_ALIASES[state] || "sent";
  const entry = READ_STATES[key];
  return {
    state: key,
    ticks: entry.ticks,
    glyph: entry.glyph,
    label: entry.label,
    classes: ["tm-c-ticks", `tm-c-ticks--${key}`],
    ariaLabel: entry.label,
  };
}

/* ─────────────────────────────── Bottom sheet / modal ────────────────────────────────────────
 * The paper screens use two overlay shapes over a dimmed backdrop: a centred `modal` card
 * (gps-attendance, claim-spot) and a bottom `sheet` (report). Both are token-styled (`.tm-c-modal` /
 * `.tm-c-sheet`) and reuse the existing `.tm-backdrop` overlay from TM-133. These descriptors just
 * name the surface class; the open/close + focus/Escape handling lives in components.js. */
export const OVERLAY_KINDS = Object.freeze(["modal", "sheet"]);

/** @param {"modal"|"sheet"} [kind] */
export function overlaySpec(kind = "modal") {
  const k = OVERLAY_KINDS.includes(kind) ? kind : "modal";
  return {
    kind: k,
    surfaceClass: k === "sheet" ? "tm-c-sheet" : "tm-c-modal",
    // A bottom sheet anchors to the bottom edge; a modal centres. Both add the wobble edge.
    backdropClass: k === "sheet" ? "tm-backdrop tm-c-sheet-backdrop" : "tm-backdrop",
  };
}
