// Pure, framework-free pricing/checkout logic for the membership feature (TM-479, epic
// group-membership / contract TM-457). No DOM, no fetch, no browser globals at module scope, so
// Node's test runner can import it directly — the SAME split the rest of the web app already uses
// (events-core.js ↔ events.js, event-form.js ↔ admin-events.js, notification-panel-core.js ↔
// notification-panel.js). It has to be a separate module because the DOM view (membership-checkout.js)
// statically imports api.js, which transitively imports the Firebase SDK from a gstatic CDN URL that
// `node --test web/tools/*.test.mjs` cannot load; keeping this logic here makes it unit-testable while
// the view stays a thin, browser-only shell.
//
// WHAT LIVES HERE (all pure functions of their inputs):
//   • resolvePriceState(): (MembershipResponse, event) → the single price state the checkout screen
//     renders — one of Free / Included / £5 (or the premium price) to Pay (AC 1), derived from the
//     caller's membership tier + first-event credit and the event's price/premium fields (TM-475:
//     `pricePence` in minor units GBP, `premium` boolean). Since TM-618 it never returns the reserved
//     UPGRADE state: a Monthly member on a premium event PAYs the premium price, matching the backend;
//   • checkoutPayload(): (event, priceState) → the request body the RSVP/checkout action sends — a
//     no-charge confirm for Free/Included, a charge for Pay, an upgrade intent for Upgrade (AC 2);
//   • formatPrice(): pence (minor units) → a "£5" / "£2.50" display string, the house money convention
//     (integer pence, exact, maps 1:1 onto what a payment provider charges — TM-475);
//   • normalizeTier(): a defensive tier reader that defaults unknown/missing values to PAY_PER_EVENT
//     (the JIT-enrolled default in the TM-457 contract), so a partial/absent MembershipResponse never
//     throws.

/**
 * The three membership tiers from the TM-457 contract. PAY_PER_EVENT is the default a caller is
 * JIT-enrolled onto on first read; MONTHLY covers standard events; DIAMOND covers everything
 * (including premium events).
 */
export const TIER = Object.freeze({
  PAY_PER_EVENT: "PAY_PER_EVENT",
  MONTHLY: "MONTHLY",
  DIAMOND: "DIAMOND",
});

/**
 * The default ticket price in pence when an event does not carry an explicit one — £5.00 = 500.
 * Mirrors the backend `Event.DEFAULT_PRICE_PENCE` / migration V22 `price_pence DEFAULT 500`, so the
 * client shows the same fallback the server would apply.
 */
export const DEFAULT_PRICE_PENCE = 500;

/**
 * The kind of price state resolvePriceState() returns — what the caller ultimately pays for THIS
 * event. Drives the badge copy and colour; distinct from CHECKOUT_MODE (which drives the action).
 */
export const PRICE_KIND = Object.freeze({
  FREE: "FREE", // no charge — the event is free, or their first-event credit covers it
  INCLUDED: "INCLUDED", // no charge — their membership tier already covers it
  PAY: "PAY", // must pay the event's price (£5 default, or the premium price)
  // Reserved contract value only — since TM-618 no resolvePriceState branch produces UPGRADE (a Monthly
  // member on a premium event now PAYs the premium price, matching the TM-476 backend, which likewise
  // yields no UPGRADE). Kept for wire/contract compatibility, mirroring the backend EntitlementDecision.
  UPGRADE: "UPGRADE",
});

/**
 * How the RSVP → checkout step behaves for a given price state (AC 2):
 *   • CONFIRM — Free / Included: a single confirm, no payment;
 *   • PAY     — a card step (wired to the Revolut widget in TM-478; a disabled "coming soon" mount
 *               point until then);
 *   • UPGRADE — reserved: send the user to membership/tier management to upgrade before they can attend.
 *               No resolvePriceState result carries this mode since TM-618 (Monthly-on-premium now PAYs,
 *               matching the backend), so checkoutPayload keeps the branch only for contract compatibility.
 */
