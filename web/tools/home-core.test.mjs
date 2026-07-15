// Unit tests for the Home screen's pure core (TM-512) — the "Events near you" feed view-model + the
// empty-home decision, refreshed to the approved wireframe (design-kit paper-home / paper-empty-home).
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
  homeFeed,
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

test("homeFeed: empty for no cards, or when every card is finished (paper-empty-home state)", () => {
  assert.deepEqual(homeFeed([], CTX), { isEmpty: true, cards: [] });
  assert.deepEqual(homeFeed(null, CTX), { isEmpty: true, cards: [] });
  const finished = { id: 1, heading: "Old", status: "FINISHED", startAt: "2026-07-01T09:00:00Z" };
  const feed = homeFeed([finished], CTX);
  assert.equal(feed.isEmpty, true);
  assert.equal(feed.cards.length, 0);
});

test("homeFeed: drops finished events and orders live-now before upcoming", () => {
  const soon = { id: 2, heading: "Soon", startAt: "2026-07-20T09:00:00Z" };
  const live = { id: 1, heading: "Live one", happeningNow: true, startAt: "2026-07-10T11:00:00Z" };
  const finished = { id: 3, heading: "Old", status: "FINISHED", startAt: "2026-07-01T09:00:00Z" };

  const feed = homeFeed([soon, live, finished], CTX);
  assert.equal(feed.isEmpty, false);
  assert.equal(feed.cards.length, 2); // finished dropped
  // Happening-now first, then upcoming (each preserving the API's soonest-first order).
  assert.deepEqual(feed.cards.map((c) => c.id), [1, 2]);
  assert.equal(feed.cards[0].live, true);
  assert.equal(feed.cards[1].live, false);
});

// TM-662: the "near you" feed must be scoped to the viewer's city — the recorded bug was a London
// event surfacing under a "Mk" header. This is the fail-before / pass-after regression.
test("homeFeed: scoped to the viewer's city — same-city events shown, other-city EXCLUDED (TM-662)", () => {
  const localMk = { id: 1, heading: "Coffee & Code", city: "Mk", startAt: "2026-07-14T18:00:00Z" };
  const otherLondon = { id: 2, heading: "London thing", city: "London", startAt: "2026-07-15T18:00:00Z" };

  const feed = homeFeed([localMk, otherLondon], { ...CTX, city: "MK" }); // case-insensitive match
  assert.equal(feed.isEmpty, false);
  // The London event never appears under an "MK" viewer — the whole point of the bug.
  assert.deepEqual(feed.cards.map((c) => c.id), [1]);
});

test("homeFeed: city match ignores case and inner whitespace (TM-662)", () => {
  const a = { id: 1, heading: "A", city: "Milton  Keynes", startAt: "2026-07-14T18:00:00Z" };
  const b = { id: 2, heading: "B", city: "milton keynes", startAt: "2026-07-15T18:00:00Z" };
  const feed = homeFeed([a, b], { ...CTX, city: " Milton Keynes " });
  assert.deepEqual(feed.cards.map((c) => c.id), [1, 2]); // both normalise to the same city
});

test("homeFeed: falls back to an event's locationText when it carries no city (TM-662)", () => {
  const byLocationText = { id: 1, heading: "A", locationText: "Bletchley", startAt: "2026-07-14T18:00:00Z" };
  assert.deepEqual(homeFeed([byLocationText], { ...CTX, city: "Bletchley" }).cards.map((c) => c.id), [1]);
  assert.deepEqual(homeFeed([byLocationText], { ...CTX, city: "Oxford" }).cards.map((c) => c.id), []);
});

test("homeFeed: a viewer whose only local matches are gone yields the honest empty state (TM-662)", () => {
  const london = { id: 2, heading: "London thing", city: "London", startAt: "2026-07-15T18:00:00Z" };
  const feed = homeFeed([london], { ...CTX, city: "Mk" });
  assert.equal(feed.isEmpty, true); // no local events → empty state, not a false "near you" list
  assert.equal(feed.cards.length, 0);
});

test("homeFeed: unknown viewer city degrades to the FULL unfiltered listing (TM-662)", () => {
  const mk = { id: 1, heading: "A", city: "Mk", startAt: "2026-07-14T18:00:00Z" };
  const london = { id: 2, heading: "B", city: "London", startAt: "2026-07-15T18:00:00Z" };
  // No city (null/blank) → cannot scope honestly → show everything (paired with the neutral label).
  assert.deepEqual(homeFeed([mk, london], { ...CTX, city: null }).cards.map((c) => c.id), [1, 2]);
  assert.deepEqual(homeFeed([mk, london], { ...CTX, city: "   " }).cards.map((c) => c.id), [1, 2]);
  assert.deepEqual(homeFeed([mk, london], CTX).cards.map((c) => c.id), [1, 2]); // no city key at all
});

test("homeFeed: bounds the digest (the finding notes the old feed was unbounded) (TM-662)", () => {
  // 20 same-city upcoming events → capped at the digest max (NEAR_YOU_MAX = 12).
  const many = Array.from({ length: 20 }, (_, i) => ({
    id: i,
    heading: `E${i}`,
    city: "Mk",
    startAt: `2026-07-${String(14 + (i % 10)).padStart(2, "0")}T18:00:00Z`,
  }));
  const feed = homeFeed(many, { ...CTX, city: "Mk" });
  assert.equal(feed.cards.length, 12);
});
