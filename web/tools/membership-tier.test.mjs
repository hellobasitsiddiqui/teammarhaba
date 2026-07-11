// Tests for the membership tier-management pure core (TM-480, subscription-aware since TM-620).
// Framework-free — Node's built-in test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// The screen's decisions all live in DOM-free, api-free functions (the AC's "pure parts tested"): the
// tier catalogue, the switch-availability state machine (SINCE TM-620: paid tiers are SUBSCRIBE
// actions pointing at the Subscribe checkout unless a subscription already covers them, and the free
// base is BLOCKED while a subscription still renews), the first-event-credit reflection, and the
// runtime switch action. performSwitch is exercised against a MOCK api (contract TM-457: the frontend
// resolves api at runtime, tests mock it) so we can assert it calls switchTier only when the switch is
// genuinely free — and NEVER touches the network for a subscribe/blocked/coming-soon tier.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  TIERS,
  TIER_IDS,
  DEFAULT_TIER,
  OptionState,
  isValidTier,
  tierMeta,
  normalizeMembership,
  isSwitchableNow,
  optionState,
  switchOptionFor,
  tierOptions,
  firstEventCreditNote,
  performSwitch,
  cancelDialogCopy,
} from "../src/assets/membership-tier.js";
import { describeSubscription } from "../src/assets/membership-subscribe-core.js";

// Subscription fixtures (the GET /me/subscription shapes the state machine keys off — TM-620).
const NO_SUB = { subscribed: false };
const ACTIVE_MONTHLY = {
  subscribed: true,
  tier: "MONTHLY",
  status: "ACTIVE",
  renewing: true,
  currentPeriodEnd: "2026-08-10T12:00:00Z",
};
const PAST_DUE_MONTHLY = { ...ACTIVE_MONTHLY, status: "PAST_DUE" };
const CANCELED_MONTHLY = { ...ACTIVE_MONTHLY, status: "CANCELED", renewing: false };

// --- Catalogue -----------------------------------------------------------------------------------

test("TIERS: the three contract tiers in display order, PAY_PER_EVENT the free base first", () => {
  assert.deepEqual(TIER_IDS, ["PAY_PER_EVENT", "MONTHLY", "DIAMOND"]);
  assert.equal(DEFAULT_TIER, "PAY_PER_EVENT");
  assert.equal(TIERS[0].paid, false, "the base is free");
  assert.equal(TIERS[1].paid, true, "Monthly is paid");
  assert.equal(TIERS[2].comingSoon, false, "Diamond went live with subscriptions (TM-620)");
  // Every tier carries a non-empty "what it includes" list (AC1).
  for (const t of TIERS) assert.ok(t.includes.length > 0, `${t.id} lists what it includes`);
});

test("isValidTier / tierMeta: known ids resolve, unknown falls back to the free base", () => {
  assert.equal(isValidTier("MONTHLY"), true);
  assert.equal(isValidTier("PLATINUM"), false);
  assert.equal(isValidTier(undefined), false);
  assert.equal(tierMeta("DIAMOND").label, "Diamond");
  assert.equal(tierMeta("nope").id, DEFAULT_TIER, "unknown tier → default meta, never undefined");
});

// --- Normalisation -------------------------------------------------------------------------------

test("normalizeMembership: coerces garbage / partial responses to a safe shape", () => {
  assert.deepEqual(normalizeMembership({ tier: "MONTHLY", firstEventCreditAvailable: true }), {
    tier: "MONTHLY",
    firstEventCreditAvailable: true,
  });
  // Unknown tier → free base; missing / non-boolean credit → false.
  assert.deepEqual(normalizeMembership({ tier: "GOLD" }), {
    tier: "PAY_PER_EVENT",
    firstEventCreditAvailable: false,
  });
  assert.deepEqual(normalizeMembership(null), {
    tier: "PAY_PER_EVENT",
    firstEventCreditAvailable: false,
  });
  assert.equal(normalizeMembership({ firstEventCreditAvailable: "yes" }).firstEventCreditAvailable, false);
});

