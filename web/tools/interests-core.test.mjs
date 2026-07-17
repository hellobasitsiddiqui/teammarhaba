// Tests for the Profile Interests card pure logic (TM-778). Framework-free — Node's built-in test
// runner, the same harness as profile-core.test.mjs / account-badges.test.mjs, picked up by the CI
// glob `node --test web/tools/*.test.mjs`.
//
// These guard the PURE core the refreshed Profile Interests card (profile.js) reads: normalising the
// min/max config, mapping saved MeResponse.interests to removable chips, grouping the catalogue for the
// ADD picker, toggling a pending selection within the max, and validating a selection before save. The
// DOM renderer (profile.js) is a thin map over these, so testing them here covers the add/remove
// behaviour (within min/max) without needing a browser.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_INTEREST_MIN,
  DEFAULT_INTEREST_MAX,
  normaliseInterestConfig,
  savedInterestLabels,
  interestChipsModel,
  interestsHint,
  catalogueGroups,
  toggleInterest,
  selectionError,
  interestEmoji,
  emojiByLabel,
} from "../src/assets/interests-core.js";

// A realistic MeResponse.interests payload (real InterestResponse shape from openapi.json:
// {label, category, sourceInterestId}). The card VIEWs these directly.
const SAVED = [
  { label: "Walking", category: "Sport & Fitness", sourceInterestId: 3 },
  { label: "Coffee & cafés", category: "Food & Drink", sourceInterestId: 41 },
];

// A slice of the real active catalogue (GET /api/v1/interests), grouped by category in catalogue order.
const CATALOGUE = [
  { label: "Walking", category: "Sport & Fitness", active: true },
  { label: "Cycling", category: "Sport & Fitness", active: true },
  { label: "Hiking & rambling", category: "Outdoors & Nature", active: true },
  { label: "Coffee & cafés", category: "Food & Drink", active: true },
];

// ---- normaliseInterestConfig ------------------------------------------------------------------

test("normaliseInterestConfig passes through a valid min/max", () => {
  assert.deepEqual(normaliseInterestConfig({ minSelections: 2, maxSelections: 5 }), { min: 2, max: 5 });
});

test("normaliseInterestConfig falls back to defaults for a null/garbage config", () => {
  assert.deepEqual(normaliseInterestConfig(null), { min: DEFAULT_INTEREST_MIN, max: DEFAULT_INTEREST_MAX });
  assert.deepEqual(normaliseInterestConfig({}), { min: DEFAULT_INTEREST_MIN, max: DEFAULT_INTEREST_MAX });
  assert.deepEqual(normaliseInterestConfig({ minSelections: 0, maxSelections: -1 }), {
    min: DEFAULT_INTEREST_MIN,
    max: DEFAULT_INTEREST_MAX,
  });
});

test("normaliseInterestConfig enforces max >= min for an inverted config", () => {
  assert.deepEqual(normaliseInterestConfig({ minSelections: 4, maxSelections: 2 }), { min: 4, max: 4 });
});

// ---- savedInterestLabels ----------------------------------------------------------------------

test("savedInterestLabels extracts labels from the MeResponse shape, in order", () => {
  assert.deepEqual(savedInterestLabels(SAVED), ["Walking", "Coffee & cafés"]);
});

test("savedInterestLabels accepts a plain string array and de-dupes + strips blanks", () => {
  assert.deepEqual(savedInterestLabels(["Walking", "  Walking  ", "", "Cycling"]), ["Walking", "Cycling"]);
});

test("savedInterestLabels returns [] for null/non-array", () => {
  assert.deepEqual(savedInterestLabels(null), []);
  assert.deepEqual(savedInterestLabels(undefined), []);
  assert.deepEqual(savedInterestLabels("nope"), []);
});

// ---- interestChipsModel (VIEW + remove within min) --------------------------------------------

test("interestChipsModel renders one chip per saved interest", () => {
  const m = interestChipsModel(SAVED, { min: 1, max: 3 });
  assert.equal(m.count, 2);
  assert.equal(m.empty, false);
  assert.deepEqual(m.chips.map((c) => c.label), ["Walking", "Coffee & cafés"]);
});

test("interestChipsModel marks chips removable when above the minimum", () => {
  // 2 saved, min 1 → removing one still leaves 1 ≥ min, so chips are removable.
  const m = interestChipsModel(SAVED, { min: 1, max: 3 });
  assert.equal(m.atMin, false);
  assert.ok(m.chips.every((c) => c.removable));
});

