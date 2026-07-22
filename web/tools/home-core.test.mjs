// Unit tests for the Home screen's pure core (TM-512, reworked TM-969) — the personalized
// attending-first section view-model + the empty-home decision, refreshed to the approved wireframe
// (design-kit paper-home / paper-empty-home).
//
// Framework-free — Node's built-in test runner, picked up by the CI glob
// `node --test web/tools/*.test.mjs` (ci.yml web-build job). No DOM/Firebase, so it runs in plain Node
// exactly like events-core.test.mjs / tabbar-core.test.mjs (home-core.js imports only events-core.js,
// which is itself DOM-free).

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  homeContextLine,
  homeCardTag,
  homeRsvpState,
  homeCardModel,
  homeSections,
  bookable,
  SEE_ALL_LABEL,
} from "../src/assets/home-core.js";

// A fixed "now" and a deterministic tz/locale so time formatting is stable across CI machines.
const NOW = Date.parse("2026-07-10T12:00:00Z");
const CTX = { tz: "Europe/London", locale: "en-GB", now: NOW };

// TM-662: the feed is now scoped to the viewer's city, so the line honestly names that city as the
// scope. When the city is unknown the feed is unfiltered, so the line makes no city claim.
test("homeContextLine: names the viewer's city as the scope when we know it (TM-662)", () => {
  assert.equal(homeContextLine("Milton Keynes"), "Meetups near Milton Keynes");
  assert.equal(homeContextLine("  Bletchley  "), "Meetups near Bletchley"); // trims
});

test("homeContextLine: neutral 'Upcoming meetups near you' when the city is unknown", () => {
  assert.equal(homeContextLine(null), "Upcoming meetups near you");
  assert.equal(homeContextLine(""), "Upcoming meetups near you");
  assert.equal(homeContextLine("   "), "Upcoming meetups near you");
  assert.equal(homeContextLine(undefined), "Upcoming meetups near you");
});

test("homeContextLine: never asserts an unbacked 'this week' date bound (TM-734)", () => {
  // The feed applies no date window, so the line must not promise one.
  assert.doesNotMatch(homeContextLine("Milton Keynes"), /this week/i);
  assert.doesNotMatch(homeContextLine(null), /this week/i);
});

test("homeCardTag: reads a category from any of the plausible field shapes, else null", () => {
  assert.equal(homeCardTag({ category: "Dog walks" }), "Dog walks");
  assert.equal(homeCardTag({ type: "Tech & coffee" }), "Tech & coffee");
  assert.equal(homeCardTag({ tag: "Bouldering" }), "Bouldering");
  // The card API does not carry a category yet — absent → no chip (never fabricated).
  assert.equal(homeCardTag({ heading: "Sunday walk" }), null);
  assert.equal(homeCardTag({ category: "   " }), null);
  assert.equal(homeCardTag({}), null);
  assert.equal(homeCardTag(null), null);
});

test("homeRsvpState: maps myState to the three wireframe button variants", () => {
  assert.deepEqual(homeRsvpState("GOING"), { kind: "going", label: "Going ✓" });
  assert.deepEqual(homeRsvpState("WAITLISTED"), { kind: "waitlist", label: "Waitlist" });
  // NONE / unknown / missing all fall through to the primary RSVP call-to-action.
  assert.deepEqual(homeRsvpState("NONE"), { kind: "rsvp", label: "RSVP" });
  assert.deepEqual(homeRsvpState("SOMETHING_ELSE"), { kind: "rsvp", label: "RSVP" });
  assert.deepEqual(homeRsvpState(undefined), { kind: "rsvp", label: "RSVP" });
});

