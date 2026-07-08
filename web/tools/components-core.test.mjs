// Unit tests for the shared UI component library's pure core (TM-511) — the descriptor logic every
// component resolves to (variants, states, ARIA text, formatting). Framework-free — Node's built-in
// test runner, picked up by the CI glob `node --test web/tools/*.test.mjs` (ci.yml web-build gate).
// No DOM/Firebase, so it runs in plain Node exactly like tabbar-core.test.mjs / account-badges.test.mjs.
//
// The DOM factories (components.js) are a thin map over these descriptors, so locking the descriptors
// locks the components' behaviour — including the ticket's headline requirement: the triple-tick
// whole-group-read read-receipt state.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COMPONENTS,
  BUTTON_VARIANTS,
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
  READ_STATES,
  readReceiptSpec,
  OVERLAY_KINDS,
  overlaySpec,
} from "../src/assets/components-core.js";

test("the component catalogue lists every wireframe component, each with a title + design-kit tile", () => {
  // These are the "Design elements · paper" tiles the ticket enumerates + the overlays.
  const ids = COMPONENTS.map((c) => c.id);
  assert.deepEqual(ids, [
    "buttons",
    "tags-pills",
    "chips",
    "input",
    "segmented",
    "toggle",
    "progress",
    "avatar-reaction",
    "badges-dots",
    "read-ticks",
    "sheet-modal",
  ]);
  // No duplicate ids, and every entry is fully described (gallery + tests rely on this).
  assert.equal(new Set(ids).size, ids.length);
  for (const c of COMPONENTS) {
    assert.ok(c.title && typeof c.title === "string", `${c.id} needs a title`);
    assert.ok(c.tile && typeof c.tile === "string", `${c.id} needs a design-kit tile reference`);
  }
});

test("buttonSpec covers primary / ghost / danger / soon; soon is disabled; unknown falls back", () => {
  assert.deepEqual(BUTTON_VARIANTS, ["primary", "ghost", "danger", "soon"]);

  const primary = buttonSpec("primary");
  assert.deepEqual(primary.classes, ["tm-c-btn", "tm-wobble-soft"]);
  assert.equal(primary.disabled, false);

  assert.ok(buttonSpec("ghost").classes.includes("tm-c-btn--ghost"));
  assert.ok(buttonSpec("danger").classes.includes("tm-c-btn--danger"));

  const soon = buttonSpec("soon");
  assert.ok(soon.classes.includes("tm-c-btn--soon"));
  assert.equal(soon.disabled, true, "the 'soon' placeholder is inherently non-interactive");

  // Unknown / missing variant defaults to primary (never blank / never crashes a screen).
  assert.equal(buttonSpec("nope").variant, "primary");
  assert.equal(buttonSpec().variant, "primary");
});

test("tag / pill specs: the 'full' pill drops the accent for the muted at-capacity look", () => {
  assert.ok(tagSpec().classes.includes("tm-c-tag"));
  assert.equal(pillSpec().full, false);
  assert.ok(!pillSpec().classes.includes("tm-c-pill--full"));
  const full = pillSpec({ full: true });
  assert.equal(full.full, true);
  assert.ok(full.classes.includes("tm-c-pill--full"));
});

test("chipSpec toggles the selected class + aria-pressed", () => {
  const off = chipSpec();
  assert.equal(off.selected, false);
  assert.equal(off.ariaPressed, "false");
  assert.ok(!off.classes.includes("tm-c-chip--selected"));

  const on = chipSpec({ selected: true });
  assert.equal(on.ariaPressed, "true");
  assert.ok(on.classes.includes("tm-c-chip--selected"));
});

test("inputSpec flags invalid state via class + aria-invalid", () => {
  assert.equal(inputSpec().ariaInvalid, null);
  const bad = inputSpec({ invalid: true });
  assert.equal(bad.ariaInvalid, "true");
  assert.ok(bad.classes.includes("tm-c-input--invalid"));
});

test("segmentedSpec marks the active option and clamps the index into range", () => {
  const s = segmentedSpec(["Going", "Waitlist"], 1);
  assert.equal(s.activeIndex, 1);
  assert.deepEqual(
    s.options.map((o) => [o.label, o.on]),
    [["Going", false], ["Waitlist", true]],
  );
  // Out-of-range indexes clamp rather than lighting a non-existent segment.
  assert.equal(segmentedSpec(["A", "B"], 9).activeIndex, 1);
  assert.equal(segmentedSpec(["A", "B"], -3).activeIndex, 0);
  // Empty options → no active segment.
  assert.equal(segmentedSpec([]).activeIndex, -1);
});