test("interestChipsModel makes chips NON-removable at the minimum (no remove that can only 400)", () => {
  // 1 saved, min 1 → removing would drop below min (backend rejects an empty set), so not removable.
  const m = interestChipsModel([{ label: "Walking" }], { min: 1, max: 3 });
  assert.equal(m.count, 1);
  assert.equal(m.atMin, true);
  assert.ok(m.chips.every((c) => !c.removable));
});

test("interestChipsModel offers ADD below the max and hides it at the max", () => {
  assert.equal(interestChipsModel(SAVED, { min: 1, max: 3 }).canAdd, true); // 2 < 3
  const full = interestChipsModel(
    [{ label: "Walking" }, { label: "Cycling" }, { label: "Hiking & rambling" }],
    { min: 1, max: 3 },
  );
  assert.equal(full.atMax, true);
  assert.equal(full.canAdd, false); // 3 === max
});

test("interestChipsModel reports an empty saved set", () => {
  const m = interestChipsModel([], { min: 1, max: 3 });
  assert.equal(m.empty, true);
  assert.equal(m.count, 0);
  assert.equal(m.canAdd, true);
});

// ---- interestsHint (replaces the old "coming soon" copy) --------------------------------------

test("interestsHint guides an empty state toward the minimum, never says 'coming soon'", () => {
  const h = interestsHint(0, 1, 3);
  assert.match(h, /at least 1 interest/);
  assert.doesNotMatch(h, /coming soon/i);
});

