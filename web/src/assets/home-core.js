// Pure, framework-free logic for the Home screen (TM-512, reworked TM-969) — the personalized
// "attending-first" feed + its empty-home first-run state, refreshed to the approved wireframe
// (design-kit `paper-home` / `app-home` and `paper-empty-home`).
//
// NO DOM, no fetch, no browser globals at module scope, so Node's test runner imports it directly
// (the same `*-core.js` split the web app already uses — see events-core.js / tabbar-core.js and
// AGENTIC-LESSONS "extract the pure logic to test it"). The DOM half is `home.js`; the markup +
// token-only styling live in index.html + styles.css.
//
// TM-969 — Home is no longer a single "upcoming events near you" list. It is a personalized digest of
// up to THREE priority sections, rendered top→bottom, each shown ONLY when it has events (empty
// sections collapse entirely — no orphan header, so the highest non-empty section is always the first
// content the member sees):
//   1. "Happening now" — my attending events (myState === "GOING") that are live now.
//   2. "Your events"   — my upcoming attending events (GOING, not yet live).
//   3. "Events near you" — nearby events I am NOT attending, BOOKABLE ONLY, as a trimmed teaser
//                          (small cap) followed by a "See all events →" link to #/events.
// The old behaviours fall out of the collapse rule for free: no live-attending → section 2 leads;
// nothing attending at all → section 3 leads (= the previous today's-near-you Home).
//
// It builds the Home view-model the DOM shell renders verbatim:
//   • the section context line ("Upcoming meetups near <city>" — honest about the unfiltered feed, TM-734);
//   • each ordered, collapse-aware section ({ key, header, cards, isTeaser, seeAllHref? });
//   • each feed card (tag / title / when / where / going-count + the RSVP-state affordance);
//   • the empty-vs-populated decision (all three sections empty → the paper-empty-home state).
//
// It REUSES events-core.js (already unit-tested) for the shared pieces — soonest-first listing split
// (finished excluded), local-time "when" formatting, the "N going" badge copy, `isHappeningNow`,
// `isFinished`, `isFull` and `bookingWindow` — so Home and the #/events list speak one vocabulary and
// there's no second, drifting formatter.
//
// DEFENSIVE BY DESIGN (mirrors events-core.js): the public EventCard is `{ id, heading, locationText,
// timezone, startAt, endAt, capacity, imagePath, goingCount, myState }`. The wireframe also shows a
// category tag chip, but the card API does not (yet) carry a category — so the tag is read as an
// OPTIONAL, possibly-absent field and simply omitted when absent, never invented.

import {
  listingBuckets,
  formatWhen,
  goingBadge,
  isHappeningNow,
  isFinished,
  isFull,
  bookingWindow,
} from "./events-core.js";

// The event-detail route a Home card links to (the whole card is the tap target, exactly like the
// #/events browse card). RSVP itself happens on the detail — the card's state affordance is an honest
// call-to-action that leads there, never a second RSVP control that would duplicate the tested
// events-core.js gate model (booking cutoff / one-active-event / age band).
const EVENT_ROUTE = "#/events";

/** Trim a possibly-null string to a non-empty value, else "". */
function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

// The "Events near you" section (section 3) is a TEASER — a short taste of what's on that hands off to
// the full #/events browse list via a "See all events →" link. TM-969 caps it tight (3) so Home stays
// a glanceable digest led by the member's own events, not a second full events list. Sections 1 & 2
// (my attending events) are NOT capped — a member sees all of their own events (they will be few).
const NEAR_YOU_TEASER_MAX = 3;

// The full-browse route the "Events near you" teaser links on to for the rest of the nearby events.
const EVENTS_ROUTE = "#/events";

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
 * The page context line under the Home page title (the "near <city>" hint).
 *
 * TM-662: the near-you section IS scoped to the viewer's city ({@link homeSections} filters section 3
 * by it), so the line honestly names that city as the scope — "Meetups near <city>". When the viewer's
 * city is unknown the near-you section is NOT filtered (it degrades to the full upcoming listing), so
 * the line must NOT claim a city it doesn't have; it stays the neutral "Upcoming meetups near you".
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

/** Is the caller attending this event (RSVP'd GOING)? The single "my events" predicate the two
 *  attending-first sections share, so "Happening now" and "Your events" can never disagree on it. */
function isAttending(card) {
  return card?.myState === "GOING";
}

/**
 * Is this nearby event still BOOKABLE for a fresh joiner right now (TM-969)? Section 3 ("Events near
 * you") is a call-to-action teaser — it must only surface events the member could actually still join,
 * so a full / already-started / finished event is filtered out rather than teasing a dead end.
 *
 * The event model carries no single "bookable" flag, so we compose the signals events-core.js already
 * exposes + unit-tests (so Home and #/events stay one vocabulary), in this order:
 *   • NOT finished              — a past event is never bookable (events-core `isFinished`).
 *   • NOT started / past cutoff — booking shuts within the cutoff of the start, and of course once it
 *     has begun (events-core `bookingWindow`: `.started` || `.closed`). This is the "past booking-cutoff
 *     / already-started" exclusion; the cutoff field is `bookingClosesAt` when the API supplies it,
 *     else it derives start − 60min — see `bookingWindow`.
 *   • NOT full                  — at/over capacity for a new RSVP (events-core `isFull`; unlimited
 *     capacity is never full). A full event would only offer a waitlist, not a bookable spot, so it is
 *     excluded from the "join something near you" teaser.
 *   • NOT already mine          — a GOING/WAITLISTED event is not a "near you, not attending" teaser
 *     card (it belongs in section 1/2, or is already handled); this section is explicitly the events I
 *     am NOT attending. (Caller also excludes attending events, but we guard here too so the predicate
 *     is honest standalone.)
 *
 * NOTE (definition): there is no dedicated "closed for new bookings" API field beyond the booking-cutoff
 * window above, so "still joinable" is defined as: not finished, not started/past-cutoff, and not full.
 * If a precise `bookingOpen` / capacity-hold field lands, prefer it here (+ a test) — recorded on TM-969.
 *
 * @param {Object} card an EventCard.
 * @param {number} now epoch-ms "now".
 * @returns {boolean}
 */
