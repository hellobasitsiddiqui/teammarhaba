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
  HEADING_MAX,
  DESCRIPTION_MAX,
  LOCATION_MAX,
  URL_MAX,
  CITY_MAX,
  CAPACITY_MIN,
  REVEAL_HOURS_MIN,
  REVEAL_HOURS_MAX,
  AGE_MIN_BOUND,
  AGE_MAX_BOUND,
  CATEGORY_CHIPS,
  isValidTimeZone,
  guessTimeZone,
  zonedToUtcIso,
  utcIsoToZoned,
  validateEventDraft,
  buildEventPayload,
  toFormModel,
  eventLifecycle,
  capacityLabel,
  attendanceCounts,
  revealSummary,
  formatEventWhen,
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
