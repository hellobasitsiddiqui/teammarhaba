// Tests for the pure events logic core (TM-396). Framework-free — Node's built-in test runner,
// picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// events-core.js has zero DOM/fetch/browser deps, so the whole behaviour is asserted here: local-time
// formatting (incl. DST + cross-timezone edges), state chips/badges, the browse listing split
// (TM-412), the reveal-aware location view (TM-408), the age/cutoff/one-active-event eligibility gates
// (TM-413/TM-415) and the composed RSVP control model that the detail view renders verbatim.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatWhen,
  formatDateLong,
  formatTime,
  describeWhen,
  zoneCityLabel,
  countdownText,
  myStateChip,
  goingBadge,
  waitlistBadge,
  initials,
  isHappeningNow,
  isFinished,
  listingBuckets,
  locationView,
  directionsUrl,
  directionsModel,
  DIRECTIONS_LABEL,
  ageBand,
  ageBandLabel,
  ageEligibility,
  bookingWindow,
  wouldLandGoing,
  activeGoingConflict,
  rsvpControlModel,
  leaveConfirmModel,
  commandErrorMessage,
  isFull,
  listCountPill,
  listCtaState,
  attendanceSummary,
  eventFilters,
  filterCards,
  browseListModel,
  ENTITLEMENT_DECISION,
  requiresPaidCheckout,
} from "../src/assets/events-core.js";

const NOON_UTC = Date.parse("2026-07-05T12:00:00Z");

// ------------------------------------------------------------------ time formatting

test("formatWhen: renders a UTC instant in the given zone, DST-correct", () => {
  // Summer: 17:00Z is 18:00 in London (BST, +1).
  assert.match(formatWhen("2026-07-05T17:00:00Z", { tz: "Europe/London" }), /5 Jul 2026, 18:00/);
  // Winter: 18:00Z is 18:00 in London (GMT, +0) — the DST edge the same instant flips across.
  assert.match(formatWhen("2026-01-05T18:00:00Z", { tz: "Europe/London" }), /5 Jan 2026, 18:00/);
  // Same absolute instant, a different viewer zone → a different wall-clock time.
  assert.match(formatWhen("2026-07-05T17:00:00Z", { tz: "America/New_York" }), /5 Jul 2026, 13:00/);
});

test("formatWhen: invalid / missing instant → empty string (never 'Invalid Date')", () => {
  assert.equal(formatWhen(null, { tz: "Europe/London" }), "");
  assert.equal(formatWhen(undefined), "");
  assert.equal(formatWhen("not-a-date", { tz: "Europe/London" }), "");
});

test("formatDateLong / formatTime: long date + 24h time in zone", () => {
  assert.match(formatDateLong("2026-07-05T17:00:00Z", { tz: "Europe/London" }), /Sunday, 5 July 2026/);
  assert.equal(formatTime("2026-07-05T17:00:00Z", { tz: "Europe/London" }), "18:00");
  assert.equal(formatTime("bad", { tz: "Europe/London" }), "");
});

test("describeWhen: viewer-local time, and an event-local line only when the zones differ", () => {
  const same = describeWhen("2026-07-05T17:00:00Z", null, "Europe/London", { viewerTz: "Europe/London" });
  assert.equal(same.showEventLocal, false, "same zone → no event-local line");
  assert.match(same.date, /Sunday, 5 July 2026/);
  assert.equal(same.time, "18:00");
  assert.equal(same.hasEnd, false);

  const cross = describeWhen("2026-07-05T17:00:00Z", null, "America/New_York", { viewerTz: "Europe/London" });
  assert.equal(cross.showEventLocal, true, "different zone → surface the event-local time");
  assert.equal(cross.eventLocalTime, "13:00");
  // TM-613: the event's zone is shown as a friendly place, never the raw IANA id ("America/New_York").
  assert.equal(cross.eventTzCity, "New York");
});

test("zoneCityLabel: friendly place from an IANA id — last segment, underscores → spaces", () => {
  assert.equal(zoneCityLabel("America/New_York"), "New York");
  assert.equal(zoneCityLabel("Europe/London"), "London");
  assert.equal(zoneCityLabel("America/Argentina/Buenos_Aires"), "Buenos Aires");
  assert.equal(zoneCityLabel(""), "");
  assert.equal(zoneCityLabel(null), "");
});

test("describeWhen: same-day end → a time range; invalid start → empty", () => {
  const ranged = describeWhen(
    "2026-07-05T17:00:00Z",
    "2026-07-05T19:00:00Z",
    "Europe/London",
    { viewerTz: "Europe/London" },
  );
  assert.equal(ranged.hasEnd, true);
  assert.equal(ranged.time, "18:00 – 20:00");

  const bad = describeWhen("nope", null, "Europe/London", { viewerTz: "Europe/London" });
  assert.equal(bad.date, "");
  assert.equal(bad.time, "");
});

test("countdownText: minute / hour / day buckets, and non-positive → 'now'", () => {
  assert.equal(countdownText(30 * 60000), "in 30 min");
  assert.equal(countdownText(3 * 3600000), "in 3 h");
  assert.equal(countdownText(50 * 3600000), "in 2 days");
  assert.equal(countdownText(0), "now");
  assert.equal(countdownText(-5000), "now");
});

