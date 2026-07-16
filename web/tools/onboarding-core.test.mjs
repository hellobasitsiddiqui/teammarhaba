// Tests for the onboarding interests PICK STEP pure logic (TM-776 / I4). Framework-free — Node's
// built-in test runner, picked up by the CI glob `node --test web/tools/*.test.mjs` (the "Web asset
// fingerprinting check"). Matches the profile-core.test.mjs / events-core.test.mjs header style.
//
// onboarding-core.js has zero DOM/fetch/browser deps, so the whole behaviour is asserted here: the
// Popular-first category grouping + intra-group sort, the selection bounds (defaults, config read,
// hard-min-1 floor, max>=min clamp), the client-mirror validation + pluralisation, the finish gate,
// the PATCH /me payload shaping (dedupe + order), and the returning-user prefill mapping.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  POPULAR_LABEL,
  groupCatalogue,
  selectionBounds,
  validateSelection,
  canFinish,
  selectionPillState,
  canSelectMore,
  chipDisabled,
  toInterestsPayload,
  selectedLabelsFromMe,
} from "../src/assets/onboarding-core.js";

// A small realistic catalogue slice (shape = PublicInterestResponse: {label, category, highlighted,
// sortWeight}). Two highlighted rows (weight 100) across two categories, plus plain rows (weight 0).
// Intentionally NOT pre-sorted so the tests prove the module does the ordering itself.
function catalogue() {
  return [
    { label: "Cycling", category: "Sport & Fitness", highlighted: false, sortWeight: 0 },
    { label: "Running & jogging", category: "Sport & Fitness", highlighted: true, sortWeight: 100 },
    { label: "Badminton", category: "Sport & Fitness", highlighted: true, sortWeight: 100 },
    { label: "Board games", category: "Games & Tech", highlighted: false, sortWeight: 0 },
    { label: "Coffee & cafés", category: "Food & Drink", highlighted: true, sortWeight: 100 },
    { label: "Aeropress", category: "Food & Drink", highlighted: false, sortWeight: 0 },
  ];
}

// ---- groupCatalogue ---------------------------------------------------------------------------

test("groupCatalogue puts the Popular group first and it contains exactly the highlighted rows", () => {
  const groups = groupCatalogue(catalogue());
  assert.equal(groups[0].category, POPULAR_LABEL);
  const popularLabels = groups[0].items.map((i) => i.label);
  // The three highlighted rows, and ONLY those.
  assert.deepEqual(new Set(popularLabels), new Set(["Running & jogging", "Badminton", "Coffee & cafés"]));
  assert.equal(popularLabels.length, 3);
});

test("groupCatalogue groups after Popular are the real categories, in first-appearance order", () => {
  const groups = groupCatalogue(catalogue());
  const categoriesAfterPopular = groups.slice(1).map((g) => g.category);
  // First appearance in the (unsorted) input: Sport & Fitness, Games & Tech, Food & Drink.
  assert.deepEqual(categoriesAfterPopular, ["Sport & Fitness", "Games & Tech", "Food & Drink"]);
  assert.ok(!categoriesAfterPopular.includes(POPULAR_LABEL), "Popular is not repeated as a real category");
});

test("groupCatalogue orders each group by sortWeight DESC then label ascending", () => {
  const groups = groupCatalogue(catalogue());
  // Popular: both weight-100 rows sort by label asc (Badminton before 'Coffee' before 'Running').
  assert.deepEqual(
    groups[0].items.map((i) => i.label),
    ["Badminton", "Coffee & cafés", "Running & jogging"],
  );
  // Sport & Fitness: the two w100 rows (Badminton, Running) float above Cycling (w0) and tie-break by
  // label asc; highlighted rows also stay in their home category (not only in Popular).
  const sport = groups.find((g) => g.category === "Sport & Fitness");
  assert.deepEqual(sport.items.map((i) => i.label), ["Badminton", "Running & jogging", "Cycling"]);
});

test("groupCatalogue: a highlighted row appears in BOTH Popular and its home category (dedupe is by label in selection)", () => {
  const groups = groupCatalogue(catalogue());
  const inPopular = groups[0].items.some((i) => i.label === "Running & jogging");
  const sport = groups.find((g) => g.category === "Sport & Fitness");
  const inHome = sport.items.some((i) => i.label === "Running & jogging");
  assert.ok(inPopular && inHome, "a highlighted interest shows in Popular and in its category");
});

test("groupCatalogue on an empty catalogue returns an empty array", () => {
  assert.deepEqual(groupCatalogue([]), []);
  assert.deepEqual(groupCatalogue(null), []);
  assert.deepEqual(groupCatalogue(undefined), []);
});