test("interestsHint counts down remaining room, and announces the cap at the max", () => {
  assert.match(interestsHint(2, 1, 3), /Add up to 1 more/);
  assert.match(interestsHint(3, 1, 3), /You've added the maximum of 3/);
});

test("interestsHint reads correctly when OVER the max (never claims they 'added the maximum')", () => {
  // A count above max (e.g. the config's max was lowered after the user saved) must not say
  // "You've added the maximum of N" — it reads as over the ceiling instead (TM-874).
  const over = interestsHint(4, 1, 3);
  assert.match(over, /over the maximum of 3/);
  assert.doesNotMatch(over, /added the maximum/);
});

// ---- catalogueGroups (the ADD picker) ---------------------------------------------------------

test("catalogueGroups groups the active catalogue by category in catalogue order", () => {
  const { groups } = catalogueGroups(CATALOGUE, [], { max: 3 });
  assert.deepEqual(groups.map((g) => g.category), ["Sport & Fitness", "Outdoors & Nature", "Food & Drink"]);
  assert.deepEqual(groups[0].options.map((o) => o.label), ["Walking", "Cycling"]);
});

test("catalogueGroups flags already-selected options", () => {
  const { groups, selectedCount } = catalogueGroups(CATALOGUE, ["Walking"], { max: 3 });
  assert.equal(selectedCount, 1);
  const walking = groups.flatMap((g) => g.options).find((o) => o.label === "Walking");
  assert.equal(walking.selected, true);
});

test("catalogueGroups disables unselected options once the max is reached, keeps selected toggleable", () => {
  // At max (3 selected), an UNselected option is disabled but a SELECTED one stays enabled (deselectable).
  const selected = ["Walking", "Cycling", "Hiking & rambling"];
  const { groups, atMax } = catalogueGroups(CATALOGUE, selected, { max: 3 });
  assert.equal(atMax, true);
  const coffee = groups.flatMap((g) => g.options).find((o) => o.label === "Coffee & cafés");
  const walking = groups.flatMap((g) => g.options).find((o) => o.label === "Walking");
  assert.equal(coffee.disabled, true); // unselected + at cap → disabled
  assert.equal(walking.disabled, false); // selected → still deselectable
});

test("catalogueGroups excludes retired (active === false) rows", () => {
  const withRetired = [...CATALOGUE, { label: "Old Fad", category: "Food & Drink", active: false }];
  const labels = catalogueGroups(withRetired, [], { max: 3 }).groups.flatMap((g) => g.options.map((o) => o.label));
  assert.ok(!labels.includes("Old Fad"));
});

// ---- toggleInterest (add/remove within max) ---------------------------------------------------

test("toggleInterest adds a new label and removes an existing one", () => {
  assert.deepEqual(toggleInterest(["Walking"], "Cycling", { max: 3 }), ["Walking", "Cycling"]);
  assert.deepEqual(toggleInterest(["Walking", "Cycling"], "Walking", { max: 3 }), ["Cycling"]);
});

test("toggleInterest refuses to add beyond the max (belt-and-braces over the disabled option)", () => {
  const atCap = ["Walking", "Cycling", "Hiking & rambling"];
  assert.deepEqual(toggleInterest(atCap, "Coffee & cafés", { max: 3 }), atCap); // unchanged
});

test("toggleInterest still allows REMOVING at the max", () => {
  const atCap = ["Walking", "Cycling", "Hiking & rambling"];
  assert.deepEqual(toggleInterest(atCap, "Cycling", { max: 3 }), ["Walking", "Hiking & rambling"]);
});

// ---- selectionError (pre-save gate mirroring the backend) -------------------------------------

test("selectionError blocks a below-min selection with a clear message", () => {
  assert.match(selectionError([], { min: 1, max: 3 }), /at least 1 interest/);
});

test("selectionError blocks an above-max selection", () => {
  assert.match(selectionError(["a", "b", "c", "d"], { min: 1, max: 3 }), /at most 3 interests/);
});

test("selectionError passes a valid selection", () => {
  assert.equal(selectionError(["Walking", "Cycling"], { min: 1, max: 3 }), "");
});

// ---- interest emoji (TM-805) ------------------------------------------------------------------
// The catalogue rows now carry a nullable `emoji` (V46 back-fills a glyph for every seed interest).
// interestEmoji() normalises it for the chip renderers; catalogueGroups/interestChipsModel surface it
// so the picker + card chips can show the leading glyph, degrading to label-only when there's none.

test("interestEmoji reads and trims a catalogue row's emoji", () => {
  assert.equal(interestEmoji({ label: "Coffee & cafés", emoji: "☕" }), "☕");
  assert.equal(interestEmoji({ label: "Padded", emoji: "  🎨  " }), "🎨");
});

test("interestEmoji returns '' for a missing/blank/non-string emoji (graceful, no glyph)", () => {
  assert.equal(interestEmoji({ label: "None" }), "");
  assert.equal(interestEmoji({ label: "Blank", emoji: "   " }), "");
  assert.equal(interestEmoji({ label: "Wrong type", emoji: 42 }), "");
  assert.equal(interestEmoji(null), "");
  assert.equal(interestEmoji(undefined), "");
});

test("emojiByLabel builds a label→glyph map, omitting glyph-less/blank rows", () => {
  const map = emojiByLabel([
    { label: "Coffee & cafés", emoji: "☕" },
    { label: "Walking", emoji: "🚶" },
    { label: "No glyph" }, // no emoji → omitted
    { label: "  ", emoji: "🙈" }, // blank label → omitted
  ]);
  assert.equal(map.get("Coffee & cafés"), "☕");
  assert.equal(map.get("Walking"), "🚶");
  assert.equal(map.has("No glyph"), false);
  assert.equal(map.size, 2);
});

test("emojiByLabel is empty for a null/non-array catalogue", () => {
  assert.equal(emojiByLabel(null).size, 0);
  assert.equal(emojiByLabel(undefined).size, 0);
  assert.equal(emojiByLabel("nope").size, 0);
});

test("catalogueGroups carries each option's emoji from the catalogue row", () => {
  const { groups } = catalogueGroups(
    [
      { label: "Walking", category: "Sport & Fitness", emoji: "🚶", active: true },
      { label: "Cycling", category: "Sport & Fitness", active: true }, // no emoji
    ],
    [],
    { max: 3 },
  );
  const opts = groups[0].options;
  assert.equal(opts.find((o) => o.label === "Walking").emoji, "🚶");
  assert.equal(opts.find((o) => o.label === "Cycling").emoji, ""); // degrades to no glyph
});

test("interestChipsModel resolves each saved chip's emoji against the passed catalogue", () => {
  const saved = [{ label: "Coffee & cafés" }, { label: "Walking" }];
  const catalogue = [
    { label: "Coffee & cafés", emoji: "☕", active: true },
    { label: "Walking", active: true }, // no emoji
  ];
  const m = interestChipsModel(saved, { min: 1, max: 3, catalogue });
  assert.equal(m.chips.find((c) => c.label === "Coffee & cafés").emoji, "☕");
  assert.equal(m.chips.find((c) => c.label === "Walking").emoji, "");
});

test("interestChipsModel leaves emoji '' when no catalogue is supplied (saved shape has none)", () => {
  const m = interestChipsModel([{ label: "Walking" }], { min: 1, max: 3 });
  assert.equal(m.chips[0].emoji, "");
});
