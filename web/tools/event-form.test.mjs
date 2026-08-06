// Tests for the admin event create/edit logic (TM-395). Framework-free — Node's built-in test
// runner, the same harness as broadcast.test.mjs / account-badges.test.mjs, picked up by the CI glob
// `node --test web/tools/*.test.mjs`.
//
// These guard the PURE core of the admin events console (event-form.js): the field caps (mirroring
// the backend DTOs), the DST-correct UTC ⇄ local-wall-clock conversion the datetime inputs rest on,
// the whole-form validation (mirroring the API's Bean Validation + cross-field rules + the TM-415
// age band), the draft → API-body builder and its inverse, and the small list/form display
// derivations. The DOM wiring in admin-events.js is a thin layer over these, so testing them here
// tests the behaviour that matters without a browser / the Firebase SDK.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  shiftEndPreservingDuration,
  basicsSummary,
  whenSummary,
  whereSummary,
  HEADING_MAX,
  DESCRIPTION_MAX,
  LOCATION_MAX,
  URL_MAX,
  CITY_MAX,
  CAPACITY_MIN,
  OPENING_MESSAGE_MAX,
  REVEAL_HOURS_MIN,
  REVEAL_HOURS_MAX,
  BOOKING_CUTOFF_HOURS_MIN,
  BOOKING_CUTOFF_HOURS_MAX,
  BOOKING_CUTOFF_DEFAULT_HOURS,
  AGE_MIN_BOUND,
  AGE_MAX_BOUND,
  CATEGORY_CHIPS,
  isValidTimeZone,
  guessTimeZone,
  zonedToUtcIso,
  utcIsoToZoned,
  validateEventDraft,
  buildEventPayload,
  clearedOptionalFields,
  CLEARABLE_OPTIONAL_FIELDS,
  toFormModel,
  eventLifecycle,
  capacityLabel,
  attendanceCounts,
  revealSummary,
  bookingCutoffSummary,
  effectiveBookingCutoffHours,
  formatEventWhen,
  isPastEvent,
  partitionEventsByPast,
  matchesStatusFilter,
  LIFECYCLE_FILTERS,
  matchesLifecycleFilter,
  EVENT_FORMAT_INPERSON,
  EVENT_FORMAT_ONLINE,
  ONLINE_LOCATION_TEXT,
  formatFromEvent,
  mapUrlPreviewState,
  startNow,
  startChips,
  endChips,
  visibleFromChips,
  visibleUntilChips,
  revealHourChips,
  shiftZonedLocal,
  AGE_DEFAULT_MIN,
  AGE_DEFAULT_MAX,
  AGE_BAND_CUSTOM,
  AGE_BAND_PRESETS,
  OPENING_MESSAGE_TEMPLATES,
  DESCRIPTION_TEMPLATES,
  blankFormModel,
  isDirtyDraft,
  DIRTY_COMPARE_FIELDS,
  CLONE_OFFSET_PRESETS,
  shiftDraftTimes,
  buildCloneDraft,
  pastStartWarning,
  ageBandToMinMax,
  minMaxToAgeBand,
  deriveVenueTimezone,
  PRICE_CHIP_CUSTOM,
  PRICE_CHIP_PRESETS,
  PRICE_DEFAULT_CHIP,
  priceChipToPence,
  penceToPriceChip,
  penceToPounds,
  poundsToPence,
  SERIES_FREQ_DAILY,
  SERIES_FREQ_WEEKLY,
  SERIES_FREQUENCIES,
  SERIES_WEEKDAYS,
  SERIES_END_UNTIL,
  SERIES_END_AFTER,
  SERIES_INTERVAL_MIN,
  weekdayOfLocal,
  validateSeriesDraft,
  buildSeriesPayload,
  SERIES_NON_TEMPLATE_KEYS,
  whoCanJoinSummary,
  bookingRulesSummary,
} from "../src/assets/event-form.js";

// --- caps mirror the backend DTOs (Create/UpdateEventRequest) --------------------------------

test("field caps mirror the backend DTOs", () => {
  assert.equal(HEADING_MAX, 120);
  assert.equal(DESCRIPTION_MAX, 5000);
  assert.equal(LOCATION_MAX, 500);
  assert.equal(URL_MAX, 2048);
  assert.equal(CITY_MAX, 120);
  assert.equal(CAPACITY_MIN, 1);
  assert.equal(REVEAL_HOURS_MIN, 1);
  assert.equal(REVEAL_HOURS_MAX, 8760);
});

test("the Coffee & X chips are the configured suggestion list", () => {
  assert.deepEqual(CATEGORY_CHIPS, ["Coffee & Code", "Coffee & Feed", "Coffee & Walk"]);
  // Frozen so no consumer can mutate the single source.
  assert.throws(() => CATEGORY_CHIPS.push("Coffee & Chaos"), TypeError);
});

// --- IANA timezone helpers -------------------------------------------------------------------

test("isValidTimeZone accepts real IANA ids and rejects junk/blank", () => {
  assert.equal(isValidTimeZone("Europe/London"), true);
  assert.equal(isValidTimeZone("America/New_York"), true);
  assert.equal(isValidTimeZone("UTC"), true);
  assert.equal(isValidTimeZone("Not/AZone"), false);
  assert.equal(isValidTimeZone(""), false);
  assert.equal(isValidTimeZone(null), false);
});

test("guessTimeZone returns a usable IANA id (or blank), never throws", () => {
  const tz = guessTimeZone();
  assert.equal(typeof tz, "string");
  if (tz) assert.equal(isValidTimeZone(tz), true);
});

// --- venue-derived timezone precedence (TM-1066) ---------------------------------------------
// The event's timezone is DERIVED from the picked venue (admin-events.js venue onSelect), EXCEPT once
// the admin has hand-edited the field. deriveVenueTimezone is the pure precedence rule; the DOM shell
// (which can't be imported in Node — a transitive Firebase https: import) is a thin layer over it.

test("deriveVenueTimezone: a venue WITH a zone sets it when the admin hasn't edited (TM-1066)", () => {
  // The core derive path: venue carries a valid IANA zone, no manual edit → return it to overwrite with.
  assert.equal(deriveVenueTimezone({ timezone: "Europe/London" }, false), "Europe/London");
  assert.equal(deriveVenueTimezone({ timezone: "America/New_York" }, false), "America/New_York");
});

test("deriveVenueTimezone: a MANUAL edit is not clobbered by a later re-pick (TM-1066 locked precedence)", () => {
  // The locked rule: once the admin edits the timezone, a subsequent venue pick must leave it alone —
  // deriveVenueTimezone returns null (= "keep the current value") regardless of the venue's zone.
  assert.equal(deriveVenueTimezone({ timezone: "Europe/London" }, true), null);
  assert.equal(deriveVenueTimezone({ timezone: "America/New_York" }, true), null);
});

test("deriveVenueTimezone: a venue WITHOUT a zone leaves the current value alone (no crash/blank) (TM-1066)", () => {
  // AC: picking a venue that carries no timezone must not blank the field. null = leave-alone.
  assert.equal(deriveVenueTimezone({ timezone: "" }, false), null);
  assert.equal(deriveVenueTimezone({ timezone: "   " }, false), null);
  assert.equal(deriveVenueTimezone({ timezone: null }, false), null);
  assert.equal(deriveVenueTimezone({}, false), null);
  // Read defensively — a null/undefined venue (the one-off / blank option) never crashes.
  assert.equal(deriveVenueTimezone(null, false), null);
  assert.equal(deriveVenueTimezone(undefined, false), null);
});

test("deriveVenueTimezone: a venue's INVALID zone is ignored, not applied (TM-1066)", () => {
  // A junk zone would fail isValidTimeZone / ensureZoneOption downstream — never set it.
  assert.equal(deriveVenueTimezone({ timezone: "Not/AZone" }, false), null);
});

// --- UTC ⇄ zoned wall-clock (DST-correct) -----------------------------------------------------

test("zonedToUtcIso applies the zone offset, DST-aware", () => {
  // London in July is BST (UTC+1): 18:30 local → 17:30 UTC.
  assert.equal(zonedToUtcIso("2026-07-10T18:30", "Europe/London"), "2026-07-10T17:30:00.000Z");
  // London in January is GMT (UTC+0): 18:30 local → 18:30 UTC.
  assert.equal(zonedToUtcIso("2026-01-10T18:30", "Europe/London"), "2026-01-10T18:30:00.000Z");
  // New York in July is EDT (UTC-4): 18:30 local → 22:30 UTC.
  assert.equal(zonedToUtcIso("2026-07-10T18:30", "America/New_York"), "2026-07-10T22:30:00.000Z");
});

test("zonedToUtcIso rejects bad input / bad zone", () => {
  assert.equal(zonedToUtcIso("", "Europe/London"), null);
  assert.equal(zonedToUtcIso("not-a-date", "Europe/London"), null);
  assert.equal(zonedToUtcIso("2026-07-10T18:30", "Not/AZone"), null);
});

test("utcIsoToZoned renders a UTC instant into the event's local wall clock", () => {
  assert.equal(utcIsoToZoned("2026-07-10T17:30:00.000Z", "Europe/London"), "2026-07-10T18:30");
  assert.equal(utcIsoToZoned("2026-01-10T18:30:00.000Z", "Europe/London"), "2026-01-10T18:30");
  assert.equal(utcIsoToZoned("2026-07-10T22:30:00.000Z", "America/New_York"), "2026-07-10T18:30");
  assert.equal(utcIsoToZoned("", "Europe/London"), "");
  // A missing instant is blank, NOT the epoch. `new Date(null)` is 1970-01-01 (getTime() === 0, not
  // NaN), so without an explicit null guard an open-ended event's null endAt would render as
  // "1970-01-01…" and block its own edit (TM-429). null and undefined must both come back "".
  assert.equal(utcIsoToZoned(null, "Europe/London"), "");
  assert.equal(utcIsoToZoned(undefined, "Europe/London"), "");
});

test("zonedToUtcIso ∘ utcIsoToZoned round-trips a local value", () => {
  for (const [local, tz] of [
    ["2026-07-10T18:30", "Europe/London"],
    ["2026-12-24T09:05", "Europe/London"],
    ["2026-03-15T23:45", "America/New_York"],
  ]) {
    assert.equal(utcIsoToZoned(zonedToUtcIso(local, tz), tz), local);
  }
});

// --- validateEventDraft: the Save-gate --------------------------------------------------------

/** A minimal draft that passes every rule — each test mutates one field to prove it flips a gate. */
function validDraft(over = {}) {
  return {
    heading: "Coffee & Code",
    description: "Bring a laptop and a mug.",
    locationText: "Marhaba Cafe, 12 High St",
    mapUrl: "",
    onlineUrl: "",
    city: "London",
    timezone: "Europe/London",
    startAt: "2026-07-10T18:00",
    endAt: "2026-07-10T20:00",
    visibilityStart: "2026-07-01T09:00",
    visibilityEnd: "2026-07-10T18:00",
    capacity: "20",
    locationRevealHours: "24",
    ageMin: "",
    ageMax: "",
    ...over,
  };
}

test("a complete, well-formed draft can save with no errors", () => {
  const { errors, canSave } = validateEventDraft(validDraft());
  assert.equal(canSave, true);
  assert.deepEqual(errors, {});
});

test("required fields are flagged on create and block save", () => {
  const { errors, canSave } = validateEventDraft(
    { heading: "", description: "", locationText: "", timezone: "", startAt: "", visibilityStart: "", visibilityEnd: "" },
    { requireForCreate: true },
  );
  assert.equal(canSave, false);
  for (const key of ["heading", "description", "locationText", "timezone", "startAt", "visibilityStart", "visibilityEnd"]) {
    assert.match(errors[key], /required/i, `${key} should be required`);
  }
});

test("edit mode (requireForCreate:false) doesn't demand a value but still caps length", () => {
  const { canSave } = validateEventDraft({ heading: "", description: "", locationText: "" }, { requireForCreate: false });
  assert.equal(canSave, true);
  const tooLong = validateEventDraft({ heading: "x".repeat(HEADING_MAX + 1) }, { requireForCreate: false });
  assert.match(tooLong.errors.heading, /120 characters or fewer/);
});

test("over-length fields are rejected with the API's caps", () => {
  const { errors } = validateEventDraft(
    validDraft({
      heading: "x".repeat(HEADING_MAX + 1),
      locationText: "y".repeat(LOCATION_MAX + 1),
      mapUrl: "https://example.com/" + "a".repeat(URL_MAX),
      city: "z".repeat(CITY_MAX + 1),
    }),
  );
  assert.match(errors.heading, /120/);
  assert.match(errors.locationText, /500/);
  assert.match(errors.mapUrl, /2048/);
  assert.match(errors.city, /120/);
});

test("an invalid IANA timezone is rejected", () => {
  const { errors } = validateEventDraft(validDraft({ timezone: "Mars/Olympus" }));
  assert.match(errors.timezone, /valid IANA/i);
});

test("the visibility window must be ordered", () => {
  const { errors } = validateEventDraft(
    validDraft({ visibilityStart: "2026-07-10T18:00", visibilityEnd: "2026-07-01T09:00" }),
  );
  assert.match(errors.visibilityEnd, /after visibility start/i);
});

test("end must be after start when an end is given", () => {
  const bad = validateEventDraft(validDraft({ startAt: "2026-07-10T20:00", endAt: "2026-07-10T18:00" }));
  assert.match(bad.errors.endAt, /after the start/i);
  // Open-ended (no end) is fine.
  assert.equal(validateEventDraft(validDraft({ endAt: "" })).canSave, true);
});

test("capacity is an optional integer ≥ 1 (blank = unlimited)", () => {
  assert.equal(validateEventDraft(validDraft({ capacity: "" })).canSave, true);
  assert.match(validateEventDraft(validDraft({ capacity: "0" })).errors.capacity, /1 or more/);
  assert.match(validateEventDraft(validDraft({ capacity: "3.5" })).errors.capacity, /whole number/i);
});