test("toggleSpec reflects on/off in the class + aria-checked", () => {
  assert.equal(toggleSpec(false).ariaChecked, "false");
  assert.ok(!toggleSpec(false).classes.includes("tm-c-toggle--on"));
  const on = toggleSpec(true);
  assert.equal(on.ariaChecked, "true");
  assert.ok(on.classes.includes("tm-c-toggle--on"));
});

test("progressSpec clamps the fraction to 0..100% and tolerates bad input", () => {
  assert.equal(progressSpec(0.62).pct, 62);
  assert.equal(progressSpec(0).pct, 0);
  assert.equal(progressSpec(1).pct, 100);
  assert.equal(progressSpec(-2).pct, 0, "below 0 clamps to 0");
  assert.equal(progressSpec(5).pct, 100, "above 1 clamps to 100");
  assert.equal(progressSpec(Number.NaN).pct, 0, "NaN is treated as 0");
  assert.equal(progressSpec(0.62).ariaValueNow, 62);
});

test("badgeSpec formats the count and collapses large numbers to 'max+'", () => {
  assert.equal(badgeSpec(2).text, "2");
  assert.equal(badgeSpec(99).text, "99");
  assert.equal(badgeSpec(120).text, "99+");
  assert.equal(badgeSpec(-4).text, "0", "negative counts floor at 0");
  assert.equal(badgeSpec(1000, { max: 999 }).text, "999+");
});

test("unreadDotSpec: unread is accent-filled, read is hollow, each with an accessible label", () => {
  const unread = unreadDotSpec(false);
  assert.equal(unread.ariaLabel, "Unread");
  assert.ok(!unread.classes.includes("tm-c-dot--read"));

  const read = unreadDotSpec(true);
  assert.equal(read.ariaLabel, "Read");
  assert.ok(read.classes.includes("tm-c-dot--read"));
});

test("avatarSpec shows a name's initial (uppercased) or passes an emoji through", () => {
  assert.equal(avatarSpec("Basit").glyph, "B");
  assert.equal(avatarSpec("sarah").glyph, "S");
  assert.equal(avatarSpec("🐕").glyph, "🐕", "an emoji glyph passes through unchanged");
  assert.equal(avatarSpec("").glyph, "?", "an empty label shows a neutral placeholder");
});

test("reactionSpec carries emoji + count with an accessible label", () => {
  const r = reactionSpec({ emoji: "👍", count: 3 });
  assert.equal(r.emoji, "👍");
  assert.equal(r.count, 3);
  assert.match(r.ariaLabel, /👍 reacted 3 times/);
  assert.match(reactionSpec({ emoji: "❤️", count: 1 }).ariaLabel, /1 time$/);
});

test("read-receipt ticks: sent → ✓, read → ✓✓, and the whole-group-read state → ✓✓✓ (TM-511)", () => {
  // The delivery ladder is defined by TICK COUNT, so it reads in the grayscale sketch theme too.
  assert.equal(READ_STATES.sent.ticks, 1);
  assert.equal(READ_STATES.read.ticks, 2);
  assert.equal(READ_STATES.group.ticks, 3);

  const sent = readReceiptSpec("sent");
  assert.equal(sent.glyph, "✓");
  assert.equal(sent.ticks, 1);

  const read = readReceiptSpec("read");
  assert.equal(read.glyph, "✓✓");
  assert.equal(read.ticks, 2);

  // The headline requirement: the triple-tick whole-group-read state.
  const group = readReceiptSpec("group");
  assert.equal(group.glyph, "✓✓✓");
  assert.equal(group.ticks, 3);
  assert.equal(group.label, "Read by everyone");
  assert.ok(group.classes.includes("tm-c-ticks--group"));
  assert.equal(group.ariaLabel, "Read by everyone", "screen readers hear the meaning, not three checks");
});

test("read-receipt aliases + unknown states resolve sensibly", () => {
  assert.equal(readReceiptSpec("delivered").state, "sent");
  assert.equal(readReceiptSpec("group-read").state, "group");
  assert.equal(readReceiptSpec("everyone").ticks, 3);
  assert.equal(readReceiptSpec("???").state, "sent", "an unknown state degrades to 'sent', never crashes");
});

test("overlaySpec picks the right surface + backdrop for a modal vs a bottom sheet", () => {
  assert.deepEqual(OVERLAY_KINDS, ["modal", "sheet"]);

  const modal = overlaySpec("modal");
  assert.equal(modal.surfaceClass, "tm-c-modal");
  assert.equal(modal.backdropClass, "tm-backdrop");

  const sheet = overlaySpec("sheet");
  assert.equal(sheet.surfaceClass, "tm-c-sheet");
  assert.ok(sheet.backdropClass.includes("tm-c-sheet-backdrop"));

  assert.equal(overlaySpec("nope").kind, "modal", "an unknown kind defaults to a modal");
});
