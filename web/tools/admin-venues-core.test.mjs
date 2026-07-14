// Tests for the admin venue create/edit logic (TM-519). Framework-free — Node's built-in test runner,
// the same harness as event-form.test.mjs, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// These guard the PURE core of the admin venues console (admin-venues-core.js): the field caps
// (mirroring the backend Create/UpdateVenueRequest DTOs), the whole-form validation (mirroring the
// API's Bean Validation + the coordinate-pair cross-field rule), and the draft → API-body builder and
// its inverse. The DOM wiring in admin-venues.js is a thin layer over these.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  NAME_MAX,
  ADDRESS_MAX,
  CITY_MAX,
  URL_MAX,
  NOTES_MAX,
  DETAIL_MAX,
  CAPACITY_MIN,
  LAT_MIN,
  LAT_MAX,
  LNG_MIN,
  LNG_MAX,
  INDOOR_OUTDOOR_OPTIONS,
  validateVenueDraft,
  buildVenuePayload,
  toVenueFormModel,
  venueSummaryLabel,
  venueImageRef,
} from "../src/assets/admin-venues-core.js";

// --- caps mirror the backend DTOs (Create/UpdateVenueRequest) --------------------------------

test("field caps mirror the backend DTOs", () => {
  assert.equal(NAME_MAX, 160);
  assert.equal(ADDRESS_MAX, 500);
  assert.equal(CITY_MAX, 120);
  assert.equal(URL_MAX, 2048);
  assert.equal(NOTES_MAX, 5000);
  assert.equal(DETAIL_MAX, 1000);
  assert.equal(CAPACITY_MIN, 1);
  assert.deepEqual([LAT_MIN, LAT_MAX], [-90, 90]);
  assert.deepEqual([LNG_MIN, LNG_MAX], [-180, 180]);
  assert.deepEqual(INDOOR_OUTDOOR_OPTIONS, ["", "INDOOR", "OUTDOOR", "MIXED"]);
});

// --- validation -------------------------------------------------------------------------------

const validDraft = (over = {}) => ({
  name: "Marhaba Hall",
  addressLine: "12 High Street, London",
  city: "London",
  latitude: "",
  longitude: "",
  mapUrl: "",
  notes: "",
  capacity: "",
  accessibility: "",
  parking: "",
  indoorOutdoor: "",
  ...over,
});

test("validateVenueDraft flags the required fields and blocks save", () => {
  const { errors, canSave } = validateVenueDraft({ name: "", addressLine: "" }, { requireForCreate: true });
  assert.equal(errors.name, "Name is required.");
  assert.equal(errors.addressLine, "Address is required.");
  assert.equal(canSave, false);
});

test("validateVenueDraft accepts a minimal valid venue", () => {
  const { errors, canSave } = validateVenueDraft(validDraft());
  assert.deepEqual(errors, {});
  assert.equal(canSave, true);
});

test("validateVenueDraft rejects half a coordinate pair (both or neither)", () => {
  const latOnly = validateVenueDraft(validDraft({ latitude: "51.5" }));
  assert.ok(latOnly.errors.longitude, "a lone latitude should flag the missing longitude");
  const lngOnly = validateVenueDraft(validDraft({ longitude: "-0.12" }));
  assert.ok(lngOnly.errors.latitude, "a lone longitude should flag the missing latitude");
  const both = validateVenueDraft(validDraft({ latitude: "51.5", longitude: "-0.12" }));
  assert.deepEqual(both.errors, {});
});

test("validateVenueDraft range-checks coordinates and capacity", () => {
  assert.ok(validateVenueDraft(validDraft({ latitude: "120", longitude: "0" })).errors.latitude);
  assert.ok(validateVenueDraft(validDraft({ latitude: "0", longitude: "200" })).errors.longitude);
  assert.ok(validateVenueDraft(validDraft({ capacity: "0" })).errors.capacity);
  assert.ok(validateVenueDraft(validDraft({ capacity: "abc" })).errors.capacity);
});

