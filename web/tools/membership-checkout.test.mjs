// Tests for the membership pricing/checkout logic (TM-479). Framework-free — Node's built-in test
// runner, picked up by the CI glob `node --test web/tools/*.test.mjs`. Covers AC 1 (the four price
// states derived from tier + first-event credit + the event's price/premium fields) and AC 2 (the
// checkout payload each state produces), plus the money formatting + defensive tier reading.
//
// It imports the PURE core (membership-checkout-core.js), never the DOM view (membership-checkout.js):
// the view statically imports api.js → auth.js → the Firebase CDN, which Node can't load. The api
// dependency is therefore "mocked" here by construction — the tested logic takes plain MembershipResponse
// + event objects, so no network/api is involved at all.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  resolvePriceState,
  checkoutPayload,
  formatPrice,
  normalizeTier,
  TIER,
  PRICE_KIND,
  CHECKOUT_MODE,
  DEFAULT_PRICE_PENCE,
} from "../src/assets/membership-checkout-core.js";

// --- money formatting --------------------------------------------------------------------------

test("formatPrice renders whole pounds without decimals and part-pounds to 2dp", () => {
  assert.equal(formatPrice(500), "£5");
  assert.equal(formatPrice(1200), "£12");
  assert.equal(formatPrice(250), "£2.50");
  assert.equal(formatPrice(99), "£0.99");
  assert.equal(formatPrice(0), "£0");
});

test("formatPrice is defensive — non-finite / negative inputs render as £0, never throw", () => {
  assert.equal(formatPrice(undefined), "£0");
  assert.equal(formatPrice(null), "£0");
  assert.equal(formatPrice(-500), "£0");
  assert.equal(formatPrice(Number.NaN), "£0");
});

// --- defensive tier reading --------------------------------------------------------------------

test("normalizeTier accepts the known tiers (any case/whitespace) and defaults the rest to PAY_PER_EVENT", () => {
  assert.equal(normalizeTier("MONTHLY"), TIER.MONTHLY);
  assert.equal(normalizeTier("diamond"), TIER.DIAMOND);
  assert.equal(normalizeTier("  Monthly  "), TIER.MONTHLY);
  assert.equal(normalizeTier("PAY_PER_EVENT"), TIER.PAY_PER_EVENT);
  // Unknown / missing / wrong-type → the safe pay-per-event default.
  assert.equal(normalizeTier("PLATINUM"), TIER.PAY_PER_EVENT);
  assert.equal(normalizeTier(undefined), TIER.PAY_PER_EVENT);
  assert.equal(normalizeTier(null), TIER.PAY_PER_EVENT);
  assert.equal(normalizeTier(42), TIER.PAY_PER_EVENT);
});

// --- AC 1: the price states --------------------------------------------------------------------

test("Free — a pay-per-event caller's FIRST event is on us (credit available)", () => {
  const s = resolvePriceState(
    { tier: TIER.PAY_PER_EVENT, firstEventCreditAvailable: true },
    { id: 1, pricePence: 500, premium: false },
  );
  assert.equal(s.kind, PRICE_KIND.FREE);
  assert.equal(s.label, "Free");
  assert.equal(s.amountPence, null);
  assert.equal(s.checkout, CHECKOUT_MODE.CONFIRM);
  assert.match(s.detail, /first event/i);
});

test("Free — an event priced at £0 is free for everyone and consumes no credit", () => {
  const s = resolvePriceState(
    { tier: TIER.PAY_PER_EVENT, firstEventCreditAvailable: false },
    { id: 1, pricePence: 0, premium: false },
  );
  assert.equal(s.kind, PRICE_KIND.FREE);
  assert.equal(s.label, "Free");
  assert.equal(s.checkout, CHECKOUT_MODE.CONFIRM);
});

test("Included — a Monthly member's standard event is covered by their tier", () => {
  const s = resolvePriceState({ tier: TIER.MONTHLY }, { id: 2, pricePence: 500, premium: false });
  assert.equal(s.kind, PRICE_KIND.INCLUDED);
  assert.equal(s.label, "Included");
  assert.equal(s.amountPence, null);
  assert.equal(s.checkout, CHECKOUT_MODE.CONFIRM);
  assert.match(s.detail, /monthly/i);
});

test("Included — Diamond covers everything, including premium events", () => {
  const s = resolvePriceState({ tier: TIER.DIAMOND }, { id: 3, pricePence: 2000, premium: true });
  assert.equal(s.kind, PRICE_KIND.INCLUDED);
  assert.equal(s.label, "Included");
  assert.equal(s.checkout, CHECKOUT_MODE.CONFIRM);
  assert.match(s.detail, /diamond/i);
});

test("£5 — a pay-per-event caller with no credit pays the event's price", () => {
  const s = resolvePriceState(
    { tier: TIER.PAY_PER_EVENT, firstEventCreditAvailable: false },
    { id: 4, pricePence: 500, premium: false },
  );
  assert.equal(s.kind, PRICE_KIND.PAY);
  assert.equal(s.label, "£5");
  assert.equal(s.amountPence, 500);
  assert.equal(s.checkout, CHECKOUT_MODE.PAY);
});

