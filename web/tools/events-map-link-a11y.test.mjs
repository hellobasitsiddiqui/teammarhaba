// Event "Open in Maps" directions-link Label-in-Name guard (TM-568). Framework-free — Node's built-in
// test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// The directions anchor in events.js `mapSection()` renders a visible label of `${model.label} —
// Directions` → "Open in Maps — Directions". It previously ALSO set
//   aria-label="Open the event location in your maps app for directions"
// which OVERRIDES the accessible name with words that don't contain the visible "Open in Maps" text —
// failing WCAG 2.5.3 Label in Name (Level A): a speech-input user who says the words they can see
// ("Open in Maps") can't activate the control. The fix drops the aria-label so the descriptive visible
// text becomes the accessible name (the pin icon is aria-hidden, so it doesn't pollute the name).
//
// Like notification-panel-dialog-a11y.test.mjs / deploy-theme-retired.test.mjs, the full events.js
// module can't be imported in Node (a transitive `https:` Firebase import in the api/auth chain isn't
// resolvable by the default ESM loader), so this is a source-level guard: it isolates the map-link
// anchor's `el()` props and asserts the accessible name always contains the visible label — so a later
// edit can't silently re-introduce a Label-in-Name violation.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DIRECTIONS_LABEL } from "../src/assets/events-core.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "../src/assets/events.js"), "utf8");

// The visible text the shell paints: `${model.label} — Directions`, where model.label is DIRECTIONS_LABEL.
const VISIBLE_LABEL = `${DIRECTIONS_LABEL} — Directions`; // "Open in Maps — Directions"

/**
 * The props object literal of the directions anchor — the `el("a", { ... }, [icon("pin"), <label span>])`
 * call in mapSection(). Matched by its `event-map-link` testid + the pin-icon/label-span children so we
 * pin the exact element under test.
 */
function mapLinkProps() {
  // Anchor on the map link's unique class so the non-greedy body can't run back to an earlier <a>
  // (e.g. the hero back button, which has its own aria-label).
  const m = SRC.match(
    /el\(\s*"a",\s*\{\s*class:\s*"tm-event-map tm-event-map-link",([\s\S]*?)\},\s*\[icon\("pin"\),\s*el\("span",\s*\{\s*class:\s*"tm-event-map-label"/,
  );
  assert.ok(m, "could not locate the event-map-link `el(\"a\", { ... })` builder in mapSection()");
  const props = m[1];
  assert.match(props, /"data-testid":\s*"event-map-link"/, "matched the wrong anchor — expected the map link");
  return props;
}

test("the directions anchor still renders its visible 'Open in Maps — Directions' label", () => {
  // The label span text is `${model.label} — Directions`; model.label is DIRECTIONS_LABEL from the core.
  assert.match(
    SRC,
    /class:\s*"tm-event-map-label",\s*text:\s*`\$\{model\.label\} — Directions`/,
    "the map link must keep its visible `${model.label} — Directions` label",
  );
  assert.equal(VISIBLE_LABEL, "Open in Maps — Directions");
});

test("accessible name CONTAINS the visible label — WCAG 2.5.3 Label in Name (TM-568)", () => {
  const props = mapLinkProps();
  const aria = props.match(/"aria-label":\s*"([^"]*)"/);
  // With no aria-label the accessible name is computed from the anchor's text (the pin icon is
  // aria-hidden), i.e. exactly the visible label. If an aria-label IS present it must still contain the
  // visible "Open in Maps" words, or speech input by visible name breaks.
  const accessibleName = aria ? aria[1] : VISIBLE_LABEL;
  assert.ok(
    accessibleName.includes(DIRECTIONS_LABEL),
    `the accessible name (${JSON.stringify(accessibleName)}) must contain the visible "${DIRECTIONS_LABEL}" text (WCAG 2.5.3)`,
  );
});

test("no aria-label overrides the visible text away from 'Open in Maps' (regression guard)", () => {
  const props = mapLinkProps();
  const aria = props.match(/"aria-label":\s*"([^"]*)"/);
  // Guard the specific regression: the old descriptive aria-label that omitted the visible words.
  if (aria) {
    assert.ok(
      aria[1].includes(DIRECTIONS_LABEL),
      "an aria-label on the map link must include the visible 'Open in Maps' text (WCAG 2.5.3)",
    );
  } else {
    assert.ok(true, "no aria-label — accessible name comes from the descriptive visible text");
  }
});

test("the pre-reveal paper-map placeholder is decorative (aria-hidden SVG, no Label-in-Name), TM-827-A", () => {
  // The illustration is a `svgEl("svg", { class: "tm-event-map-doodle", ... "aria-hidden": "true" })`;
  // the accessible content is the caption <p> text, not the artwork. Assert the doodle carries
  // aria-hidden so a screen reader announces only the caption, and that the placeholder builder does not
  // slap an aria-label on the map container (which could re-introduce a Label-in-Name mismatch).
  const doodle = SRC.match(/svgEl\(\s*"svg",\s*\{\s*class:\s*"tm-event-map-doodle",([\s\S]*?)\},/);
  assert.ok(doodle, "could not locate the paper-map doodle svgEl() builder");
  assert.match(doodle[1], /"aria-hidden":\s*"true"/, "the decorative paper-map SVG must be aria-hidden");
  // The placeholder container renders the doodle + a caption <p>; it must not carry its own aria-label.
  const placeholder = SRC.match(/class:\s*"tm-event-map tm-event-map-placeholder",([\s\S]*?)\},/);
  assert.ok(placeholder, "could not locate the map placeholder container");
  assert.ok(!/aria-label/.test(placeholder[1]), "the placeholder container must not add an aria-label");
});

test("the 'See similar events' CTA is a real link whose accessible name is its visible text (TM-827-C / TM-568)", () => {
  // The CTA is `el("a", { class: "...tm-event-similar-cta", href, "data-testid": "event-similar-cta" }, label)`
  // — a real <a> (navigates, so a disabled primary can't fire it) with NO aria-label, so the visible
  // "See similar events" text IS the accessible name (no WCAG 2.5.3 Label-in-Name mismatch).
  const m = SRC.match(/el\(\s*"a",\s*\{\s*class:\s*"tm-btn tm-btn-sm tm-event-similar-cta",([\s\S]*?)\},/);
  assert.ok(m, "could not locate the similar-events CTA anchor builder");
  assert.match(m[1], /"data-testid":\s*"event-similar-cta"/, "matched the wrong anchor");
  assert.ok(!/aria-label/.test(m[1]), "the similar-events CTA must not add an aria-label (visible text is the name)");
});