export const CHECKOUT_MODE = Object.freeze({
  CONFIRM: "CONFIRM",
  PAY: "PAY",
  UPGRADE: "UPGRADE",
});

/**
 * Read a tier value defensively. Trims/upper-cases a string and only accepts the known tiers;
 * anything else (undefined, null, a typo, a future tier this build doesn't know) falls back to
 * PAY_PER_EVENT — the safe default that charges per event rather than accidentally granting access.
 * @param {unknown} tier
 * @returns {string} one of TIER.*
 */
export function normalizeTier(tier) {
  const t = typeof tier === "string" ? tier.trim().toUpperCase() : "";
  return t === TIER.MONTHLY || t === TIER.DIAMOND ? t : TIER.PAY_PER_EVENT;
}

/**
 * Normalize an event's `pricePence` to a non-negative integer. A missing/invalid/negative value
 * falls back to the £5 default (mirroring the DB backstop), so the UI is always well-defined; an
 * explicit 0 is preserved (a genuinely free event).
 * @param {unknown} value
 * @returns {number} pence, integer ≥ 0
 */
function normalizePence(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_PRICE_PENCE;
  return Math.round(n);
}

/**
 * Format a price in pence (minor units, GBP) as a short display string. Whole pounds render without
 * decimals ("£5"), part-pounds to two places ("£2.50"). Defensive: a non-finite/negative input
 * formats as "£0" rather than throwing.
 * @param {number} pence
 * @returns {string}
 */
export function formatPrice(pence) {
  const n = Number(pence);
  const safe = Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
  const pounds = safe / 100;
  return `£${safe % 100 === 0 ? String(pounds) : pounds.toFixed(2)}`;
}

/** Build a frozen price-state record (the single return shape of resolvePriceState). */
function priceState(kind, label, detail, amountPence, checkout) {
  return Object.freeze({ kind, label, detail, amountPence, checkout });
}

/**
 * Resolve what an event costs THIS caller, and how checkout should behave — the heart of AC 1/2.
 *
 * Precedence (first match wins):
 *   1. A genuinely free event (admin priced it at £0) — free for everyone, consumes no credit.
 *   2. Tier coverage → "Included": Diamond covers every event; Monthly covers standard (non-premium).
 *   3. A pay-per-event caller whose first-event credit is still available, on a STANDARD event → "Free"
 *      (their first is on us). Premium events are NEVER free (product decision 2026-07-10): the credit is
 *      standard-only, so a credit + a premium event skips this and falls through to Pay — matching the
 *      authoritative TM-476 backend resolver (EntitlementResolver).
 *   4. Otherwise → "Pay" the event's price (£5 default, or the premium price the admin set). This covers
 *      pay-per-event with no credit AND — since TM-618 — a MONTHLY member on a PREMIUM event: Monthly does
 *      not cover premium, so they PAY the premium price rather than being shown "Upgrade to attend". That
 *      matches the backend EntitlementResolver rule "any tier below Diamond PAYs for a premium event", so
 *      the checkout screen and the server can never disagree. No branch yields UPGRADE any more (the
 *      backend produces none either); UPGRADE stays a reserved contract value only.
 *
 * @param {{tier?: string, firstEventCreditAvailable?: boolean}} [membership] the MembershipResponse
 *   from GET /api/v1/me/membership (TM-474). Read defensively — a partial/absent object is treated as
 *   a fresh PAY_PER_EVENT caller with no credit.
 * @param {{id?: (string|number), pricePence?: number, premium?: boolean}} [event] the event's
 *   price/premium fields (TM-475 EventResponse).
 * @returns {{kind: string, label: string, detail: string, amountPence: (number|null), checkout: string}}
 */
