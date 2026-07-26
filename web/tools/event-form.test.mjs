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
  OPENING_MESSAGE_MAX,
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
  clearedOptionalFields,
  CLEARABLE_OPTIONAL_FIELDS,
  toFormModel,
  eventLifecycle,
  capacityLabel,
  attendanceCounts,
  revealSummary,
  formatEventWhen,
  isPastEvent,
  partitionEventsByPast,
  matchesStatusFilter,
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
  ageBandToMinMax,
  minMaxToAgeBand,
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
  // finishes it. With the authoritative `past` flag it follows the server verdict; without it, the
  // endAt-only fallback keeps it live (Visible) rather than mislabelling it Finished at start.
  const openEndedStarted = {
    ...base,
    endAt: null,
    startAt: "2026-07-10T18:00:00.000Z",
    visibilityEnd: "2026-07-31T00:00:00.000Z", // still within its listing window
  };
  const justStarted = "2026-07-10T18:30:00Z"; // 30 min after start, no endAt
  assert.equal(eventLifecycle(openEndedStarted, justStarted).label, "Visible", "open-ended not finished at start");
  // The server's authoritative `past` flag still wins when it says the open-ended event has ended.
  assert.equal(
    eventLifecycle({ ...openEndedStarted, past: true }, justStarted).label,
    "Finished",
    "server past flag finishes it",
  );
});

test("isPastEvent prefers the server `past` flag, falls back to the instants (TM-518)", () => {
  // The authoritative signal is the projection's own `past` boolean — trusted over the instants.
  assert.equal(isPastEvent({ past: true, startAt: "2999-01-01T00:00:00Z" }), true, "flag wins over a future start");
  assert.equal(isPastEvent({ past: false, endAt: "2000-01-01T00:00:00Z" }), false, "flag wins over a past end");

  // Fallback (no flag): ended once now ≥ endAt; open-ended uses startAt.
  const now = "2026-07-11T00:00:00Z";
  assert.equal(isPastEvent({ startAt: "2026-07-10T18:00:00Z", endAt: "2026-07-10T20:00:00Z" }, now), true);
  assert.equal(isPastEvent({ startAt: "2026-07-20T18:00:00Z", endAt: "2026-07-20T20:00:00Z" }, now), false);
  assert.equal(isPastEvent({ startAt: "2026-07-10T18:00:00Z", endAt: null }, now), true, "open-ended: past its start");
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