test("groupCatalogue returns the {category, items[]} shape the picker renders, Popular counted once", () => {
  const groups = groupCatalogue(catalogue());
  // Every group is a { category:string, items:Array } the renderer maps to a section + chip wrap.
  for (const g of groups) {
    assert.equal(typeof g.category, "string");
    assert.ok(Array.isArray(g.items) && g.items.length > 0, "no empty group section");
    for (const item of g.items) assert.equal(typeof item.label, "string");
  }
  // Exactly one synthetic Popular group (the highlighted bucket), the rest real categories.
  assert.equal(groups.filter((g) => g.category === POPULAR_LABEL).length, 1);
  // A highlighted label is present in TWO groups (Popular + its home category); a plain one in exactly one.
  const groupsWith = (label) => groups.filter((g) => g.items.some((i) => i.label === label)).length;
  assert.equal(groupsWith("Running & jogging"), 2, "highlighted row sits in Popular AND its home category");
  assert.equal(groupsWith("Cycling"), 1, "a plain row sits only in its home category");
});

test("groupCatalogue with zero highlighted rows renders NO Popular group", () => {
  const noHighlights = [
    { label: "Cycling", category: "Sport & Fitness", highlighted: false, sortWeight: 0 },
    { label: "Board games", category: "Games & Tech", highlighted: false, sortWeight: 0 },
  ];
  const groups = groupCatalogue(noHighlights);
  assert.ok(!groups.some((g) => g.category === POPULAR_LABEL), "no empty Popular section");
  assert.deepEqual(groups.map((g) => g.category), ["Sport & Fitness", "Games & Tech"]);
});

// ---- selectionBounds --------------------------------------------------------------------------

test("selectionBounds defaults to {min:1, max:3} when config is null/missing", () => {
  assert.deepEqual(selectionBounds(null), { min: 1, max: 3 });
  assert.deepEqual(selectionBounds(undefined), { min: 1, max: 3 });
  assert.deepEqual(selectionBounds({}), { min: 1, max: 3 });
});

test("selectionBounds reads config values", () => {
  assert.deepEqual(selectionBounds({ minSelections: 2, maxSelections: 5 }), { min: 2, max: 5 });
});

test("selectionBounds floors min to 1 even if config says 0 (hard-min-1 invariant)", () => {
  assert.deepEqual(selectionBounds({ minSelections: 0, maxSelections: 3 }), { min: 1, max: 3 });
  assert.deepEqual(selectionBounds({ minSelections: -4, maxSelections: 3 }), { min: 1, max: 3 });
});

test("selectionBounds clamps max to be >= min", () => {
  // A nonsensical config (max < min) can never produce an unsatisfiable gate.
  assert.deepEqual(selectionBounds({ minSelections: 3, maxSelections: 1 }), { min: 3, max: 3 });
});

// ---- validateSelection ------------------------------------------------------------------------

test("validateSelection: 0 selected fails with 'at least 1 interest' (singular)", () => {
  const r = validateSelection([], { min: 1, max: 3 });
  assert.equal(r.ok, false);
  assert.equal(r.message, "Select at least 1 interest.");
});

test("validateSelection passes at the min boundary and at the max boundary", () => {
  assert.equal(validateSelection(["a"], { min: 1, max: 3 }).ok, true);
  assert.equal(validateSelection(["a", "b", "c"], { min: 1, max: 3 }).ok, true);
});

test("validateSelection: max+1 fails with 'at most N interests' (plural)", () => {
  const r = validateSelection(["a", "b", "c", "d"], { min: 1, max: 3 });
  assert.equal(r.ok, false);
  assert.equal(r.message, "Select at most 3 interests.");
});

test("validateSelection pluralisation matches backend copy for min=1 vs min=2", () => {
  assert.equal(validateSelection([], { min: 1, max: 3 }).message, "Select at least 1 interest.");
  assert.equal(validateSelection([], { min: 2, max: 3 }).message, "Select at least 2 interests.");
});

test("validateSelection counts distinct labels (a Set is accepted)", () => {
  assert.equal(validateSelection(new Set(["a", "b"]), { min: 1, max: 3 }).ok, true);
  // duplicates collapse — three raw entries, two distinct → still within max 3
  assert.equal(validateSelection(["a", "a", "b"], { min: 1, max: 3 }).ok, true);
});

// ---- canFinish --------------------------------------------------------------------------------

test("canFinish is false at 0, true at min, true at max, false above max", () => {
  const bounds = { min: 1, max: 3 };
  assert.equal(canFinish([], bounds), false);
  assert.equal(canFinish(["a"], bounds), true);
  assert.equal(canFinish(["a", "b", "c"], bounds), true);
  assert.equal(canFinish(["a", "b", "c", "d"], bounds), false);
});

// ---- selectionPillState (TM-804 paper "Pick interests" pill copy) ------------------------------

