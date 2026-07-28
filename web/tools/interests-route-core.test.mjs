// Tests for the dedicated interests-management ROUTE pure view-model (TM-1095). Framework-free — Node's
// built-in test runner, the same harness as interests-core.test.mjs / profile-core.test.mjs, picked up
// by the CI glob `node --test web/tools/*.test.mjs`.
//
// TM-1095 replaces the in-place picker OVERLAY with a dedicated full-screen route (`#/profile/interests`)
// that adds a SEARCH filter, COLLAPSIBLE category sections, and a sticky Save/Cancel bar, keeping the
// same min/max bounds + the same PATCH /me save contract. These guard the PURE core the route's DOM
// renderer (interests-route.js) is a thin map over: the search filter, the Popular-first grouping, the
// collapse state, the min/max-gated selection toggle + summary, and the save-bar (valid + dirty) gate.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  POPULAR_GROUP,
  normaliseQuery,
  rowMatchesQuery,
  groupedSections,
  selectionSummary,
  saveBarModel,
  sameLabelSet,
  toggleSection,
  toggleInterest,
  noResultsMessage,
} from "../src/assets/interests-route-core.js";

// A slice of the real PUBLIC catalogue (GET /api/v1/interests/catalogue → PublicInterestResponse shape:
// {label, category, emoji, highlighted, sortWeight}). Two highlighted rows across two categories, plus
// plain rows, plus a retired row that must never surface.
const CATALOGUE = [
  { label: "Running & jogging", category: "Sport & Fitness", emoji: "🏃", highlighted: true, sortWeight: 100, active: true },
  { label: "Yoga", category: "Sport & Fitness", emoji: "🧘", highlighted: false, sortWeight: 0, active: true },
  { label: "Swimming", category: "Sport & Fitness", emoji: "🏊", highlighted: false, sortWeight: 0, active: true },
  { label: "Coffee & cafés", category: "Food & Drink", emoji: "☕", highlighted: true, sortWeight: 100, active: true },
  { label: "Wine tasting", category: "Food & Drink", emoji: "🍷", highlighted: false, sortWeight: 0, active: true },
  { label: "Retired thing", category: "Food & Drink", emoji: null, highlighted: false, sortWeight: 0, active: false },
];

// ── normaliseQuery / rowMatchesQuery ────────────────────────────────────────────────────────────────

test("normaliseQuery lower-cases and trims; blank/absent → ''", () => {
  assert.equal(normaliseQuery("  Coffee "), "coffee");
  assert.equal(normaliseQuery("YOGA"), "yoga");
  assert.equal(normaliseQuery(""), "");
  assert.equal(normaliseQuery("   "), "");
  assert.equal(normaliseQuery(null), "");
  assert.equal(normaliseQuery(undefined), "");
});

test("rowMatchesQuery matches label OR category, case-insensitively; blank query matches all", () => {
  const coffee = { label: "Coffee & cafés", category: "Food & Drink" };
  assert.equal(rowMatchesQuery(coffee, "coff"), true, "label substring");
  assert.equal(rowMatchesQuery(coffee, "food"), true, "category substring");
  assert.equal(rowMatchesQuery(coffee, "yoga"), false, "no match");
  assert.equal(rowMatchesQuery(coffee, ""), true, "blank query = no filter");
});

// ── groupedSections: Popular-first grouping ─────────────────────────────────────────────────────────

test("groupedSections puts a synthetic Popular group FIRST, then categories in first-seen order", () => {
  const { sections } = groupedSections(CATALOGUE, [], { max: 3 });
  assert.equal(sections[0].name, POPULAR_GROUP);
  assert.equal(sections[0].popular, true);
  // The two highlighted rows land in Popular.
  assert.deepEqual(sections[0].options.map((o) => o.label).sort(), ["Coffee & cafés", "Running & jogging"]);
  // Then the real categories, in first-seen order.
  assert.deepEqual(sections.slice(1).map((s) => s.name), ["Sport & Fitness", "Food & Drink"]);
});

test("groupedSections excludes retired (active:false) rows from every section", () => {
  const { sections } = groupedSections(CATALOGUE, [], { max: 3 });
  const all = sections.flatMap((s) => s.options.map((o) => o.label));
  assert.ok(!all.includes("Retired thing"), "retired row never surfaces");
});

test("groupedSections carries the emoji off the catalogue row", () => {
  const { sections } = groupedSections(CATALOGUE, [], { max: 3 });
  const popular = sections.find((s) => s.popular);
  const running = popular.options.find((o) => o.label === "Running & jogging");
  assert.equal(running.emoji, "🏃");
});

