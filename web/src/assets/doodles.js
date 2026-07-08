// Doodle asset pack (TM-214) — hand-drawn, MVP-rough SVG line-art for the "doodle" theme.
//
// TeamMarhaba is a social-events app, so the motifs are people meeting at events: dates, RSVPs,
// places, a crowd, a hello wave, a celebration, etc. They decorate doodle-theme surfaces (headers,
// empty states like "no events yet", and dividers). They are VISUAL ONLY — TM-215 wires them into
// real pages; this module just provides the pack + how to drop one in.
//
// Design contract (so they restyle with the theme and stay safe):
//   • Themeable — every stroke is `stroke="currentColor"` and fills are `fill="none"` (or
//     `currentColor` where a solid dot/glyph is wanted). NO hardcoded colours, so a doodle inks with
//     the Paper tokens: it picks up `var(--fg)` (ink) wherever it's placed, and flips with dark mode
//     automatically.
//   • Hand-drawn — rough, slightly wobbly paths (round caps/joins) to match Paper's ink-on-paper skin
//     and the wobble filter. They carry the `tm-doodle` class so styles.css can size them under
//     `[data-sketchy="on"]`; opt into the SVG wobble with `tm-wobble-soft` if wanted.
//   • XSS-safe — built structurally from a namespaced element factory that only ever sets attributes
//     (and on the divider, a static `<text>` via `textContent`). There is no innerHTML seam and no
//     user data ever flows in; every doodle is static inline SVG.
//   • Sketchy-only — meant to render under `[data-sketchy="on"]` (the wavy/sketchy Paper look). The
//     pack adds no chrome to clean Paper; pages mount these decorations, CSS hides them when off.
//
// Usage (framework-free SPA, mirrors the el() kit in ui.js):
//
//   import { doodles, doodle } from "./doodles.js";
//
//   // 1) by name (handy for data-driven placement):
//   header.append(doodle("calendar"));
//   // 2) or call the builder directly:
//   emptyState.prepend(doodles.crowd({ size: 96, title: "A small crowd" }));
//   // 3) a full-width divider between sections:
//   section.after(doodles.divider());
//
// Each builder returns a fresh detached <svg> Element (never a shared node), so callers can mount
// the same doodle in several places. Options: `size` (px, sets width/height — divider sizes by
// width only), `title` (adds an <title> + role="img"/aria-label for a11y; omitted → aria-hidden
// decorative), `class` (extra classes appended after `tm-doodle`). Pass `wobble:true` to add the
// `tm-wobble-soft` class so the doodle picks up the theme's hand-drawn jitter filter.

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Build an SVG-namespaced element. Attribute-only (XSS-safe like ui.js `el()`): every value is set
 * via setAttribute, and the only text path is `text` → textContent. No innerHTML, ever.
 * @param {string} tag
 * @param {Object} [attrs]
 * @param {(Node|null)[]|Node} [children]
 */
function s(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null) continue;
    if (key === "text") node.textContent = value; // static strings only
    else node.setAttribute(key, String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child == null) continue;
    node.append(child);
  }
  return node;
}

/** Convenience: a `<path d=…>` with the shared ink line settings. */
const p = (d, extra = {}) => s("path", { d, ...extra });

/**
 * Frame a doodle: a sized, themeable <svg> with the common line-art defaults
 * (stroke=currentColor, fill=none, round caps/joins) plus a11y wiring.
 * @param {string} viewBox
 * @param {(Node|null)[]} body  the doodle's paths/shapes
 * @param {{size?:number, width?:number, height?:number, title?:string, class?:string, wobble?:boolean}} [opts]
 */