// ------------------------------------------------------------------ chips + badges

test("myStateChip: GOING / WAITLISTED render; NONE + unknown → null", () => {
  assert.deepEqual(myStateChip("GOING"), { state: "GOING", label: "✓ Going", cls: "tm-event-chip-going" });
  assert.equal(myStateChip("WAITLISTED").label, "Waitlisted");
  assert.equal(myStateChip("NONE"), null);
  assert.equal(myStateChip(undefined), null);
});

test("goingBadge / waitlistBadge: counts + warm empty copy + pluralisation", () => {
  assert.equal(goingBadge(0), "Be the first to go");
  assert.equal(goingBadge(1), "1 going");
  assert.equal(goingBadge(12), "12 going");
  assert.equal(waitlistBadge(0), "");
  assert.equal(waitlistBadge(1), "1 on the waitlist");
  assert.equal(waitlistBadge(4), "4 on the waitlist");
});

test("initials: one word, two words, empty/unknown", () => {
  assert.equal(initials("Amal"), "AM");
  assert.equal(initials("Bilal Khan"), "BK");
  assert.equal(initials("  Chandra  Rao "), "CR");
  assert.equal(initials(""), "?");
  assert.equal(initials(null), "?");
});

// ------------------------------------------------------------------ listing states (TM-412)

test("isHappeningNow: API signal wins; else derived from the instants", () => {
  // The API field is `happeningNow` (EventCard/EventDetail) — the preferred boolean must read that
  // exact name, not `isHappeningNow` (TM-525), so a live event surfaced by the server is trusted.
  assert.equal(isHappeningNow({ happeningNow: true }), true, "explicit bool wins");
  assert.equal(isHappeningNow({ happeningNow: false, startAt: "2000-01-01T00:00:00Z" }), false);
  // The old wrong key is ignored — it must fall through to the derivation, not be read as the signal.
  assert.equal(isHappeningNow({ isHappeningNow: true, startAt: "2099-01-01T00:00:00Z" }), false, "wrong key ignored");
  assert.equal(isHappeningNow({ status: "HAPPENING_NOW" }), true);
  assert.equal(isHappeningNow({ status: "UPCOMING", startAt: "2000-01-01T00:00:00Z" }), false);
  // Derived: started an hour ago, ends in an hour → live.
  assert.equal(
    isHappeningNow({ startAt: "2026-07-05T11:00:00Z", endAt: "2026-07-05T13:00:00Z" }, NOON_UTC),
    true,
  );
  // Not started yet → not live.
  assert.equal(isHappeningNow({ startAt: "2026-07-05T18:00:00Z" }, NOON_UTC), false);
  // Started, open-ended, still listed → treated as live.
  assert.equal(isHappeningNow({ startAt: "2026-07-05T11:00:00Z", endAt: null }, NOON_UTC), true);
});

test("isFinished: status or a past end; open-ended is never client-side finished", () => {
  assert.equal(isFinished({ status: "FINISHED" }), true);
  assert.equal(isFinished({ endAt: "2026-07-05T11:00:00Z" }, NOON_UTC), true);
  assert.equal(isFinished({ endAt: "2026-07-05T13:00:00Z" }, NOON_UTC), false);
  assert.equal(isFinished({ startAt: "2000-01-01T00:00:00Z", endAt: null }, NOON_UTC), false);
});

test("listingBuckets: splits happening-now vs upcoming vs past (TM-518), preserves order, tolerates junk", () => {
  const cards = [
    { id: 1, startAt: "2026-07-05T11:00:00Z", endAt: "2026-07-05T13:00:00Z" }, // live
    { id: 2, startAt: "2026-07-05T18:00:00Z" }, // upcoming
    { id: 3, startAt: "2026-07-06T09:00:00Z" }, // upcoming (later)
    { id: 4, status: "FINISHED" }, // past (tagged)
    { id: 5, startAt: "2026-07-05T08:00:00Z", endAt: "2026-07-05T10:00:00Z" }, // past (ended before noon)
  ];
  const { happeningNow, upcoming, past } = listingBuckets(cards, NOON_UTC);
  assert.deepEqual(happeningNow.map((c) => c.id), [1]);
  assert.deepEqual(upcoming.map((c) => c.id), [2, 3], "active order preserved (soonest-first)");
  assert.deepEqual(past.map((c) => c.id), [4, 5], "finished events land in past (API order preserved), not dropped");
  const empty = listingBuckets(null, NOON_UTC);
  assert.deepEqual(empty, { happeningNow: [], upcoming: [], past: [] });
});

// ------------------------------------------------------------------ location reveal (TM-408)

test("locationView: pre-reveal shows approximate city + a countdown note, withholds exact + links", () => {
  const v = locationView(
    { locationRevealed: false, city: "Shoreditch, London", locationRevealsAt: "2026-07-05T18:00:00Z", mapUrl: "x", onlineUrl: "y" },
    NOON_UTC,
  );
  assert.equal(v.revealed, false);
  assert.equal(v.approximate, true);
  assert.equal(v.primary, "Shoreditch, London");
  assert.match(v.note, /Exact location revealed in 6 h/);
  assert.equal(v.mapUrl, null, "exact links withheld before reveal");
  assert.equal(v.onlineUrl, null);
});