test("selectionPillState below the min reads 'Pick at least N to continue' and is NOT satisfied", () => {
  // 0 selected, min 1 → the below-min prompt (the empty/hollow-ring pill state).
  const s0 = selectionPillState([], { min: 1, max: 3 });
  assert.equal(s0.satisfied, false);
  assert.equal(s0.count, 0);
  assert.equal(s0.label, "Pick at least 1 to continue");

  // The prompt uses the effective MIN, not the max: min 2, one picked → still below.
  const s1 = selectionPillState(["a"], { min: 2, max: 3 });
  assert.equal(s1.satisfied, false);
  assert.equal(s1.label, "Pick at least 2 to continue");
});

test("selectionPillState at the min boundary flips to satisfied and reads 'N selected'", () => {
  // Exactly at the min (default min 1) — the boundary is inclusive → satisfied, checkmark pill.
  const s = selectionPillState(["a"], { min: 1, max: 3 });
  assert.equal(s.satisfied, true);
  assert.equal(s.count, 1);
  assert.equal(s.label, "1 selected");

  // At a higher min boundary too.
  const s2 = selectionPillState(["a", "b"], { min: 2, max: 3 });
  assert.equal(s2.satisfied, true);
  assert.equal(s2.label, "2 selected");
});

test("selectionPillState above the min reports the live count in 'N selected'", () => {
  const s = selectionPillState(["a", "b", "c"], { min: 1, max: 3 });
  assert.equal(s.satisfied, true);
  assert.equal(s.count, 3);
  assert.equal(s.label, "3 selected");
});

test("selectionPillState counts DISTINCT labels (a Set is passed through by size)", () => {
  // Duplicates collapse — three raw entries, two distinct → count 2.
  assert.equal(selectionPillState(["a", "a", "b"], { min: 1, max: 3 }).count, 2);
  assert.equal(selectionPillState(new Set(["a", "b"]), { min: 1, max: 3 }).label, "2 selected");
});

// ---- canSelectMore + chipDisabled (TM-804 max-cap chip dimming) --------------------------------

test("canSelectMore is true below the max and false once the cap is reached", () => {
  const bounds = { min: 1, max: 3 };
  assert.equal(canSelectMore([], bounds), true);
  assert.equal(canSelectMore(["a"], bounds), true);
  assert.equal(canSelectMore(["a", "b"], bounds), true); // still one slot left
  assert.equal(canSelectMore(["a", "b", "c"], bounds), false); // exactly at the cap
});

test("chipDisabled: below the cap nothing is disabled (selected or not)", () => {
  const bounds = { min: 1, max: 3 };
  assert.equal(chipDisabled(false, ["a"], bounds), false); // unselected, room left
  assert.equal(chipDisabled(true, ["a"], bounds), false); // selected, room left
});

test("chipDisabled: at the cap the UNSELECTED chips disable but SELECTED ones stay toggleable", () => {
  const bounds = { min: 1, max: 3 };
  const atCap = ["a", "b", "c"]; // 3 = max
  // An unselected chip at the cap → disabled (can't add a 4th).
  assert.equal(chipDisabled(false, atCap, bounds), true);
  // An already-selected chip at the cap → NOT disabled, so the user can toggle it off to swap.
  assert.equal(chipDisabled(true, atCap, bounds), false);
});

// ---- toInterestsPayload -----------------------------------------------------------------------

test("toInterestsPayload dedupes repeated labels, preserves order, returns plain strings", () => {
  const payload = toInterestsPayload(["Running & jogging", "Cycling", "Running & jogging", "Yoga"]);
  assert.deepEqual(payload, ["Running & jogging", "Cycling", "Yoga"]);
  assert.ok(payload.every((l) => typeof l === "string"));
});

test("toInterestsPayload accepts a Set and skips non-strings", () => {
  assert.deepEqual(toInterestsPayload(new Set(["a", "b"])), ["a", "b"]);
  assert.deepEqual(toInterestsPayload(["a", null, 3, "b"]), ["a", "b"]);
  assert.deepEqual(toInterestsPayload(null), []);
});

// ---- selectedLabelsFromMe ---------------------------------------------------------------------

test("selectedLabelsFromMe maps interests[].label and handles empty/absent", () => {
  assert.deepEqual(selectedLabelsFromMe({ interests: [] }), []);
  assert.deepEqual(selectedLabelsFromMe({}), []);
  assert.deepEqual(selectedLabelsFromMe(null), []);
  assert.deepEqual(
    selectedLabelsFromMe({
      interests: [
        { label: "Cycling", category: "Sport & Fitness", sourceInterestId: 4 },
        { label: "Yoga", category: "Sport & Fitness", sourceInterestId: 9 },
      ],
    }),
    ["Cycling", "Yoga"],
  );
});