function frame(viewBox, body, opts = {}) {
  const { size, width, height, title, class: extra, wobble } = opts;
  const [, , vbW, vbH] = viewBox.split(/\s+/).map(Number);
  const w = width ?? size ?? vbW;
  const h = height ?? (size ? Math.round((size * vbH) / vbW) : vbH);
  const cls = ["tm-doodle", wobble ? "tm-wobble-soft" : null, extra].filter(Boolean).join(" ");

  const attrs = {
    xmlns: SVG_NS,
    viewBox,
    width: w,
    height: h,
    class: cls,
    fill: "none",
    stroke: "currentColor",
    "stroke-width": 2.4,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    focusable: "false",
  };
  if (title) {
    attrs.role = "img";
    attrs["aria-label"] = title;
  } else {
    attrs["aria-hidden"] = "true";
  }
  const kids = title ? [s("title", { text: title }), ...body] : body;
  return s("svg", attrs, kids);
}

// ── The pack ────────────────────────────────────────────────────────────────────────────────────
// Each is `(opts) => SVGElement`. Motifs are social-events only — no owls / mascots / animals.

/** Calendar / date — the event's "when". */
function calendar(opts) {
  return frame("0 0 64 64", [
    p("M8 16 q 0 -4 5 -4 h 38 q 5 0 5 4 v 36 q 0 4 -5 4 h -38 q -5 0 -5 -4 z"),
    p("M8 26 h 48"),
    p("M18 8 v 10 M46 8 v 10"),
    p("M22 36 l4 4 8 -10"), // a hand-drawn tick: "you're going"
    s("circle", { cx: 44, cy: 44, r: 3, fill: "currentColor", stroke: "none" }),
  ], opts);
}

/** RSVP ticket — admit one. */
function ticket(opts) {
  return frame("0 0 72 48", [
    p("M6 12 q 0 -3 4 -3 h 22 v 6 a4 4 0 0 0 0 18 v 6 h -22 q -4 0 -4 -3 z"),
    p("M32 9 h 30 q 4 0 4 3 v 9 a4 4 0 0 0 0 18 v 9 q 0 3 -4 3 h -30"),
    p("M32 13 v 6 M32 27 v 6", { "stroke-dasharray": "2 4" }), // perforation
    p("M42 20 h 16 M42 28 h 12"),
  ], opts);
}

/** Location pin / little map — the event's "where". */
function pin(opts) {
  return frame("0 0 48 64", [
    p("M24 6 q 15 0 15 16 q 0 13 -15 36 q -15 -23 -15 -36 q 0 -16 15 -16 z"),
    s("circle", { cx: 24, cy: 22, r: 6 }),
    p("M10 50 q 14 8 28 0", { "stroke-dasharray": "3 5" }), // ground line
  ], opts);
}

/** A small crowd / group of people — "who's coming". */
function crowd(opts) {
  return frame("0 0 80 56", [
    // three sketchy heads + shoulders
    s("circle", { cx: 22, cy: 18, r: 8 }),
    p("M8 50 q 0 -16 14 -16 q 14 0 14 16"),
    s("circle", { cx: 44, cy: 14, r: 9 }),
    p("M28 50 q 0 -18 16 -18 q 16 0 16 18"),
    s("circle", { cx: 64, cy: 18, r: 8 }),
    p("M50 50 q 0 -16 14 -16 q 14 0 14 16"),
  ], opts);
}

/** Chat / speech bubble — conversation, comments. */
function chat(opts) {
  return frame("0 0 64 56", [
    p("M8 12 q 0 -6 8 -6 h 32 q 8 0 8 6 v 20 q 0 6 -8 6 h -22 l -12 10 l 2 -10 q -8 -2 -8 -6 z"),
    s("circle", { cx: 22, cy: 22, r: 2, fill: "currentColor", stroke: "none" }),
    s("circle", { cx: 32, cy: 22, r: 2, fill: "currentColor", stroke: "none" }),
    s("circle", { cx: 42, cy: 22, r: 2, fill: "currentColor", stroke: "none" }),
  ], opts);
}

