// Tests for the admin city create/edit logic (TM-1166). Framework-free — Node's built-in test runner,
// the same harness as admin-venues-core.test.mjs, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// These guard the PURE core of the admin cities console (admin-cities-core.js): the field caps
// (mirroring the backend Create/UpdateCityRequest DTOs), the whole-form validation (mirroring the
// API's Bean Validation + the coordinate-pair completeness rule the console enforces), the draft →
// API-body builder and its inverse, and the image-path classifier. The DOM wiring in admin-cities.js
// is a thin layer over these.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  NAME_MAX,
  COUNTRY_MAX,
  ICON_EMOJI_MAX,
  IMAGE_PATH_MAX,
  SORT_WEIGHT_MIN,
  SORT_WEIGHT_MAX,
  LAT_MIN,
  LAT_MAX,
  LNG_MIN,
  LNG_MAX,
  validateCityDraft,
  buildCityPayload,
  toCityFormModel,
  citySummaryLabel,
  cityImageRef,
} from "../src/assets/admin-cities-core.js";

// --- caps mirror the backend DTOs (Create/UpdateCityRequest) ---------------------------------

test("field caps mirror the backend DTOs / columns", () => {
  assert.equal(NAME_MAX, 120);
  assert.equal(COUNTRY_MAX, 80);
  assert.equal(ICON_EMOJI_MAX, 16);
  assert.equal(IMAGE_PATH_MAX, 500);
  assert.deepEqual([SORT_WEIGHT_MIN, SORT_WEIGHT_MAX], [0, 1000]);
  assert.deepEqual([LAT_MIN, LAT_MAX], [-90, 90]);
  assert.deepEqual([LNG_MIN, LNG_MAX], [-180, 180]);
});

// --- validation -------------------------------------------------------------------------------

test("a complete draft is valid", () => {
  const { errors, canSave } = validateCityDraft({
    name: "London",
    country: "United Kingdom",
    iconEmoji: "🇬🇧",
    geoLat: "51.5074",
    geoLng: "-0.1278",
    sortWeight: "40",
  });
  assert.deepEqual(errors, {});
  assert.equal(canSave, true);
});

test("name + country are required on create, present-but-blank rejected on edit", () => {
  const create = validateCityDraft({ name: "", country: "" }, { requireForCreate: true });
  assert.equal(create.errors.name, "Name is required.");
  assert.equal(create.errors.country, "Country is required.");
  assert.equal(create.canSave, false);

  const edit = validateCityDraft({ name: "  ", country: "  " }, { requireForCreate: false });
  assert.equal(edit.errors.name, "Name can't be blank.");
  assert.equal(edit.errors.country, "Country can't be blank.");
});

test("name/country/emoji length caps are enforced", () => {
  assert.match(validateCityDraft({ name: "x".repeat(NAME_MAX + 1), country: "UK" }).errors.name, /120 characters/);
  assert.match(
    validateCityDraft({ name: "London", country: "y".repeat(COUNTRY_MAX + 1) }).errors.country,
    /80 characters/,
  );
  assert.match(
    validateCityDraft({ name: "London", country: "UK", iconEmoji: "z".repeat(ICON_EMOJI_MAX + 1) }).errors.iconEmoji,
    /16 characters/,
  );
});

test("geo must be in WGS-84 range and a coordinate pair must be complete (both or neither)", () => {
  // out of range
  assert.match(validateCityDraft({ name: "A", country: "B", geoLat: "120", geoLng: "0" }).errors.geoLat, /between -90 and 90/);
  assert.match(validateCityDraft({ name: "A", country: "B", geoLat: "0", geoLng: "200" }).errors.geoLng, /between -180 and 180/);
  // non-numeric
  assert.match(validateCityDraft({ name: "A", country: "B", geoLat: "abc", geoLng: "0" }).errors.geoLat, /Enter a number/);
  // half a pair: lat only → flag the missing lng
  assert.match(validateCityDraft({ name: "A", country: "B", geoLat: "51.5" }).errors.geoLng, /Add a longitude/);
  // half a pair: lng only → flag the missing lat
  assert.match(validateCityDraft({ name: "A", country: "B", geoLng: "-0.1" }).errors.geoLat, /Add a latitude/);
  // neither → fine
  assert.deepEqual(validateCityDraft({ name: "A", country: "B" }).errors, {});
});

