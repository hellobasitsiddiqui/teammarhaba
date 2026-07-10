// Tests for the membership tier-management pure core (TM-480). Framework-free — Node's built-in test
// runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// The screen's decisions all live in DOM-free, api-free functions (the AC's "pure parts tested"): the
// tier catalogue, the switch-availability state machine (which tiers are switchable now vs gated
// behind the card step vs a coming-soon future tier), the first-event-credit reflection, and the
// runtime switch action. performSwitch is exercised against a MOCK api (contract TM-457: the frontend
// resolves api at runtime, tests mock it) so we can assert it calls switchTier for the free base and
// NEVER touches the network for a gated / coming-soon tier — with no browser.

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
} from "../src/assets/membership-tier.js";

// --- Catalogue -----------------------------------------------------------------------------------

test("TIERS: the three contract tiers in display order, PAY_PER_EVENT the free base first", () => {
  assert.deepEqual(TIER_IDS, ["PAY_PER_EVENT", "MONTHLY", "DIAMOND"]);
  assert.equal(DEFAULT_TIER, "PAY_PER_EVENT");
  assert.equal(TIERS[0].paid, false, "the base is free");
  assert.equal(TIERS[1].paid, true, "Monthly is paid");
  assert.equal(TIERS[2].comingSoon, true, "Diamond is a coming-soon future tier");
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

// --- Switch availability state machine (the AC) --------------------------------------------------

test("isSwitchableNow: only the free base is self-serve without the card step (AC2)", () => {
  assert.equal(isSwitchableNow("PAY_PER_EVENT"), true);
  assert.equal(isSwitchableNow("MONTHLY"), false);
  assert.equal(isSwitchableNow("DIAMOND"), false);
});

test("optionState: current is CURRENT; free base SWITCHABLE; paid GATED; Diamond COMING_SOON", () => {
  // Caller on the free base.
  assert.equal(optionState("PAY_PER_EVENT", "PAY_PER_EVENT"), OptionState.CURRENT);
  assert.equal(optionState("PAY_PER_EVENT", "MONTHLY"), OptionState.GATED, "paid upgrade gated behind M5");
  assert.equal(optionState("PAY_PER_EVENT", "DIAMOND"), OptionState.COMING_SOON, "Diamond is future");

  // Caller on Monthly can drop back to the free base right now (AC2), and Monthly is their CURRENT.
  assert.equal(optionState("MONTHLY", "PAY_PER_EVENT"), OptionState.SWITCHABLE);
  assert.equal(optionState("MONTHLY", "MONTHLY"), OptionState.CURRENT);

  // Coming-soon precedence: even though Diamond is also paid, it's COMING_SOON, never GATED.
  assert.equal(optionState("MONTHLY", "DIAMOND"), OptionState.COMING_SOON);
});

test("switchOptionFor: descriptor carries label, disabled flag and note per state", () => {
  const current = switchOptionFor("PAY_PER_EVENT", "PAY_PER_EVENT");
  assert.equal(current.isCurrent, true);
  assert.equal(current.disabled, true);
  assert.match(current.actionLabel, /current/i);

  const gated = switchOptionFor("PAY_PER_EVENT", "MONTHLY");
  assert.equal(gated.state, OptionState.GATED);
  assert.equal(gated.disabled, true, "paid upgrade is shown but not clickable yet (AC2)");
  assert.ok(gated.note, "gated option explains the card step");

  const soon = switchOptionFor("PAY_PER_EVENT", "DIAMOND");
  assert.equal(soon.state, OptionState.COMING_SOON);
  assert.equal(soon.disabled, true);
  assert.match(soon.actionLabel, /coming soon/i);

  const switchable = switchOptionFor("MONTHLY", "PAY_PER_EVENT");
  assert.equal(switchable.state, OptionState.SWITCHABLE);
  assert.equal(switchable.disabled, false, "switching to the free base works now (AC2)");
});

test("tierOptions: one descriptor per tier in order, exactly one marked current", () => {
  const opts = tierOptions({ tier: "MONTHLY" });
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

test("performSwitch: NEVER calls the endpoint for a gated / coming-soon tier", async () => {
  let called = false;
  const api = {
    switchTier: async () => {
      called = true;
      return {};
    },
  };
  for (const tier of ["MONTHLY", "DIAMOND"]) {
    const errors = [];
    const result = await performSwitch(api, tier, { onError: (e) => errors.push(e) });
    assert.equal(result.ok, false, `${tier} is not switchable now`);
    assert.equal(result.reason, "not-switchable");
    assert.equal(errors.length, 1, "the caller is told why via onError");
  }
  assert.equal(called, false, "no network call for a non-switchable tier");
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