test("location-reveal hours are bounded 1..8760 when set", () => {
  assert.equal(validateEventDraft(validDraft({ locationRevealHours: "" })).canSave, true);
  assert.match(validateEventDraft(validDraft({ locationRevealHours: "0" })).errors.locationRevealHours, /between 1 and 8760/);
  assert.match(validateEventDraft(validDraft({ locationRevealHours: "9000" })).errors.locationRevealHours, /between 1 and 8760/);
});

// --- booking cutoff (stop-accepting-RSVPs) validation (TM-413 exposed by TM-1157) -------------

test("booking cutoff: blank is valid (inherit); 0 is valid (accept up to start) (TM-1157)", () => {
  assert.equal(validateEventDraft(validDraft({ bookingCutoffHours: "" })).canSave, true);
  // 0 is a REAL value here (unlike location-reveal which is @Min(1)) — must NOT error.
  assert.equal(validateEventDraft(validDraft({ bookingCutoffHours: "0" })).canSave, true);
  assert.equal(validateEventDraft(validDraft({ bookingCutoffHours: "0" })).errors.bookingCutoffHours, undefined);
  assert.equal(validateEventDraft(validDraft({ bookingCutoffHours: "48" })).canSave, true);
});

test("booking cutoff: rejects a negative, an over-max, and a non-integer (TM-1157)", () => {
  assert.match(validateEventDraft(validDraft({ bookingCutoffHours: "-1" })).errors.bookingCutoffHours, /between 0 and 8760/);
  assert.match(validateEventDraft(validDraft({ bookingCutoffHours: "9000" })).errors.bookingCutoffHours, /between 0 and 8760/);
  assert.match(validateEventDraft(validDraft({ bookingCutoffHours: "2.5" })).errors.bookingCutoffHours, /whole number/i);
});

test("booking-cutoff bounds mirror the backend @Min(0)/@Max(8760) (TM-413/TM-1157)", () => {
  assert.equal(BOOKING_CUTOFF_HOURS_MIN, 0);
  assert.equal(BOOKING_CUTOFF_HOURS_MAX, 8760);
  assert.equal(BOOKING_CUTOFF_DEFAULT_HOURS, 1);
});

test("age band: both blank = all ages; min ≤ max enforced when both set (TM-415)", () => {
  assert.equal(validateEventDraft(validDraft({ ageMin: "", ageMax: "" })).canSave, true);
  // One side only is allowed (an open-ended band).
  assert.equal(validateEventDraft(validDraft({ ageMin: "21", ageMax: "" })).canSave, true);
  assert.equal(validateEventDraft(validDraft({ ageMin: "", ageMax: "40" })).canSave, true);
  // min ≤ max: equal is fine, min > max is the error.
  assert.equal(validateEventDraft(validDraft({ ageMin: "30", ageMax: "30" })).canSave, true);
  assert.match(validateEventDraft(validDraft({ ageMin: "40", ageMax: "25" })).errors.ageMax, /at least the minimum/i);
  // Out-of-range bounds.
  assert.match(validateEventDraft(validDraft({ ageMin: String(AGE_MIN_BOUND - 1) })).errors.ageMin, /between/);
  assert.match(validateEventDraft(validDraft({ ageMax: String(AGE_MAX_BOUND + 1) })).errors.ageMax, /between/);
});

// --- buildEventPayload: draft → API body ------------------------------------------------------

test("buildEventPayload converts instants to UTC and includes the required fields", () => {
  const body = buildEventPayload(validDraft());
  assert.equal(body.heading, "Coffee & Code");
  assert.equal(body.description, "Bring a laptop and a mug.");
  assert.equal(body.locationText, "Marhaba Cafe, 12 High St");
  assert.equal(body.timezone, "Europe/London");
  assert.equal(body.city, "London");
  assert.equal(body.startAt, "2026-07-10T17:00:00.000Z"); // BST → -1h
  assert.equal(body.endAt, "2026-07-10T19:00:00.000Z");
  assert.equal(body.visibilityStart, "2026-07-01T08:00:00.000Z");
  assert.equal(body.visibilityEnd, "2026-07-10T17:00:00.000Z");
  assert.equal(body.capacity, 20);
  assert.equal(body.locationRevealHours, 24);
});

test("buildEventPayload omits blank optionals (no empty strings on the wire)", () => {
  const body = buildEventPayload(validDraft({ mapUrl: "", onlineUrl: "", endAt: "", capacity: "", city: "" }));
  assert.equal("mapUrl" in body, false);
  assert.equal("onlineUrl" in body, false);
  assert.equal("endAt" in body, false);
  assert.equal("capacity" in body, false);
  assert.equal("city" in body, false);
});

test("buildEventPayload sends age band as camelCase ageMin/ageMax, omitted when blank (TM-415)", () => {
  const withAges = buildEventPayload(validDraft({ ageMin: "21", ageMax: "35" }));
  assert.equal(withAges.ageMin, 21);
  assert.equal(withAges.ageMax, 35);
  const noAges = buildEventPayload(validDraft({ ageMin: "", ageMax: "" }));
  assert.equal("ageMin" in noAges, false);
  assert.equal("ageMax" in noAges, false);
});

test("buildEventPayload carries the venueId reference and omits it when unset (TM-519)", () => {
  const withVenue = buildEventPayload(validDraft({ venueId: "7" }));
  assert.equal(withVenue.venueId, 7); // sent as an integer id
  const noVenue = buildEventPayload(validDraft({ venueId: "" }));
  assert.equal("venueId" in noVenue, false); // a one-off location omits it (back-compat)
});

test("buildEventPayload sends bookingCutoffHours override, OMITS when blank (null=inherit), keeps 0 (TM-1157)", () => {
  // An explicit override is sent verbatim.
  assert.equal(buildEventPayload(validDraft({ bookingCutoffHours: "48" })).bookingCutoffHours, 48);
  // Blank = inherit → OMITTED entirely (so it's null/absent on the wire, NOT 0).
  const blank = buildEventPayload(validDraft({ bookingCutoffHours: "" }));
  assert.equal("bookingCutoffHours" in blank, false);
  // 0 is a REAL value (accept right up to start) — sent verbatim, never confused with blank/inherit.
  const zero = buildEventPayload(validDraft({ bookingCutoffHours: "0" }));
  assert.equal(zero.bookingCutoffHours, 0);
  assert.equal("bookingCutoffHours" in zero, true);
});

test("toFormModel prefills the RAW bookingCutoffHours override, null-safe (inherit → BLANK, not 0) (TM-1157)", () => {
  // An event with an explicit override → the raw value as a string.
  assert.equal(toFormModel({ bookingCutoffHours: 48 }).bookingCutoffHours, "48");
  // An explicit 0 override round-trips as "0" (not blank).
  assert.equal(toFormModel({ bookingCutoffHours: 0 }).bookingCutoffHours, "0");
  // An INHERITING event (override null) shows BLANK — NOT 0, and NOT the effective 1 — even when the
  // response carries a resolved effective value. This is the null-safe prefill AC.
  assert.equal(toFormModel({ bookingCutoffHours: null, effectiveBookingCutoffHours: 1 }).bookingCutoffHours, "");
  assert.equal(toFormModel({ effectiveBookingCutoffHours: 24 }).bookingCutoffHours, ""); // absent override
  assert.equal(toFormModel({}).bookingCutoffHours, "");
});

test("effectiveBookingCutoffHours resolves the placeholder value, defaulting to the app default (TM-1157)", () => {
  assert.equal(effectiveBookingCutoffHours({ effectiveBookingCutoffHours: 24 }), 24);
  assert.equal(effectiveBookingCutoffHours({ effectiveBookingCutoffHours: 0 }), 0); // 0 is a real effective value
  // No resolved value (create / legacy response) → the app default (1).
  assert.equal(effectiveBookingCutoffHours({}), BOOKING_CUTOFF_DEFAULT_HOURS);
  assert.equal(effectiveBookingCutoffHours(), BOOKING_CUTOFF_DEFAULT_HOURS);
  // A garbage / negative value never leaks through as the placeholder → falls back to the default.
  assert.equal(effectiveBookingCutoffHours({ effectiveBookingCutoffHours: -5 }), BOOKING_CUTOFF_DEFAULT_HOURS);
});

test("bookingCutoffSummary reports the effective window + its source, 0 reads as 'up to the start' (TM-1157)", () => {
  assert.match(
    bookingCutoffSummary({ effectiveBookingCutoffHours: 24, bookingCutoffHours: null }),
    /RSVPs stop 24 hours before the start.*city \/ app default/,
  );
  assert.match(
    bookingCutoffSummary({ effectiveBookingCutoffHours: 1, bookingCutoffHours: 1 }),
    /RSVPs stop 1 hour before the start.*this event's override/,
  );
  assert.match(
    bookingCutoffSummary({ effectiveBookingCutoffHours: 0, bookingCutoffHours: 0 }),
    /right up to the start.*this event's override/,
  );
  assert.equal(bookingCutoffSummary({}), ""); // no resolved value → no summary
});

// --- clearedOptionalFields: the silent-no-op guard on edit (TM-734) ---------------------------

test("clearedOptionalFields flags an optional the admin blanked that the PATCH can't clear (TM-734)", () => {
  // The event carried a mapUrl + a capacity; the admin blanked both in the edit draft. buildEventPayload
  // OMITS blanks, and the server reads absent as "leave unchanged", so those clears silently no-op.
  const original = {
    heading: "Coffee & Code",
    description: "Bring a laptop.",
    locationText: "Marhaba Cafe",
    timezone: "Europe/London",
    startAt: "2026-07-10T17:00:00.000Z",
    visibilityStart: "2026-07-01T08:00:00.000Z",
    visibilityEnd: "2026-07-10T17:00:00.000Z",
    mapUrl: "https://maps.example/abc",
    capacity: 20,
    city: "London",
  };
  const draft = validDraft({ mapUrl: "", capacity: "", city: "London" });
  const cleared = clearedOptionalFields(original, draft);
  assert.deepEqual(new Set(cleared), new Set(["mapUrl", "capacity"]));
  // A field left unchanged (city stayed "London") is NOT reported.
  assert.equal(cleared.includes("city"), false);
});

test("clearedOptionalFields returns [] when nothing was actually cleared (TM-734)", () => {
  const original = { mapUrl: "https://maps.example/abc", capacity: 20, timezone: "Europe/London" };
  // Draft keeps the same values → the payload carries them → nothing silently dropped.
  const draft = validDraft({ mapUrl: "https://maps.example/abc", capacity: "20" });
  assert.deepEqual(clearedOptionalFields(original, draft), []);
});

test("clearedOptionalFields returns [] on create (no original to compare) (TM-734)", () => {
  assert.deepEqual(clearedOptionalFields(null, validDraft({ mapUrl: "" })), []);
  assert.deepEqual(clearedOptionalFields(undefined, validDraft({ capacity: "" })), []);
});

test("clearedOptionalFields ignores blanking an already-empty optional (TM-734)", () => {
  // The event never had a mapUrl; blanking a blank isn't a lost clear.
  const original = { timezone: "Europe/London", capacity: 20 };
  const cleared = clearedOptionalFields(original, validDraft({ mapUrl: "", capacity: "20" }));
  assert.equal(cleared.includes("mapUrl"), false);
});

test("CLEARABLE_OPTIONAL_FIELDS excludes required fields that validation blocks blanking (TM-734)", () => {
  for (const req of ["heading", "description", "locationText", "timezone", "startAt", "visibilityStart"]) {
    assert.equal(CLEARABLE_OPTIONAL_FIELDS.includes(req), false, `${req} must not be treated as clearable`);
  }
});

test("toFormModel reads venueId back for the edit prefill (TM-519)", () => {
  assert.equal(toFormModel({ venueId: 7 }).venueId, "7");
  assert.equal(toFormModel({}).venueId, ""); // no reference → blank
});

test("toFormModel ∘ buildEventPayload round-trips an EventResponse's instants", () => {
  const event = {
    heading: "Coffee & Walk",
    description: "Meet by the fountain.",
    locationText: "Hyde Park corner",
    mapUrl: null,
    onlineUrl: null,
    city: "London",
    timezone: "Europe/London",
    startAt: "2026-07-10T17:00:00.000Z",
    endAt: "2026-07-10T19:00:00.000Z",
    visibilityStart: "2026-07-01T08:00:00.000Z",
    visibilityEnd: "2026-07-10T17:00:00.000Z",
    capacity: 12,
    locationRevealHours: 24,
  };
  const model = toFormModel(event);
  assert.equal(model.startAt, "2026-07-10T18:00"); // rendered back into BST local
  assert.equal(model.mapUrl, ""); // null → ""
  assert.equal(model.capacity, "12");
  const body = buildEventPayload(model);
  assert.equal(body.startAt, event.startAt);
  assert.equal(body.endAt, event.endAt);
  assert.equal(body.visibilityStart, event.visibilityStart);
  assert.equal(body.capacity, 12);
});

test("an open-ended event (null endAt) prefills blank and stays editable (TM-429)", () => {
  const event = {
    heading: "Coffee & Code",
    description: "Bring your laptop.",
    locationText: "The corner cafe",
    city: "London",
    timezone: "Europe/London",
    startAt: "2026-07-10T17:30:00.000Z",
    endAt: null, // open-ended: the event never had an end time
    visibilityStart: "2026-07-01T09:00:00.000Z",
    visibilityEnd: "2026-07-10T12:00:00.000Z",
    capacity: 10,
  };
  const model = toFormModel(event);
  // The End field must be BLANK, not 1970 — else it poisons the form.
  assert.equal(model.endAt, "");
  // The edit draft must be saveable (endAt no longer fails "end after start").
  const { errors, canSave } = validateEventDraft(model, { requireForCreate: false });
  assert.equal(errors.endAt, undefined);
  assert.equal(canSave, true);
  // And the PATCH body must OMIT endAt (leave-unchanged), not send a bogus 1970 instant.
  const body = buildEventPayload(model);
  assert.equal("endAt" in body, false);
  assert.equal(body.startAt, event.startAt);
});

// --- display derivations ----------------------------------------------------------------------

