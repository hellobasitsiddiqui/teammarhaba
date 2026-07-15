// Pure, framework-free logic for the Home screen (TM-512) — the "Events near you" feed + its
// empty-home first-run state, refreshed to the approved wireframe (design-kit `paper-home` /
// `app-home` and `paper-empty-home`).
//
// NO DOM, no fetch, no browser globals at module scope, so Node's test runner imports it directly
// (the same `*-core.js` split the web app already uses — see events-core.js / tabbar-core.js and
// AGENTIC-LESSONS "extract the pure logic to test it"). The DOM half is `home.js`; the markup +
// token-only styling live in index.html + styles.css.
//
// It builds the Home view-model the DOM shell renders verbatim:
//   • the section context line ("Upcoming meetups near <city>" — honest about the unfiltered feed, TM-734);
//   • each feed card (tag / title / when / where / going-count + the RSVP-state affordance);
//   • the empty-vs-populated decision.
//
// It REUSES events-core.js (already unit-tested) for the shared pieces — soonest-first listing split
// (finished excluded), local-time "when" formatting, and the "N going" badge copy — so Home and the
// #/events list speak one vocabulary and there's no second, drifting formatter.
//
// DEFENSIVE BY DESIGN (mirrors events-core.js): the public EventCard is `{ id, heading, locationText,
// timezone, startAt, endAt, capacity, imagePath, goingCount, myState }`. The wireframe also shows a
// category tag chip, but the card API does not (yet) carry a category — so the tag is read as an
// OPTIONAL, possibly-absent field and simply omitted when absent, never invented.

import { listingBuckets, formatWhen, goingBadge, isHappeningNow } from "./events-core.js";

// The event-detail route a Home card links to (the whole card is the tap target, exactly like the
// #/events browse card). RSVP itself happens on the detail — the card's state affordance is an honest
// call-to-action that leads there, never a second RSVP control that would duplicate the tested
// events-core.js gate model (booking cutoff / one-active-event / age band).
const EVENT_ROUTE = "#/events";

/** Trim a possibly-null string to a non-empty value, else "". */
function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

// The most events the "near you" feed will surface at once. The finding (TM-662) notes the old feed
// was UNBOUNDED — it rendered every matching event. Home is a glanceable digest, not the full browse
// list (that's #/events), so we cap the card count; the CTA leads to the full list for the rest.
const NEAR_YOU_MAX = 12;

/**
 * Normalise a city for comparison: trim + collapse inner whitespace + lowercase, so cosmetic
 * differences ("Mk" vs "mk", " Milton  Keynes ") never split the same place into two. Returns "" for a
 * blank/missing value (an unknown city matches nothing). Pure so the filter stays unit-testable.
 * @param {?string} value
 * @returns {string}
 */
function cityKey(value) {
  return clean(value).replace(/\s+/g, " ").toLowerCase();
}

/**
 * Does this event belong to the viewer's city? An event's location key is its APPROXIMATE `city` (which
 * is always exposed, even before the exact-venue reveal of TM-408) with `locationText` as a fallback
 * only when `city` is absent. A blank/missing viewer city (the caller degrades to unfiltered) never
 * reaches here. Pure comparison — the whole reason the filter lives in home-core.js.
 * @param {Object} card an EventCard.
 * @param {string} viewerKey the normalised viewer city (from {@link cityKey}).
 * @returns {boolean}
 */
function cardMatchesCity(card, viewerKey) {
  const cardKey = cityKey(card?.city) || cityKey(card?.locationText);
  return cardKey !== "" && cardKey === viewerKey;
}

/**
 * The section context line under the "Events near you" title.
 *
 * TM-662: the feed IS now scoped to the viewer's city ({@link homeFeed} filters by it), so the line
 * honestly names that city as the scope — "Meetups near <city>". When the viewer's city is unknown the
 * feed is NOT filtered (it degrades to the full upcoming listing), so the line must NOT claim a city it
 * doesn't have; it stays the neutral "Upcoming meetups near you".
 *
 * We still do not claim a "this week" date bound (TM-734): the listing applies no date window, so the
 * line never promises one. When a real date window lands, this line should regain that wording (+ test).
 *
 * @param {?string} city the viewer's city, or null/blank when unknown.
 * @returns {string}
 */
export function homeContextLine(city) {
  const c = clean(city);
  return c ? `Meetups near ${c}` : "Upcoming meetups near you";
}