test("homeCardModel: builds the full card view-model (href, title, when, where, going, state)", () => {
  const model = homeCardModel(
    {
      id: 42,
      heading: "Coffee & Code Meetup",
      locationText: "Central Milton Keynes",
      startAt: "2026-07-14T17:30:00Z",
      goingCount: 8,
      myState: "NONE",
      category: "Tech & coffee",
    },
    CTX,
  );
  assert.equal(model.id, 42);
  assert.equal(model.href, "#/events/42");
  assert.equal(model.title, "Coffee & Code Meetup");
  assert.equal(model.where, "Central Milton Keynes");
  assert.equal(model.tag, "Tech & coffee");
  assert.equal(model.going, "8 going");
  assert.deepEqual(model.state, { kind: "rsvp", label: "RSVP" });
  assert.equal(model.live, false);
  // 'when' is a real formatted instant (not the fail-soft placeholder).
  assert.notEqual(model.when, "Date to be confirmed");
  assert.match(model.when, /2026/);
});

test("homeCardModel: fail-soft fallbacks (title, where, when) never render a blank/invalid line", () => {
  const model = homeCardModel({ id: 7 }, CTX);
  assert.equal(model.title, "Untitled event");
  assert.equal(model.where, "Location shared before the event");
  assert.equal(model.when, "Date to be confirmed"); // no startAt → placeholder, never "Invalid Date"
  assert.equal(model.tag, null);
  assert.deepEqual(model.state, { kind: "rsvp", label: "RSVP" });
});

test("homeCardModel: 'where' prefers exact locationText, then city, then the placeholder", () => {
  assert.equal(homeCardModel({ id: 1, locationText: "Willen Lake", city: "MK" }, CTX).where, "Willen Lake");
  assert.equal(homeCardModel({ id: 2, city: "Milton Keynes" }, CTX).where, "Milton Keynes");
  assert.equal(homeCardModel({ id: 3 }, CTX).where, "Location shared before the event");
});

test("homeCardModel: encodes the id into the detail href", () => {
  assert.equal(homeCardModel({ id: "a b/c" }, CTX).href, "#/events/a%20b%2Fc");
});