test("eventLifecycle derives the admin status pill from status + window + now", () => {
  const base = {
    status: "PUBLISHED",
    startAt: "2026-07-10T18:00:00.000Z",
    endAt: "2026-07-10T20:00:00.000Z",
    visibilityStart: "2026-07-01T09:00:00.000Z",
    visibilityEnd: "2026-07-10T18:00:00.000Z",
  };
  // Cancelled wins regardless of the window.
  assert.deepEqual(eventLifecycle({ ...base, status: "CANCELLED" }, "2026-07-05T00:00:00Z"), {
    label: "Cancelled",
    tone: "off",
  });
  // Before the visibility window opens → Hidden.
  assert.equal(eventLifecycle(base, "2026-06-20T00:00:00Z").label, "Hidden");
  // Within the window → Visible.
  assert.equal(eventLifecycle(base, "2026-07-05T00:00:00Z").label, "Visible");
  // After the event's end → Finished.
  assert.equal(eventLifecycle(base, "2026-07-11T00:00:00Z").label, "Finished");
  // Past the listing window but not yet started → Unlisted (visEnd before startAt edge).
  assert.equal(
    eventLifecycle(
      { ...base, visibilityEnd: "2026-07-02T00:00:00.000Z", startAt: "2026-07-10T18:00:00.000Z", endAt: null },
      "2026-07-05T00:00:00Z",
    ).label,
    "Unlisted",
  );

  // TM-727: an OPEN-ENDED event (no endAt) that has STARTED must NOT be "Finished" the instant it
  // begins — the server runs it for an assumed default duration and the member UI never client-side-
  // finishes it. Post-TM-1096 a started, not-finished event reads "Happening" (live), not "Visible" —
  // the endAt-only fallback keeps it live rather than mislabelling it Finished at start.
  const openEndedStarted = {
    ...base,
    endAt: null,
    startAt: "2026-07-10T18:00:00.000Z",
    visibilityEnd: "2026-07-31T00:00:00.000Z", // still within its listing window
  };
  const justStarted = "2026-07-10T18:30:00Z"; // 30 min after start, no endAt
  assert.equal(eventLifecycle(openEndedStarted, justStarted).label, "Happening", "open-ended, started → Happening (not Finished)");
  // The server's authoritative `past` flag still wins when it says the open-ended event has ended.
  assert.equal(
    eventLifecycle({ ...openEndedStarted, past: true }, justStarted).label,
    "Finished",
    "server past flag finishes it",
  );
  // TM-1221: once an open-ended event is past its assumed 3h duration it reads Finished — even with a
  // STALE `past: false`. The bug: it stayed "Happening" forever because the client never client-side-
  // finished an end-less event, so a cached/stale `past` pinned it live indefinitely.
  const wellAfterStart = "2026-07-11T00:00:00Z"; // ~30h after the 18:00 start, well past the 3h window
  assert.equal(eventLifecycle(openEndedStarted, wellAfterStart).label, "Finished", "open-ended past 3h → Finished (was stuck Happening)");
  assert.equal(
    eventLifecycle({ ...openEndedStarted, past: false }, wellAfterStart).label,
    "Finished",
    "a stale past:false no longer strands an open-ended event on Happening",
  );
  // Still live within the window.
  assert.equal(eventLifecycle(openEndedStarted, "2026-07-10T20:00:00Z").label, "Happening", "open-ended 2h in (< 3h) still Happening");
});

test("isPastEvent prefers the server `past` flag, falls back to the instants (TM-518)", () => {
  // The authoritative signal is the projection's own `past` boolean — trusted over the instants.
  assert.equal(isPastEvent({ past: true, startAt: "2999-01-01T00:00:00Z" }), true, "flag wins over a future start");
  assert.equal(isPastEvent({ past: false, endAt: "2000-01-01T00:00:00Z" }), false, "flag wins over a past end");

  // Fallback (no flag): ended once now ≥ endAt; open-ended uses startAt + the assumed 3h duration (TM-1221).
  const now = "2026-07-11T00:00:00Z";
  assert.equal(isPastEvent({ startAt: "2026-07-10T18:00:00Z", endAt: "2026-07-10T20:00:00Z" }, now), true);
  assert.equal(isPastEvent({ startAt: "2026-07-20T18:00:00Z", endAt: "2026-07-20T20:00:00Z" }, now), false);
  assert.equal(isPastEvent({ startAt: "2026-07-10T18:00:00Z", endAt: null }, now), true, "open-ended 6h past start (> 3h) is past");
  assert.equal(isPastEvent({ startAt: "2026-07-10T22:00:00Z", endAt: null }, now), false, "open-ended 2h past start (< 3h) is NOT yet past (TM-1221)");
  assert.equal(isPastEvent({}, now), false, "no dates → not past, never throws");
});

test("partitionEventsByPast splits active vs past, preserving order in each (TM-518)", () => {
  const events = [
    { id: 1, past: false },
    { id: 2, past: true },
    { id: 3, past: false },
    { id: 4, past: true },
  ];
  const { upcoming, past } = partitionEventsByPast(events);
  assert.deepEqual(upcoming.map((e) => e.id), [1, 3], "active order preserved");
  assert.deepEqual(past.map((e) => e.id), [2, 4], "past order preserved");
  assert.deepEqual(partitionEventsByPast([]), { upcoming: [], past: [] });
  assert.deepEqual(partitionEventsByPast(null), { upcoming: [], past: [] }, "tolerates junk");
});

test("capacityLabel reads unlimited for a blank/null capacity", () => {
  assert.equal(capacityLabel(null), "Unlimited");
  assert.equal(capacityLabel(""), "Unlimited");
  assert.equal(capacityLabel(50), "50");
});

test("attendanceCounts returns nulls today and lights up when the projection carries counts", () => {
  // Today's admin EventResponse carries no counts → nulls (the list renders "—").
  assert.deepEqual(attendanceCounts({ id: 1, capacity: 10 }), { going: null, waitlist: null });
  // Forward-compatible: reads them the moment a projection exposes them (any of the aliases).
  assert.deepEqual(attendanceCounts({ goingCount: 7, waitlistCount: 3 }), { going: 7, waitlist: 3 });
  assert.deepEqual(attendanceCounts({ attending: 4, waitlisted: 0 }), { going: 4, waitlist: 0 });
});

test("revealSummary reports the effective reveal window and its source (TM-408)", () => {
  // No per-event override → the effective value comes from the city/app default.
  assert.match(
    revealSummary({ effectiveLocationRevealHours: 24, locationRevealHours: null }),
    /24 hours before the start.*city \/ app default/i,
  );
  // A per-event override → says so, and pluralises correctly.
  assert.match(
    revealSummary({ effectiveLocationRevealHours: 1, locationRevealHours: 1 }),
    /1 hour before the start.*this event's override/i,
  );
  // No resolved value → "".
  assert.equal(revealSummary({}), "");
});

test("formatEventWhen renders the start in the event's own timezone", () => {
  // A UTC instant shown in London BST is +1h, so 17:00Z reads as 18:00 local, in 2026.
  const shown = formatEventWhen("2026-07-10T17:00:00.000Z", "Europe/London");
  assert.match(shown, /2026/);
  assert.match(shown, /18:00/);
  // Same instant in New York (EDT, -4) reads as 13:00.
  assert.match(formatEventWhen("2026-07-10T17:00:00.000Z", "America/New_York"), /13:00/);
  // Unparseable → em dash, never a throw.
  assert.equal(formatEventWhen("nope", "Europe/London"), "—");
});

// --- matchesStatusFilter: the admin list status filter, incl. the TM-965 "Unlisted" gap ------------

test("matchesStatusFilter: ALL / empty matches everything", () => {
  const ev = { status: "PUBLISHED", past: false, visibilityStart: "2026-01-01T00:00:00Z", visibilityEnd: "2026-12-31T00:00:00Z" };
  const now = Date.parse("2026-06-01T00:00:00Z");
  assert.equal(matchesStatusFilter(ev, "ALL", now), true);
  assert.equal(matchesStatusFilter(ev, "", now), true);
  assert.equal(matchesStatusFilter(ev, undefined, now), true);
});

test("matchesStatusFilter: an UNLISTED event matches the 'Unlisted' filter (TM-965)", () => {
  // Unlisted = PUBLISHED, not finished, but now is PAST the visibility window (window closed) and the
  // event hasn't started. Before TM-965 there was no Unlisted filter option, so such an event matched
  // NO non-ALL filter and vanished from every filtered view — this regression-guards that gap.
  const unlisted = {
    status: "PUBLISHED",
    past: false, // authoritative: not finished
    startAt: "2026-08-01T00:00:00Z", // still upcoming
    visibilityStart: "2026-06-01T00:00:00Z",
    visibilityEnd: "2026-06-10T00:00:00Z", // window already closed at `now`
  };
  const now = Date.parse("2026-06-20T00:00:00Z"); // after visibilityEnd, before startAt

  // Sanity: the derived lifecycle really is "Unlisted".
  assert.equal(eventLifecycle(unlisted, now).label, "Unlisted");
  // The load-bearing assertion: it matches the Unlisted filter…
  assert.equal(matchesStatusFilter(unlisted, "Unlisted", now), true);
  // …and only that one (it isn't swept up by the other buckets, and ALL still matches).
  assert.equal(matchesStatusFilter(unlisted, "Visible", now), false);
  assert.equal(matchesStatusFilter(unlisted, "Hidden", now), false);
  assert.equal(matchesStatusFilter(unlisted, "Finished", now), false);
  assert.equal(matchesStatusFilter(unlisted, "Cancelled", now), false);
  assert.equal(matchesStatusFilter(unlisted, "ALL", now), true);
});

test("matchesStatusFilter: Visible / Hidden / Cancelled buckets", () => {
  const now = Date.parse("2026-06-15T00:00:00Z");
  const visible = { status: "PUBLISHED", past: false, visibilityStart: "2026-06-01T00:00:00Z", visibilityEnd: "2026-06-30T00:00:00Z" };
  const hidden = { status: "PUBLISHED", past: false, visibilityStart: "2026-07-01T00:00:00Z", visibilityEnd: "2026-07-30T00:00:00Z" };
  const cancelled = { status: "CANCELLED", visibilityStart: "2026-06-01T00:00:00Z", visibilityEnd: "2026-06-30T00:00:00Z" };
  assert.equal(matchesStatusFilter(visible, "Visible", now), true);
  assert.equal(matchesStatusFilter(hidden, "Hidden", now), true);
  assert.equal(matchesStatusFilter(cancelled, "Cancelled", now), true);
  assert.equal(matchesStatusFilter(visible, "Unlisted", now), false);
});

// --- TM-1096: the "Happening" lifecycle branch (started, not finished) + its precedence edges -------

test("eventLifecycle: a started, not-finished event reads Happening (TM-1096)", () => {
  // Window is open and the event has STARTED but not ended → Happening, not Visible. `tone` is "ok".
  const live = {
    status: "PUBLISHED",
    past: false,
    startAt: "2026-07-10T18:00:00.000Z",
    endAt: "2026-07-10T20:00:00.000Z",
    visibilityStart: "2026-07-01T09:00:00.000Z",
    visibilityEnd: "2026-07-31T00:00:00.000Z",
  };
  const midEvent = "2026-07-10T19:00:00Z"; // an hour in, before the end
  assert.deepEqual(eventLifecycle(live, midEvent), { label: "Happening", tone: "ok" });

  // A NOT-yet-started event in its window is still plain Visible (Happening must not swallow it).
  const beforeStart = "2026-07-10T12:00:00Z";
  assert.equal(eventLifecycle(live, beforeStart).label, "Visible", "not started yet → Visible");
});

test("eventLifecycle: Happening precedence — Cancelled/Finished win, Hidden/Unlisted don't (TM-1096)", () => {
  const base = {
    status: "PUBLISHED",
    startAt: "2026-07-10T18:00:00.000Z",
    endAt: "2026-07-10T20:00:00.000Z",
    visibilityStart: "2026-07-01T09:00:00.000Z",
    visibilityEnd: "2026-07-31T00:00:00.000Z",
  };
  const mid = "2026-07-10T19:00:00Z"; // started, not over

  // Cancelled beats Happening even mid-event.
  assert.equal(eventLifecycle({ ...base, status: "CANCELLED" }, mid).label, "Cancelled");
  // Finished (server `past` flag) beats Happening.
  assert.equal(eventLifecycle({ ...base, past: true }, mid).label, "Finished");

  // Happening beats Hidden: a started event whose visibility window hasn't "opened" (visStart in the
  // future) still reads Happening — being live takes precedence over the window position.
  const startedButWindowNotOpen = { ...base, visibilityStart: "2026-07-20T00:00:00Z" };
  assert.equal(eventLifecycle(startedButWindowNotOpen, mid).label, "Happening", "Happening beats Hidden");

  // Happening beats Unlisted: a started event past its listing window is still live, not Unlisted.
  const startedButWindowClosed = { ...base, visibilityEnd: "2026-07-05T00:00:00Z" };
  assert.equal(eventLifecycle(startedButWindowClosed, mid).label, "Happening", "Happening beats Unlisted");
});

test("eventLifecycle: Happening edges at exactly startAt and exactly endAt (TM-1096)", () => {
  const ev = {
    status: "PUBLISHED",
    startAt: "2026-07-10T18:00:00.000Z",
    endAt: "2026-07-10T20:00:00.000Z",
    visibilityStart: "2026-07-01T09:00:00.000Z",
    visibilityEnd: "2026-07-31T00:00:00.000Z",
  };
  // At EXACTLY startAt (now === startAt) it's already Happening (`>=`), not still Visible.
  assert.equal(eventLifecycle(ev, "2026-07-10T18:00:00.000Z").label, "Happening", "at startAt → Happening");
  // One ms before startAt it's still Visible.
  assert.equal(eventLifecycle(ev, "2026-07-10T17:59:59.999Z").label, "Visible", "just before start → Visible");
  // At EXACTLY endAt the Finished branch (t >= endAt) has already claimed it — NOT Happening.
  assert.equal(eventLifecycle(ev, "2026-07-10T20:00:00.000Z").label, "Finished", "at endAt → Finished");
  // One ms before endAt it's still Happening.
  assert.equal(eventLifecycle(ev, "2026-07-10T19:59:59.999Z").label, "Happening", "just before end → Happening");

  // An OPEN-ENDED event (no endAt) that has started is Happening (not finished at start, TM-727), and
  // stays Happening as long as the server's `past` flag hasn't flipped.
  const openEnded = { ...ev, endAt: null };
  assert.equal(eventLifecycle(openEnded, "2026-07-10T18:30:00Z").label, "Happening", "open-ended, started → Happening");
});

