// Unit tests (TM-1098) for the pure notification audience-targeting filter core — the City / Age group /
// Gender / Active-24h chip predicate that narrows the SELECTABLE recipient set client-side. Asserted
// without a browser (the broadcast.js / admin-sent-history-core.js split); runs on the PR gate via
// `node --test web/tools/*.test.mjs`.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AGE_GROUPS,
  GENDER_CHIPS,
  ACTIVE_WINDOW_MS,
  ageGroupOf,
  genderOf,
  isActiveWithin24h,
  emptyAudienceFilter,
  hasActiveFilter,
  matchesAudienceFilter,
  applyAudienceFilter,
  citiesOf,
} from "../src/assets/notification-audience-core.js";

// A fixed "now" so the Active-24h tests are deterministic.
const NOW = Date.parse("2026-07-22T12:00:00Z");
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000).toISOString();

// A representative loaded eligible-user row each test tweaks (mirrors the enriched admin UserResponse).
const user = (over = {}) => ({
  id: 1,
  city: "London",
  age: 30,
  gender: "FEMALE",
  lastActiveAt: hoursAgo(1),
  pushEligible: true,
  ...over,
});

// ---- age grouping ----------------------------------------------------------------------------

test("ageGroupOf buckets ages into the fixed groups (inclusive bounds)", () => {
  assert.equal(ageGroupOf({ age: 18 }), "18-24");
  assert.equal(ageGroupOf({ age: 24 }), "18-24");
  assert.equal(ageGroupOf({ age: 25 }), "25-34");
  assert.equal(ageGroupOf({ age: 34 }), "25-34");
  assert.equal(ageGroupOf({ age: 44 }), "35-44");
  assert.equal(ageGroupOf({ age: 54 }), "45-54");
  assert.equal(ageGroupOf({ age: 55 }), "55+");
  assert.equal(ageGroupOf({ age: 99 }), "55+");
});

test("ageGroupOf returns '' for a missing / non-numeric age", () => {
  assert.equal(ageGroupOf({}), "");
  assert.equal(ageGroupOf({ age: null }), "");
  assert.equal(ageGroupOf({ age: "notanumber" }), "");
});

test("AGE_GROUPS are contiguous and non-overlapping", () => {
  for (let i = 1; i < AGE_GROUPS.length; i += 1) {
    // Each group's min is exactly one past the previous group's max (except the open-ended tail).
    if (AGE_GROUPS[i - 1].max != null) {
      assert.equal(AGE_GROUPS[i].min, AGE_GROUPS[i - 1].max + 1);
    }
  }
  assert.equal(AGE_GROUPS[AGE_GROUPS.length - 1].max, null); // last is open-ended
});

// ---- gender ----------------------------------------------------------------------------------

test("genderOf returns the stated enum name, or '' when absent", () => {
  assert.equal(genderOf({ gender: "MALE" }), "MALE");
  assert.equal(genderOf({ gender: "PREFER_NOT_TO_SAY" }), "PREFER_NOT_TO_SAY");
  assert.equal(genderOf({}), "");
  assert.equal(genderOf({ gender: null }), "");
});

test("GENDER_CHIPS are Male/Female only (the MVP set)", () => {
  assert.deepEqual(GENDER_CHIPS.map((g) => g.value).sort(), ["FEMALE", "MALE"]);
});

// ---- active-in-24h ---------------------------------------------------------------------------

test("isActiveWithin24h is true inside the window, false outside / future / missing", () => {
  assert.equal(isActiveWithin24h({ lastActiveAt: hoursAgo(1) }, NOW), true);
  assert.equal(isActiveWithin24h({ lastActiveAt: hoursAgo(23) }, NOW), true);
  assert.equal(isActiveWithin24h({ lastActiveAt: hoursAgo(25) }, NOW), false); // just outside 24h
  assert.equal(isActiveWithin24h({ lastActiveAt: hoursAgo(-1) }, NOW), false); // future ⇒ not active
  assert.equal(isActiveWithin24h({ lastActiveAt: null }, NOW), false);
  assert.equal(isActiveWithin24h({}, NOW), false);
  assert.equal(isActiveWithin24h({ lastActiveAt: "garbage" }, NOW), false);
});

test("isActiveWithin24h accepts epoch-ms as well as ISO strings, and boundary is inclusive", () => {
  assert.equal(isActiveWithin24h({ lastActiveAt: NOW - 1000 }, NOW), true);
  assert.equal(isActiveWithin24h({ lastActiveAt: NOW - ACTIVE_WINDOW_MS }, NOW), true); // exactly 24h
  assert.equal(isActiveWithin24h({ lastActiveAt: NOW - ACTIVE_WINDOW_MS - 1 }, NOW), false);
});

// ---- the empty / no-op filter ----------------------------------------------------------------

test("the empty filter matches everyone (chips only ever NARROW)", () => {
  const f = emptyAudienceFilter();
  assert.equal(hasActiveFilter(f), false);
  assert.equal(matchesAudienceFilter(user(), f, NOW), true);
  assert.equal(matchesAudienceFilter(user({ city: "Karachi", age: 70, gender: null, lastActiveAt: null }), f, NOW), true);
});

