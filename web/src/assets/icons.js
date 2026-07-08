// Inline line icons — appearance-agnostic (TM-515).
//
// The doodle pack (doodles.js) is decorative and hidden in clean Paper — styles.css shows it only
// when the sketchy toggle is on (`:root:not([data-sketchy="on"]) .tm-doodle { display: none }`). So
// screens that must show a glyph in BOTH toggle states can't use doodles for functional icons. These
// reproduce the approved wireframes' OWN inline SVG glyphs — the paper-notifications per-type icons,
// the chat composer send arrow, and the chat-empty speech bubble — as small `currentColor` line-art
// that inks with the Paper foreground token whichever way the toggle is set.
//
// Import-safe in Node: `ICONS` / `ICON_NAMES` are plain data and the only DOM call (createElementNS)
// lives inside lineIcon(), so a Node test can import the names to assert coverage without a DOM.

const NS = "http://www.w3.org/2000/svg";

// Each icon is its child shapes on a 24×24 viewBox, taken verbatim from the wireframe markup so the
// app glyphs match the approved design 1:1.
export const ICONS = Object.freeze({
  // paper-notifications per-type glyphs (bell / people / clock / speech-bubble / home):
  spot: [{ t: "path", d: "M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6z" }, { t: "path", d: "M10 19a2 2 0 0 0 4 0" }],
  people: [{ t: "circle", cx: 12, cy: 9, r: 3.2 }, { t: "path", d: "M6 19c0-3.3 2.7-5 6-5s6 1.7 6 5" }],
  clock: [{ t: "circle", cx: 12, cy: 12, r: 8.5 }, { t: "path", d: "M12 7.5V12l3 2" }],
  chat: [{ t: "path", d: "M5 5h14v10H9l-4 4z" }],
  welcome: [{ t: "path", d: "M4 11l8-6 8 6" }, { t: "path", d: "M6 10v9h12v-9" }],
  // chat composer send arrow (paper-chat-thread / paper-chat-empty):
  send: [{ t: "path", d: "M4 12l16-7-7 16-2-7-7-2z" }],
});

/** The available icon names — handy for tests asserting a data module only references real icons. */
export const ICON_NAMES = Object.freeze(Object.keys(ICONS));

/**
 * Build a themeable inline line icon by name — `currentColor` stroke, no fill, so it inks with the
 * caller's text colour on every theme. Returns null for an unknown name (caller can fall back), never
 * throws. XSS-safe: only setAttribute + static path data, no innerHTML.
 * @param {string} name one of ICON_NAMES
 * @param {{size?: number, strokeWidth?: number, title?: string}} [opts]
 * @returns {SVGElement|null}
 */
export function lineIcon(name, { size = 20, strokeWidth = 1.8, title } = {}) {
  const shapes = ICONS[name];
  if (!shapes) return null;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", String(strokeWidth));
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  if (title) {
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", title);
  } else {
    svg.setAttribute("aria-hidden", "true");
  }
  for (const shape of shapes) {
    const node = document.createElementNS(NS, shape.t);
    if (shape.t === "path") {
      node.setAttribute("d", shape.d);
    } else {
      node.setAttribute("cx", String(shape.cx));
      node.setAttribute("cy", String(shape.cy));
      node.setAttribute("r", String(shape.r));
    }
    svg.append(node);
  }
  return svg;
}