test("homeCardModel: GOING card carries the 'Going ✓' state + warm zero-going copy", () => {
  const model = homeCardModel({ id: 9, heading: "Sunday walk", myState: "GOING", goingCount: 0 }, CTX);
  assert.deepEqual(model.state, { kind: "going", label: "Going ✓" });
  assert.equal(model.going, "Be the first to go");
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// bookable(card, now) — the section-3 "still joinable near you" predicate (TM-969). It composes
// events-core's finished / booking-cutoff / full signals so the "Events near you" teaser never surfaces
// a dead-end event. These are the fail-before / pass-after tests for the new predicate.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

test("bookable: a fresh upcoming event with spare capacity IS bookable (TM-969)", () => {
  const card = { id: 1, startAt: "2026-07-20T18:00:00Z", capacity: 10, goingCount: 3, myState: "NONE" };
  assert.equal(bookable(card, NOW), true);
});

test("bookable: excludes finished / started / past-cutoff events (TM-969)", () => {
  // Finished (past endAt).
  assert.equal(bookable({ id: 1, startAt: "2026-07-01T09:00:00Z", endAt: "2026-07-01T11:00:00Z" }, NOW), false);
  // Explicitly finished status.
  assert.equal(bookable({ id: 2, status: "FINISHED", startAt: "2026-07-20T18:00:00Z" }, NOW), false);
  // Already started (start in the past, open-ended).
  assert.equal(bookable({ id: 3, startAt: "2026-07-10T11:00:00Z" }, NOW), false);
  // Within the 60-min booking cutoff of the start (starts 30 min after NOW) — booking is closed.
  assert.equal(bookable({ id: 4, startAt: "2026-07-10T12:30:00Z" }, NOW), false);
});

test("bookable: excludes a FULL event (at/over capacity — waitlist only, not a bookable spot) (TM-969)", () => {
  assert.equal(bookable({ id: 1, startAt: "2026-07-20T18:00:00Z", capacity: 5, goingCount: 5 }, NOW), false);
  // Unlimited capacity (no capacity field) is never full → still bookable.
  assert.equal(bookable({ id: 2, startAt: "2026-07-20T18:00:00Z", goingCount: 999 }, NOW), true);
});

test("bookable: excludes events I'm already attending / waitlisted (they aren't a 'near you' teaser) (TM-969)", () => {
  assert.equal(bookable({ id: 1, startAt: "2026-07-20T18:00:00Z", myState: "GOING" }, NOW), false);
  assert.equal(bookable({ id: 2, startAt: "2026-07-20T18:00:00Z", myState: "WAITLISTED" }, NOW), false);
});

test("bookable: defensive — null / undefined card is not bookable (TM-969)", () => {
  assert.equal(bookable(null, NOW), false);
  assert.equal(bookable(undefined, NOW), false);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// homeSections(cards, ctx) — the three ordered, collapse-aware sections (TM-969). Replaces the old
// single homeFeed view-model. These are the fail-before / pass-after tests for the grouping, the
// collapse-empties ordering, and the teaser cap.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

test("homeSections: empty for no cards, or when every card is finished (paper-empty-home state)", () => {
  assert.deepEqual(homeSections([], CTX), { isEmpty: true, sections: [] });
  assert.deepEqual(homeSections(null, CTX), { isEmpty: true, sections: [] });
  const finished = { id: 1, heading: "Old", status: "FINISHED", startAt: "2026-07-01T09:00:00Z" };
  const out = homeSections([finished], CTX);
  assert.equal(out.isEmpty, true);
  assert.equal(out.sections.length, 0);
});

test("homeSections: all three sections present stack in fixed order 1,2,3 with headers (TM-969)", () => {
  const liveMine = { id: 1, heading: "My live one", myState: "GOING", happeningNow: true, startAt: "2026-07-10T11:00:00Z" };
  const upcomingMine = { id: 2, heading: "My upcoming", myState: "GOING", startAt: "2026-07-20T18:00:00Z" };
  const nearYou = { id: 3, heading: "Bookable near me", myState: "NONE", city: "Mk", capacity: 10, goingCount: 2, startAt: "2026-07-21T18:00:00Z" };

  const out = homeSections([liveMine, upcomingMine, nearYou], { ...CTX, city: "Mk" });
  assert.equal(out.isEmpty, false);
  assert.deepEqual(out.sections.map((s) => s.key), ["happening-now", "your-events", "near-you"]);
  assert.deepEqual(out.sections.map((s) => s.header), ["Happening now", "Your events", "Events near you"]);
  // Each section carries just its own cards.
  assert.deepEqual(out.sections[0].cards.map((c) => c.id), [1]);
  assert.deepEqual(out.sections[1].cards.map((c) => c.id), [2]);
  assert.deepEqual(out.sections[2].cards.map((c) => c.id), [3]);
  // Only section 3 is the teaser and carries the "See all events →" hand-off link.
  assert.deepEqual(out.sections.map((s) => s.isTeaser), [false, false, true]);
  assert.equal(out.sections[2].seeAllHref, "#/events");
  assert.equal(SEE_ALL_LABEL, "See all events →");
});

test("homeSections: 'Happening now' = MY GOING events that are live now (not others' live events) (TM-969)", () => {
  const myLive = { id: 1, heading: "Mine live", myState: "GOING", happeningNow: true, startAt: "2026-07-10T11:00:00Z" };
  const othersLive = { id: 2, heading: "Not mine, live", myState: "NONE", happeningNow: true, startAt: "2026-07-10T11:00:00Z" };

  const out = homeSections([myLive, othersLive], CTX);
  const now = out.sections.find((s) => s.key === "happening-now");
  assert.ok(now, "the Happening now section is present");
  // Only MY live event is in it — a live event I'm not attending never lands here.
  assert.deepEqual(now.cards.map((c) => c.id), [1]);
  assert.equal(now.cards[0].live, true);
});

test("homeSections: 'Your events' = MY upcoming GOING events, no live ones (TM-969)", () => {
  const myLive = { id: 1, heading: "Mine live", myState: "GOING", happeningNow: true, startAt: "2026-07-10T11:00:00Z" };
  const myUpcoming = { id: 2, heading: "Mine soon", myState: "GOING", startAt: "2026-07-20T18:00:00Z" };

  const out = homeSections([myLive, myUpcoming], CTX);
  const yours = out.sections.find((s) => s.key === "your-events");
  assert.ok(yours, "the Your events section is present");
  assert.deepEqual(yours.cards.map((c) => c.id), [2]); // the live one is in section 1, not here
  assert.equal(yours.cards[0].live, false);
});

test("homeSections: collapse — no live-attending → section 2 (Your events) LEADS (TM-969)", () => {
  const myUpcoming = { id: 2, heading: "Mine soon", myState: "GOING", startAt: "2026-07-20T18:00:00Z" };
  const nearYou = { id: 3, heading: "Near me", myState: "NONE", city: "Mk", capacity: 10, goingCount: 1, startAt: "2026-07-21T18:00:00Z" };

  const out = homeSections([myUpcoming, nearYou], { ...CTX, city: "Mk" });
  // No 'Happening now' section (empty → collapsed, no orphan header); the first content is 'Your events'.
  assert.deepEqual(out.sections.map((s) => s.key), ["your-events", "near-you"]);
});

test("homeSections: collapse — attending NOTHING → ONLY section 3 (Events near you) shows (TM-969)", () => {
  const a = { id: 1, heading: "A near me", myState: "NONE", city: "Mk", capacity: 10, goingCount: 1, startAt: "2026-07-20T18:00:00Z" };
  const b = { id: 2, heading: "B near me", myState: "NONE", city: "Mk", capacity: 10, goingCount: 1, startAt: "2026-07-21T18:00:00Z" };

  const out = homeSections([a, b], { ...CTX, city: "Mk" });
  assert.equal(out.isEmpty, false);
  assert.deepEqual(out.sections.map((s) => s.key), ["near-you"]); // = the old today's-near-you Home
  assert.equal(out.sections[0].isTeaser, true);
});

test("homeSections: section 3 is BOOKABLE-ONLY — full / started / past-cutoff excluded (TM-969)", () => {
  const bookableOne = { id: 1, heading: "Joinable", myState: "NONE", city: "Mk", capacity: 10, goingCount: 2, startAt: "2026-07-20T18:00:00Z" };
  const full = { id: 2, heading: "Full", myState: "NONE", city: "Mk", capacity: 3, goingCount: 3, startAt: "2026-07-21T18:00:00Z" };
  const withinCutoff = { id: 3, heading: "Too late", myState: "NONE", city: "Mk", startAt: "2026-07-10T12:30:00Z" }; // 30 min out
  const finished = { id: 4, heading: "Done", myState: "NONE", city: "Mk", status: "FINISHED", startAt: "2026-07-01T09:00:00Z" };

  const out = homeSections([bookableOne, full, withinCutoff, finished], { ...CTX, city: "Mk" });
  const near = out.sections.find((s) => s.key === "near-you");
  assert.ok(near, "a bookable event yields a near-you section");
  assert.deepEqual(near.cards.map((c) => c.id), [1]); // only the genuinely joinable event
});

test("homeSections: section 3 excludes events I'm ALREADY attending (they're my events, not a teaser) (TM-969)", () => {
  const mine = { id: 1, heading: "Mine", myState: "GOING", city: "Mk", startAt: "2026-07-20T18:00:00Z" };
  const other = { id: 2, heading: "Bookable", myState: "NONE", city: "Mk", capacity: 10, goingCount: 1, startAt: "2026-07-21T18:00:00Z" };

  const out = homeSections([mine, other], { ...CTX, city: "Mk" });
  const near = out.sections.find((s) => s.key === "near-you");
  assert.deepEqual(near.cards.map((c) => c.id), [2]); // my GOING event isn't a "near you" card
  // …and it IS surfaced in section 2 instead.
  assert.deepEqual(out.sections.find((s) => s.key === "your-events").cards.map((c) => c.id), [1]);
});

// The near-you scoping (TM-662) is preserved on section 3 — the recorded bug was a London event
// surfacing under a "Mk" header.
test("homeSections: section 3 scoped to the viewer's city — other-city bookable events EXCLUDED (TM-662, preserved)", () => {
  const localMk = { id: 1, heading: "Coffee & Code", myState: "NONE", city: "Mk", capacity: 10, goingCount: 1, startAt: "2026-07-20T18:00:00Z" };
  const otherLondon = { id: 2, heading: "London thing", myState: "NONE", city: "London", capacity: 10, goingCount: 1, startAt: "2026-07-21T18:00:00Z" };

  const out = homeSections([localMk, otherLondon], { ...CTX, city: "MK" }); // case-insensitive match
  const near = out.sections.find((s) => s.key === "near-you");
  assert.deepEqual(near.cards.map((c) => c.id), [1]); // the London event never appears under an MK viewer
});

test("homeSections: section 3 — unknown viewer city degrades to the FULL unfiltered bookable listing (TM-662, preserved)", () => {
  const mk = { id: 1, heading: "A", myState: "NONE", city: "Mk", capacity: 10, goingCount: 1, startAt: "2026-07-20T18:00:00Z" };
  const london = { id: 2, heading: "B", myState: "NONE", city: "London", capacity: 10, goingCount: 1, startAt: "2026-07-21T18:00:00Z" };
  const near = homeSections([mk, london], { ...CTX, city: null }).sections.find((s) => s.key === "near-you");
  assert.deepEqual(near.cards.map((c) => c.id), [1, 2]); // no city → show everything bookable
});

test("homeSections: sections 1 & 2 (MY events) are NOT city-scoped — my RSVPs show wherever they are (TM-969)", () => {
  // My GOING events are in London, but my viewer city is Mk — I must still see my own events.
  const myLiveLondon = { id: 1, heading: "My live", myState: "GOING", happeningNow: true, city: "London", startAt: "2026-07-10T11:00:00Z" };
  const myUpcomingLondon = { id: 2, heading: "My soon", myState: "GOING", city: "London", startAt: "2026-07-20T18:00:00Z" };

  const out = homeSections([myLiveLondon, myUpcomingLondon], { ...CTX, city: "Mk" });
  assert.deepEqual(out.sections.find((s) => s.key === "happening-now").cards.map((c) => c.id), [1]);
  assert.deepEqual(out.sections.find((s) => s.key === "your-events").cards.map((c) => c.id), [2]);
});

test("homeSections: section 3 is trimmed to the teaser cap (small taste, not the full list) (TM-969)", () => {
  // 8 same-city bookable events → the near-you teaser is capped at NEAR_YOU_TEASER_MAX (3).
  const many = Array.from({ length: 8 }, (_, i) => ({
    id: i,
    heading: `E${i}`,
    myState: "NONE",
    city: "Mk",
    capacity: 10,
    goingCount: 0,
    startAt: `2026-07-${String(14 + i).padStart(2, "0")}T18:00:00Z`,
  }));
  const near = homeSections(many, { ...CTX, city: "Mk" }).sections.find((s) => s.key === "near-you");
  assert.equal(near.cards.length, 3);
  assert.equal(near.isTeaser, true);
  assert.equal(near.seeAllHref, "#/events");
});

test("homeSections: sections 1 & 2 (MY events) are NOT trimmed — all my events show (TM-969)", () => {
  // 6 of my upcoming GOING events → all show (only the near-you teaser is capped).
  const many = Array.from({ length: 6 }, (_, i) => ({
    id: i,
    heading: `M${i}`,
    myState: "GOING",
    startAt: `2026-07-${String(14 + i).padStart(2, "0")}T18:00:00Z`,
  }));
  const yours = homeSections(many, CTX).sections.find((s) => s.key === "your-events");
  assert.equal(yours.cards.length, 6); // uncapped
  assert.equal(yours.isTeaser, false);
});
