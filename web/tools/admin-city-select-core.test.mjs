// Unit tests for the pure admin city-dropdown option core (TM-1174). Framework-free — Node's built-in
// test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// WHY THIS EXISTS: TM-1174 cuts the two ADMIN City dropdowns (event create/edit; admin profile-edit)
// over to the admin-managed catalogue. The DOM/render + catalogue-fetch live in admin-events.js /
// admin.js (both node-un-importable — they pull api.js → the Firebase CDN chain), so the testable seam
// is this pure module: it builds the [value,label] option rows from a PASSED-IN offered list and keeps
// a legacy off-list saved city selectable. These pin the option shape + the off-list allowance.

import assert from "node:assert/strict";
import { test } from "node:test";

import { cityOptionRows, isOffListCity } from "../src/assets/admin-city-select-core.js";

test("cityOptionRows builds [blank, ...offered] from a PASSED-IN catalogue list (TM-1174)", () => {
  // The offered list is the admin-managed catalogue — NOT the hardcoded four. A city that only exists
  // in the catalogue (Marhabaville) must appear as a selectable option.
  const rows = cityOptionRows(["London", "Marhabaville"]);
  assert.deepEqual(rows, [
    ["", "Choose a city…"],
    ["London", "London"],
    ["Marhabaville", "Marhabaville"],
  ]);
});

test("cityOptionRows appends a saved OFF-LIST city so a legacy value stays selectable (TM-877 allowance)", () => {
  // "Dubai" is not in the offered list but is the target's saved city — it must be injected last so an
  // existing profile/event is never silently overwritten on save.
  const rows = cityOptionRows(["London", "Karachi"], "Dubai");
  assert.deepEqual(rows, [
    ["", "Choose a city…"],
    ["London", "London"],
    ["Karachi", "Karachi"],
    ["Dubai", "Dubai"],
  ]);
});

test("cityOptionRows does NOT duplicate a saved city that is already offered", () => {
  const rows = cityOptionRows(["London", "Karachi"], "London");
  assert.deepEqual(rows, [
    ["", "Choose a city…"],
    ["London", "London"],
    ["Karachi", "Karachi"],
  ]);
});

test("cityOptionRows treats a blank/absent saved city as no off-list injection", () => {
  assert.deepEqual(cityOptionRows(["London"], ""), [["", "Choose a city…"], ["London", "London"]]);
  assert.deepEqual(cityOptionRows(["London"], null), [["", "Choose a city…"], ["London", "London"]]);
  assert.deepEqual(cityOptionRows(["London"], "   "), [["", "Choose a city…"], ["London", "London"]]);
});

test("cityOptionRows tolerates an empty/absent offered list (fallback-shaped input)", () => {
  assert.deepEqual(cityOptionRows([]), [["", "Choose a city…"]]);
  assert.deepEqual(cityOptionRows([], "Dubai"), [["", "Choose a city…"], ["Dubai", "Dubai"]]);
  assert.deepEqual(cityOptionRows(undefined), [["", "Choose a city…"]]);
});

test("isOffListCity is true only for a non-blank city absent from the offered list (TM-1174)", () => {
  assert.equal(isOffListCity("Dubai", ["London", "Karachi"]), true); // not offered → off-list
  assert.equal(isOffListCity("London", ["London", "Karachi"]), false); // offered → on-list
  assert.equal(isOffListCity("", ["London"]), false); // blank = "no city", never off-list
  assert.equal(isOffListCity(null, ["London"]), false);
  assert.equal(isOffListCity("  London  ", ["London"]), false); // trimmed before the check
  assert.equal(isOffListCity("Dubai", []), true); // empty offered list → any non-blank is off-list
  assert.equal(isOffListCity("Dubai", undefined), true); // tolerate an absent list
});
