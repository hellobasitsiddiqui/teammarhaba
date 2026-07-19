// Tests for the static annotated help guide's pure data + lookup logic (TM-178). Framework-free —
// Node's built-in test runner, same harness as the other tools/*.test.mjs and picked up by the CI glob
// `node --test web/tools/*.test.mjs`.
//
// We exercise the data island (tour-highlights.js) and the guide's pure resolver (help-guide.js's
// `highlightFor` + its `SCREENS` data) WITHOUT touching the DOM: the render functions that call ui.js
// `el()` aren't invoked here, and importing the modules is side-effect-free (no top-level DOM access),
// so this runs cleanly under plain Node. The contract under test is the one AC3/AC1 lean on: the guide
// callouts are data-driven and their copy is SHARED with the live tour (so the two can't drift).

import assert from "node:assert/strict";
import { test } from "node:test";

import { SITE_HIGHLIGHTS, PAGE_HIGHLIGHTS } from "../src/assets/tour-highlights.js";
import { highlightFor, SCREENS } from "../src/assets/help-guide.js";

test("highlightFor resolves a site-tour highlight by its target selector", () => {
  const hit = highlightFor("#me");
  assert.ok(hit, "expected a highlight for #me");
  // Same copy the live tour uses (shared source) — proves the two surfaces draw from one place.
  const source = SITE_HIGHLIGHTS.find((h) => h.target === "#me");
  assert.equal(hit.title, source.title);
  assert.equal(hit.body, source.body);
});

test("highlightFor also resolves a per-page highlight (e.g. an admin one)", () => {
  const hit = highlightFor(".tm-stats");
  assert.ok(hit);
  assert.equal(hit.title, PAGE_HIGHLIGHTS["#/admin/users"].find((h) => h.target === ".tm-stats").title); // TM-917: users console moved to #/admin/users
});

test("highlightFor returns null for a selector no highlight targets", () => {
  assert.equal(highlightFor("#definitely-not-a-target"), null);
});

test("at least the primary/landing screen is defined (AC1)", () => {
  assert.ok(SCREENS.length >= 1, "expected at least one annotated screen");
  const home = SCREENS[0];
  assert.equal(home.id, "home", "the primary screen should be the home screen");
});

test("the primary screen renders arrows + callouts: it has at least one callout (AC1)", () => {
  const home = SCREENS[0];
  assert.ok(Array.isArray(home.callouts) && home.callouts.length >= 1);
  // Every callout names a side (which drives the arrow direction) so an arrow can be drawn.
  for (const c of home.callouts) {
    assert.ok(["left", "right", "top", "bottom"].includes(c.side), `callout side must be valid, got ${c.side}`);
    assert.ok(c.at && typeof c.at.x === "number" && typeof c.at.y === "number", "callout needs an anchor point");
  }
});

test("every screen has accessible alt text describing the whole mock (AC4)", () => {
  for (const screen of SCREENS) {
    assert.equal(typeof screen.alt, "string");
    assert.ok(screen.alt.length > 20, `screen ${screen.id} should have a descriptive alt`);
  }
});

test("each fromHighlight callout resolves to real shared copy (no dangling references)", () => {
  for (const screen of SCREENS) {
    for (const c of screen.callouts) {
      if (c.fromHighlight) {
        const resolved = highlightFor(c.fromHighlight);
        assert.ok(resolved, `callout fromHighlight ${c.fromHighlight} on ${screen.id} must resolve to a highlight`);
        // And the resolved copy is non-empty, so the callout actually has words to show.
        assert.ok(resolved.title || resolved.body);
      } else {
        // An inline callout must carry its own copy.
        assert.ok(c.title || c.body, `inline callout on ${screen.id} needs a title or body`);
      }
    }
  }
});

test("every callout's percentage anchor sits inside the stage (0–100)", () => {
  for (const screen of SCREENS) {
    for (const c of screen.callouts) {
      assert.ok(c.at.x >= 0 && c.at.x <= 100, "x in range");
      assert.ok(c.at.y >= 0 && c.at.y <= 100, "y in range");
    }
  }
});