test("locationView: pre-reveal without city / without revealsAt → neutral placeholder + static note", () => {
  const noCity = locationView({ locationRevealed: false }, NOON_UTC);
  assert.equal(noCity.primary, "Location shared ~24h before the event");
  assert.match(noCity.note, /revealed 24h before/);
  assert.equal(noCity.countdownMs, null);
});

test("locationView: revealed → exact text + map/online links", () => {
  const v = locationView(
    { locationRevealed: true, locationText: "Marhaba Cafe, 5 High St", mapUrl: "https://maps/x", onlineUrl: "https://meet/y" },
    NOON_UTC,
  );
  assert.equal(v.revealed, true);
  assert.equal(v.primary, "Marhaba Cafe, 5 High St");
  assert.equal(v.mapUrl, "https://maps/x");
  assert.equal(v.onlineUrl, "https://meet/y");
});

test("locationView: reveal fields absent (pre-TM-408 API) → treated as revealed with what we have", () => {
  const legacy = locationView({ locationText: "Marhaba Cafe" }, NOON_UTC);
  assert.equal(legacy.revealed, true);
  assert.equal(legacy.primary, "Marhaba Cafe");
  const nothing = locationView({}, NOON_UTC);
  assert.equal(nothing.primary, "Location shared ~24h before the event", "no location at all → placeholder, not blank");
});

// ------------------------------------------------------------------ open in maps / directions (TM-487)

test("directionsUrl: a curated mapUrl wins verbatim on EVERY platform", () => {
  const map = "https://maps.example/venue/42";
  assert.equal(directionsUrl({ mapUrl: map, query: "ignored" }, "IOS"), map);
  assert.equal(directionsUrl({ mapUrl: map, query: "ignored" }, "ANDROID"), map);
  assert.equal(directionsUrl({ mapUrl: map, query: "ignored" }, "WEB"), map);
  // Surrounding whitespace is trimmed, but the link is otherwise untouched.
  assert.equal(directionsUrl({ mapUrl: `  ${map}  ` }, "WEB"), map);
});

test("directionsUrl: no mapUrl → a platform-correct query deep-link, URL-encoded", () => {
  const q = "Marhaba Cafe, 5 High St, London";
  const enc = encodeURIComponent(q);
  assert.equal(directionsUrl({ query: q }, "IOS"), `https://maps.apple.com/?q=${enc}`);
  assert.equal(directionsUrl({ query: q }, "ANDROID"), `geo:0,0?q=${enc}`);
  assert.equal(directionsUrl({ query: q }, "WEB"), `https://www.google.com/maps/search/?api=1&query=${enc}`);
  // An unknown / absent platform falls through to the web (Google Maps https) link — the safe default.
  assert.equal(directionsUrl({ query: q }, "DESKTOP"), `https://www.google.com/maps/search/?api=1&query=${enc}`);
  assert.equal(directionsUrl({ query: q }), `https://www.google.com/maps/search/?api=1&query=${enc}`);
  // The encoding is real, not cosmetic: spaces/commas never leak through raw.
  assert.ok(!directionsUrl({ query: q }, "WEB").includes(" "));
});

test("directionsUrl: nothing to point at (no mapUrl, blank/absent query) → null", () => {
  assert.equal(directionsUrl({ query: "   " }, "IOS"), null);
  assert.equal(directionsUrl({ mapUrl: "  " }, "ANDROID"), null);
  assert.equal(directionsUrl({}, "WEB"), null);
  assert.equal(directionsUrl(undefined, "WEB"), null);
});

test("directionsModel: hidden before reveal (never leaks the venue), even if a link exists", () => {
  const m = directionsModel(
    { locationRevealed: false, city: "Shoreditch, London", locationText: "Secret Venue", mapUrl: "https://maps/x" },
    "IOS",
    NOON_UTC,
  );
  assert.equal(m.show, false);
  assert.equal(m.href, null);
  assert.equal(m.label, DIRECTIONS_LABEL);
});

test("directionsModel: revealed + mapUrl → shows the curated link (platform-agnostic)", () => {
  const m = directionsModel(
    { locationRevealed: true, locationText: "Marhaba Cafe", mapUrl: "https://maps/x" },
    "ANDROID",
    NOON_UTC,
  );
  assert.deepEqual(m, { show: true, href: "https://maps/x", label: DIRECTIONS_LABEL });
});

test("directionsModel: revealed, no mapUrl → builds a platform-correct link from the location text", () => {
  const detail = { locationRevealed: true, locationText: "Marhaba Cafe, 5 High St" };
  const enc = encodeURIComponent("Marhaba Cafe, 5 High St");
  assert.equal(directionsModel(detail, "IOS", NOON_UTC).href, `https://maps.apple.com/?q=${enc}`);
  assert.equal(directionsModel(detail, "ANDROID", NOON_UTC).href, `geo:0,0?q=${enc}`);
  assert.equal(directionsModel(detail, "WEB", NOON_UTC).href, `https://www.google.com/maps/search/?api=1&query=${enc}`);
});