// ── groupedSections: search filter ──────────────────────────────────────────────────────────────────

test("groupedSections filters by query and drops sections with no matches", () => {
  const { sections, matchCount, filtering } = groupedSections(CATALOGUE, [], { max: 3, query: "coffee" });
  assert.equal(filtering, true);
  // Only "Coffee & cafés" matches (label) — it's highlighted, so it shows in Popular AND Food & Drink.
  assert.equal(matchCount, 1);
  const names = sections.map((s) => s.name);
  assert.ok(names.includes(POPULAR_GROUP), "Popular kept (coffee is highlighted)");
  assert.ok(names.includes("Food & Drink"), "its category kept");
  assert.ok(!names.includes("Sport & Fitness"), "Sport & Fitness dropped (no match)");
});

test("groupedSections category-name search returns the whole category", () => {
  const { sections, matchCount } = groupedSections(CATALOGUE, [], { max: 3, query: "sport" });
  const sport = sections.find((s) => s.name === "Sport & Fitness");
  assert.ok(sport, "Sport & Fitness section present");
  // All three active Sport rows match the category name.
  assert.deepEqual(sport.options.map((o) => o.label).sort(), ["Running & jogging", "Swimming", "Yoga"]);
  // matchCount counts distinct catalogue rows (Running also appears in Popular, but is ONE row).
  assert.equal(matchCount, 3);
});

test("groupedSections with a no-match query yields zero sections + matchCount 0", () => {
  const { sections, matchCount } = groupedSections(CATALOGUE, [], { max: 3, query: "zzzznope" });
  assert.equal(sections.length, 0);
  assert.equal(matchCount, 0);
});

// ── groupedSections: min/max gating (selected + disabled) ───────────────────────────────────────────

test("groupedSections flags selected options and disables the rest at the cap", () => {
  // At max (3) with these 3 chosen, every UNSELECTED option is disabled; selected ones stay enabled.
  const { sections, atMax } = groupedSections(CATALOGUE, ["Yoga", "Swimming", "Wine tasting"], { max: 3 });
  assert.equal(atMax, true);
  const opts = sections.flatMap((s) => s.options);
  const yoga = opts.find((o) => o.label === "Yoga");
  const running = opts.find((o) => o.label === "Running & jogging");
  assert.equal(yoga.selected, true);
  assert.equal(yoga.disabled, false, "a selected option is never disabled (must be deselectable)");
  assert.equal(running.selected, false);
  assert.equal(running.disabled, true, "an unselected option is disabled at the cap");
});

test("groupedSections below the cap disables nothing", () => {
  const { sections, atMax } = groupedSections(CATALOGUE, ["Yoga"], { max: 3 });
  assert.equal(atMax, false);
  assert.ok(sections.flatMap((s) => s.options).every((o) => o.disabled === false));
});

// ── groupedSections: collapse state ─────────────────────────────────────────────────────────────────

test("groupedSections reflects the collapsed set (default expanded)", () => {
  const { sections } = groupedSections(CATALOGUE, [], { max: 3, collapsed: new Set(["Food & Drink"]) });
  const food = sections.find((s) => s.name === "Food & Drink");
  const sport = sections.find((s) => s.name === "Sport & Fitness");
  assert.equal(food.collapsed, true);
  assert.equal(sport.collapsed, false, "unfolded sections default to expanded");
});

test("groupedSections force-expands every section while a search is active", () => {
  // Even though Food & Drink is in the collapsed set, an active query expands it so matches are visible.
  const { sections } = groupedSections(CATALOGUE, [], {
    max: 3,
    query: "wine",
    collapsed: new Set(["Food & Drink"]),
  });
  const food = sections.find((s) => s.name === "Food & Drink");
  assert.ok(food, "Food & Drink still present (wine matches)");
  assert.equal(food.collapsed, false, "search force-expands collapsed sections");
});

// ── selectionSummary ────────────────────────────────────────────────────────────────────────────────

test("selectionSummary reports count, bounds, and the count line", () => {
  const s = selectionSummary(["Yoga", "Swimming"], { min: 1, max: 3 });
  assert.deepEqual(s.chips.map((c) => c.label), ["Yoga", "Swimming"]);
  assert.equal(s.count, 2);
  assert.equal(s.min, 1);
  assert.equal(s.max, 3);
  assert.equal(s.atMin, false);
  assert.equal(s.atMax, false);
  assert.equal(s.empty, false);
  assert.equal(s.countLine, "2 of 3 selected");
});

