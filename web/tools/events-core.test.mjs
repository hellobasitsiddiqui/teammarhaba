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
  countdownText,
  myStateChip,
  goingBadge,
  waitlistBadge,
  initials,
  isHappeningNow,
  isFinished,
  listingBuckets,
  locationView,
  ageBand,
  ageBandLabel,
  ageEligibility,
  bookingWindow,
  wouldLandGoing,
  activeGoingConflict,
  rsvpControlModel,
  commandErrorMessage,
  isFull,
  listCountPill,
  listCtaState,
  attendanceSummary,
  eventFilters,
  filterCards,
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
  assert.equal(isHappeningNow({ isHappeningNow: true }), true, "explicit bool wins");
  assert.equal(isHappeningNow({ isHappeningNow: false, startAt: "2000-01-01T00:00:00Z" }), false);
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

test("listingBuckets: splits happening-now vs upcoming, preserves order, drops finished, tolerates junk", () => {
  const cards = [
    { id: 1, startAt: "2026-07-05T11:00:00Z", endAt: "2026-07-05T13:00:00Z" }, // live
    { id: 2, startAt: "2026-07-05T18:00:00Z" }, // upcoming
    { id: 3, startAt: "2026-07-06T09:00:00Z" }, // upcoming (later)
    { id: 4, status: "FINISHED" }, // dropped
  ];
  const { happeningNow, upcoming } = listingBuckets(cards, NOON_UTC);
  assert.deepEqual(happeningNow.map((c) => c.id), [1]);
  assert.deepEqual(upcoming.map((c) => c.id), [2, 3], "order preserved (soonest-first)");
  const empty = listingBuckets(null, NOON_UTC);
  assert.deepEqual(empty, { happeningNow: [], upcoming: [] });
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
    { myState: "NONE", isHappeningNow: true },
  ];
  assert.deepEqual(eventFilters(cards, NOON_UTC).map((c) => c.key), ["all", "going", "waitlisted", "live"]);
  assert.deepEqual(eventFilters([], NOON_UTC), [{ key: "all", label: "All" }]);
});

test("filterCards: filters by status/live; 'all'/unknown returns the list unchanged", () => {
  const cards = [
    { id: 1, myState: "GOING" },
    { id: 2, myState: "WAITLISTED" },
    { id: 3, myState: "NONE", isHappeningNow: true },
    { id: 4, myState: "NONE" },
  ];
  assert.deepEqual(filterCards(cards, "going", NOON_UTC).map((c) => c.id), [1]);
  assert.deepEqual(filterCards(cards, "waitlisted", NOON_UTC).map((c) => c.id), [2]);
  assert.deepEqual(filterCards(cards, "live", NOON_UTC).map((c) => c.id), [3]);
  assert.deepEqual(filterCards(cards, "all", NOON_UTC).map((c) => c.id), [1, 2, 3, 4]);
  assert.deepEqual(filterCards(cards, "bogus", NOON_UTC).map((c) => c.id), [1, 2, 3, 4]);
});