test("directionsModel: legacy API (no reveal fields) is treated as revealed; city is the fallback query", () => {
  // Pre-TM-408 event with only a city → still a usable directions link (degrades exact → city).
  const enc = encodeURIComponent("Shoreditch, London");
  assert.equal(directionsModel({ city: "Shoreditch, London" }, "WEB", NOON_UTC).href, `https://www.google.com/maps/search/?api=1&query=${enc}`);
  // Revealed but no venue at all (online-only / placeholder) → no button.
  assert.equal(directionsModel({ locationRevealed: true }, "WEB", NOON_UTC).show, false);
  assert.equal(directionsModel({}, "WEB", NOON_UTC).show, false);
});

// ------------------------------------------------------------------ age band (TM-415)

test("ageBand / ageBandLabel: both bounds, open bounds, alternate field names, none", () => {
  assert.deepEqual(ageBand({ ageMin: 25, ageMax: 30 }), { min: 25, max: 30 });
  assert.deepEqual(ageBand({ minAge: 21, maxAge: 35 }), { min: 21, max: 35 });
  assert.deepEqual(ageBand({ ageBand: { min: 18, max: 25 } }), { min: 18, max: 25 });
  assert.equal(ageBand({}), null);
  assert.equal(ageBandLabel({ ageMin: 25, ageMax: 30 }), "Ages 25–30");
  assert.equal(ageBandLabel({ ageMin: 25 }), "Ages 25+");
  assert.equal(ageBandLabel({ ageMax: 30 }), "Ages up to 30");
  assert.equal(ageBandLabel({}), null);
});

test("ageEligibility: no band → ok; unset age → unset; ±2 tolerance boundary; outside", () => {
  assert.equal(ageEligibility({}, { age: 40 }).status, "ok", "no band → always ok");
  assert.equal(ageEligibility({ ageMin: 25, ageMax: 30 }, {}).status, "unset", "no profile age → unset");
  assert.equal(ageEligibility({ ageMin: 25, ageMax: 30 }, { age: null }).status, "unset");
  // Band 25–30, ±2 → eligible window [23, 32].
  assert.equal(ageEligibility({ ageMin: 25, ageMax: 30 }, { age: 23 }).status, "ok", "lower edge inclusive");
  assert.equal(ageEligibility({ ageMin: 25, ageMax: 30 }, { age: 32 }).status, "ok", "upper edge inclusive");
  assert.equal(ageEligibility({ ageMin: 25, ageMax: 30 }, { age: 22 }).status, "outside");
  assert.equal(ageEligibility({ ageMin: 25, ageMax: 30 }, { age: 33 }).status, "outside");
  // Open-ended bands.
  assert.equal(ageEligibility({ ageMin: 40 }, { age: 100 }).status, "ok");
  assert.equal(ageEligibility({ ageMax: 18 }, { age: 25 }).status, "outside");
});

test("ageEligibility: prefers the server's ageEligible verdict over the local ±tolerance re-derivation (TM-525)", () => {
  // The server's own verdict is authoritative — when present it decides ok/outside, NOT the client's
  // band±tolerance test, so the two can never drift on the tolerance.
  const banded = { ageMin: 25, ageMax: 30 };
  // Age 40 sits well outside the local [23,32] window, yet a server verdict of true wins → ok.
  assert.equal(ageEligibility({ ...banded, ageEligible: true }, { age: 40 }).status, "ok", "server true wins");
  // Age 27 sits inside the local window, yet a server verdict of false wins → outside.
  assert.equal(ageEligibility({ ...banded, ageEligible: false }, { age: 27 }).status, "outside", "server false wins");
  // Unset age is still detected locally (the fixable "add your age" state), even though the server
  // would collapse it into ageEligible=false — the UI needs the distinct state.
  assert.equal(ageEligibility({ ...banded, ageEligible: false }, { age: null }).status, "unset", "unset stays local");
  // A non-boolean/absent verdict (a listing card, or an older API) falls back to the local test.
  assert.equal(ageEligibility({ ...banded, ageEligible: null }, { age: 27 }).status, "ok", "null → local fallback");
  assert.equal(ageEligibility(banded, { age: 22 }).status, "outside", "absent → local fallback");
});

// ------------------------------------------------------------------ booking window (TM-413)

test("bookingWindow: open / within-cutoff / started, explicit bookingClosesAt, custom cutoff", () => {
  const start = "2026-07-05T18:00:00Z"; // 6h after NOON_UTC
  assert.deepEqual(
    { ...bookingWindow({ startAt: start }, NOON_UTC), cutoffAtMs: 0, startMs: 0 },
    { started: false, closed: false, cutoffAtMs: 0, startMs: 0 },
    "6h out → open",
  );
  // 30 min before start → within the 1h cutoff.
  const soon = bookingWindow({ startAt: "2026-07-05T12:30:00Z" }, NOON_UTC);
  assert.equal(soon.closed, true);
  assert.equal(soon.started, false);
  // Already started.
  const started = bookingWindow({ startAt: "2026-07-05T11:00:00Z" }, NOON_UTC);
  assert.equal(started.started, true);
  assert.equal(started.closed, true);
  // Explicit API cutoff overrides the derived one.
  const explicit = bookingWindow({ startAt: start, bookingClosesAt: "2026-07-05T11:00:00Z" }, NOON_UTC);
  assert.equal(explicit.closed, true, "explicit bookingClosesAt in the past → closed even though start is 6h out");
  // Custom cutoff minutes.
  const wide = bookingWindow({ startAt: "2026-07-05T14:00:00Z" }, NOON_UTC, { cutoffMinutes: 180 });
  assert.equal(wide.closed, true, "3h cutoff and start is 2h out → closed");
});