// ---- single-category filtering ---------------------------------------------------------------

test("City chip narrows to the selected cities (OR within category)", () => {
  const f = { ...emptyAudienceFilter(), cities: ["London", "Milton Keynes"] };
  assert.equal(matchesAudienceFilter(user({ city: "London" }), f, NOW), true);
  assert.equal(matchesAudienceFilter(user({ city: "Milton Keynes" }), f, NOW), true);
  assert.equal(matchesAudienceFilter(user({ city: "Karachi" }), f, NOW), false);
});

test("Age chip narrows to the selected groups; a user with no age fails a non-empty age filter", () => {
  const f = { ...emptyAudienceFilter(), ageGroups: ["25-34", "35-44"] };
  assert.equal(matchesAudienceFilter(user({ age: 30 }), f, NOW), true);
  assert.equal(matchesAudienceFilter(user({ age: 40 }), f, NOW), true);
  assert.equal(matchesAudienceFilter(user({ age: 20 }), f, NOW), false);
  assert.equal(matchesAudienceFilter(user({ age: null }), f, NOW), false);
});

test("Gender chip narrows to the selected genders; unknown / prefer-not-to-say fails", () => {
  const f = { ...emptyAudienceFilter(), genders: ["FEMALE"] };
  assert.equal(matchesAudienceFilter(user({ gender: "FEMALE" }), f, NOW), true);
  assert.equal(matchesAudienceFilter(user({ gender: "MALE" }), f, NOW), false);
  assert.equal(matchesAudienceFilter(user({ gender: "PREFER_NOT_TO_SAY" }), f, NOW), false);
  assert.equal(matchesAudienceFilter(user({ gender: null }), f, NOW), false);
});

test("Active-24h chip narrows to recently-active users", () => {
  const f = { ...emptyAudienceFilter(), activeWithin24h: true };
  assert.equal(matchesAudienceFilter(user({ lastActiveAt: hoursAgo(2) }), f, NOW), true);
  assert.equal(matchesAudienceFilter(user({ lastActiveAt: hoursAgo(48) }), f, NOW), false);
  assert.equal(matchesAudienceFilter(user({ lastActiveAt: null }), f, NOW), false);
});

// ---- combined (AND across categories) --------------------------------------------------------

test("chips combine with AND across categories (the AC example: City=London + Age=25-34)", () => {
  const f = { ...emptyAudienceFilter(), cities: ["London"], ageGroups: ["25-34"] };
  assert.equal(matchesAudienceFilter(user({ city: "London", age: 30 }), f, NOW), true);
  assert.equal(matchesAudienceFilter(user({ city: "London", age: 50 }), f, NOW), false); // wrong age
  assert.equal(matchesAudienceFilter(user({ city: "Karachi", age: 30 }), f, NOW), false); // wrong city
});

test("all four categories combine with AND", () => {
  const f = { cities: ["London"], ageGroups: ["25-34"], genders: ["FEMALE"], activeWithin24h: true };
  assert.equal(matchesAudienceFilter(user({ city: "London", age: 30, gender: "FEMALE", lastActiveAt: hoursAgo(1) }), f, NOW), true);
  assert.equal(matchesAudienceFilter(user({ city: "London", age: 30, gender: "MALE", lastActiveAt: hoursAgo(1) }), f, NOW), false);
  assert.equal(matchesAudienceFilter(user({ city: "London", age: 30, gender: "FEMALE", lastActiveAt: hoursAgo(48) }), f, NOW), false);
});

// ---- applyAudienceFilter over a list ---------------------------------------------------------

test("applyAudienceFilter preserves order and returns matches only", () => {
  const users = [
    user({ id: 1, city: "London", age: 30 }),
    user({ id: 2, city: "Karachi", age: 30 }),
    user({ id: 3, city: "London", age: 60 }),
  ];
  const f = { ...emptyAudienceFilter(), cities: ["London"], ageGroups: ["25-34"] };
  assert.deepEqual(applyAudienceFilter(users, f, NOW).map((u) => u.id), [1]);
});

test("applyAudienceFilter with no chips returns a fresh copy of the whole list (no mutation)", () => {
  const users = [user({ id: 1 }), user({ id: 2 })];
  const out = applyAudienceFilter(users, emptyAudienceFilter(), NOW);
  assert.deepEqual(out.map((u) => u.id), [1, 2]);
  assert.notEqual(out, users); // a fresh array, safe to sort/slice
});

test("applyAudienceFilter tolerates a non-array input", () => {
  assert.deepEqual(applyAudienceFilter(null, emptyAudienceFilter(), NOW), []);
  assert.deepEqual(applyAudienceFilter(undefined, {}, NOW), []);
});

// ---- citiesOf --------------------------------------------------------------------------------

test("citiesOf returns the distinct non-blank cities present, sorted", () => {
  const users = [
    user({ city: "London" }),
    user({ city: "Karachi" }),
    user({ city: "London" }),
    user({ city: "  " }),
    user({ city: null }),
  ];
  assert.deepEqual(citiesOf(users), ["Karachi", "London"]);
});

test("citiesOf tolerates a non-array input", () => {
  assert.deepEqual(citiesOf(null), []);
});