// --- TM-1096: the lifecycle filter chips (LIFECYCLE_FILTERS) + matchesLifecycleFilter --------------

test("LIFECYCLE_FILTERS: the chip buckets + their lifecycle labels (TM-1096, relabel TM-1110)", () => {
  // One chip per lifecycle bucket, in reading order. TM-1110: the chip COPY differs from the lifecycle
  // label for the "upcoming"/"scheduled" pair — a PUBLISHED, not-yet-started event carries the "Visible"
  // lifecycle label and is what the admin means by "Upcoming"; a not-yet-visible ("Hidden") event is
  // "Scheduled". (Pre-TM-1110 the "Upcoming" chip was wired to Hidden, which is ~always empty.)
  assert.deepEqual(LIFECYCLE_FILTERS, [
    ["Happening", "Happening now"],
    ["Visible", "Upcoming"],
    ["Hidden", "Scheduled"],
    ["Unlisted", "Unlisted"],
    ["Finished", "Finished"],
    ["Cancelled", "Cancelled"],
  ]);
  // The load-bearing label↔bucket mapping (TM-1110 AC): "Upcoming" surfaces Visible, "Scheduled" Hidden.
  const byLabel = new Map(LIFECYCLE_FILTERS.map(([key, label]) => [label, key]));
  assert.equal(byLabel.get("Upcoming"), "Visible", "the 'Upcoming' chip matches the Visible lifecycle");
  assert.equal(byLabel.get("Scheduled"), "Hidden", "the 'Scheduled' chip matches the Hidden lifecycle");
  // Every key is a real lifecycle label eventLifecycle can emit (no orphan chip that matches nothing).
  const emitted = new Set(["Happening", "Visible", "Hidden", "Unlisted", "Finished", "Cancelled"]);
  for (const [key] of LIFECYCLE_FILTERS) assert.ok(emitted.has(key), `${key} is a real lifecycle label`);
});

test("matchesLifecycleFilter: empty selection ⇒ show all (TM-1096)", () => {
  const ev = { status: "PUBLISHED", past: false, startAt: "2026-08-01T00:00:00Z", visibilityStart: "2026-06-01T00:00:00Z", visibilityEnd: "2026-12-31T00:00:00Z" };
  const now = Date.parse("2026-07-01T00:00:00Z");
  assert.equal(matchesLifecycleFilter(ev, new Set(), now), true, "empty Set matches");
  assert.equal(matchesLifecycleFilter(ev, [], now), true, "empty array matches");
  assert.equal(matchesLifecycleFilter(ev, null, now), true, "null matches");
  assert.equal(matchesLifecycleFilter(ev, undefined, now), true, "undefined matches");
});

test("matchesLifecycleFilter: single-bucket selection matches only that lifecycle (TM-1096)", () => {
  // A started, not-finished event = Happening.
  const happening = { status: "PUBLISHED", past: false, startAt: "2026-07-10T18:00:00Z", endAt: "2026-07-10T22:00:00Z", visibilityStart: "2026-07-01T00:00:00Z", visibilityEnd: "2026-07-31T00:00:00Z" };
  const now = Date.parse("2026-07-10T20:00:00Z"); // mid-event
  assert.equal(eventLifecycle(happening, now).label, "Happening");
  assert.equal(matchesLifecycleFilter(happening, new Set(["Happening"]), now), true, "Happening chip matches");
  assert.equal(matchesLifecycleFilter(happening, new Set(["Visible"]), now), false, "Visible chip does not");
  assert.equal(matchesLifecycleFilter(happening, ["Happening"], now), true, "array form matches too");
});

test("matchesLifecycleFilter: MULTI-select is a union across buckets (TM-1096)", () => {
  const now = Date.parse("2026-07-10T20:00:00Z");
  const happening = { status: "PUBLISHED", past: false, startAt: "2026-07-10T18:00:00Z", endAt: "2026-07-10T22:00:00Z", visibilityStart: "2026-07-01T00:00:00Z", visibilityEnd: "2026-07-31T00:00:00Z" };
  const cancelled = { status: "CANCELLED", startAt: "2026-07-15T00:00:00Z", visibilityStart: "2026-07-01T00:00:00Z", visibilityEnd: "2026-07-31T00:00:00Z" };
  const visible = { status: "PUBLISHED", past: false, startAt: "2026-08-01T00:00:00Z", visibilityStart: "2026-07-01T00:00:00Z", visibilityEnd: "2026-08-31T00:00:00Z" };
  const sel = new Set(["Happening", "Cancelled"]);
  // Both selected buckets match…
  assert.equal(matchesLifecycleFilter(happening, sel, now), true);
  assert.equal(matchesLifecycleFilter(cancelled, sel, now), true);
  // …and a bucket NOT in the set does not.
  assert.equal(matchesLifecycleFilter(visible, sel, now), false, "Visible isn't selected → excluded");
});

// --- format (In person / Online) — CLIENT-ONLY, no backend field (TM-1063) -------------------

test("formatFromEvent infers Online from onlineUrl or a literal 'Online' locationText (TM-1063)", () => {
  // A new event (no signals) defaults to In person.
  assert.equal(formatFromEvent({}), EVENT_FORMAT_INPERSON);
  assert.equal(formatFromEvent(null), EVENT_FORMAT_INPERSON);
  // A physical location line, no online URL → In person.
  assert.equal(formatFromEvent({ locationText: "Marhaba Cafe, 12 High St" }), EVENT_FORMAT_INPERSON);
  // Either signal flips it to Online: an onlineUrl…
  assert.equal(formatFromEvent({ onlineUrl: "https://meet.example/abc", locationText: "" }), EVENT_FORMAT_ONLINE);
  // …or a literal "Online" location line (case-insensitive), even without an onlineUrl.
  assert.equal(formatFromEvent({ locationText: "Online" }), EVENT_FORMAT_ONLINE);
  assert.equal(formatFromEvent({ locationText: "  online  " }), EVENT_FORMAT_ONLINE);
});

test("validateEventDraft — Online requires an Online URL, not a physical Location (TM-1063)", () => {
  // Online, with a URL but a blank Location, is valid (locationText is auto-filled "Online" on the wire).
  const online = validateEventDraft(
    validDraft({ format: EVENT_FORMAT_ONLINE, onlineUrl: "https://meet.example/abc", locationText: "" }),
  );
  assert.equal(online.canSave, true);
  assert.equal(online.errors.locationText, undefined, "Online must not demand a physical Location");
  // Online with NO onlineUrl fails on onlineUrl (and still not on locationText).
  const noUrl = validateEventDraft(validDraft({ format: EVENT_FORMAT_ONLINE, onlineUrl: "", locationText: "" }));
  assert.equal(noUrl.canSave, false);
  assert.match(noUrl.errors.onlineUrl, /required/i);
  assert.equal(noUrl.errors.locationText, undefined);
});

test("validateEventDraft — In person keeps today's rules (Location required, Online URL optional) (TM-1063)", () => {
  // In person with a blank Location fails on locationText, NOT onlineUrl.
  const noLoc = validateEventDraft(validDraft({ format: EVENT_FORMAT_INPERSON, locationText: "", onlineUrl: "" }));
  assert.equal(noLoc.canSave, false);
  assert.match(noLoc.errors.locationText, /required/i);
  assert.equal(noLoc.errors.onlineUrl, undefined, "In person must not demand an Online URL");
  // A missing format defaults to In person (back-compat with drafts that predate the selector).
  const noFormat = validateEventDraft(validDraft({ locationText: "", onlineUrl: "" }));
  assert.match(noFormat.errors.locationText, /required/i);
});

test("buildEventPayload — Online auto-fills locationText='Online', omits the physical trio (TM-1063)", () => {
  const body = buildEventPayload(
    validDraft({
      format: EVENT_FORMAT_ONLINE,
      onlineUrl: "https://meet.example/abc",
      locationText: "",
      mapUrl: "https://maps.example/xyz",
      city: "London",
      venueId: "7",
    }),
  );
  // The server @NotBlank on locationText is satisfied by the auto-filled sentinel.
  assert.equal(body.locationText, ONLINE_LOCATION_TEXT);
  assert.equal(body.onlineUrl, "https://meet.example/abc");
  // The physical fields are NOT sent for an Online event.
  assert.equal("mapUrl" in body, false);
  assert.equal("city" in body, false);
  assert.equal("venueId" in body, false);
});

test("buildEventPayload — Online create submits with no physical location and passes server shape (TM-1063)", () => {
  // Create-as-Online: the resulting body carries every required server field (heading/description/
  // locationText/timezone + the instants) so it POSTs cleanly under the existing @NotBlank/@NotNull.
  const body = buildEventPayload(
    validDraft({ format: EVENT_FORMAT_ONLINE, onlineUrl: "https://meet.example/live", locationText: "", city: "", mapUrl: "" }),
  );
  for (const required of ["heading", "description", "locationText", "timezone", "startAt", "visibilityStart", "visibilityEnd"]) {
    assert.ok(required in body, `${required} must be present for a valid POST`);
  }
  assert.equal(body.locationText, ONLINE_LOCATION_TEXT);
});

test("buildEventPayload — In person is unchanged (physical fields, no forced Online) (TM-1063)", () => {
  const body = buildEventPayload(
    validDraft({ format: EVENT_FORMAT_INPERSON, locationText: "Marhaba Cafe", mapUrl: "https://maps.example/abc", city: "London" }),
  );
  assert.equal(body.locationText, "Marhaba Cafe");
  assert.equal(body.mapUrl, "https://maps.example/abc");
  assert.equal(body.city, "London");
});

test("toFormModel carries the inferred client-only format for the edit prefill (TM-1063)", () => {
  assert.equal(toFormModel({ onlineUrl: "https://meet.example/abc" }).format, EVENT_FORMAT_ONLINE);
  assert.equal(toFormModel({ locationText: "Online" }).format, EVENT_FORMAT_ONLINE);
  assert.equal(toFormModel({ locationText: "Marhaba Cafe" }).format, EVENT_FORMAT_INPERSON);
  assert.equal(toFormModel({}).format, EVENT_FORMAT_INPERSON);
});

// --- Map URL preview state (TM-1063): broken = HTTP-unreachable ONLY, not "no OG data" -----------

test("mapUrlPreviewState: blank URL → 'none' (nothing to draw)", () => {
  assert.deepEqual(mapUrlPreviewState("", true, null), { state: "none", preview: null });
  assert.deepEqual(mapUrlPreviewState("   ", false, { title: "x" }), { state: "none", preview: null });
});

test("mapUrlPreviewState: a NON-2xx response → 'broken' (unreachable/invalid URL)", () => {
  const { state, preview } = mapUrlPreviewState("https://maps.example/abc", false, null);
  assert.equal(state, "broken");
  assert.equal(preview, null);
});

test("mapUrlPreviewState: reachable + OG title → 'preview' (draw the card)", () => {
  const { state, preview } = mapUrlPreviewState(
    "https://maps.example/abc",
    true,
    { url: "https://maps.example/abc", title: "Marhaba Cafe", description: "12 High St" },
  );
  assert.equal(state, "preview");
  assert.equal(preview.title, "Marhaba Cafe");
  assert.equal(preview.hasContent, true);
});

test("mapUrlPreviewState: reachable but NO OG data → 'empty', NEVER 'broken' (Maps consent pages) (TM-1063)", () => {
  // The load-bearing rule: a reachable URL that carries no OpenGraph metadata (e.g. a Google Maps
  // consent/interstitial page) is a VALID link — it must show a neutral "no rich preview" state, not a
  // broken indicator. Only an HTTP-unreachable URL (non-2xx) is broken.
  const { state, preview } = mapUrlPreviewState("https://maps.example/consent", true, { url: "https://maps.example/consent", title: null });
  assert.equal(state, "empty");
  assert.equal(preview.hasContent, false);
});

// --- scheduling preset chips (TM-1064) --------------------------------------------------------
//
// These assert the PURE chip-value helpers. Every datetime chip must produce a value that, once seeded
// into the field, passes validateEventDraft — computed IN THE SELECTED EVENT TIMEZONE (a non-browser
// zone) and across a DST boundary. Each value round-trips losslessly (zonedToUtcIso ∘ helper) so it is a
// real, orderable wall clock the server will accept.

// A fixed non-browser zone with a stable offset (UTC+5, no DST) for the deterministic cases.
const KHI = "Asia/Karachi";

test("startNow rounds UP to the next 15 min, in the event zone (non-browser zone) (TM-1064)", () => {
  // 2026-07-10T12:07:00Z. In Karachi (UTC+5) that's 17:07 local → rounds up to 17:15.
  assert.equal(startNow(KHI, "2026-07-10T12:07:00.000Z"), "2026-07-10T17:15");
  // Already on a boundary: 12:00Z = 17:00 local → unchanged (ceil is a no-op, not +15).
  assert.equal(startNow(KHI, "2026-07-10T12:00:00.000Z"), "2026-07-10T17:00");
  // Exactly one second past a boundary still rounds up to the next quarter.
  assert.equal(startNow(KHI, "2026-07-10T12:00:01.000Z"), "2026-07-10T17:15");
  // Rounding crosses the hour: 17:52 local → 18:00.
  assert.equal(startNow(KHI, "2026-07-10T12:52:00.000Z"), "2026-07-10T18:00");
});