/**
 * The category tag chip for a card, or null when the event has no category. The card API does not
 * carry a category yet (see the module header), so this reads any of the plausible field shapes and
 * omits the chip when none is present — it never fabricates one.
 * @returns {?string}
 */
export function homeCardTag(card) {
  const tag = clean(card?.category) || clean(card?.type) || clean(card?.tag);
  return tag || null;
}

/**
 * The RSVP-state affordance for a card — the wireframe's three button variants, mapped from the
 * caller's `myState`:
 *   • GOING       → "Going ✓"  (the done / accent-light variant)
 *   • WAITLISTED  → "Waitlist" (the ghost variant)
 *   • NONE / else → "RSVP"     (the primary accent variant; leads to the detail to actually RSVP)
 * `kind` is a stable token the DOM/CSS + tests key off; `label` is the verbatim on-screen text.
 * @param {"NONE"|"GOING"|"WAITLISTED"|string} myState
 * @returns {{kind: "going"|"waitlist"|"rsvp", label: string}}
 */
export function homeRsvpState(myState) {
  if (myState === "GOING") return { kind: "going", label: "Going ✓" };
  if (myState === "WAITLISTED") return { kind: "waitlist", label: "Waitlist" };
  return { kind: "rsvp", label: "RSVP" };
}

/**
 * The full view-model for one Home feed card — everything the DOM shell needs, already resolved and
 * fail-soft (never "Invalid Date", never a blank line), so home.js is a thin builder.
 * @param {Object} card an EventCard.
 * @param {{tz?: string, locale?: string, now?: number}} [ctx]
 * @returns {{id, href, tag, title, when, where, going, live, state}}
 */
export function homeCardModel(card, { tz, locale, now = Date.now() } = {}) {
  const id = card?.id;
  return {
    id,
    href: `${EVENT_ROUTE}/${encodeURIComponent(String(id))}`,
    tag: homeCardTag(card),
    title: clean(card?.heading) || "Untitled event",
    // Reveal-aware line degrades to a neutral placeholder (the exact venue is withheld pre-reveal,
    // TM-408) — mirrors the #/events browse card's `where`.
    where: clean(card?.locationText) || clean(card?.city) || "Location shared before the event",
    when: formatWhen(card?.startAt, { tz, locale }) || "Date to be confirmed",
    going: goingBadge(card?.goingCount),
    live: isHappeningNow(card, now),
    state: homeRsvpState(card?.myState),
  };
}

/**
 * The Home feed view-model: the visible listing (finished dropped defensively) in the surfaced order
 * — anything happening now first, then upcoming, each soonest-first — mapped to card models, plus the
 * empty-vs-populated decision that swaps in the `paper-empty-home` state.
 *
 * NEAR-YOU FILTER (TM-662): when the viewer's `city` is known, the feed is SCOPED to events in that
 * city — an event in London never surfaces under a "Meetups near Mk" header. City match is normalised
 * (case/whitespace-insensitive; see {@link cardMatchesCity}) against the event's approximate `city`
 * (with `locationText` as a fallback). When the viewer's city is unknown the feed CANNOT be scoped
 * honestly, so it degrades to the full unfiltered listing (paired with the neutral "near you" label
 * from {@link homeContextLine}, which makes no city claim). The result is bounded to {@link
 * NEAR_YOU_MAX} — Home is a glanceable digest, and the CTA / #/events carries the full list.
 *
 * @param {Object[]} cards the raw EventCard listing.
 * @param {{city?: ?string, tz?: string, locale?: string, now?: number}} [ctx] `city` is the viewer's.
 * @returns {{isEmpty: boolean, cards: Object[]}}
 */
export function homeFeed(cards, { city, tz, locale, now = Date.now() } = {}) {
  const { happeningNow, upcoming } = listingBuckets(cards, now);
  const ordered = [...happeningNow, ...upcoming];

  // Scope to the viewer's city when we know it; otherwise show the full listing (the label degrades
  // to a neutral "near you" that makes no city promise). An empty result is a legitimate empty state
  // (no local events yet), not an error.
  const viewerKey = cityKey(city);
  const scoped = viewerKey ? ordered.filter((c) => cardMatchesCity(c, viewerKey)) : ordered;

  // Bound the digest (the finding notes the old feed was unbounded).
  const bounded = scoped.slice(0, NEAR_YOU_MAX);

  return {
    isEmpty: bounded.length === 0,
    cards: bounded.map((c) => homeCardModel(c, { tz, locale, now })),
  };
}