// --- Switch availability state machine (TM-620) --------------------------------------------------

test("isSwitchableNow: without a subscription only the free base is switchable — paid tiers need the checkout", () => {
  assert.equal(isSwitchableNow("PAY_PER_EVENT", NO_SUB), true);
  assert.equal(isSwitchableNow("PAY_PER_EVENT", undefined), true, "absent subscription = none");
  assert.equal(isSwitchableNow("MONTHLY", NO_SUB), false);
  assert.equal(isSwitchableNow("DIAMOND", NO_SUB), false);
});

test("isSwitchableNow: a covering subscription unlocks its paid tier; a renewing one blocks the free base", () => {
  // The MONTHLY subscription covers MONTHLY (e.g. switching back after a manual downgrade)…
  assert.equal(isSwitchableNow("MONTHLY", ACTIVE_MONTHLY), true);
  // …but never the OTHER paid tier.
  assert.equal(isSwitchableNow("DIAMOND", ACTIVE_MONTHLY), false);
  // While renewals still run (ACTIVE or dunning) the free base is blocked — cancel first.
  assert.equal(isSwitchableNow("PAY_PER_EVENT", ACTIVE_MONTHLY), false);
  assert.equal(isSwitchableNow("PAY_PER_EVENT", PAST_DUE_MONTHLY), false);
  // A cancelled subscription no longer renews, so dropping to the free base is fine again.
  assert.equal(isSwitchableNow("PAY_PER_EVENT", CANCELED_MONTHLY), true);
});

test("optionState: current is CURRENT; paid without a sub is SUBSCRIBE; free base blocked while renewing", () => {
  // Caller on the free base, never subscribed: both paid tiers offer the Subscribe checkout.
  assert.equal(optionState("PAY_PER_EVENT", "PAY_PER_EVENT", NO_SUB), OptionState.CURRENT);
  assert.equal(optionState("PAY_PER_EVENT", "MONTHLY", NO_SUB), OptionState.SUBSCRIBE);
  assert.equal(optionState("PAY_PER_EVENT", "DIAMOND", NO_SUB), OptionState.SUBSCRIBE);

  // Caller on Monthly with an active subscription: Monthly is CURRENT, the free base is BLOCKED
  // (cancel first), and Diamond is a SUBSCRIBE (a different subscription).
  assert.equal(optionState("MONTHLY", "MONTHLY", ACTIVE_MONTHLY), OptionState.CURRENT);
  assert.equal(optionState("MONTHLY", "PAY_PER_EVENT", ACTIVE_MONTHLY), OptionState.BLOCKED);
  assert.equal(optionState("MONTHLY", "DIAMOND", ACTIVE_MONTHLY), OptionState.SUBSCRIBE);

  // After a cancel the free base becomes SWITCHABLE again (access runs to the period end server-side).
  assert.equal(optionState("MONTHLY", "PAY_PER_EVENT", CANCELED_MONTHLY), OptionState.SWITCHABLE);
});