test("startChips: Now / In 2h / In 4h are quarter-aligned and strictly increasing, in-zone (TM-1064)", () => {
  const chips = startChips(KHI, "2026-07-10T12:07:00.000Z");
  assert.deepEqual(chips.map((c) => c.label), ["Now", "In 2h", "In 4h"]);
  assert.equal(chips[0].value, "2026-07-10T17:15");
  assert.equal(chips[1].value, "2026-07-10T19:15");
  assert.equal(chips[2].value, "2026-07-10T21:15");
  // Each value round-trips through zonedToUtcIso (it's a real, orderable wall clock).
  for (const c of chips) assert.equal(utcIsoToZoned(zonedToUtcIso(c.value, KHI), KHI), c.value);
});

test("startChips 'Now' seeds a draft that validateEventDraft accepts (TM-1064)", () => {
  const chips = startChips("Europe/London", "2026-07-10T12:07:00.000Z");
  const start = chips[0].value;
  const draft = validDraft({ timezone: "Europe/London", startAt: start, endAt: "", visibilityStart: "2026-07-01T09:00", visibilityEnd: start });
  const { errors } = validateEventDraft(draft);
  assert.equal(errors.startAt, undefined);
});

test("endChips: +1h/+2h/+4h off the current start, DST-correct across spring-forward (TM-1064)", () => {
  // London spring-forward is 2026-03-29: 01:00 local jumps to 02:00 (02:00–02:59 does NOT exist).
  // A 00:30 start + 1h must land on 02:30 (a REAL hour later), not the non-existent 01:30.
  const chips = endChips("2026-03-29T00:30", "Europe/London");
  assert.deepEqual(chips.map((c) => c.label), ["+1h", "+2h", "+4h"]);
  assert.equal(chips[0].value, "2026-03-29T02:30"); // +1 real hour skips the DST gap
  assert.equal(chips[1].value, "2026-03-29T03:30");
  assert.equal(chips[2].value, "2026-03-29T05:30");
  // Non-DST zone sanity (Karachi): plain +Nh.
  const khi = endChips("2026-07-10T17:15", KHI);
  assert.equal(khi[0].value, "2026-07-10T18:15");
});

test("endChips with a BLANK start yields all-'' values (a harmless no-op) (TM-1064)", () => {
  const chips = endChips("", "Europe/London");
  assert.deepEqual(chips.map((c) => c.value), ["", "", ""]);
  // Garbage in is also just "" (never throws, never a stray date).
  assert.deepEqual(endChips("not-a-date", KHI).map((c) => c.value), ["", "", ""]);
});

test("endChips '+2h' seeds an end that passes validateEventDraft (after > start) (TM-1064)", () => {
  const start = "2026-07-10T18:00";
  const end = endChips(start, "Europe/London")[1].value; // +2h → 20:00
  assert.equal(end, "2026-07-10T20:00");
  const { errors } = validateEventDraft(validDraft({ timezone: "Europe/London", startAt: start, endAt: end }));
  assert.equal(errors.endAt, undefined);
});

test("visibleFromChips: Today/Tomorrow at 09:00 local; N-before tracks the start (TM-1064)", () => {
  const start = "2026-07-10T18:00";
  const chips = visibleFromChips(start, KHI, "2026-07-01T12:00:00.000Z"); // 17:00 Karachi on Jul 1
  assert.deepEqual(chips.map((c) => c.label), ["Today", "Tomorrow", "1 day before", "1 week before"]);
  assert.equal(chips[0].value, "2026-07-01T09:00"); // Today (in-zone date) at 09:00
  assert.equal(chips[1].value, "2026-07-02T09:00"); // Tomorrow
  assert.equal(chips[2].value, "2026-07-09T18:00"); // 1 day before start, same time of day
  assert.equal(chips[3].value, "2026-07-03T18:00"); // 1 week before start
});

test("visibleFromChips 'Today' uses the EVENT zone's date, not the browser's (late-night edge) (TM-1064)", () => {
  // 2026-07-10T23:30Z is still 2026-07-10 in UTC but already 2026-07-11 04:30 in Karachi (UTC+5).
  // "Today" must be the KARACHI date (the event zone), i.e. the 11th.
  assert.equal(visibleFromChips("", KHI, "2026-07-10T23:30:00.000Z")[0].value, "2026-07-11T09:00");
});

test("visibleFromChips: start-relative chips are '' when start is blank (TM-1064)", () => {
  const chips = visibleFromChips("", KHI, "2026-07-01T12:00:00.000Z");
  assert.equal(chips[2].value, ""); // 1 day before
  assert.equal(chips[3].value, ""); // 1 week before
  // Today/Tomorrow don't depend on start, so they're still populated.
  assert.notEqual(chips[0].value, "");
});

test("visibleFromChips '1 week before' keeps the wall clock across a DST change (TM-1064)", () => {
  // Start Apr 5 2026 10:00 London (BST); 1 week before is Mar 29 — the spring-forward day. Keeping the
  // TIME OF DAY (10:00), not a real-ms shift, is what "a week before" means to an admin.
  const chips = visibleFromChips("2026-04-05T10:00", "Europe/London", "2026-03-01T00:00:00.000Z");
  assert.equal(chips[3].value, "2026-03-29T10:00");
});

test("visibleUntilChips: single '1h before start', tracks the current start (TM-1064)", () => {
  const chips = visibleUntilChips("2026-07-10T18:00", "Europe/London");
  assert.equal(chips.length, 1);
  assert.equal(chips[0].label, "1h before start");
  assert.equal(chips[0].value, "2026-07-10T17:00");
  // Blank start → '' (no-op).
  assert.equal(visibleUntilChips("", "Europe/London")[0].value, "");
  // A seeded visibility-end 1h before start passes validation (visStart < visEnd, before start).
  const { errors } = validateEventDraft(
    validDraft({ timezone: "Europe/London", startAt: "2026-07-10T18:00", visibilityStart: "2026-07-01T09:00", visibilityEnd: chips[0].value }),
  );
  assert.equal(errors.visibilityEnd, undefined);
});

test("revealHourChips: 1h / 24h, both within the API bounds (TM-1064)", () => {
  const chips = revealHourChips();
  assert.deepEqual(chips, [
    { label: "1h", value: "1" },
    { label: "24h", value: "24" },
  ]);
  for (const c of chips) {
    const { errors } = validateEventDraft(validDraft({ locationRevealHours: c.value }));
    assert.equal(errors.locationRevealHours, undefined);
    assert.ok(Number(c.value) >= REVEAL_HOURS_MIN && Number(c.value) <= REVEAL_HOURS_MAX);
  }
});

test("shiftZonedLocal is real-ms and null-safe (TM-1064)", () => {
  // A fall-back edge (London 2026-10-25 02:00 → 01:00; 01:00–01:59 occurs TWICE). Adding a real hour to
  // 00:30 lands on the FIRST 01:30, then another real hour reaches the SECOND 01:30 wall clock again is
  // ambiguous — assert the +2h real-ms result is a valid, parseable wall clock (never throws / blank).
  assert.equal(shiftZonedLocal("2026-07-10T10:00", 90 * 60 * 1000, KHI), "2026-07-10T11:30");
  assert.equal(shiftZonedLocal("", 3600000, KHI), "");
  assert.equal(shiftZonedLocal("2026-07-10T10:00", 3600000, "Not/AZone"), "");
});

// --- age band: preset ⇄ min/max mapping + Custom fallback (TM-1065) ---------------------------

test("age-band presets drop 13-17 and the create default is 18-99 (TM-1065)", () => {
  // Attendees are 18–99 (TM-884): no under-18 preset, and the create default is the whole adult range.
  assert.equal(AGE_DEFAULT_MIN, 18);
  assert.equal(AGE_DEFAULT_MAX, 99);
  assert.equal(AGE_BAND_CUSTOM, "Custom");
  const labels = AGE_BAND_PRESETS.map((b) => b.label);
  assert.deepEqual(labels, ["18-30", "21-35", "30+", "All ages"]);
  // No preset is below 18 (13-17 dropped), and none IS the Custom sentinel.
  for (const b of AGE_BAND_PRESETS) {
    if (b.min != null) assert.ok(b.min >= 18, `${b.label} min must be >= 18`);
    assert.notEqual(b.label, AGE_BAND_CUSTOM);
  }
  // Frozen so no consumer can mutate the single source.
  assert.throws(() => AGE_BAND_PRESETS.push({ label: "x", min: 1, max: 2 }), TypeError);
});

test("ageBandToMinMax maps each preset label to its min/max strings (TM-1065)", () => {
  assert.deepEqual(ageBandToMinMax("18-30"), { min: "18", max: "30" });
  assert.deepEqual(ageBandToMinMax("21-35"), { min: "21", max: "35" });
  // Open-ended "30+" → no max; "All ages" → neither bound.
  assert.deepEqual(ageBandToMinMax("30+"), { min: "30", max: "" });
  assert.deepEqual(ageBandToMinMax("All ages"), { min: "", max: "" });
  // The Custom sentinel and any unknown label carry no fixed numbers.
  assert.deepEqual(ageBandToMinMax("Custom"), { min: "", max: "" });
  assert.deepEqual(ageBandToMinMax("not-a-band"), { min: "", max: "" });
  assert.deepEqual(ageBandToMinMax(""), { min: "", max: "" });
});

test("minMaxToAgeBand reverse-maps a saved band to its preset (TM-1065)", () => {
  // Each preset must round-trip: preset → min/max → back to the same preset.
  for (const b of AGE_BAND_PRESETS) {
    assert.equal(minMaxToAgeBand(b.min, b.max), b.label, `${b.label} must reverse-map to itself`);
  }
  // Editing an 18-30 event opens on that preset (numbers or numeric strings both work).
  assert.equal(minMaxToAgeBand(18, 30), "18-30");
  assert.equal(minMaxToAgeBand("18", "30"), "18-30");
  // "30+" is min-only; "All ages" is both absent (null / "" / undefined all read as absent).
  assert.equal(minMaxToAgeBand(30, null), "30+");
  assert.equal(minMaxToAgeBand("30", ""), "30+");
  assert.equal(minMaxToAgeBand(null, null), "All ages");
  assert.equal(minMaxToAgeBand("", undefined), "All ages");
});

test("minMaxToAgeBand falls back to Custom for a non-preset band (TM-1065)", () => {
  // The load-bearing fallback: a saved 25-40 is NOT a preset → Custom (the form reveals 25/40).
  assert.equal(minMaxToAgeBand(25, 40), AGE_BAND_CUSTOM);
  // The 18-99 create default is also a non-preset band → Custom.
  assert.equal(minMaxToAgeBand(AGE_DEFAULT_MIN, AGE_DEFAULT_MAX), AGE_BAND_CUSTOM);
  // A half-open band that matches no preset (e.g. max-only, or a min that isn't a preset min).
  assert.equal(minMaxToAgeBand(null, 40), AGE_BAND_CUSTOM);
  assert.equal(minMaxToAgeBand(22, 35), AGE_BAND_CUSTOM); // 21-35 is the preset, not 22-35
  // Present-but-unparseable input on either side is a real (odd) band → Custom, never a preset match.
  assert.equal(minMaxToAgeBand("abc", 30), AGE_BAND_CUSTOM);
});

test("ageBandToMinMax ∘ minMaxToAgeBand round-trips every preset (TM-1065)", () => {
  for (const b of AGE_BAND_PRESETS) {
    const { min, max } = ageBandToMinMax(b.label);
    assert.equal(minMaxToAgeBand(min, max), b.label);
  }
});

test("opening-message templates are 2-3 generic, non-blank starters within the cap (TM-1065)", () => {
  assert.ok(OPENING_MESSAGE_TEMPLATES.length >= 2 && OPENING_MESSAGE_TEMPLATES.length <= 3);
  for (const t of OPENING_MESSAGE_TEMPLATES) {
    assert.equal(typeof t, "string");
    assert.ok(t.trim().length > 0, "template must be non-blank");
    // Each must fit the field cap so a tap can never over-fill the textarea.
    assert.ok(t.length <= OPENING_MESSAGE_MAX);
    // A tapped template seeds a valid draft (no openingMessage error).
    const { errors } = validateEventDraft(validDraft({ openingMessage: t }));
    assert.equal(errors.openingMessage, undefined);
  }
  // Frozen — the single source can't be mutated by a consumer.
  assert.throws(() => OPENING_MESSAGE_TEMPLATES.push("x"), TypeError);
});

// --- price control (TM-1076) -----------------------------------------------------------------
// The Price field + its pure helpers. The load-bearing behaviour: DEFAULT = Free, and buildEventPayload
// ALWAYS sends `pricePence` (0 for Free) so a form-created event is NEVER silently £5.

test("price presets: Free is FIRST (the default) and the preset set is Free/£5/£10 (TM-1076)", () => {
  assert.deepEqual(
    PRICE_CHIP_PRESETS.map((p) => [p.label, p.pence]),
    [["Free (£0)", 0], ["£5", 500], ["£10", 1000]],
  );
  // Free is the create default — the whole point of the ticket.
  assert.equal(PRICE_DEFAULT_CHIP, "Free (£0)");
  assert.equal(PRICE_CHIP_CUSTOM, "Custom");
  // Frozen — the single source can't be mutated by a consumer.
  assert.throws(() => PRICE_CHIP_PRESETS.push({ label: "£20", pence: 2000 }), TypeError);
});

test("priceChipToPence maps each preset label to its pence, Custom/unknown → null (TM-1076)", () => {
  assert.equal(priceChipToPence("Free (£0)"), 0);
  assert.equal(priceChipToPence("£5"), 500);
  assert.equal(priceChipToPence("£10"), 1000);
  // Custom (and anything else) carries no fixed value — the admin types a £ amount.
  assert.equal(priceChipToPence("Custom"), null);
  assert.equal(priceChipToPence("£99"), null);
  assert.equal(priceChipToPence(""), null);
});

test("penceToPriceChip reverse-maps a saved price to its preset (TM-1076)", () => {
  assert.equal(penceToPriceChip(0), "Free (£0)");
  assert.equal(penceToPriceChip(500), "£5");
  assert.equal(penceToPriceChip(1000), "£10");
  // Accepts a numeric string too (the wire may carry either).
  assert.equal(penceToPriceChip("500"), "£5");
});