export function bookable(card, now = Date.now()) {
  if (!card) return false;
  if (card.myState === "GOING" || card.myState === "WAITLISTED") return false; // already mine
  if (isFinished(card, now)) return false; // past — never bookable
  const bw = bookingWindow(card, now);
  if (bw.started || bw.closed) return false; // started, or past the booking cutoff
  if (isFull(card)) return false; // at/over capacity — no bookable spot (waitlist only)
  return true;
}

// The stable section keys (the DOM/CSS + tests key off these) and their light on-screen headers.
const SECTION = Object.freeze({
  HAPPENING_NOW: { key: "happening-now", header: "Happening now" },
  YOUR_EVENTS: { key: "your-events", header: "Your events" },
  NEAR_YOU: { key: "near-you", header: "Events near you" },
});

/** The verbatim on-screen text for the section-3 hand-off link to the full events browse list. One
 *  constant so home.js and its tests agree on the copy. */
export const SEE_ALL_LABEL = "See all events →";

/**
 * The personalized Home view-model (TM-969): up to THREE ordered, collapse-aware sections plus the
 * empty-vs-populated decision that swaps in the `paper-empty-home` state.
 *
 * The three sections, in fixed top→bottom priority order, each present ONLY when it has ≥1 card
 * (empty sections collapse entirely — no orphan header — so the highest non-empty section is always
 * the first content):
 *   1. HAPPENING NOW — my attending events (GOING) that are live now (events-core `isHappeningNow`).
 *   2. YOUR EVENTS   — my upcoming attending events (GOING, not yet live), soonest-first.
 *   3. EVENTS NEAR YOU — nearby events I'm NOT attending, {@link bookable} only, trimmed to a small
 *      TEASER cap ({@link NEAR_YOU_TEASER_MAX}) with a "See all events →" hand-off to #/events.
 *
 * The old fallbacks fall out of the collapse rule for free: no live-attending → section 2 leads;
 * nothing attending at all → only section 3 shows (= the previous today's-near-you Home); all three
 * present → they stack 1, 2, 3.
 *
 * NEAR-YOU FILTER (preserved from TM-662): section 3 is SCOPED to the viewer's `city` when known — an
 * event in London never surfaces under a "near Mk" viewer. City match is normalised
 * (case/whitespace-insensitive; see {@link cardMatchesCity}) against the event's approximate `city`
 * (with `locationText` as a fallback). When the viewer's city is unknown section 3 CANNOT be scoped
 * honestly, so it degrades to the full unfiltered (bookable) listing — paired with the neutral "near
 * you" label from {@link homeContextLine}, which makes no city claim. Sections 1 & 2 (MY events) are
 * never city-scoped: my own RSVPs are always mine to see, wherever they are.
 *
 * @param {Object[]} cards the raw EventCard listing.
 * @param {{city?: ?string, tz?: string, locale?: string, now?: number}} [ctx] `city` is the viewer's.
 * @returns {{isEmpty: boolean, sections: {key:string, header:string, cards:Object[], isTeaser:boolean, seeAllHref?:string}[]}}
 */
export function homeSections(cards, { city, tz, locale, now = Date.now() } = {}) {
  // events-core splits the listing into live / upcoming (finished dropped defensively) and preserves
  // the API's soonest-first order within each bucket.
  const { happeningNow, upcoming } = listingBuckets(cards, now);

  // Sections 1 & 2 — MY attending (GOING) events, split by live-vs-upcoming. Uncapped: a member sees
  // all of their own events (they will be few), so no teaser trimming here.
  const myLive = happeningNow.filter(isAttending);
  const myUpcoming = upcoming.filter(isAttending);

  // Section 3 — nearby, bookable events I'm NOT attending. Start from the upcoming bucket (a live event
  // I'm not attending isn't "book something to go to"), drop anything not currently bookable, then scope
  // to my city when known (else the full unfiltered listing, per the neutral label). The `bookable`
  // predicate already excludes my GOING/WAITLISTED events, so this is genuinely "near you, not mine".
  const viewerKey = cityKey(city);
  const nearYouBookable = upcoming
    .filter((c) => bookable(c, now))
    .filter((c) => (viewerKey ? cardMatchesCity(c, viewerKey) : true));
  // Trim to the teaser cap — the "See all events →" link carries the rest to the full browse list.
  const nearYouTeaser = nearYouBookable.slice(0, NEAR_YOU_TEASER_MAX);

  const toModels = (list) => list.map((c) => homeCardModel(c, { tz, locale, now }));

  // Build the three sections in fixed order, then drop the empty ones so the highest non-empty section
  // is always the first content (no orphan header). The near-you teaser carries the hand-off link.
  const built = [
    { ...SECTION.HAPPENING_NOW, cards: toModels(myLive), isTeaser: false },
    { ...SECTION.YOUR_EVENTS, cards: toModels(myUpcoming), isTeaser: false },
    { ...SECTION.NEAR_YOU, cards: toModels(nearYouTeaser), isTeaser: true, seeAllHref: EVENTS_ROUTE },
  ];
  const sections = built.filter((s) => s.cards.length > 0);

  return { isEmpty: sections.length === 0, sections };
}