test("switchOptionFor: descriptor carries label, disabled flag, price and navigation per state", () => {
  const current = switchOptionFor("PAY_PER_EVENT", "PAY_PER_EVENT", NO_SUB);
  assert.equal(current.isCurrent, true);
  assert.equal(current.disabled, true);
  assert.match(current.actionLabel, /current/i);

  // A paid tier without a covering subscription: an ENABLED Subscribe action that navigates to the
  // Subscribe checkout with the price on the label (TM-620).
  const subscribe = switchOptionFor("PAY_PER_EVENT", "MONTHLY", NO_SUB);
  assert.equal(subscribe.state, OptionState.SUBSCRIBE);
  assert.equal(subscribe.disabled, false, "Subscribe is a live action, not a placeholder");
  assert.match(subscribe.actionLabel, /subscribe/i);
  assert.match(subscribe.actionLabel, /£9\.99\/month/, "Monthly is £9.99/mo (locked price)");
  assert.equal(subscribe.subscribeHref, "#/membership/subscribe/MONTHLY");
  assert.equal(subscribe.price, "£9.99/month");

  const diamond = switchOptionFor("PAY_PER_EVENT", "DIAMOND", NO_SUB);
  assert.match(diamond.actionLabel, /£19\.99\/month/, "Diamond is £19.99/mo (locked price)");
  assert.equal(diamond.subscribeHref, "#/membership/subscribe/DIAMOND");

  // The free base while the subscription renews: shown but disabled, pointing at cancel.
  const blocked = switchOptionFor("MONTHLY", "PAY_PER_EVENT", ACTIVE_MONTHLY);
  assert.equal(blocked.state, OptionState.BLOCKED);
  assert.equal(blocked.disabled, true);
  assert.ok(blocked.note, "blocked option explains that cancel comes first");

  const switchable = switchOptionFor("MONTHLY", "PAY_PER_EVENT", CANCELED_MONTHLY);
  assert.equal(switchable.state, OptionState.SWITCHABLE);
  assert.equal(switchable.disabled, false, "switching to the free base works once cancelled");
});

test("tierOptions: one descriptor per tier in order, exactly one marked current", () => {
  const opts = tierOptions({ tier: "MONTHLY" }, ACTIVE_MONTHLY);
  assert.deepEqual(opts.map((o) => o.tier), TIER_IDS);
  assert.equal(opts.filter((o) => o.isCurrent).length, 1);
  assert.equal(opts.find((o) => o.isCurrent).tier, "MONTHLY");
});

// --- First-event credit reflection ---------------------------------------------------------------

test("firstEventCreditNote: reflects the credit only for PAY_PER_EVENT (AC / contract)", () => {
  const available = firstEventCreditNote({ tier: "PAY_PER_EVENT", firstEventCreditAvailable: true });
  assert.equal(available.available, true);
  assert.match(available.text, /free credit|first event/i);

  const used = firstEventCreditNote({ tier: "PAY_PER_EVENT", firstEventCreditAvailable: false });
  assert.equal(used.available, false);
  assert.match(used.text, /used/i);

  // Paid tiers: the credit doesn't apply, so no note is shown.
  assert.equal(firstEventCreditNote({ tier: "MONTHLY", firstEventCreditAvailable: true }), null);
});

// --- Runtime switch action against a mock api ----------------------------------------------------

test("performSwitch: calls api.switchTier for the free base and returns the normalised membership", async () => {
  const calls = [];
  const api = {
    switchTier: async (tier) => {
      calls.push(tier);
      return { tier, firstEventCreditAvailable: true };
    },
  };
  const events = [];
  const result = await performSwitch(api, "PAY_PER_EVENT", {
    onStart: () => events.push("start"),
    onSuccess: (m) => events.push(["success", m.tier]),
  });
  assert.deepEqual(calls, ["PAY_PER_EVENT"], "hit the switch endpoint exactly once");
  assert.equal(result.ok, true);
  assert.deepEqual(result.membership, { tier: "PAY_PER_EVENT", firstEventCreditAvailable: true });
  assert.deepEqual(events, ["start", ["success", "PAY_PER_EVENT"]]);
});

test("performSwitch: NEVER calls the endpoint for a paid tier without a covering subscription", async () => {
  let called = false;
  const api = {
    switchTier: async () => {
      called = true;
      return {};
    },
  };
  for (const tier of ["MONTHLY", "DIAMOND"]) {
    const errors = [];
    const result = await performSwitch(api, tier, { onError: (e) => errors.push(e) }, NO_SUB);
    assert.equal(result.ok, false, `${tier} needs the Subscribe checkout, not a free switch`);
    assert.equal(result.reason, "not-switchable");
    assert.equal(errors.length, 1, "the caller is told why via onError");
  }
  assert.equal(called, false, "no network call for a non-switchable tier");
});