/** Waving hand — "hello" / marhaba. */
function hello(opts) {
  return frame("0 0 56 64", [
    // palm + four fingers + thumb, with little motion ticks
    p("M16 58 q -4 -16 0 -28 v -14 q 0 -4 4 -4 q 4 0 4 4 v 12"),
    p("M24 26 v -16 q 0 -4 4 -4 q 4 0 4 4 v 16"),
    p("M32 26 v -14 q 0 -4 4 -4 q 4 0 4 4 v 16"),
    p("M40 28 v -10 q 0 -4 4 -4 q 4 0 4 4 v 18 q 0 18 -16 24 q -12 0 -16 -10"),
    p("M16 30 q -8 -2 -10 -10"), // thumb
    p("M46 6 q 6 -2 8 -6 M50 16 q 6 0 6 -4", { "stroke-dasharray": "3 4" }), // wave lines
  ], opts);
}

/** Celebration / confetti — a popper with bursting bits. */
function celebrate(opts) {
  return frame("0 0 64 64", [
    p("M10 54 l 18 -26 q 8 8 8 18 z"), // cone
    p("M28 28 q 2 -4 6 -4"),
    // confetti bits
    p("M40 12 l3 6 6 3 -6 3 -3 6 -3 -6 -6 -3 6 -3z"),
    p("M52 30 l2 5 5 2 -5 2 -2 5 -2 -5 -5 -2 5 -2z"),
    s("circle", { cx: 36, cy: 40, r: 2.5, fill: "currentColor", stroke: "none" }),
    s("circle", { cx: 54, cy: 50, r: 2.5, fill: "currentColor", stroke: "none" }),
    p("M44 46 l 6 0 M47 43 l 0 6"), // little plus spark
  ], opts);
}

/** Clock / time — the event's "what time". */
function clock(opts) {
  return frame("0 0 56 56", [
    s("circle", { cx: 28, cy: 30, r: 20 }),
    p("M28 30 v -12 M28 30 l 10 6"), // hands
    p("M18 6 l 8 6 M38 6 l -8 6"), // little bells/ears
    p("M28 8 v 3 M28 49 v 3 M6 30 h 3 M47 30 h 3"), // tick marks
  ], opts);
}

/** Host badge — a star/rosette badge for the event host/organiser. */
function host(opts) {
  return frame("0 0 56 64", [
    s("circle", { cx: 28, cy: 24, r: 18 }),
    p("M28 14 l3 7 7 1 -5 5 1 7 -6 -3 -6 3 1 -7 -5 -5 7 -1z"), // star
    p("M16 38 l -4 22 l 16 -10 l 16 10 l -4 -22"), // ribbon tails
  ], opts);
}

/** Hand-drawn divider / squiggle — sits between sections. Includes an optional "hello!" tag. */
function divider(opts = {}) {
  const { tag = false } = opts;
  const body = [
    p("M0 14 C 80 2, 130 26, 220 14 S 380 2, 480 16 S 660 4, 760 14"),
  ];
  if (tag) {
    body.push(
      s("g", { transform: "translate(330 0)" }, [
        p("M0 6 q 0 -6 8 -6 h 44 q 8 0 8 6 q 0 6 -8 6 h -36 l -8 8 l 2 -8 q -10 -1 -10 -6 z", {
          fill: "currentColor",
          "fill-opacity": "0.06",
        }),
        s("text", {
          x: 12,
          y: 9,
          "font-size": 9,
          "font-family": "'Shadows Into Light', cursive",
          stroke: "none",
          fill: "currentColor",
          text: "hello!",
        }),
      ]),
    );
  }
  // divider sizes by width; default to a wide ribbon.
  return frame("0 0 760 28", body, { width: opts.size ?? opts.width ?? 760, ...opts });
}

/** The pack, keyed by name. */
export const doodles = {
  calendar,
  ticket,
  pin,
  crowd,
  chat,
  hello,
  celebrate,
  clock,
  host,
  divider,
};

/** The motif names available (handy for docs / data-driven placement). */
export const doodleNames = Object.keys(doodles);

/**
 * Build a doodle by name. Returns null for an unknown name (so a caller can fall back), never throws.
 * @param {string} name one of `doodleNames`
 * @param {Object} [opts] see the builders (size/title/class/wobble)
 * @returns {SVGElement|null}
 */
export function doodle(name, opts) {
  const make = doodles[name];
  return typeof make === "function" ? make(opts) : null;
}