test("sort weight is an optional integer in [0, 1000]", () => {
  assert.match(validateCityDraft({ name: "A", country: "B", sortWeight: "1.5" }).errors.sortWeight, /whole number/);
  assert.match(validateCityDraft({ name: "A", country: "B", sortWeight: "-1" }).errors.sortWeight, /between 0 and 1000/);
  assert.match(validateCityDraft({ name: "A", country: "B", sortWeight: "1001" }).errors.sortWeight, /between 0 and 1000/);
  assert.deepEqual(validateCityDraft({ name: "A", country: "B", sortWeight: "" }).errors, {}); // blank OK
});

// --- payload building -------------------------------------------------------------------------

test("payload carries required text + always sends the (trimmed) emoji, omitting blank geo/weight", () => {
  const body = buildCityPayload({ name: "  London  ", country: " UK ", iconEmoji: " 🇬🇧 ", geoLat: "", geoLng: "", sortWeight: "" });
  assert.deepEqual(body, { name: "London", country: "UK", iconEmoji: "🇬🇧" });
  // A blank emoji is still SENT as "" (so the server clears it), and geo/weight are omitted when blank.
  assert.equal("iconEmoji" in buildCityPayload({ name: "A", country: "B", iconEmoji: "" }), true);
  assert.equal(buildCityPayload({ name: "A", country: "B", iconEmoji: "" }).iconEmoji, "");
});

test("payload includes valid geo + sort weight when present, and never the image paths", () => {
  const body = buildCityPayload({ name: "A", country: "B", geoLat: "51.5", geoLng: "-0.1", sortWeight: "40" });
  assert.equal(body.geoLat, 51.5);
  assert.equal(body.geoLng, -0.1);
  assert.equal(body.sortWeight, 40);
  // Images ride a follow-up PATCH once the id exists — NEVER built into the create/edit body here.
  assert.equal("imagePath" in body, false);
  assert.equal("iconImagePath" in body, false);
});

// --- form model (edit prefill) ----------------------------------------------------------------

test("toCityFormModel maps an AdminCityResponse to the form draft, carrying both image paths", () => {
  const model = toCityFormModel({
    name: "London",
    country: "United Kingdom",
    iconEmoji: "🇬🇧",
    geoLat: 51.5074,
    geoLng: -0.1278,
    sortWeight: 40,
    imagePath: "city-images/1",
    iconImagePath: "city-icon-images/1",
  });
  assert.deepEqual(model, {
    name: "London",
    country: "United Kingdom",
    iconEmoji: "🇬🇧",
    geoLat: "51.5074",
    geoLng: "-0.1278",
    sortWeight: "40",
    imagePath: "city-images/1",
    iconImagePath: "city-icon-images/1",
  });
});

test("toCityFormModel blanks absent optionals", () => {
  const model = toCityFormModel({ name: "Bare", country: "Nowhere" });
  assert.equal(model.iconEmoji, "");
  assert.equal(model.geoLat, "");
  assert.equal(model.geoLng, "");
  assert.equal(model.imagePath, "");
  assert.equal(model.iconImagePath, "");
});

// --- display helpers --------------------------------------------------------------------------

test("citySummaryLabel joins name and country", () => {
  assert.equal(citySummaryLabel({ name: "London", country: "UK" }), "London — UK");
  assert.equal(citySummaryLabel({ name: "London" }), "London");
  assert.equal(citySummaryLabel({}), "Untitled city");
});

test("cityImageRef classifies a stored path as url vs Storage object path", () => {
  assert.equal(cityImageRef(""), null);
  assert.equal(cityImageRef(null), null);
  assert.deepEqual(cityImageRef("city-icon-images/7"), { kind: "path", value: "city-icon-images/7" });
  assert.deepEqual(cityImageRef("https://example.com/x.png"), { kind: "url", value: "https://example.com/x.png" });
});
