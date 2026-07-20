// Static annotated-screenshot help guide (TM-178) — the illustrated, NON-interactive counterpart to
// the live product tour (tour.js / tours.js, TM-135). It renders a representative MOCK of a screen
// (CSS/DOM-drawn, not a captured photo) with arrows + callout notes pointing at the important
// controls, so a user can understand a screen at a glance without launching the live walkthrough.
//
// ── Why a data-driven DOM mock, not a real screenshot ─────────────────────────────────────────────
// Real screenshots ROT: the moment the UI shifts, a captured PNG is stale, and hand-pixel-pushed
// callout coordinates over it drift out of place. So instead each screen is described as DATA (a small
// list of mock "regions" + callouts positioned in PERCENTAGES over a fixed-aspect stage). The mock is
// built from the same theme tokens as the real app, so it auto-follows clean / doodle / sketch and
// dark mode for free — no asset to re-capture when the look changes. Callout COPY is reused from the
// shared tour highlight points (tour-highlights.js / TM-178) so the guide and the live tour stay in
// lockstep: edit a control's explanation once and both surfaces update.
//
// ── How to add a new annotated screen ─────────────────────────────────────────────────────────────
//   1. (Copy source) If the screen's callouts mirror a live tour, make sure its highlight points exist
//      in tour-highlights.js (SITE_HIGHLIGHTS or PAGE_HIGHLIGHTS["#/route"]). Reuse those so the two
//      surfaces can't drift; otherwise write the callout text inline in the SCREENS entry below.
//   2. (Mock) Add an entry to SCREENS: a `title`, an `alt` (a sentence describing the whole mock for
//      screen-reader users), a `regions` array (the boxes drawn on the mock, each with a label +
//      percentage box), and a `callouts` array (each a note positioned over the mock, optionally
//      sourced from a highlight point via `fromHighlight`).
//   3. That's it — buildGuide() renders every screen in SCREENS in order. No engine change.
//
// XSS-safe like the rest of the UX kit (TM-133): everything is built with ui.js `el()` (textContent
// only — no innerHTML seam), so the copy can never inject markup.

import { clear, el } from "./ui.js";
import { SITE_HIGHLIGHTS, PAGE_HIGHLIGHTS } from "./tour-highlights.js";

/**
 * Look up a highlight point's copy by the live selector it targets, across the site + page highlight
 * sets. Returns `{ title, body }` or null if no highlight targets that selector. This is the seam that
 * keeps a guide callout's text identical to the live tour's: the guide references the SELECTOR (a
 * stable key), and the words come from the shared source.
 * @param {string} selector
 * @returns {{title: string, body: string}|null}
 */
export function highlightFor(selector) {
  const pools = [SITE_HIGHLIGHTS, ...Object.values(PAGE_HIGHLIGHTS)];
  for (const pool of pools) {
    const hit = pool.find((h) => h.target === selector);
    if (hit) return { title: hit.title, body: hit.body };
  }
  return null;
}

/**
 * The annotated screens, rendered in order. Coordinates are PERCENTAGES (0–100) of the mock stage, so
 * the mock + its callouts scale together responsively and never depend on a fixed pixel size.
 *
 *   region:  { label, box:{x,y,w,h}, kind? }   — a labelled box drawn on the mock (kind tweaks styling)
 *   callout: { at:{x,y}, side, fromHighlight?, title?, body? }
 *               at         — the point on the mock the arrow points AT
 *               side       — which side of `at` the note sits on: "left" | "right" | "top" | "bottom"
 *               fromHighlight — a live selector to pull title/body from (shared with the tour); when
 *                               set, `title`/`body` are optional overrides
 *
 * The PRIMARY/landing screen ("Home") is first and is the one AC1 requires to render with arrows +
 * callouts. Its callouts are sourced from the SITE tour highlight points so they match the walkthrough.
 * @type {ReadonlyArray<object>}
 */
export const SCREENS = [
  {
    id: "home",
    title: "Home — your signed-in screen",
    alt:
      "A mock of the Circle home screen: a top navigation bar with Help, Profile, an Admin link " +
      "and an avatar, above a card showing your signed-in identity. Sign out lives on the Profile screen.",
    regions: [
      { label: "Circle", box: { x: 4, y: 6, w: 40, h: 12 }, kind: "brand" },
      { label: "Help", box: { x: 50, y: 7, w: 9, h: 10 }, kind: "nav" },
      // TM-906: the top-nav Sign out button is gone (sign-out moved to the Profile hub, behind a
      // confirm), so the Profile region now anchors the tour's re-homed closing step (#nav-profile).
      { label: "Profile", box: { x: 60, y: 7, w: 11, h: 10 }, kind: "nav", anchor: "#nav-profile" },
      { label: "Admin", box: { x: 72, y: 7, w: 10, h: 10 }, kind: "nav", anchor: "#nav-admin" },
      { label: "Signed in as you@example.com", box: { x: 6, y: 34, w: 88, h: 30 }, kind: "card", anchor: "#me" },
    ],
    callouts: [
      { at: { x: 50, y: 49 }, side: "bottom", fromHighlight: "#me" },
      { at: { x: 77, y: 12 }, side: "bottom", fromHighlight: "#nav-admin" },
      { at: { x: 66, y: 12 }, side: "bottom", fromHighlight: "#nav-profile" },
    ],
  },
];