test("wouldLandGoing: free spot + no waitlist → going; full or waitlisted → not", () => {
  assert.equal(wouldLandGoing({ capacity: 10, goingCount: 3, waitlistedCount: 0 }), true);
  assert.equal(wouldLandGoing({ capacity: 3, goingCount: 3, waitlistedCount: 0 }), false, "at capacity");
  assert.equal(wouldLandGoing({ capacity: 10, goingCount: 3, waitlistedCount: 1 }), false, "waitlist exists → queue");
  assert.equal(wouldLandGoing({ capacity: null, goingCount: 999, waitlistedCount: 0 }), true, "unlimited");
});

test("activeGoingConflict: explicit hint, derived from cards, ignores self + finished", () => {
  const detail = { id: 1 };
  assert.deepEqual(
    activeGoingConflict({ id: 1, activeGoingEvent: { id: 9, heading: "Rooftop BBQ" } }),
    { blocked: true, event: { id: 9, heading: "Rooftop BBQ" } },
  );
  const cards = [
    { id: 1, myState: "GOING" }, // self — ignored
    { id: 2, myState: "GOING", heading: "Picnic in the Park" }, // the conflict
  ];
  assert.deepEqual(activeGoingConflict(detail, cards, NOON_UTC), {
    blocked: true,
    event: { id: 2, heading: "Picnic in the Park" },
  });
  assert.equal(activeGoingConflict(detail, [{ id: 3, myState: "WAITLISTED" }], NOON_UTC).blocked, false);
  assert.equal(
    activeGoingConflict(detail, [{ id: 4, myState: "GOING", status: "FINISHED" }], NOON_UTC).blocked,
    false,
    "a finished GOING event is not an active conflict",
  );
});

// ------------------------------------------------------------------ the RSVP control model

const OPEN_DETAIL = { id: 1, startAt: "2026-07-05T18:00:00Z", capacity: 10, goingCount: 3, waitlistedCount: 0, myState: "NONE" };

test("control: NONE + open + eligible → enabled RSVP with confirm + reminder note", () => {
  const m = rsvpControlModel({ detail: OPEN_DETAIL, me: { age: 27 }, nowMs: NOON_UTC });
  assert.equal(m.primary.kind, "rsvp");
  assert.equal(m.primary.disabled, false);
  assert.equal(m.primary.label, "RSVP — I'm going");
  assert.ok(m.primary.confirm, "RSVP confirms");
  assert.match(m.primary.confirm.message, /remind you the day before/);
  assert.equal(m.chip, null);
});

test("control: a finished event is read-only — no action, keeps the ✓ Going chip as history, says it ended (TM-518)", () => {
  // A past GOING attendee: chip stays (history), but there is NO cancel/leave/RSVP action to take.
  const finishedGoing = { ...OPEN_DETAIL, status: "FINISHED", myState: "GOING", goingCount: 4 };
  const m = rsvpControlModel({ detail: finishedGoing, me: { age: 27 }, nowMs: NOON_UTC });
  assert.equal(m.primary, null, "no actionable primary on a finished event");
  assert.equal(m.secondary, null);
  assert.deepEqual(m.chip, { state: "GOING", label: "✓ Going", cls: "tm-event-chip-going" }, "history chip kept");
  assert.equal(m.remindNote, "This event has ended.");

  // Also read-only for a NONE viewer (an event that ended by its endAt, no status tag needed).
  const endedByTime = { ...OPEN_DETAIL, startAt: "2026-07-05T08:00:00Z", endAt: "2026-07-05T10:00:00Z" };
  const none = rsvpControlModel({ detail: endedByTime, me: { age: 27 }, nowMs: NOON_UTC });
  assert.equal(none.primary, null);
  assert.equal(none.remindNote, "This event has ended.");
});

test("control: NONE + full → enabled 'Join the waiting list' (no confirm)", () => {
  const full = { ...OPEN_DETAIL, capacity: 3, goingCount: 3 };
  const m = rsvpControlModel({ detail: full, me: { age: 27 }, nowMs: NOON_UTC });
  assert.equal(m.primary.kind, "waitlist");
  assert.equal(m.primary.disabled, false);
  assert.equal(m.primary.label, "Join the waiting list");
  assert.equal(m.primary.confirm, null);
  assert.equal(m.full, true);
});

test("control: NONE + within cutoff / started → disabled with honest time copy", () => {
  const soon = rsvpControlModel({ detail: { ...OPEN_DETAIL, startAt: "2026-07-05T12:30:00Z" }, me: { age: 27 }, nowMs: NOON_UTC });
  assert.equal(soon.primary.disabled, true);
  assert.match(soon.primary.reason, /Booking closed — this event starts in under an hour/);
  const started = rsvpControlModel({ detail: { ...OPEN_DETAIL, startAt: "2026-07-05T11:00:00Z" }, me: { age: 27 }, nowMs: NOON_UTC });
  assert.equal(started.primary.disabled, true);
  assert.match(started.primary.reason, /has started/);
});