test("premium price — a pay-per-event caller with no credit pays the admin-set premium price", () => {
  const s = resolvePriceState(
    { tier: TIER.PAY_PER_EVENT, firstEventCreditAvailable: false },
    { id: 5, pricePence: 2500, premium: true },
  );
  assert.equal(s.kind, PRICE_KIND.PAY);
  assert.equal(s.label, "£25");
  assert.equal(s.amountPence, 2500);
  assert.equal(s.checkout, CHECKOUT_MODE.PAY);
});

test("Premium is never free — a PAY_PER_EVENT caller WITH a first-event credit on a PREMIUM event PAYS, not Free", () => {
  // Product decision 2026-07-10: the first-event credit is STANDARD-only — it must never make a premium
  // event free. This mirrors the authoritative TM-476 backend resolver (EntitlementResolver: any tier
  // below Diamond PAYs for premium; the credit is neither applied nor consumed), so the client display
  // and the server can't disagree. Same inputs but premium:false stays Free (the test above).
  const s = resolvePriceState(
    { tier: TIER.PAY_PER_EVENT, firstEventCreditAvailable: true },
    { id: 20, pricePence: 2500, premium: true },
  );
  assert.equal(s.kind, PRICE_KIND.PAY);
  assert.notEqual(s.kind, PRICE_KIND.FREE);
  assert.equal(s.label, "£25");
  assert.equal(s.amountPence, 2500);
  assert.equal(s.checkout, CHECKOUT_MODE.PAY);
  assert.match(s.detail, /premium/i);
});

test("Upgrade to attend — a Monthly member hits a premium event they must upgrade for", () => {
  const s = resolvePriceState({ tier: TIER.MONTHLY }, { id: 6, pricePence: 2000, premium: true });
  assert.equal(s.kind, PRICE_KIND.UPGRADE);
  assert.equal(s.label, "Upgrade to attend");
  assert.equal(s.amountPence, null);
  assert.equal(s.checkout, CHECKOUT_MODE.UPGRADE);
});

// --- defensive resolution ----------------------------------------------------------------------

test("resolvePriceState treats a missing membership as a fresh pay-per-event caller (no credit)", () => {
  // No membership object at all → default PAY_PER_EVENT, no credit → pay the default price.
  const s = resolvePriceState(undefined, { id: 7, pricePence: 500, premium: false });
  assert.equal(s.kind, PRICE_KIND.PAY);
  assert.equal(s.amountPence, 500);
});

test("resolvePriceState falls back to the £5 default when the event omits a price", () => {
  const s = resolvePriceState({ tier: TIER.PAY_PER_EVENT }, { id: 8 });
  assert.equal(s.kind, PRICE_KIND.PAY);
  assert.equal(s.amountPence, DEFAULT_PRICE_PENCE);
  assert.equal(s.label, "£5");
});

test("resolvePriceState returns a frozen record so a shared state can't be mutated", () => {
  const s = resolvePriceState({ tier: TIER.DIAMOND }, { id: 9, pricePence: 500 });
  assert.ok(Object.isFrozen(s));
});

// --- AC 2: the checkout payloads ---------------------------------------------------------------

test("checkoutPayload — Free / Included produce a no-charge RSVP", () => {
  const freeState = resolvePriceState({ firstEventCreditAvailable: true }, { id: 10, pricePence: 500 });
  assert.deepEqual(checkoutPayload({ id: 10 }, freeState), { eventId: 10, action: "RSVP", chargePence: 0 });

  const includedState = resolvePriceState({ tier: TIER.DIAMOND }, { id: 11, pricePence: 500 });
  assert.deepEqual(checkoutPayload({ id: 11 }, includedState), { eventId: 11, action: "RSVP", chargePence: 0 });
});

test("checkoutPayload — Pay carries the exact charge in pence + currency", () => {
  const payState = resolvePriceState({ tier: TIER.PAY_PER_EVENT }, { id: 12, pricePence: 2500, premium: true });
  assert.deepEqual(checkoutPayload({ id: 12 }, payState), {
    eventId: 12,
    action: "PAY",
    chargePence: 2500,
    currency: "GBP",
  });
});

test("checkoutPayload — Upgrade is an upgrade intent with no event charge", () => {
  const upgradeState = resolvePriceState({ tier: TIER.MONTHLY }, { id: 13, pricePence: 2000, premium: true });
  assert.deepEqual(checkoutPayload({ id: 13 }, upgradeState), { action: "UPGRADE" });
});

test("checkoutPayload tolerates a missing event id", () => {
  const payState = resolvePriceState({ tier: TIER.PAY_PER_EVENT }, { pricePence: 500 });
  assert.deepEqual(checkoutPayload(undefined, payState), {
    eventId: null,
    action: "PAY",
    chargePence: 500,
    currency: "GBP",
  });
});
