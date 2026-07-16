// Tests for the admin interest create/edit logic (TM-779). Framework-free — Node's built-in test runner,
// the same harness as admin-venues-core.test.mjs, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// These guard the PURE core of the admin interests console (admin-interests-core.js): the field caps
// (mirroring the backend Create/UpdateInterestRequest + InterestConfigRequest DTOs), the known-category
// set (mirroring InterestCategories.KNOWN — the case-sensitive contract), the whole-form validation
// (mirroring the API's Bean Validation), the draft → API-body builder and its inverse, and the config
// (min/max selection) validation that guards the PUT. The DOM wiring in admin-interests.js is a thin layer
// over these.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LABEL_MAX,
  CATEGORY_MAX,
  SORT_WEIGHT_MIN,
  SORT_WEIGHT_MAX,
  CONFIG_MIN,
  CATEGORIES,
  validateInterestDraft,
  buildInterestPayload,
  toInterestFormModel,
  validateConfigDraft,
  interestSummaryLabel,
} from "../src/assets/admin-interests-core.js";

// --- caps mirror the backend DTOs (Create/UpdateInterestRequest + InterestConfigRequest) ------

test("field caps mirror the backend DTOs", () => {
  assert.equal(LABEL_MAX, 120);
  assert.equal(CATEGORY_MAX, 80);
  assert.deepEqual([SORT_WEIGHT_MIN, SORT_WEIGHT_MAX], [0, 1000]);
  assert.equal(CONFIG_MIN, 1);
});

test("CATEGORIES is exactly the seven known seed strings (case-sensitive contract)", () => {
  // Mirrors InterestCategories.KNOWN — the exact spellings. Order here is seed order; membership is what
  // matters. Asserting the SET locks the case-sensitive contract with the backend @AssertTrue.
  assert.deepEqual(
    new Set(CATEGORIES),
    new Set([
      "Outdoors & Nature",
      "Sport & Fitness",
      "Food & Drink",
      "Arts & Creative",
      "Games & Tech",
      "Music & Nightlife",
      "Social & Wellbeing",
    ]),
  );
  assert.equal(CATEGORIES.length, 7);
});

// --- interest draft validation ----------------------------------------------------------------

const validDraft = (over = {}) => ({
  label: "Coffee & cafés",
  category: "Food & Drink",
  sortWeight: "",
  highlighted: false,
  ...over,
});

test("validateInterestDraft accepts a minimal valid interest", () => {
  const { errors, canSave } = validateInterestDraft(validDraft());
  assert.deepEqual(errors, {});
  assert.equal(canSave, true);
});

test("validateInterestDraft flags a blank label on create and blocks save", () => {
  const { errors, canSave } = validateInterestDraft({ label: "", category: "Food & Drink" }, { requireForCreate: true });
  assert.equal(errors.label, "Label is required.");
  assert.equal(canSave, false);
});

test("validateInterestDraft rejects an over-cap label", () => {
  const { errors } = validateInterestDraft(validDraft({ label: "x".repeat(LABEL_MAX + 1) }));
  assert.ok(errors.label, "over-cap label should error");
});

test("validateInterestDraft requires a category and rejects an unknown / mis-cased one", () => {
  assert.ok(validateInterestDraft(validDraft({ category: "" })).errors.category, "blank category errors");
  assert.ok(validateInterestDraft(validDraft({ category: "food & drink" })).errors.category, "mis-cased category errors (case-sensitive)");
  assert.ok(validateInterestDraft(validDraft({ category: "Not A Bucket" })).errors.category, "unknown category errors");
  assert.deepEqual(validateInterestDraft(validDraft({ category: "Games & Tech" })).errors, {});
});

test("validateInterestDraft: sortWeight optional (blank ok), integer, in range", () => {
  assert.deepEqual(validateInterestDraft(validDraft({ sortWeight: "" })).errors, {}, "blank sortWeight is valid (omitted)");
  assert.deepEqual(validateInterestDraft(validDraft({ sortWeight: "500" })).errors, {});
  assert.ok(validateInterestDraft(validDraft({ sortWeight: "abc" })).errors.sortWeight, "non-integer errors");
  assert.ok(validateInterestDraft(validDraft({ sortWeight: "1.5" })).errors.sortWeight, "decimal errors (whole number only)");
  assert.ok(validateInterestDraft(validDraft({ sortWeight: "-1" })).errors.sortWeight, "below range errors");
  assert.ok(validateInterestDraft(validDraft({ sortWeight: "1001" })).errors.sortWeight, "above range errors");
});