export function resolvePriceState(membership, event) {
  const tier = normalizeTier(membership?.tier);
  const creditAvailable = Boolean(membership?.firstEventCreditAvailable);
  const premium = Boolean(event?.premium);
  const pricePence = normalizePence(event?.pricePence);

  // 1. Genuinely free event (£0) — free for anyone, no credit consumed, a simple confirm.
  if (pricePence === 0) {
    return priceState(PRICE_KIND.FREE, "Free", "This event is free to attend.", null, CHECKOUT_MODE.CONFIRM);
  }

  // 2. Tier coverage → "Included" (no charge).
  if (tier === TIER.DIAMOND) {
    return priceState(
      PRICE_KIND.INCLUDED,
      "Included",
      "Included with your Diamond membership.",
      null,
      CHECKOUT_MODE.CONFIRM,
    );
  }
  if (tier === TIER.MONTHLY && !premium) {
    return priceState(
      PRICE_KIND.INCLUDED,
      "Included",
      "Included with your Monthly membership.",
      null,
      CHECKOUT_MODE.CONFIRM,
    );
  }

  // A MONTHLY member on a PREMIUM event is intentionally NOT handled here: before TM-618 this branch
  // returned "Upgrade to attend", but the authoritative TM-476 backend EntitlementResolver maps any tier
  // below Diamond on a premium event to PAY the premium price (product decision 2026-07-10). We therefore
  // let a Monthly-on-premium caller fall through to the Pay branch below so the client charge matches what
  // the backend would charge; the `&& !premium` guard on the credit branch keeps that from short-circuiting
  // to Free. No branch produces UPGRADE any more — it mirrors the backend, which yields none either.

  // 3. Pay-per-event with a first-event credit still available, on a STANDARD event → their first event
  // is on us. Premium events are NEVER free (product decision 2026-07-10): the first-event credit is
  // standard-only and does NOT apply to a premium event, so the `&& !premium` guard makes a credit-holding
  // caller on a PREMIUM event fall through to the Pay branch below (the admin-set premium price) rather
  // than being shown Free. This aligns the client display with the authoritative TM-476 backend resolver
  // (EntitlementResolver: any tier below Diamond PAYs for a premium event; the credit is neither applied
  // nor consumed), so the checkout screen and the server can never disagree.
  if (creditAvailable && !premium) {
    return priceState(PRICE_KIND.FREE, "Free", "Your first event is on us.", null, CHECKOUT_MODE.CONFIRM);
  }

  // 4. Pay the event's price (£5 default, or the premium price). Reached by a pay-per-event caller with no
  // credit AND by a MONTHLY member on a premium event (Monthly does not cover premium — see the note above).
  return priceState(
    PRICE_KIND.PAY,
    formatPrice(pricePence),
    premium ? "Premium event." : "Pay to attend.",
    pricePence,
    CHECKOUT_MODE.PAY,
  );
}

/**
 * Build the request body the RSVP/checkout action sends for a resolved price state (AC 2). Kept pure
 * and separate from the network call so it is unit-testable and so the future payment wiring (TM-478)
 * has one canonical payload shape to send.
 *   • CONFIRM (Free / Included) → a no-charge RSVP;
 *   • PAY                        → an RSVP that must be paid for, carrying the exact charge in pence;
 *   • UPGRADE                    → an upgrade intent (no event charge — routed to tier management).
 * @param {{id?: (string|number)}} [event]
 * @param {{checkout?: string, amountPence?: (number|null)}} [state] a resolvePriceState() result.
 * @returns {object} the checkout payload.
 */
export function checkoutPayload(event, state) {
  const eventId = event?.id ?? null;
  const mode = state?.checkout;
  if (mode === CHECKOUT_MODE.PAY) {
    return { eventId, action: "PAY", chargePence: state?.amountPence ?? 0, currency: "GBP" };
  }
  if (mode === CHECKOUT_MODE.UPGRADE) {
    return { action: "UPGRADE" };
  }
  // CONFIRM (Free / Included): a no-charge RSVP.
  return { eventId, action: "RSVP", chargePence: 0 };
}
