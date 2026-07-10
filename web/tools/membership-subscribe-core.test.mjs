// Tests for the subscription pure core (TM-620). Framework-free — Node's built-in test runner,
// picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// Everything the Subscribe checkout + manage-subscription panel decide lives in the DOM-free,
// api-free functions of membership-subscribe-core.js: the LOCKED prices (MONTHLY £9.99 / DIAMOND
// £19.99, product decision 2026-07-10), the defensive subscription-response reader, the manage-panel
// view model ("Renews on …" / dunning / "Ends on …" copy + when Cancel applies), and the
// #/membership/subscribe/{TIER} route helpers shared with the tier screen and router.js.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PAID_TIERS,
  SUBSCRIPTION_PRICE_PENCE,
  SUBSCRIPTION_STATUS,
  subscriptionPricePence,
  subscriptionPriceLabel,
  normalizeSubscription,
  formatChargeDate,
  describeSubscription,
  SUBSCRIBE_ROUTE_PREFIX,
  subscribeRoute,
  tierFromSubscribeRoute,
} from "../src/assets/membership-subscribe-core.js";

// --- Prices (the locked product decision) ---------------------------------------------------------

test("prices: MONTHLY £9.99 and DIAMOND £19.99, in pence, and nothing else has a price", () => {
  assert.deepEqual(PAID_TIERS, ["MONTHLY", "DIAMOND"]);
  assert.equal(SUBSCRIPTION_PRICE_PENCE.MONTHLY, 999);
  assert.equal(SUBSCRIPTION_PRICE_PENCE.DIAMOND, 1999);
  assert.equal(subscriptionPricePence("MONTHLY"), 999);
  assert.equal(subscriptionPricePence("diamond"), 1999, "case-insensitive read");
  assert.equal(subscriptionPricePence("PAY_PER_EVENT"), null, "the free base has no price");
  assert.equal(subscriptionPricePence(undefined), null);
});

test("subscriptionPriceLabel: the '£9.99/month' line both screens show", () => {
  assert.equal(subscriptionPriceLabel("MONTHLY"), "£9.99/month");
  assert.equal(subscriptionPriceLabel("DIAMOND"), "£19.99/month");
  assert.equal(subscriptionPriceLabel("PAY_PER_EVENT"), null);
});

// --- Defensive response reading -------------------------------------------------------------------

test("normalizeSubscription: a well-formed subscribed payload passes through", () => {
  const sub = normalizeSubscription({
    subscribed: true,
    tier: "MONTHLY",
    status: "ACTIVE",
    currentPeriodStart: "2026-07-10T12:00:00Z",
    currentPeriodEnd: "2026-08-10T12:00:00Z",
    renewing: true,
    amountPence: 999,
  });
  assert.equal(sub.subscribed, true);
  assert.equal(sub.tier, "MONTHLY");
  assert.equal(sub.status, SUBSCRIPTION_STATUS.ACTIVE);
  assert.equal(sub.renewing, true);
  assert.equal(sub.amountPence, 999);
});

test("normalizeSubscription: garbage / partial / none-state payloads collapse to the safe none-state", () => {
  for (const bad of [
    null,
    undefined,
    {},
    { subscribed: false },
    { subscribed: true }, // no tier/status → unusable
    { subscribed: true, tier: "GOLD", status: "ACTIVE" }, // unknown tier
    { subscribed: true, tier: "MONTHLY", status: "PAUSED" }, // unknown status
    "not-an-object",
  ]) {
    const sub = normalizeSubscription(bad);
    assert.equal(sub.subscribed, false, `unusable payload collapses: ${JSON.stringify(bad)}`);
    assert.equal(sub.tier, null);
  }
  // A missing amount falls back to the locked price table rather than NaN.
  const noAmount = normalizeSubscription({ subscribed: true, tier: "DIAMOND", status: "ACTIVE" });
  assert.equal(noAmount.amountPence, 1999);
});

test("formatChargeDate: short human date, null for garbage", () => {
  assert.equal(formatChargeDate("2026-08-10T12:00:00Z"), "10 Aug 2026");
  assert.equal(formatChargeDate("not-a-date"), null);
  assert.equal(formatChargeDate(null), null);
});

// --- Manage-panel view model ----------------------------------------------------------------------

test("describeSubscription: ACTIVE renews on the period end and offers Cancel", () => {
  const view = describeSubscription({
    subscribed: true,
    tier: "MONTHLY",
    status: "ACTIVE",
    currentPeriodEnd: "2026-08-10T12:00:00Z",
    renewing: true,
  });
  assert.equal(view.subscribed, true);
  assert.equal(view.statusLabel, "Active");
  assert.match(view.renewalLine, /renews on 10 Aug 2026/i);
  assert.equal(view.priceLine, "£9.99/month");
  assert.equal(view.canCancel, true);
  assert.equal(view.paymentProblem, false);
});

test("describeSubscription: PAST_DUE shows the dunning copy and still offers Cancel (tier is kept)", () => {
  const view = describeSubscription({
    subscribed: true,
    tier: "DIAMOND",
    status: "PAST_DUE",
    currentPeriodEnd: "2026-08-10T12:00:00Z",
    renewing: true,
  });
  assert.equal(view.statusLabel, "Payment problem");
  assert.match(view.renewalLine, /retry/i);
  assert.equal(view.paymentProblem, true);
  assert.equal(view.canCancel, true);
});

test("describeSubscription: CANCELED shows the access horizon and no Cancel (already done)", () => {
  const view = describeSubscription({
    subscribed: true,
    tier: "MONTHLY",
    status: "CANCELED",
    currentPeriodEnd: "2026-08-10T12:00:00Z",
    renewing: false,
  });
  assert.equal(view.statusLabel, "Cancelled");
  assert.match(view.renewalLine, /ends on 10 Aug 2026/i);
  assert.equal(view.canCancel, false);
});

test("describeSubscription: the none-state renders no panel actions", () => {
  const view = describeSubscription({ subscribed: false });
  assert.equal(view.subscribed, false);
  assert.equal(view.canCancel, false);
  assert.equal(view.statusLabel, null);
});

// --- Route helpers ---------------------------------------------------------------------------------

test("subscribeRoute / tierFromSubscribeRoute: round-trip, defaults, and rejection", () => {
  assert.equal(subscribeRoute("MONTHLY"), "#/membership/subscribe/MONTHLY");
  assert.equal(tierFromSubscribeRoute(subscribeRoute("MONTHLY")), "MONTHLY");
  assert.equal(tierFromSubscribeRoute(subscribeRoute("DIAMOND")), "DIAMOND");
  // A bare subscribe route lands on the default paid tier rather than nowhere.
  assert.equal(tierFromSubscribeRoute(SUBSCRIBE_ROUTE_PREFIX), "MONTHLY");
  // Lowercase tier segments are tolerated (hash edits by hand).
  assert.equal(tierFromSubscribeRoute("#/membership/subscribe/diamond"), "DIAMOND");
  // Everything else is not a subscribe route: null is the router's predicate signal.
  assert.equal(tierFromSubscribeRoute("#/membership/subscribe/GOLD"), null);
  assert.equal(tierFromSubscribeRoute("#/membership"), null);
  assert.equal(tierFromSubscribeRoute(undefined), null);
});