test("control: NONE + age unset → disabled with add-your-age link to profile", () => {
  const banded = { ...OPEN_DETAIL, ageMin: 25, ageMax: 30 };
  const m = rsvpControlModel({ detail: banded, me: {}, nowMs: NOON_UTC });
  assert.equal(m.primary.disabled, true);
  assert.match(m.primary.reason, /Add your age to your profile/);
  assert.deepEqual(m.primary.link, { href: "#/profile", label: "Add your age" });
  assert.equal(m.ageBandLabel, "Ages 25–30", "the band is shown regardless");
});

test("control: NONE + age outside band → disabled naming the band", () => {
  const banded = { ...OPEN_DETAIL, ageMin: 25, ageMax: 30 };
  const m = rsvpControlModel({ detail: banded, me: { age: 40 }, nowMs: NOON_UTC });
  assert.equal(m.primary.disabled, true);
  assert.match(m.primary.reason, /for Ages 25–30/);
});

test("control: one-active-event blocks a would-be GOING RSVP (names it) but ALLOWS a second waitlist", () => {
  const cards = [{ id: 2, myState: "GOING", heading: "Rooftop BBQ", startAt: "2026-07-06T18:00:00Z" }];
  // Would land GOING → blocked, names the event.
  const going = rsvpControlModel({ detail: OPEN_DETAIL, me: { age: 27 }, cards, nowMs: NOON_UTC });
  assert.equal(going.primary.disabled, true);
  assert.match(going.primary.reason, /You're going to Rooftop BBQ until it ends/);
  // Would land WAITLISTED (event full) → allowed; note explains the second-waitlist case.
  const full = { ...OPEN_DETAIL, capacity: 3, goingCount: 3 };
  const wl = rsvpControlModel({ detail: full, me: { age: 27 }, cards, nowMs: NOON_UTC });
  assert.equal(wl.primary.disabled, false, "waitlisting a second event is allowed");
  assert.equal(wl.primary.kind, "waitlist");
  assert.match(wl.remindNote, /Rooftop BBQ/);
});

test("control: GOING → 'Cancel RSVP' primary (danger) + ✓ Going chip; disabled once closed", () => {
  const going = { ...OPEN_DETAIL, myState: "GOING", goingCount: 4 };
  const m = rsvpControlModel({ detail: going, me: { age: 27 }, nowMs: NOON_UTC });
  assert.equal(m.primary.kind, "leave");
  assert.equal(m.primary.label, "Cancel RSVP");
  assert.equal(m.primary.disabled, false);
  assert.equal(m.chip.state, "GOING");
  const closed = rsvpControlModel({ detail: { ...going, startAt: "2026-07-05T12:30:00Z" }, me: { age: 27 }, nowMs: NOON_UTC });
  assert.equal(closed.primary.disabled, true);
});

test("control: WAITLISTED without an offer → 'Leave the waiting list'", () => {
  const wl = { ...OPEN_DETAIL, myState: "WAITLISTED", capacity: 3, goingCount: 3, waitlistedCount: 2 };
  const m = rsvpControlModel({ detail: wl, me: { age: 27 }, nowMs: NOON_UTC });
  assert.equal(m.primary.kind, "leave");
  assert.equal(m.primary.label, "Leave the waiting list");
  assert.equal(m.chip.state, "WAITLISTED");
});

test("control: WAITLISTED + live claim offer → prominent claim primary + leave secondary; disabled once closed", () => {
  const claimable = { ...OPEN_DETAIL, myState: "WAITLISTED", capacity: 3, goingCount: 2, waitlistedCount: 1, spotAvailableToClaim: true };
  const m = rsvpControlModel({ detail: claimable, me: { age: 27 }, nowMs: NOON_UTC });
  assert.equal(m.primary.kind, "claim");
  assert.equal(m.primary.disabled, false);
  assert.equal(m.primary.prominent, true);
  assert.match(m.primary.label, /A spot opened — claim it/);
  assert.equal(m.secondary.kind, "leave");
  const closed = rsvpControlModel({ detail: { ...claimable, startAt: "2026-07-05T12:30:00Z" }, me: { age: 27 }, nowMs: NOON_UTC });
  assert.equal(closed.primary.disabled, true, "claim disabled once booking closes");
});

test("commandErrorMessage: prefers the backend's own 409 detail, falls back cleanly", () => {
  assert.equal(
    commandErrorMessage({ message: "That spot has already been taken — you are still on the waitlist." }),
    "That spot has already been taken — you are still on the waitlist.",
  );
  assert.equal(commandErrorMessage({}, "fallback copy"), "fallback copy");
  assert.equal(commandErrorMessage(null, "fallback copy"), "fallback copy");
});

// ------------------------------------------------------------------ wireframe affordances (TM-513)

test("isFull: at/over capacity is full; unlimited capacity is never full", () => {
  assert.equal(isFull({ capacity: 10, goingCount: 10 }), true);
  assert.equal(isFull({ capacity: 10, goingCount: 11 }), true);
  assert.equal(isFull({ capacity: 10, goingCount: 8 }), false);
  assert.equal(isFull({ capacity: null, goingCount: 999 }), false); // unlimited
  assert.equal(isFull({ goingCount: 5 }), false); // no capacity → unlimited
});

test("listCountPill: 'N going' normally, 'Full' when full and not already GOING", () => {
  assert.deepEqual(listCountPill({ goingCount: 8, capacity: 12 }), { label: "8 going", full: false });
  assert.deepEqual(listCountPill({ goingCount: 12, capacity: 12, myState: "NONE" }), { label: "Full", full: true });
  // A full event I'm already GOING to still shows my "N going" count, not "Full".
  assert.deepEqual(listCountPill({ goingCount: 12, capacity: 12, myState: "GOING" }), { label: "12 going", full: false });
  assert.deepEqual(listCountPill({ goingCount: 0, capacity: 5 }), { label: "Be the first to go", full: false });
});

test("listCtaState: mirrors the wireframe button states", () => {
  assert.deepEqual(listCtaState({ myState: "GOING" }), { label: "Going ✓", variant: "done" });
  assert.deepEqual(listCtaState({ myState: "WAITLISTED" }), { label: "Waitlisted", variant: "done" });
  assert.deepEqual(listCtaState({ myState: "NONE", capacity: 4, goingCount: 4 }), { label: "Waitlist", variant: "ghost" });
  assert.deepEqual(listCtaState({ myState: "NONE", capacity: 12, goingCount: 8 }), { label: "RSVP", variant: "primary" });
  assert.deepEqual(listCtaState({}), { label: "RSVP", variant: "primary" }); // default: joinable
});

test("listCtaState: a past event is read-only 'Ended' — wins even over a stale GOING/WAITLISTED (TM-518)", () => {
  assert.deepEqual(listCtaState({ status: "FINISHED" }, NOON_UTC), { label: "Ended", variant: "ended" });
  assert.deepEqual(
    listCtaState({ startAt: "2026-07-05T08:00:00Z", endAt: "2026-07-05T10:00:00Z" }, NOON_UTC),
    { label: "Ended", variant: "ended" },
  );
  // A finished event the caller was GOING to still reads as Ended (no RSVP/Going affordance).
  assert.deepEqual(listCtaState({ status: "FINISHED", myState: "GOING" }, NOON_UTC), { label: "Ended", variant: "ended" });
});

test("attendanceSummary: leads with the going badge; '· spots' only for finite capacity", () => {
  assert.deepEqual(attendanceSummary({ goingCount: 8, capacity: 12 }), { going: "8 going", spots: "12 spots" });
  assert.deepEqual(attendanceSummary({ goingCount: 3, capacity: null }), { going: "3 going", spots: "" });
  assert.deepEqual(attendanceSummary({ goingCount: 0, capacity: 5 }), { going: "Be the first to go", spots: "5 spots" });
});

test("eventFilters: always offers All, plus data-backed status chips only when ≥1 matches", () => {
  // No status matches → just All (so the chip row stays hidden).
  assert.deepEqual(eventFilters([{ myState: "NONE" }], NOON_UTC), [{ key: "all", label: "All" }]);
  // A GOING + a WAITLISTED + a live event → all four chips, in a stable order.
  const cards = [
    { myState: "GOING" },
    { myState: "WAITLISTED" },
    { myState: "NONE", happeningNow: true },
  ];
  assert.deepEqual(eventFilters(cards, NOON_UTC).map((c) => c.key), ["all", "going", "waitlisted", "live"]);
  assert.deepEqual(eventFilters([], NOON_UTC), [{ key: "all", label: "All" }]);
});

test("filterCards: filters by status/live; 'all'/unknown returns the list unchanged", () => {
  const cards = [
    { id: 1, myState: "GOING" },
    { id: 2, myState: "WAITLISTED" },
    { id: 3, myState: "NONE", happeningNow: true },
    { id: 4, myState: "NONE" },
  ];
  assert.deepEqual(filterCards(cards, "going", NOON_UTC).map((c) => c.id), [1]);
  assert.deepEqual(filterCards(cards, "waitlisted", NOON_UTC).map((c) => c.id), [2]);
  assert.deepEqual(filterCards(cards, "live", NOON_UTC).map((c) => c.id), [3]);
  assert.deepEqual(filterCards(cards, "all", NOON_UTC).map((c) => c.id), [1, 2, 3, 4]);
  assert.deepEqual(filterCards(cards, "bogus", NOON_UTC).map((c) => c.id), [1, 2, 3, 4]);
});

test("browseListModel: an all-finished listing is now a LIST with a Past events section (TM-518), truly-empty stays empty", () => {
  // TM-518 supersedes TM-535's all-finished→empty: the API now SURFACES finished events, so a listing
  // of only past events is a real "list" whose content IS the Past events section — not an empty state.
  const allFinished = [
    { id: 1, status: "FINISHED" },
    { id: 2, startAt: "2026-07-05T08:00:00Z", endAt: "2026-07-05T10:00:00Z" }, // ended before NOON_UTC
  ];
  const finishedModel = browseListModel(allFinished, "all", NOON_UTC);
  assert.equal(finishedModel.kind, "list");
  assert.deepEqual(finishedModel.happeningNow, []);
  assert.deepEqual(finishedModel.upcoming, []);
  assert.deepEqual(finishedModel.past.map((c) => c.id), [1, 2], "both finished cards land in the Past section");

  // Truly zero cards → still the empty state, whatever the (stale) filter key.
  assert.equal(browseListModel([], "all", NOON_UTC).kind, "empty");
  assert.equal(browseListModel(null, "going", NOON_UTC).kind, "empty");

  // A finished GOING card under the "going" filter still HAS content — it's the caller's past going
  // event, so it lands in the Past section ("list"), not a dead-end (TM-518 refines TM-535).
  const goingButEnded = [{ id: 1, myState: "GOING", startAt: "2026-07-05T08:00:00Z", endAt: "2026-07-05T10:00:00Z" }];
  const goingEndedModel = browseListModel(goingButEnded, "going", NOON_UTC);
  assert.equal(goingEndedModel.kind, "list");
  assert.deepEqual(goingEndedModel.past.map((c) => c.id), [1]);

  // A real filter that matches NOTHING in any bucket is still the filter-empty note (the chip row
  // escapes to All): filtering "live" when the only card is a future upcoming one.
  const noLive = [{ id: 1, myState: "NONE", startAt: "2026-07-05T18:00:00Z" }];
  assert.equal(browseListModel(noLive, "live", NOON_UTC).kind, "filter-empty");

  // A mixed listing is the list state, with the happening-now / upcoming / past split all intact.
  const mixed = [
    { id: 1, startAt: "2026-07-05T11:00:00Z", endAt: "2026-07-05T13:00:00Z" }, // live at NOON_UTC
    { id: 2, startAt: "2026-07-05T18:00:00Z" }, // upcoming
    { id: 3, status: "FINISHED" }, // past
  ];
  const listModel = browseListModel(mixed, "all", NOON_UTC);
  assert.equal(listModel.kind, "list");
  assert.deepEqual(listModel.happeningNow.map((c) => c.id), [1]);
  assert.deepEqual(listModel.upcoming.map((c) => c.id), [2]);
  assert.deepEqual(listModel.past.map((c) => c.id), [3]);
});

// ------------------------------------------------------------------ leave confirm copy (TM-525)

test("leaveConfirmModel: waitlist leave and plain GOING cancel show the base copy, no strike", () => {
  const wl = leaveConfirmModel({ myState: "WAITLISTED" });
  assert.deepEqual(wl, {
    title: "Leave the waiting list?",
    message: "You'll lose your place in the queue.",
    confirmLabel: "Leave",
    danger: true,
  });
  // GOING with no preview, or a free (early) preview → just the base warning, no strike notice.
  assert.equal(leaveConfirmModel({ myState: "GOING" }).message, "You'll give up your spot for this event.");
  const free = leaveConfirmModel({ myState: "GOING", preview: { preview: true, lateCancel: false, message: null } });
  assert.equal(free.message, "You'll give up your spot for this event.");
  assert.equal(free.title, "Cancel your RSVP?");
  assert.equal(free.confirmLabel, "Cancel RSVP");
});

test("leaveConfirmModel: a late-cancel preview appends the server's strike warning before confirm", () => {
  const preview = {
    preview: true,
    lateCancel: true,
    lateCancelCount: 2,
    message: "Cancelling now would count as a late cancellation — this would be your 2nd.",
  };
  const m = leaveConfirmModel({ myState: "GOING", preview });
  assert.equal(
    m.message,
    "You'll give up your spot for this event. Cancelling now would count as a late cancellation — this would be your 2nd.",
  );
  // A waitlist leave never surrenders a spot, so even a (spurious) late flag adds nothing to the queue copy.
  assert.equal(leaveConfirmModel({ myState: "WAITLISTED", preview }).message, "You'll lose your place in the queue.");
});

// ------------------------------------------------------------------ paid per-event checkout (TM-624)

test("requiresPaidCheckout: only a PAY entitlement decision routes through the paid checkout", () => {
  // PAY is the one decision that means the event costs the caller money → must detour to checkout.
  assert.equal(requiresPaidCheckout({ decision: ENTITLEMENT_DECISION.PAY, amountPence: 500 }), true);
  // FREE / INCLUDED are free to the caller — the normal (free) RSVP is correct, no checkout.
  assert.equal(requiresPaidCheckout({ decision: ENTITLEMENT_DECISION.FREE, amountPence: 0 }), false);
  assert.equal(requiresPaidCheckout({ decision: ENTITLEMENT_DECISION.INCLUDED, amountPence: 0 }), false);
  // UPGRADE is a reserved decision the backend no longer emits — treated as "not a paid charge here".
  assert.equal(requiresPaidCheckout({ decision: ENTITLEMENT_DECISION.UPGRADE }), false);
});

test("requiresPaidCheckout: an absent / malformed entitlement is never PAY (fail-safe → direct RSVP)", () => {
  // A failed lookup must NOT block the join — it falls through to the direct RSVP (backend is the gate).
  assert.equal(requiresPaidCheckout(undefined), false);
  assert.equal(requiresPaidCheckout(null), false);
  assert.equal(requiresPaidCheckout({}), false);
  assert.equal(requiresPaidCheckout({ decision: "WAT" }), false);
  assert.equal(requiresPaidCheckout({ decision: "pay" }), false); // exact enum only, not a lowered variant
});