test("penceToPriceChip falls back to Custom for a non-preset / invalid amount (TM-1076)", () => {
  // A non-preset amount (£7.50) opens on Custom so the exact number stays visible + editable.
  assert.equal(penceToPriceChip(750), "Custom");
  assert.equal(penceToPriceChip(1), "Custom");
  // null / blank / negative / non-integer → Custom (never a silent coerce to a preset).
  assert.equal(penceToPriceChip(null), "Custom");
  assert.equal(penceToPriceChip(""), "Custom");
  assert.equal(penceToPriceChip(-100), "Custom");
  assert.equal(penceToPriceChip("abc"), "Custom");
});

test("priceChipToPence ∘ penceToPriceChip round-trips every preset (TM-1076)", () => {
  for (const p of PRICE_CHIP_PRESETS) {
    assert.equal(penceToPriceChip(p.pence), p.label);
    assert.equal(priceChipToPence(p.label), p.pence);
  }
});

test("poundsToPence: £ amount → integer pence, rounds float error, rejects negatives/junk (TM-1076)", () => {
  assert.equal(poundsToPence("0"), 0);
  assert.equal(poundsToPence("5"), 500);
  assert.equal(poundsToPence("10"), 1000);
  // £7.50 → 750 (the ticket's worked example) — and the *100 float wobble is rounded away.
  assert.equal(poundsToPence("7.50"), 750);
  assert.equal(poundsToPence("7.5"), 750);
  assert.equal(poundsToPence("0.01"), 1);
  // A leading "£" and surrounding space are tolerated.
  assert.equal(poundsToPence(" £12.34 "), 1234);
  // Blank → null (the caller treats blank as Free / 0, not an error).
  assert.equal(poundsToPence(""), null);
  assert.equal(poundsToPence("   "), null);
  // Negative / non-numeric / too-many-decimals → NaN (the caller surfaces the validation error).
  assert.ok(Number.isNaN(poundsToPence("-5")));
  assert.ok(Number.isNaN(poundsToPence("abc")));
  assert.ok(Number.isNaN(poundsToPence("5.999")));
  assert.ok(Number.isNaN(poundsToPence("1.2.3")));
});

test("penceToPounds: pence → £ string, whole pounds without decimals, else 2dp (TM-1076)", () => {
  assert.equal(penceToPounds(0), "0");
  assert.equal(penceToPounds(500), "5");
  assert.equal(penceToPounds(1000), "10");
  assert.equal(penceToPounds(750), "7.50");
  assert.equal(penceToPounds(1), "0.01");
  assert.equal(penceToPounds(null), "");
  assert.equal(penceToPounds(""), "");
});

test("penceToPounds ∘ poundsToPence round-trips a range of amounts (TM-1076)", () => {
  for (const pence of [0, 1, 500, 750, 1000, 1234]) {
    assert.equal(poundsToPence(penceToPounds(pence)), pence);
  }
});

// --- buildEventPayload ALWAYS sends pricePence (the £5-by-default fix) ------------------------

test("buildEventPayload ALWAYS includes pricePence — an untouched (Free) control sends 0, not £5 (TM-1076)", () => {
  // The AC: creating an event with the untouched control produces pricePence:0 (Free), NOT £5. On the
  // untouched control the £ input carries "0" (the Free default the control seeds), so the payload is 0.
  const body = buildEventPayload(validDraft({ price: "0" }));
  assert.equal(body.pricePence, 0);
  // Even with NO `price` key at all (a defensive draft), the payload must still carry pricePence — never
  // omit it (an omitted price is exactly what makes the backend fall back to £5).
  assert.ok("pricePence" in buildEventPayload(validDraft()));
  assert.equal(buildEventPayload(validDraft()).pricePence, 0);
});

test("buildEventPayload maps each price chip / custom amount to its pence (TM-1076)", () => {
  assert.equal(buildEventPayload(validDraft({ price: "0" })).pricePence, 0); // Free
  assert.equal(buildEventPayload(validDraft({ price: "5" })).pricePence, 500); // £5
  assert.equal(buildEventPayload(validDraft({ price: "10" })).pricePence, 1000); // £10
  assert.equal(buildEventPayload(validDraft({ price: "7.50" })).pricePence, 750); // Custom
});

test("validateEventDraft rejects a negative / non-numeric custom price, accepts Free/blank (TM-1076)", () => {
  assert.match(validateEventDraft(validDraft({ price: "-5" })).errors.price, /price/i);
  assert.match(validateEventDraft(validDraft({ price: "abc" })).errors.price, /price/i);
  // Free (0) and a blank (= Free) are valid; a good custom amount is valid.
  assert.equal(validateEventDraft(validDraft({ price: "0" })).errors.price, undefined);
  assert.equal(validateEventDraft(validDraft({ price: "" })).errors.price, undefined);
  assert.equal(validateEventDraft(validDraft({ price: "7.50" })).errors.price, undefined);
});

test("toFormModel maps a saved pricePence back to the form's £ amount for the edit prefill (TM-1076)", () => {
  assert.equal(toFormModel({ pricePence: 0 }).price, "0"); // Free re-opens as Free
  assert.equal(toFormModel({ pricePence: 500 }).price, "5");
  assert.equal(toFormModel({ pricePence: 750 }).price, "7.50"); // a custom amount round-trips
  // A legacy response that never carried pricePence comes back "" (the control then defaults to Free).
  assert.equal(toFormModel({}).price, "");
});

// The FULL edit-prefill mapping chain the price control's initial active-chip rests on (TM-1076): an
// EventResponse's pricePence → toFormModel().price (the £ string seeded into #event-price) → the £-string
// buildPriceControl reverse-maps to an active chip. This pins BOTH halves so a regression in either — the
// one that made the mobile e2e read the Custom chip as un-pressed for a saved £7.50 — is caught here,
// viewport-independently. buildPriceControl computes `initialPence = round(Number(price)*100)` then
// `active = penceToPriceChip(initialPence)`; we assert that composed result, the exact thing the DOM does.
test("edit-prefill: a saved pricePence resolves to the SAME active chip the control lights (TM-1076)", () => {
  const activeChipFor = (pricePence) => {
    const price = toFormModel({ pricePence }).price; // the £ string seeded into #event-price
    // Mirror buildPriceControl's initial-active computation exactly (empty → Free default).
    if (price.trim() === "") return PRICE_DEFAULT_CHIP;
    return penceToPriceChip(Math.round(Number(price.trim()) * 100));
  };
  assert.equal(activeChipFor(0), "Free (£0)");
  assert.equal(activeChipFor(500), "£5");
  assert.equal(activeChipFor(1000), "£10");
  // The non-preset case the mobile e2e caught: a saved £7.50 (750) MUST light Custom, not a preset.
  assert.equal(activeChipFor(750), PRICE_CHIP_CUSTOM);
  assert.equal(activeChipFor(1), PRICE_CHIP_CUSTOM);
  // A legacy response with no pricePence defaults to Free (never leaves the control with no active chip).
  assert.equal(activeChipFor(null), PRICE_DEFAULT_CHIP);
});

// --- description templates (TM-1113) ---------------------------------------------------------
// Mirror the opening-message templates (TM-1065): 2-3 generic, non-blank, tap-to-prefill starters that
// SEED the Description textarea (free text after) and each fit DESCRIPTION_MAX so a tap can't over-fill.

test("description templates are 2-3 generic, non-blank starters within the cap (TM-1113)", () => {
  assert.ok(Array.isArray(DESCRIPTION_TEMPLATES));
  assert.ok(DESCRIPTION_TEMPLATES.length >= 2 && DESCRIPTION_TEMPLATES.length <= 3);
  for (const t of DESCRIPTION_TEMPLATES) {
    assert.equal(typeof t, "string");
    assert.ok(t.trim().length > 0, "template must be non-blank");
    // Each must fit the field cap so a tap can never over-fill the textarea (cap unchanged).
    assert.ok(t.length <= DESCRIPTION_MAX);
    // A tapped template seeds a VALID description (no description error — required + length both satisfied).
    const { errors } = validateEventDraft(validDraft({ description: t }));
    assert.equal(errors.description, undefined);
  }
  // Frozen — the single source can't be mutated by a consumer (matches OPENING_MESSAGE_TEMPLATES).
  assert.throws(() => DESCRIPTION_TEMPLATES.push("x"), TypeError);
});

// --- dirty-guard on exit + Clear/Reset (TM-1101) ---------------------------------------------
// isDirtyDraft(draft, baseline) drives the confirm-on-exit; blankFormModel() is the "Clear all" target
// on create. Both are pure so the exit-gate + reset decisions are testable without the DOM.

test("isDirtyDraft: a draft equal to its baseline is NOT dirty (TM-1101)", () => {
  // A pristine create form: readDraft() equals blankFormModel() (bar the guessed timezone, compared below).
  const baseline = blankFormModel();
  assert.equal(isDirtyDraft({ ...baseline }, baseline), false);
  // An edit form freshly prefilled from an event: readDraft() equals toFormModel(event) → not dirty.
  const event = {
    heading: "Coffee & Code",
    description: "Bring a laptop.",
    locationText: "Marhaba Cafe",
    timezone: "Europe/London",
    startAt: "2026-07-10T17:00:00.000Z",
    visibilityStart: "2026-07-01T08:00:00.000Z",
    visibilityEnd: "2026-07-10T17:00:00.000Z",
    pricePence: 0,
  };
  const model = toFormModel(event);
  assert.equal(isDirtyDraft({ ...model }, model), false);
});

test("isDirtyDraft: any changed compared field reads dirty (TM-1101)", () => {
  const baseline = blankFormModel();
  // Editing the heading makes it dirty.
  assert.equal(isDirtyDraft({ ...baseline, heading: "New" }, baseline), true);
  // So does a venue pick (venueId), a timezone, a datetime, the price, or the format toggle.
  assert.equal(isDirtyDraft({ ...baseline, venueId: "7" }, baseline), true);
  assert.equal(isDirtyDraft({ ...baseline, startAt: "2026-07-10T18:00" }, baseline), true);
  assert.equal(isDirtyDraft({ ...baseline, price: "5" }, baseline), true);
  assert.equal(isDirtyDraft({ ...baseline, format: "online" }, baseline), true);
});

test("isDirtyDraft: whitespace-only differences do NOT count as dirty (TM-1101)", () => {
  const baseline = blankFormModel();
  // A field that is "" vs "   " (trailing spaces) is not a real edit.
  assert.equal(isDirtyDraft({ ...baseline, heading: "   " }, baseline), false);
  // "Coffee" vs "Coffee " (a stray trailing space) is likewise not dirty.
  const b2 = { ...baseline, heading: "Coffee" };
  assert.equal(isDirtyDraft({ ...b2, heading: "Coffee " }, b2), false);
});

test("blankFormModel: every compared field is blank except the in-person format default (TM-1101)", () => {
  const blank = blankFormModel();
  for (const key of DIRTY_COMPARE_FIELDS) {
    if (key === "format") assert.equal(blank[key], "inperson", "a cleared form defaults to In person");
    else assert.equal(blank[key], "", `${key} must be blank on a cleared create form`);
  }
});

// --- clone / duplicate an event with a time offset (TM-1061) ----------------------------------

// A representative source EventResponse for the clone tests — the shape toFormModel reads. Europe/London
// so the DST behaviour is real. startAt in JULY (BST, +1) so the wall-clock ⇄ UTC round-trip is exercised.
const CLONE_SOURCE = Object.freeze({
  id: 42,
  heading: "Coffee & Code",
  description: "Bring a laptop.",
  locationText: "Marhaba Cafe, 12 High St",
  city: "London",
  timezone: "Europe/London",
  startAt: "2026-07-10T17:00:00.000Z", // 18:00 London (BST)
  endAt: "2026-07-10T20:00:00.000Z", // 21:00 London — a 3h event
  visibilityStart: "2026-07-03T08:00:00.000Z", // a week before
  visibilityEnd: "2026-07-10T16:00:00.000Z", // 1h before start
  capacity: 20,
  locationRevealHours: 24,
  ageMin: 21,
  ageMax: 40,
  pricePence: 1000,
  imagePath: "event-images/42",
  openingMessage: "Welcome everyone — say hi in the chat!",
  status: "PUBLISHED",
});

test("CLONE_OFFSET_PRESETS is exactly +7 days and +7 hours (LOCKED, TM-1061)", () => {
  const labels = CLONE_OFFSET_PRESETS.map((p) => p.label);
  assert.deepEqual(labels, ["+7 days", "+7 hours"], "round 1 offers ONLY these two presets (no free-form field)");
  assert.equal(CLONE_OFFSET_PRESETS[0].ms, 7 * 24 * 3_600_000, "+7 days in ms");
  assert.equal(CLONE_OFFSET_PRESETS[1].ms, 7 * 3_600_000, "+7 hours in ms");
});

test("shiftDraftTimes: +7 days shifts all four datetimes together, keeps the interval (TM-1061)", () => {
  const base = toFormModel(CLONE_SOURCE);
  const shifted = shiftDraftTimes(base, 7 * 24 * 3_600_000);
  // Each field moves +7 calendar days at the same London wall-clock (no DST crossing in July).
  assert.equal(shifted.startAt, "2026-07-17T18:00");
  assert.equal(shifted.endAt, "2026-07-17T21:00");
  assert.equal(shifted.visibilityStart, "2026-07-10T09:00"); // was 2026-07-03T09:00 (BST)
  assert.equal(shifted.visibilityEnd, "2026-07-17T17:00");
  // The base is not mutated.
  assert.equal(base.startAt, "2026-07-10T18:00");
});

