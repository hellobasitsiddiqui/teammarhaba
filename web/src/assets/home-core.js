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
//   • the section context line ("<city> · this week");
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

/**
 * The section context line under the "Events near you" title — the wireframe's "Milton Keynes · this
 * week". Uses the viewer's city when we know it (best-effort from /me), else a neutral "Near you".
 * @param {?string} city the viewer's city, or null/blank when unknown.
 * @returns {string}
 */
export function homeContextLine(city) {
  const c = clean(city);
  return `${c || "Near you"} · this week`;
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
 * @param {Object[]} cards the raw EventCard listing.
 * @param {{tz?: string, locale?: string, now?: number}} [ctx]
 * @returns {{isEmpty: boolean, cards: Object[]}}
 */
export function homeFeed(cards, { tz, locale, now = Date.now() } = {}) {
  const { happeningNow, upcoming } = listingBuckets(cards, now);
  const ordered = [...happeningNow, ...upcoming];
  return {
    isEmpty: ordered.length === 0,
    cards: ordered.map((c) => homeCardModel(c, { tz, locale, now })),
  };
}