test("selectionSummary de-dupes + strips blanks like the shared savedInterestLabels", () => {
  const s = selectionSummary(["Yoga", "Yoga", "", "  ", "Swimming"], { min: 1, max: 3 });
  assert.deepEqual(s.chips.map((c) => c.label), ["Yoga", "Swimming"]);
  assert.equal(s.count, 2);
});

test("selectionSummary flags atMin/atMax/empty at the boundaries", () => {
  assert.equal(selectionSummary([], { min: 1, max: 3 }).empty, true);
  assert.equal(selectionSummary(["a"], { min: 1, max: 3 }).atMin, true);
  assert.equal(selectionSummary(["a", "b", "c"], { min: 1, max: 3 }).atMax, true);
});

// ── saveBarModel: valid + dirty gate ────────────────────────────────────────────────────────────────

test("saveBarModel: unchanged selection is not dirty and cannot Save", () => {
  const m = saveBarModel(["Yoga", "Swimming"], ["Swimming", "Yoga"], { min: 1, max: 3 });
  assert.equal(m.dirty, false, "same set (order-independent) is not dirty");
  assert.equal(m.canSave, false, "no changes → nothing to save");
  assert.equal(m.error, "");
});

test("saveBarModel: a valid CHANGED selection can Save", () => {
  const m = saveBarModel(["Yoga", "Coffee & cafés"], ["Yoga"], { min: 1, max: 3 });
  assert.equal(m.dirty, true);
  assert.equal(m.canSave, true);
  assert.equal(m.error, "");
});

test("saveBarModel: below-min selection is blocked with the server's message even when dirty", () => {
  const m = saveBarModel([], ["Yoga"], { min: 1, max: 3 });
  assert.equal(m.dirty, true, "emptying a one-interest set is a change");
  assert.equal(m.canSave, false, "but below min, so Save stays disabled");
  assert.equal(m.error, "Choose at least 1 interest.");
});

test("saveBarModel: above-max selection is blocked", () => {
  const m = saveBarModel(["a", "b", "c", "d"], ["a"], { min: 1, max: 3 });
  assert.equal(m.canSave, false);
  assert.equal(m.error, "Choose at most 3 interests.");
});

// ── sameLabelSet / toggleSection ────────────────────────────────────────────────────────────────────

test("sameLabelSet is order-independent set equality", () => {
  assert.equal(sameLabelSet(["a", "b"], ["b", "a"]), true);
  assert.equal(sameLabelSet(["a", "b"], ["a"]), false);
  assert.equal(sameLabelSet([], []), true);
  assert.equal(sameLabelSet(["a", "a"], ["a"]), true, "de-duped before compare");
});

test("toggleSection folds/unfolds a section name without mutating the input", () => {
  const start = new Set(["Food & Drink"]);
  const expanded = toggleSection(start, "Food & Drink");
  assert.equal(expanded.has("Food & Drink"), false, "toggling a folded section unfolds it");
  assert.equal(start.has("Food & Drink"), true, "input Set is not mutated");
  const folded = toggleSection(new Set(), "Sport & Fitness");
  assert.equal(folded.has("Sport & Fitness"), true, "toggling an unfolded section folds it");
});

test("toggleSection ignores a blank section name", () => {
  const start = new Set(["A"]);
  const out = toggleSection(start, "   ");
  assert.deepEqual([...out], ["A"]);
});

// ── the shared toggle wired through the route core (end-to-end selection flow) ─────────────────────────

test("toggleInterest (re-exported) round-trips add + remove within the max", () => {
  let sel = [];
  sel = toggleInterest(sel, "Yoga", { max: 3 });
  sel = toggleInterest(sel, "Swimming", { max: 3 });
  assert.deepEqual(sel, ["Yoga", "Swimming"]);
  sel = toggleInterest(sel, "Yoga", { max: 3 }); // remove
  assert.deepEqual(sel, ["Swimming"]);
});

test("toggleInterest refuses to exceed the max (belt-and-braces)", () => {
  const sel = toggleInterest(["a", "b", "c"], "d", { max: 3 });
  assert.deepEqual(sel, ["a", "b", "c"], "adding past the cap is a no-op");
});

// ── noResultsMessage ────────────────────────────────────────────────────────────────────────────────

test("noResultsMessage names the query", () => {
  assert.equal(noResultsMessage("banjo"), "No interests match “banjo”.");
  assert.equal(noResultsMessage("  "), "No interests match your search.");
});