test("shiftDraftTimes: +7 hours lands later the same day (TM-1061)", () => {
  const base = toFormModel(CLONE_SOURCE);
  const shifted = shiftDraftTimes(base, 7 * 3_600_000);
  assert.equal(shifted.startAt, "2026-07-11T01:00"); // 18:00 + 7h = 01:00 next day
  assert.equal(shifted.endAt, "2026-07-11T04:00");
  // Non-datetime fields are copied through untouched.
  assert.equal(shifted.heading, "Coffee & Code");
  assert.equal(shifted.capacity, "20");
});

test("shiftDraftTimes: a blank optional datetime STAYS blank (open-ended event, TM-1061)", () => {
  const openEnded = { ...CLONE_SOURCE, endAt: null };
  const base = toFormModel(openEnded);
  assert.equal(base.endAt, "", "open-ended event has a blank endAt to begin with");
  const shifted = shiftDraftTimes(base, 7 * 24 * 3_600_000);
  assert.equal(shifted.endAt, "", "a blank endAt is never invented by the shift");
  assert.equal(shifted.startAt, "2026-07-17T18:00", "the present datetimes still shift");
});

test("shiftDraftTimes: a zero / non-finite offset is a no-op (TM-1061)", () => {
  const base = toFormModel(CLONE_SOURCE);
  assert.deepEqual(shiftDraftTimes(base, 0), base);
  assert.deepEqual(shiftDraftTimes(base, NaN), base);
});

test("shiftDraftTimes: uses REAL-ms arithmetic across the autumn fall-back (TM-1061)", () => {
  // London clocks go back at 02:00 on 2026-10-25 (BST→GMT), so the week 2026-10-24 → 2026-10-31 gains an
  // extra hour. shiftDraftTimes adds 7×24h of REAL time (the same DST-correct span the scheduling chips
  // use), so an 18:00 BST start lands at 17:00 GMT — one wall-clock hour earlier, because the real elapsed
  // week was 169h, not 168h. This proves the shift is real-ms (not a naive wall-clock string add, which
  // would wrongly report 18:00 and silently drift the actual instant by an hour). The interval between the
  // paired fields is likewise preserved on the real timeline.
  const dstSource = { ...CLONE_SOURCE, startAt: "2026-10-24T17:00:00.000Z", endAt: "2026-10-24T20:00:00.000Z", visibilityStart: null, visibilityEnd: null };
  const base = toFormModel(dstSource);
  assert.equal(base.startAt, "2026-10-24T18:00", "18:00 London on 2026-10-24 (BST)");
  assert.equal(base.endAt, "2026-10-24T21:00", "21:00 London on 2026-10-24 (BST)");
  const shifted = shiftDraftTimes(base, 7 * 24 * 3_600_000);
  assert.equal(shifted.startAt, "2026-10-31T17:00", "+7 real days lands at 17:00 GMT (the week gained an hour)");
  assert.equal(shifted.endAt, "2026-10-31T20:00", "the 3h interval is preserved on the real timeline");
});

test("buildCloneDraft: copies everything, shifts the times, BLANKS the opening message (TM-1061)", () => {
  const draft = buildCloneDraft(CLONE_SOURCE, 7 * 24 * 3_600_000);
  // Copied verbatim (the edit-prefill model).
  assert.equal(draft.heading, "Coffee & Code");
  assert.equal(draft.description, "Bring a laptop.");
  assert.equal(draft.locationText, "Marhaba Cafe, 12 High St");
  assert.equal(draft.city, "London");
  assert.equal(draft.timezone, "Europe/London");
  assert.equal(draft.capacity, "20");
  assert.equal(draft.locationRevealHours, "24");
  assert.equal(draft.ageMin, "21");
  assert.equal(draft.ageMax, "40");
  assert.equal(draft.price, "10"); // £10 from 1000 pence
  // The source image is preserved on the draft so the DOM layer can re-upload it to a NEW object.
  assert.equal(draft.imagePath, "event-images/42");
  // Times shifted +7 days.
  assert.equal(draft.startAt, "2026-07-17T18:00");
  // Opening message BLANKED (LOCKED decision) — never carry stale text.
  assert.equal(draft.openingMessage, "", "opening message must be blank on clone");
});

test("buildCloneDraft: a CANCELLED source clones to a normal draft (no cancelled status carried) (TM-1061)", () => {
  const cancelled = { ...CLONE_SOURCE, status: "CANCELLED" };
  const draft = buildCloneDraft(cancelled, 0);
  // The draft is a plain create-form model — it carries no `status` field at all, so the clone is a fresh
  // PUBLISHED-on-create event, never a cancelled one.
  assert.equal(draft.status, undefined);
  assert.equal(draft.heading, "Coffee & Code");
});

test("buildCloneDraft: the produced draft passes validateEventDraft (create) (TM-1061)", () => {
  // A cloned draft must be a VALID create draft (nothing required left blank) so the admin can Save it
  // without fixing anything but (optionally) a past start — proves the shift + blank keep it well-formed.
  const draft = buildCloneDraft(CLONE_SOURCE, 7 * 24 * 3_600_000);
  const { canSave, errors } = validateEventDraft(draft, { requireForCreate: true });
  assert.equal(canSave, true, `cloned draft should be a valid create draft; errors: ${JSON.stringify(errors)}`);
});

test("pastStartWarning: warns when the shifted start is still in the past (TM-1061)", () => {
  // An OLD event: start on 2020-01-01. Even +7 hours leaves it deep in the past → warn.
  const old = { ...CLONE_SOURCE, startAt: "2020-01-01T12:00:00.000Z", endAt: null, visibilityStart: null, visibilityEnd: null };
  const draft = buildCloneDraft(old, 7 * 3_600_000);
  const warning = pastStartWarning(draft, Date.parse("2026-07-24T00:00:00.000Z"));
  assert.match(warning, /past/i, "a past shifted start must surface a visible warning");
});

test("pastStartWarning: no warning when the shifted start is in the future (TM-1061)", () => {
  const draft = buildCloneDraft(CLONE_SOURCE, 7 * 24 * 3_600_000); // shifts to 2026-07-17
  const warning = pastStartWarning(draft, Date.parse("2026-07-01T00:00:00.000Z")); // "now" is before the start
  assert.equal(warning, "", "a future start must NOT warn");
});

test("pastStartWarning: blank/unparseable start is not this warning's concern (TM-1061)", () => {
  assert.equal(pastStartWarning({ startAt: "", timezone: "Europe/London" }), "");
  assert.equal(pastStartWarning({ startAt: "not-a-date", timezone: "Europe/London" }), "");
  assert.equal(pastStartWarning({}), "");
});

// --- recurrence: the Repeat picker → CreateSeriesRequest (TM-796) ------------------------------
//
// These mirror the series API's edge validation (CreateSeriesRequest, TM-795) so the admin gets inline
// recurrence errors BEFORE the POST: exactly-one-end, interval ≥ 1, WEEKLY needs a weekday that matches
// the start's weekday, DAILY forbids a weekday; and buildSeriesPayload emits the exact wire shape
// (frequency/interval/[byWeekday]/(untilDate XOR afterN)/timezone/first*-anchor + template).

// A fixed clock BEFORE the seriesDraft start (2026-07-10T17:00Z) so validateSeriesDraft's future-start rule
// (TM-1183 item 8) is satisfied deterministically — the suite must not depend on the real wall-clock, which
// long ago passed 2026-07-10. `vsd(draft)` = validateSeriesDraft pinned to that clock; only the dedicated
// future-start test overrides `now`.
const SERIES_NOW = Date.parse("2026-07-01T00:00:00.000Z");
const vsd = (draft, opts = {}) => validateSeriesDraft(draft, { now: SERIES_NOW, ...opts });

// A valid RECURRING draft (a Weekly-every-1, until, on the start's weekday). 2026-07-10 is a FRIDAY.
function seriesDraft(over = {}) {
  return {
    ...validDraft(),
    startAt: "2026-07-10T18:00", // a Friday
    endAt: "2026-07-10T20:00",
    frequency: SERIES_FREQ_WEEKLY,
    interval: "1",
    byWeekday: "FRIDAY",
    endMode: SERIES_END_UNTIL,
    untilDate: "2026-09-10",
    afterN: "",
    ...over,
  };
}

test("SERIES_FREQUENCIES + SERIES_WEEKDAYS are the frozen v1 sources (DAILY/WEEKLY, Mon-first) (TM-796)", () => {
  assert.deepEqual(SERIES_FREQUENCIES.map(([v]) => v), [SERIES_FREQ_DAILY, SERIES_FREQ_WEEKLY]);
  assert.equal(SERIES_FREQ_DAILY, "DAILY");
  assert.equal(SERIES_FREQ_WEEKLY, "WEEKLY");
  assert.deepEqual(SERIES_WEEKDAYS.map((d) => d.value), ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]);
  assert.equal(SERIES_INTERVAL_MIN, 1);
  // Frozen so no consumer mutates the single source.
  assert.throws(() => SERIES_FREQUENCIES.push(["MONTHLY", "Monthly"]), TypeError);
  assert.throws(() => SERIES_WEEKDAYS.push({ value: "X", label: "X" }), TypeError);
});

test("weekdayOfLocal maps a datetime-local value to its ISO weekday name (TM-796)", () => {
  assert.equal(weekdayOfLocal("2026-07-10T18:00"), "FRIDAY"); // 2026-07-10 is a Friday
  assert.equal(weekdayOfLocal("2026-07-13T09:00"), "MONDAY");
  assert.equal(weekdayOfLocal("2026-07-12T00:00"), "SUNDAY");
  assert.equal(weekdayOfLocal(""), "");
  assert.equal(weekdayOfLocal("nope"), "");
});

test("validateSeriesDraft: a well-formed weekly (and daily) draft can save (TM-796)", () => {
  assert.equal(vsd(seriesDraft()).canSave, true);
  assert.deepEqual(vsd(seriesDraft()).errors, {});
  // Daily-every-2, afterN=6 (no weekday).
  const daily = vsd(seriesDraft({ frequency: SERIES_FREQ_DAILY, byWeekday: "", interval: "2", endMode: SERIES_END_AFTER, untilDate: "", afterN: "6" }));
  assert.equal(daily.canSave, true);
  assert.deepEqual(daily.errors, {});
});

test("validateSeriesDraft: interval must be an integer ≥ 1 (mirrors @Min(1)) (TM-796)", () => {
  assert.match(vsd(seriesDraft({ interval: "0" })).errors.interval, /1 or more/);
  assert.match(vsd(seriesDraft({ interval: "" })).errors.interval, /1 or more/);
  assert.match(vsd(seriesDraft({ interval: "2.5" })).errors.interval, /whole number/i);
  assert.match(vsd(seriesDraft({ interval: "-1" })).errors.interval, /1 or more/);
});

test("validateSeriesDraft: EXACTLY ONE end condition — neither / both are errors (TM-796)", () => {
  // Neither: endMode isn't set → endMode error.
  assert.match(vsd(seriesDraft({ endMode: "" })).errors.endMode, /how the series ends/i);
  // Until chosen but blank date → untilDate error.
  assert.match(vsd(seriesDraft({ endMode: SERIES_END_UNTIL, untilDate: "" })).errors.untilDate, /end date/i);
  // After chosen but blank / zero → afterN error.
  assert.match(vsd(seriesDraft({ endMode: SERIES_END_AFTER, untilDate: "", afterN: "" })).errors.afterN, /1 or more/i);
  assert.match(vsd(seriesDraft({ endMode: SERIES_END_AFTER, untilDate: "", afterN: "0" })).errors.afterN, /1 or more/i);
  // A valid After (with the stray untilDate ignored because endMode=after) still saves — only the active
  // mode supplies the end, so buildSeriesPayload can never emit both.
  assert.equal(vsd(seriesDraft({ endMode: SERIES_END_AFTER, afterN: "8" })).canSave, true);
});

test("validateSeriesDraft: WEEKLY requires a weekday that MATCHES the start's weekday (TM-796)", () => {
  // Blank weekday on WEEKLY.
  assert.match(vsd(seriesDraft({ byWeekday: "" })).errors.byWeekday, /pick a weekday/i);
  // A weekday that doesn't match the Friday start.
  assert.match(vsd(seriesDraft({ byWeekday: "MONDAY" })).errors.byWeekday, /match the start/i);
  // The matching weekday is fine.
  assert.equal(vsd(seriesDraft({ byWeekday: "FRIDAY" })).canSave, true);
});

test("validateSeriesDraft: DAILY must NOT carry a weekday (parity with the API edge) (TM-796)", () => {
  const bad = vsd(seriesDraft({ frequency: SERIES_FREQ_DAILY, byWeekday: "MONDAY", endMode: SERIES_END_AFTER, untilDate: "", afterN: "4" }));
  assert.match(bad.errors.byWeekday, /only applies to a weekly/i);
});

test("validateSeriesDraft: the first occurrence must start in the FUTURE (mirrors CreateSeriesRequest, TM-1183)", () => {
  // The seriesDraft start resolves to 2026-07-10T17:00Z (BST). A `now` AFTER it → past-start error on startAt.
  const past = validateSeriesDraft(seriesDraft(), { now: Date.parse("2026-07-10T17:00:01.000Z") });
  assert.match(past.errors.startAt, /future/i);
  assert.equal(past.canSave, false);
  // A `now` a moment BEFORE the anchor → no future-start error (the rest of the draft is valid).
  const future = validateSeriesDraft(seriesDraft(), { now: Date.parse("2026-07-10T16:59:59.000Z") });
  assert.equal("startAt" in future.errors, false);
  assert.equal(future.canSave, true);
  // Missing/unparseable start or zone → the rule is skipped (validateEventDraft owns "start required").
  const noStart = validateSeriesDraft(seriesDraft({ startAt: "" }), { now: Date.parse("2030-01-01T00:00:00.000Z") });
  assert.equal("startAt" in noStart.errors, false);
});