test("validateInterestDraft on EDIT: absent label ok, present-but-blank rejected", () => {
  // On edit (requireForCreate=false) a valid draft still passes...
  assert.deepEqual(validateInterestDraft(validDraft(), { requireForCreate: false }).errors, {});
  // ...but a blank label is rejected — you can't clear a label to nothing (mirrors isLabelUsable).
  assert.ok(validateInterestDraft(validDraft({ label: "" }), { requireForCreate: false }).errors.label, "blanking a label on edit errors");
});

// --- payload building -------------------------------------------------------------------------

test("buildInterestPayload always emits label/category/highlighted and omits a blank sortWeight", () => {
  const body = buildInterestPayload(validDraft({ label: "  Hiking  ", category: "Outdoors & Nature", highlighted: true, sortWeight: "" }));
  assert.equal(body.label, "Hiking"); // trimmed
  assert.equal(body.category, "Outdoors & Nature");
  assert.equal(body.highlighted, true);
  assert.equal("sortWeight" in body, false); // blank omitted → server default / leave-unchanged
});

test("buildInterestPayload includes a valid integer sortWeight", () => {
  const body = buildInterestPayload(validDraft({ sortWeight: "250", highlighted: false }));
  assert.equal(body.sortWeight, 250);
  assert.equal(body.highlighted, false);
});

test("toInterestFormModel round-trips an AdminInterestResponse into form values", () => {
  const interest = {
    id: 7,
    label: "Live music",
    category: "Music & Nightlife",
    highlighted: true,
    sortWeight: 100,
    active: true,
    retired: false,
  };
  const model = toInterestFormModel(interest);
  assert.equal(model.label, "Live music");
  assert.equal(model.category, "Music & Nightlife");
  assert.equal(model.highlighted, true); // boolean for the checkbox
  assert.equal(model.sortWeight, "100"); // stringified for the number input
  // ...and back through the payload builder.
  const body = buildInterestPayload(model);
  assert.equal(body.label, "Live music");
  assert.equal(body.category, "Music & Nightlife");
  assert.equal(body.highlighted, true);
  assert.equal(body.sortWeight, 100);
});

// --- config (min/max selection) validation — the fail-before/pass-after regression guard on the PUT ----

test("validateConfigDraft accepts valid bounds (both ≥ 1, max ≥ min)", () => {
  const { errors, canSave } = validateConfigDraft({ minSelections: "3", maxSelections: "5" });
  assert.deepEqual(errors, {});
  assert.equal(canSave, true);
  // Equal bounds are valid (max ≥ min).
  assert.equal(validateConfigDraft({ minSelections: "4", maxSelections: "4" }).canSave, true);
});

test("validateConfigDraft rejects min < 1", () => {
  assert.ok(validateConfigDraft({ minSelections: "0", maxSelections: "5" }).errors.minSelections);
  assert.equal(validateConfigDraft({ minSelections: "0", maxSelections: "5" }).canSave, false);
});

test("validateConfigDraft rejects max < min", () => {
  const { errors, canSave } = validateConfigDraft({ minSelections: "5", maxSelections: "3" });
  assert.ok(errors.maxSelections, "max below min errors");
  assert.equal(canSave, false);
});

test("validateConfigDraft rejects non-integer and blank bounds", () => {
  assert.ok(validateConfigDraft({ minSelections: "abc", maxSelections: "5" }).errors.minSelections);
  assert.ok(validateConfigDraft({ minSelections: "2", maxSelections: "2.5" }).errors.maxSelections);
  assert.ok(validateConfigDraft({ minSelections: "", maxSelections: "5" }).errors.minSelections);
  assert.ok(validateConfigDraft({ minSelections: "2", maxSelections: "" }).errors.maxSelections);
});

// --- display helper ---------------------------------------------------------------------------

test("interestSummaryLabel renders 'Label — Category' (or just the label)", () => {
  assert.equal(interestSummaryLabel({ label: "Hiking", category: "Outdoors & Nature" }), "Hiking — Outdoors & Nature");
  assert.equal(interestSummaryLabel({ label: "Hiking" }), "Hiking");
  assert.equal(interestSummaryLabel({}), "Untitled interest");
});
