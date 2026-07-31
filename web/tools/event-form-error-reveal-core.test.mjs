// Generalised error-force-open tests (TM-1197). Framework-free — Node's built-in test runner,
// picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// THE GAP (pre-TM-1197): on a failed submit the admin event form only force-opened the two
// hardcoded sections whose fields could be collapsed — timezone's "When" and booking-cutoff's
// "Booking rules" (the TM-1195 `["timezone","bookingCutoffHours"]` list). After TM-1195 regrouped
// the form into FIVE collapsible sections, an error on ANY other collapsed-section field (e.g.
// `capacity` in "Who can join", or a custom age-band field nested in an inner <details>) stayed
// hidden behind its fold — the admin saw "Please fix the highlighted fields" with nothing visibly
// wrong, because the highlight was folded away.
//
// THE FIX (this pure core): drive purely off the live DOM. Every errored input carries
// `aria-invalid="true"` (set by admin-events.js `setFieldError`), so `revealFirstError`:
//   (1) opens EVERY <details> ancestor of EVERY invalid field — all 5 sections AND nested reveals,
//       with no per-key→section map that could drift from the layout,
//   (2) scrolls the first errored field's section into view, and
//   (3) focuses the first invalid field (DOM order = on-screen reading order).
// These tests pin that contract against a minimal fake DOM (the real Chromium behaviour is covered
// by the e2e). Would FAIL against the old hardcoded-list approach for any section outside the two.

import assert from "node:assert/strict";
import { test } from "node:test";
import { revealFirstError } from "../src/assets/event-form-error-reveal-core.js";

// --- minimal fake DOM ---------------------------------------------------------------------------

function matchSel(n, sel) {
  if (sel === "details") return n.tagName === "DETAILS";
  if (sel[0] === ".") return n._classes.has(sel.slice(1));
  if (sel === '[aria-invalid="true"]') return n._attrs["aria-invalid"] === "true";
  return false;
}

function walk(n, fn) {
  fn(n);
  for (const c of n.children) walk(c, fn);
}

function node(tag, opts = {}) {
  const n = {
    tagName: tag.toUpperCase(),
    _attrs: { ...(opts.attrs || {}) },
    _classes: new Set(opts.classes || []),
    parentElement: null,
    children: [],
    open: opts.open,
    focused: false,
    scrolled: null,
  };
  n.closest = function (sel) {
    let c = n;
    while (c) {
      if (matchSel(c, sel)) return c;
      c = c.parentElement;
    }
    return null;
  };
  n.querySelectorAll = function (sel) {
    const out = [];
    walk(n, (d) => {
      if (d !== n && matchSel(d, sel)) out.push(d);
    });
    return out;
  };
  if (!opts.noScroll) n.scrollIntoView = (arg) => { n.scrolled = arg || true; };
  if (!opts.noFocus) n.focus = () => { n.focused = true; };
  return n;
}

function append(parent, ...kids) {
  for (const k of kids) {
    k.parentElement = parent;
    parent.children.push(k);
  }
  return parent;
}

function section(name, { open }) {
  return node("details", { classes: ["tm-form-section"], open, attrs: { "data-section": name } });
}

function invalidInput(id) {
  return node("input", { attrs: { id, "aria-invalid": "true" } });
}

// --- (1) generalisation: a collapsed section OUTSIDE the old hardcoded two -----------------------

test("opens a collapsed section whose field errors (the case the old list missed)", () => {
  const form = node("form");
  const basics = section("basics", { open: true });
  append(basics, invalidInput("heading-not-invalid")); // no aria-invalid → not errored
  basics.children[0]._attrs["aria-invalid"] = "false";
  const who = section("who", { open: false });
  const capacity = invalidInput("event-capacity");
  append(who, capacity);
  append(form, basics, who);

  const returned = revealFirstError(form);

  assert.equal(who.open, true, "the collapsed 'Who can join' section must force-open");
  assert.equal(capacity.focused, true, "the first invalid field is focused");
  assert.equal(who.scrolled !== null, true, "the errored field's section is scrolled into view");
  assert.equal(returned, capacity, "returns the first invalid field");
});

// --- (2) nested <details>: open the whole ancestor chain -----------------------------------------

test("opens EVERY <details> ancestor — nested reveal AND its outer section", () => {
  const form = node("form");
  const who = section("who", { open: false });
  const ageReveal = node("details", { open: false }); // e.g. the custom age-band reveal
  const ageMin = invalidInput("event-age-min");
  append(ageReveal, ageMin);
  append(who, ageReveal);
  append(form, who);

  revealFirstError(form);

  assert.equal(ageReveal.open, true, "the nested reveal opens");
  assert.equal(who.open, true, "and its outer section opens too (ancestor-walk, no per-key map)");
});

// --- (3) FIRST invalid field (DOM order) across multiple errored sections ------------------------

test("focuses the FIRST invalid field in DOM order when several sections error", () => {
  const form = node("form");
  const who = section("who", { open: false });
  const capacity = invalidInput("event-capacity");
  append(who, capacity);
  const booking = section("booking", { open: false });
  const cutoff = invalidInput("event-booking-cutoff");
  append(booking, cutoff);
  append(form, who, booking);

  const returned = revealFirstError(form);

  assert.equal(who.open, true);
  assert.equal(booking.open, true, "every errored section opens, not just the first");
  assert.equal(capacity.focused, true, "the earlier (DOM-order) field is focused");
  assert.equal(cutoff.focused, false, "the later field is not the focus target");
  assert.equal(returned, capacity);
});

// --- (4) no errors → pure no-op ------------------------------------------------------------------

test("no invalid fields → returns null and opens nothing", () => {
  const form = node("form");
  const who = section("who", { open: false });
  append(who, node("input", { attrs: { id: "x" } }));
  append(form, who);

  assert.equal(revealFirstError(form), null);
  assert.equal(who.open, false, "a valid form leaves collapsed sections collapsed");
});

// --- (5) scrollIntoView / focus feature-detected (jsdom / fake DOM may lack them) ----------------

test("does not throw when target lacks scrollIntoView / field lacks focus", () => {
  const form = node("form");
  const who = section("who", { open: false, noScroll: true });
  const capacity = node("input", { attrs: { id: "event-capacity", "aria-invalid": "true" }, noFocus: true });
  append(who, capacity);
  append(form, who);

  assert.doesNotThrow(() => revealFirstError(form));
  assert.equal(who.open, true, "the fold still opens even without scroll/focus support");
});

// --- (6) guards: bad input -----------------------------------------------------------------------

test("null / non-container formEl → returns null, no throw", () => {
  assert.equal(revealFirstError(null), null);
  assert.equal(revealFirstError(undefined), null);
  assert.equal(revealFirstError({}), null, "an object without querySelectorAll is ignored");
});