/** A small arrow glyph (inline SVG) pointing from a callout toward its target. Decorative. */
function arrow(side) {
  const svg = el("span", { class: `tm-guide-arrow tm-guide-arrow-${side}`, "aria-hidden": "true" });
  return svg;
}

/**
 * Build one callout node from a screen callout spec. Resolves its copy from the shared highlight point
 * (when `fromHighlight` is set) and falls back to inline title/body. Positions itself over the stage
 * via percentage CSS custom properties; CSS (.tm-guide-callout) reads them.
 */
function calloutNode(spec, index) {
  const fromHl = spec.fromHighlight ? highlightFor(spec.fromHighlight) : null;
  const title = spec.title ?? fromHl?.title ?? "";
  const body = spec.body ?? fromHl?.body ?? "";
  const side = spec.side || "bottom";
  return el(
    "figcaption",
    {
      class: `tm-guide-callout tm-guide-callout-${side}`,
      // Number the callouts so the alt/region list and the visible notes line up for everyone.
      dataset: { n: String(index + 1) },
      style: `--at-x:${spec.at.x}%; --at-y:${spec.at.y}%;`,
    },
    [
      arrow(side),
      el("span", { class: "tm-guide-callout-num", "aria-hidden": "true", text: String(index + 1) }),
      el("span", { class: "tm-guide-callout-body" }, [
        title ? el("strong", { class: "tm-guide-callout-title", text: title }) : null,
        body ? el("span", { text: body }) : null,
      ]),
    ],
  );
}

/** Build one mock region (a labelled box) for the stage. */
function regionNode(region) {
  const { x, y, w, h } = region.box;
  return el("span", {
    class: `tm-guide-region tm-guide-region-${region.kind || "box"}`,
    style: `--x:${x}%; --y:${y}%; --w:${w}%; --h:${h}%;`,
    text: region.label,
  });
}

/** Build one annotated screen (a <figure> with the mock stage + its callouts). */
function screenNode(screen) {
  const stage = el(
    "div",
    { class: "tm-guide-stage", role: "img", "aria-label": screen.alt },
    [
      // The drawn mock (regions). aria-hidden because the <figure>'s role=img + aria-label already
      // describe the whole picture to assistive tech; the labels are visual scaffolding.
      el("div", { class: "tm-guide-mock", "aria-hidden": "true" }, screen.regions.map(regionNode)),
      // The positioned callouts overlaid on the stage.
      ...screen.callouts.map(calloutNode),
    ],
  );

  // A plain, linear list of the same callouts beneath the picture — the accessible, reflow-friendly
  // version of the annotations (the absolutely-positioned notes can overlap on a tiny screen; this
  // list always reads cleanly and is what a screen-reader user follows after the alt text).
  const list = el(
    "ol",
    { class: "tm-guide-notes" },
    screen.callouts.map((spec) => {
      const fromHl = spec.fromHighlight ? highlightFor(spec.fromHighlight) : null;
      const title = spec.title ?? fromHl?.title ?? "";
      const body = spec.body ?? fromHl?.body ?? "";
      return el("li", {}, [
        title ? el("strong", { text: `${title}. ` }) : null,
        body ? document.createTextNode(body) : null,
      ]);
    }),
  );

  return el("figure", { class: "tm-guide-figure" }, [
    el("figcaption", { class: "tm-guide-figure-title", text: screen.title }),
    stage,
    list,
  ]);
}

/**
 * Build the annotated-guide content into `container` (idempotent: clears first). Renders every screen
 * in SCREENS. Pure DOM construction — no live-overlay dependency, so it works as a plain page.
 * @param {HTMLElement} container
 * @returns {HTMLElement} the container
 */
export function buildGuide(container) {
  clear(container).append(
    el("div", { class: "tm-guide" }, [
      el("h3", { class: "tm-guide-heading", text: "Visual guide" }),
      el("p", {
        class: "tm-guide-intro",
        text:
          "A labelled picture of each screen — the same things the interactive tour points at, but " +
          "static, so you can read it at a glance. Nothing here is live: it's just an illustration.",
      }),
      ...SCREENS.map(screenNode),
    ]),
  );
  return container;
}