test("performSwitch: allows a paid tier the subscription covers, blocks the free base while renewing", async () => {
  const calls = [];
  const api = {
    switchTier: async (tier) => {
      calls.push(tier);
      return { tier, firstEventCreditAvailable: false };
    },
  };
  // Covered paid tier → the endpoint IS called (the backend gate would also allow it).
  const covered = await performSwitch(api, "MONTHLY", {}, ACTIVE_MONTHLY);
  assert.equal(covered.ok, true);
  assert.deepEqual(calls, ["MONTHLY"]);

  // Free base while renewing → blocked client-side (the backend would 409 with "cancel first").
  const blocked = await performSwitch(api, "PAY_PER_EVENT", {}, ACTIVE_MONTHLY);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "not-switchable");
  assert.deepEqual(calls, ["MONTHLY"], "no second network call");
});

test("performSwitch: surfaces an api failure via onError without throwing", async () => {
  const boom = new Error("network down");
  const api = {
    switchTier: async () => {
      throw boom;
    },
  };
  const errors = [];
  const result = await performSwitch(api, "PAY_PER_EVENT", { onError: (e) => errors.push(e) });
  assert.equal(result.ok, false);
  assert.equal(result.error, boom);
  assert.deepEqual(errors, [boom]);
});

// --- Cancel-confirmation copy (TM-629) --------------------------------------------------------------
//
// Regression guard: the cancel confirm dialog used to show ONE reassuring message — "You keep your
// current plan until the end of the period you've already paid for" — to every cancellable state. For
// a PAST_DUE (dunning) subscription that promise is FALSE: cancelling parks the next charge at the
// period end, which is already in the past, so the next scheduler tick downgrades the account within
// minutes. The copy now varies on describeSubscription().paymentProblem.

test("cancelDialogCopy: PAST_DUE (dunning) must NOT promise the plan is kept until the period end (TM-629)", () => {
  // Build the view exactly the way the panel does — from the raw GET /me/subscription payload.
  const pastDue = describeSubscription({
    subscribed: true,
    tier: "MONTHLY",
    status: "PAST_DUE",
    currentPeriodEnd: "2026-06-10T12:00:00Z", // already in the past — that's why dunning is retrying
    renewing: true,
  });
  assert.equal(pastDue.paymentProblem, true, "precondition: PAST_DUE is the payment-problem state");
  const copy = cancelDialogCopy(pastDue);
  // THE regression: the reassuring promise must be gone for a dunning subscription…
  assert.doesNotMatch(
    copy.message,
    /keep your current plan until the end of the period/i,
    "a PAST_DUE user is downgraded within minutes of cancelling — the dialog must not promise otherwise",
  );
  // …replaced by honest right-away copy.
  assert.match(copy.message, /right away/i, "the dialog states the downgrade is immediate");
  assert.match(copy.message, /pay-per-event/i, "the dialog says what the account moves to");
  assert.equal(copy.title, "Cancel your subscription?");
});

test("cancelDialogCopy: ACTIVE keeps the paid-period promise (it is true there)", () => {
  const active = describeSubscription({
    subscribed: true,
    tier: "MONTHLY",
    status: "ACTIVE",
    currentPeriodEnd: "2026-08-10T12:00:00Z",
    renewing: true,
  });
  assert.equal(active.paymentProblem, false);
  const copy = cancelDialogCopy(active);
  assert.match(copy.message, /keep your current plan until the end of the period you've already paid for/i);
  assert.doesNotMatch(copy.message, /right away/i);
});

test("cancelDialogCopy: defensive — a missing/garbage view falls back to the standard copy, never throws", () => {
  for (const junk of [undefined, null, {}, { paymentProblem: "yes" }]) {
    const copy = cancelDialogCopy(junk);
    assert.equal(copy.title, "Cancel your subscription?");
    assert.match(copy.message, /keep your current plan/i);
  }
});