test("buildSeriesPayload emits the CreateSeriesRequest wire shape: rule + first* anchor + template (TM-796)", () => {
  const body = buildSeriesPayload(seriesDraft());
  // Recurrence rule.
  assert.equal(body.frequency, "WEEKLY");
  assert.equal(body.interval, 1);
  assert.equal(body.byWeekday, "FRIDAY"); // uppercase DayOfWeek name (the API wire format)
  // End condition — EXACTLY the chosen one; the other is ABSENT.
  assert.equal(body.untilDate, "2026-09-10");
  assert.equal("afterN" in body, false);
  // First-occurrence anchor — the event's instants re-keyed onto first* (BST → -1h).
  assert.equal(body.firstStartAt, "2026-07-10T17:00:00.000Z");
  assert.equal(body.firstEndAt, "2026-07-10T19:00:00.000Z");
  assert.equal(body.firstVisibilityStart, "2026-07-01T08:00:00.000Z");
  assert.equal(body.firstVisibilityEnd, "2026-07-10T17:00:00.000Z");
  assert.equal(body.timezone, "Europe/London");
  // Template snapshot — the same fields a single create carries; NOT the raw startAt/visibility* keys.
  assert.equal(body.heading, "Coffee & Code");
  assert.equal(body.description, "Bring a laptop and a mug.");
  assert.equal(body.locationText, "Marhaba Cafe, 12 High St");
  assert.equal(body.capacity, 20);
  assert.equal(body.locationRevealHours, 24);
  // The event's own instant keys must NOT leak onto the series body (only the first* anchor names).
  for (const k of ["startAt", "endAt", "visibilityStart", "visibilityEnd"]) assert.equal(k in body, false, `${k} must not be on the series body`);
});

test("buildSeriesPayload STRIPS the non-template keys the series DTO can't read (TM-1184)", () => {
  // A draft that DOES carry every non-template field (onlineUrl / mapUrl / openingMessage / ageMin / ageMax).
  // buildEventPayload would emit these; buildSeriesPayload must strip them so no occurrence is materialised
  // with a field the series template has no column for (worst case: an Online series with no join link).
  const body = buildSeriesPayload(
    seriesDraft({ mapUrl: "https://maps.example/x", openingMessage: "Welcome all!", ageMin: "18", ageMax: "40" }),
  );
  for (const k of SERIES_NON_TEMPLATE_KEYS) assert.equal(k in body, false, `${k} must be stripped from the series body`);
  assert.deepEqual(SERIES_NON_TEMPLATE_KEYS, ["onlineUrl", "mapUrl", "openingMessage", "ageMin", "ageMax"]);
  // Sanity: the same fields WOULD ride a single-create body (so the strip is meaningful, not vacuous).
  const single = buildEventPayload(seriesDraft({ mapUrl: "https://maps.example/x", openingMessage: "Welcome all!", ageMin: "18", ageMax: "40" }));
  assert.equal(single.mapUrl, "https://maps.example/x");
  assert.equal(single.openingMessage, "Welcome all!");
  assert.equal(single.ageMin, 18);
  // The template fields the series DTO DOES read still ride through.
  assert.equal(body.heading, "Coffee & Code");
  assert.equal(body.locationText, "Marhaba Cafe, 12 High St");
  assert.equal(body.capacity, 20);
});

test("buildSeriesPayload — an Online draft still never carries onlineUrl onto the series (TM-1184 invariant)", () => {
  // Even if a caller hands buildSeriesPayload an Online-format draft (the form prevents this, but the payload
  // builder is the load-bearing guarantee), onlineUrl is stripped — an Online series can't materialise with a
  // per-occurrence join link, so the invariant "no Online series with onlineUrl" holds at the payload layer.
  const body = buildSeriesPayload(seriesDraft({ format: "online", onlineUrl: "https://meet.example/room", locationText: "" }));
  assert.equal("onlineUrl" in body, false);
});

test("buildSeriesPayload — DAILY omits byWeekday and can carry afterN instead of untilDate (TM-796)", () => {
  const body = buildSeriesPayload(seriesDraft({ frequency: SERIES_FREQ_DAILY, byWeekday: "", interval: "3", endMode: SERIES_END_AFTER, untilDate: "", afterN: "5" }));
  assert.equal(body.frequency, "DAILY");
  assert.equal(body.interval, 3);
  assert.equal("byWeekday" in body, false); // DAILY carries no weekday
  assert.equal(body.afterN, 5);
  assert.equal("untilDate" in body, false); // the OTHER end condition is absent
});

test("buildSeriesPayload — an open-ended first occurrence (blank end) omits firstEndAt (TM-796)", () => {
  const body = buildSeriesPayload(seriesDraft({ endAt: "" }));
  assert.equal("firstEndAt" in body, false);
  assert.ok("firstStartAt" in body);
});

// --- collapsed-section value summaries (TM-1196) ----------------------------------------------
// whoCanJoinSummary / bookingRulesSummary produce the terse one-line value string each COLLAPSED
// section header shows so an admin sees what's in a fold without opening it. Pure — derived-display
// only; they read the same draft readDraft() produces and never touch validate/payload/section state.

test("whoCanJoinSummary: all-defaults draft reads public · no cap · all ages (TM-1196)", () => {
  assert.equal(whoCanJoinSummary({}), "public · no cap · all ages");
  // An explicitly blank draft (create defaults: blank visibility/capacity/age) is the same.
  assert.equal(
    whoCanJoinSummary({ visibilityStart: "", visibilityEnd: "", capacity: "", ageMin: "", ageMax: "" }),
    "public · no cap · all ages",
  );
});

test("whoCanJoinSummary: fully populated draft reads scheduled · cap 20 · 18-30 (TM-1196)", () => {
  assert.equal(
    whoCanJoinSummary({
      visibilityStart: "2026-08-01T09:00",
      visibilityEnd: "2026-08-10T09:00",
      capacity: "20",
      ageMin: "18",
      ageMax: "30",
    }),
    "scheduled · cap 20 · 18-30",
  );
});

test("whoCanJoinSummary: partial values (TM-1196)", () => {
  // A visibility window on EITHER side → scheduled.
  assert.equal(whoCanJoinSummary({ visibilityStart: "2026-08-01T09:00" }), "scheduled · no cap · all ages");
  assert.equal(whoCanJoinSummary({ visibilityEnd: "2026-08-10T09:00" }), "scheduled · no cap · all ages");
  // Capacity set, age open.
  assert.equal(whoCanJoinSummary({ capacity: "5" }), "public · cap 5 · all ages");
  // Age min only → "N+"; max only → "≤N".
  assert.equal(whoCanJoinSummary({ ageMin: "30" }), "public · no cap · 30+");
  assert.equal(whoCanJoinSummary({ ageMax: "40" }), "public · no cap · ≤40");
});

test("whoCanJoinSummary: never shows undefined / raw blanks (TM-1196)", () => {
  const s = whoCanJoinSummary({ capacity: "abc", ageMin: "x" });
  assert.equal(s.includes("undefined"), false);
  assert.equal(s.includes("NaN"), false);
  // Non-integer capacity/age fall back to the sensible default word, never a broken part.
  assert.equal(s, "public · no cap · all ages");
});

test("bookingRulesSummary: all-defaults draft reads cutoff default · reveal default · Free (TM-1196)", () => {
  assert.equal(bookingRulesSummary({}), "cutoff default · reveal default · Free");
  assert.equal(
    bookingRulesSummary({ bookingCutoffHours: "", locationRevealHours: "", price: "" }),
    "cutoff default · reveal default · Free",
  );
});

test("bookingRulesSummary: fully populated draft reads cutoff 1h · reveal 24h · £5 (TM-1196)", () => {
  assert.equal(
    bookingRulesSummary({ bookingCutoffHours: "1", locationRevealHours: "24", price: "5" }),
    "cutoff 1h · reveal 24h · £5",
  );
  // A fractional £ amount keeps two places.
  assert.equal(
    bookingRulesSummary({ bookingCutoffHours: "2", locationRevealHours: "48", price: "7.50" }),
    "cutoff 2h · reveal 48h · £7.50",
  );
});

test("bookingRulesSummary: partial values + the 0-cutoff real value (TM-1196)", () => {
  // Cutoff 0 is a REAL override (accept up to start), not the inherit default.
  assert.equal(bookingRulesSummary({ bookingCutoffHours: "0" }), "cutoff 0h · reveal default · Free");
  // Reveal set, cutoff inheriting, price Free.
  assert.equal(bookingRulesSummary({ locationRevealHours: "12" }), "cutoff default · reveal 12h · Free");
  // Price 0 → Free; a set price → the £ amount.
  assert.equal(bookingRulesSummary({ price: "0" }), "cutoff default · reveal default · Free");
  assert.equal(bookingRulesSummary({ price: "10" }), "cutoff default · reveal default · £10");
});

test("bookingRulesSummary: never shows undefined / raw blanks (TM-1196)", () => {
  const s = bookingRulesSummary({ bookingCutoffHours: "x", locationRevealHours: "y", price: "abc" });
  assert.equal(s.includes("undefined"), false);
  assert.equal(s.includes("NaN"), false);
  assert.equal(s, "cutoff default · reveal default · Free");
});

// --- shiftEndPreservingDuration (TM-1208) -------------------------------------------------------
// When Start moves, End slides by the same delta so the event keeps its length (and never ends before it
// starts). Pure wall-clock math on datetime-local strings; null = "leave End as-is".

test("shiftEndPreservingDuration: pushing Start later slides End by the same delta (the reported bug)", () => {
  // 18:30–20:30 (2h). Move Start to 21:00 → End becomes 23:00, still 2h.
  assert.equal(
    shiftEndPreservingDuration("2026-08-02T18:30", "2026-08-02T21:00", "2026-08-02T20:30"),
    "2026-08-02T23:00",
  );
});

test("shiftEndPreservingDuration: moving Start earlier slides End earlier too, preserving length", () => {
  // 18:00–19:30 (1.5h). Move Start to 16:00 → End 17:30.
  assert.equal(
    shiftEndPreservingDuration("2026-08-02T18:00", "2026-08-02T16:00", "2026-08-02T19:30"),
    "2026-08-02T17:30",
  );
});

test("shiftEndPreservingDuration: a multi-day duration rolls the date correctly", () => {
  // 2h event on the 2nd, move Start forward by 1 day + 3h → End rolls the date with it.
  assert.equal(
    shiftEndPreservingDuration("2026-08-02T18:30", "2026-08-03T21:30", "2026-08-02T20:30"),
    "2026-08-03T23:30",
  );
});

test("shiftEndPreservingDuration: crossing midnight keeps the 2h length onto the next day", () => {
  // 23:00–01:00 next day (2h). Move Start to 23:30 → End 01:30 next day.
  assert.equal(
    shiftEndPreservingDuration("2026-08-02T23:00", "2026-08-02T23:30", "2026-08-03T01:00"),
    "2026-08-03T01:30",
  );
});

test("shiftEndPreservingDuration: blank End → null (End is optional, never invent one)", () => {
  assert.equal(shiftEndPreservingDuration("2026-08-02T18:30", "2026-08-02T21:00", ""), null);
});

test("shiftEndPreservingDuration: blank / unparseable Start → null (no delta to apply)", () => {
  assert.equal(shiftEndPreservingDuration("", "2026-08-02T21:00", "2026-08-02T20:30"), null);
  assert.equal(shiftEndPreservingDuration("2026-08-02T18:30", "not-a-date", "2026-08-02T20:30"), null);
});

test("shiftEndPreservingDuration: Start unchanged → null (nothing to do)", () => {
  assert.equal(shiftEndPreservingDuration("2026-08-02T18:30", "2026-08-02T18:30", "2026-08-02T20:30"), null);
});

test("shiftEndPreservingDuration: End not after Start (no positive duration) → null (leave it alone)", () => {
  // End equals Start (0-length) or End before Start (already invalid) — don't shift it further.
  assert.equal(shiftEndPreservingDuration("2026-08-02T18:30", "2026-08-02T21:00", "2026-08-02T18:30"), null);
  assert.equal(shiftEndPreservingDuration("2026-08-02T18:30", "2026-08-02T21:00", "2026-08-02T17:00"), null);
});

// --- all-section collapsed summaries (TM-1209) --------------------------------------------------
// Basics / When / Where now carry a collapsed-header summary too (previously only Who-can-join /
// Booking-rules did). Pure + defaults-aware, same " · " style.

test("basicsSummary: names the event + its format", () => {
  assert.equal(basicsSummary({ heading: "Coffee Morning", format: "in-person" }), "Coffee Morning · in person");
});
test("basicsSummary: an online event reads 'online'", () => {
  assert.equal(basicsSummary({ heading: "Virtual Standup", format: "online" }), "Virtual Standup · online");
});
test("basicsSummary: unnamed event falls back to the format word alone (never empty/undefined)", () => {
  assert.equal(basicsSummary({ heading: "", format: "in-person" }), "in person");
  assert.equal(basicsSummary({}), "in person");
});

test("whenSummary: same-day event shows a compact date + time range", () => {
  assert.equal(whenSummary({ startAt: "2026-08-02T18:30", endAt: "2026-08-02T20:30" }), "2 Aug, 18:30–20:30");
});
test("whenSummary: no end → just the start", () => {
  assert.equal(whenSummary({ startAt: "2026-08-02T18:30" }), "2 Aug, 18:30");
});
test("whenSummary: an event crossing into the next day spells out the end date", () => {
  assert.equal(whenSummary({ startAt: "2026-08-02T23:00", endAt: "2026-08-03T01:00" }), "2 Aug, 23:00 → 3 Aug, 01:00");
});
test("whenSummary: no start set → 'no date set' (never a raw blank / undefined)", () => {
  assert.equal(whenSummary({}), "no date set");
  assert.equal(whenSummary({ startAt: "" }), "no date set");
});

test("whereSummary: online event reads 'Online' regardless of any stale location text", () => {
  assert.equal(whereSummary({ format: "online", locationText: "old hall" }), "Online");
});
test("whereSummary: in-person shows the location, falling back to the city", () => {
  assert.equal(whereSummary({ format: "in-person", locationText: "Community Hall" }), "Community Hall");
  assert.equal(whereSummary({ format: "in-person", locationText: "", city: "London" }), "London");
});
test("whereSummary: nothing set → 'no location' (never empty)", () => {
  assert.equal(whereSummary({ format: "in-person" }), "no location");
});