test("validateVenueDraft rejects an unknown indoor/outdoor value", () => {
  assert.ok(validateVenueDraft(validDraft({ indoorOutdoor: "CAVE" })).errors.indoorOutdoor);
  assert.deepEqual(validateVenueDraft(validDraft({ indoorOutdoor: "MIXED" })).errors, {});
});

// --- payload building -------------------------------------------------------------------------

test("buildVenuePayload includes present fields and omits blank optionals", () => {
  const body = buildVenuePayload(
    validDraft({ latitude: "51.5074", longitude: "-0.1278", capacity: "120", indoorOutdoor: "INDOOR" }),
  );
  assert.equal(body.name, "Marhaba Hall");
  assert.equal(body.addressLine, "12 High Street, London");
  assert.equal(body.city, "London");
  assert.equal(body.latitude, 51.5074);
  assert.equal(body.longitude, -0.1278);
  assert.equal(body.capacity, 120);
  assert.equal(body.indoorOutdoor, "INDOOR");
  // Blank optionals never go on the wire.
  assert.equal("mapUrl" in body, false);
  assert.equal("notes" in body, false);
  assert.equal("accessibility" in body, false);
  assert.equal("parking" in body, false);
});

test("toVenueFormModel ∘ buildVenuePayload round-trips a VenueResponse", () => {
  const venue = {
    id: 7,
    name: "Riverside Pavilion",
    addressLine: "1 Riverside Walk",
    city: "London",
    latitude: 51.5,
    longitude: -0.12,
    mapUrl: null,
    notes: "Meet at the north entrance.",
    capacity: 60,
    accessibility: "Step-free",
    parking: null,
    indoorOutdoor: "MIXED",
    photoPath: "venue-images/7",
    active: true,
  };
  const model = toVenueFormModel(venue);
  assert.equal(model.name, "Riverside Pavilion");
  assert.equal(model.mapUrl, ""); // null → ""
  assert.equal(model.capacity, "60");
  assert.equal(model.latitude, "51.5");
  const body = buildVenuePayload(model);
  assert.equal(body.name, venue.name);
  assert.equal(body.capacity, 60);
  assert.equal(body.latitude, 51.5);
  assert.equal(body.longitude, -0.12);
  assert.equal(body.indoorOutdoor, "MIXED");
});

test("venueSummaryLabel renders 'Name — City' (or just the name)", () => {
  assert.equal(venueSummaryLabel({ name: "Marhaba Hall", city: "London" }), "Marhaba Hall — London");
  assert.equal(venueSummaryLabel({ name: "Marhaba Hall" }), "Marhaba Hall");
  assert.equal(venueSummaryLabel({}), "Untitled venue");
});

// --- venue photo classifier (TM-711, twin of eventImageRef / TM-708) --------------------------

test("venueImageRef → null when there's no photo", () => {
  assert.equal(venueImageRef(null), null);
  assert.equal(venueImageRef(undefined), null);
  assert.equal(venueImageRef(""), null);
  assert.equal(venueImageRef("   "), null);
});

test("venueImageRef classifies a Storage object path as kind 'path' (what uploadVenueImage persists)", () => {
  // This is the bug's core: the admin stores `venue-images/{id}`, so it must be resolved (not used as a
  // src verbatim). Before the render fix nothing consumed photoPath at all.
  assert.deepEqual(venueImageRef("venue-images/7"), { kind: "path", value: "venue-images/7" });
  assert.deepEqual(venueImageRef("  venue-images/7  "), { kind: "path", value: "venue-images/7" });
});

test("venueImageRef classifies an http(s) URL as kind 'url' (legacy / external, used directly)", () => {
  assert.deepEqual(venueImageRef("https://cdn.example.com/v.jpg"), {
    kind: "url",
    value: "https://cdn.example.com/v.jpg",
  });
  assert.deepEqual(venueImageRef("HTTP://x/y.png"), { kind: "url", value: "HTTP://x/y.png" });
});
