// Unit tests (TM-1115) for the pure admin roster math — the 4-state badge derivation, the live+past
// merge with rejoin supersession + history affordance, and the client-side include/exclude chip filter
// (NO refetch). Asserted without a browser (the event-form.js split). Runs on the PR gate via
// `node --test web/tools/*.test.mjs`.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ROSTER_STATE_GOING,
  ROSTER_STATE_WAITLISTED,
  ROSTER_STATE_EVICTED,
  ROSTER_STATE_CANCELLED,
  ROSTER_FILTER_CHIPS,
  defaultChipSelection,
  rosterStateBadge,
  mergeRosterRows,
  filterRosterRows,
} from "../src/assets/roster-core.js";

// ---- defaults --------------------------------------------------------------------------------

test("default chip selection is Waitlist ON, Evicted OFF, Cancelled OFF (Going has no chip)", () => {
  const sel = defaultChipSelection();
  assert.equal(sel.has(ROSTER_STATE_WAITLISTED), true, "waitlist on by default");
  assert.equal(sel.has(ROSTER_STATE_EVICTED), false, "evicted off by default");
  assert.equal(sel.has(ROSTER_STATE_CANCELLED), false, "cancelled off by default");
  assert.equal(sel.has(ROSTER_STATE_GOING), false, "Going is not a chip (always shown)");
  // Fresh Set per call — mutating one must not affect the next.
  sel.add(ROSTER_STATE_EVICTED);
  assert.equal(defaultChipSelection().has(ROSTER_STATE_EVICTED), false, "not a shared reference");
});

test("chip config governs exactly the three non-Going states", () => {
  const keys = ROSTER_FILTER_CHIPS.map((c) => c.key);
  assert.deepEqual(keys, [ROSTER_STATE_WAITLISTED, ROSTER_STATE_EVICTED, ROSTER_STATE_CANCELLED]);
  assert.equal(keys.includes(ROSTER_STATE_GOING), false);
});

// ---- 4-state badges --------------------------------------------------------------------------

test("badge derivation covers all four states", () => {
  assert.deepEqual(rosterStateBadge(ROSTER_STATE_GOING), { label: "Going", tone: "ok" });
  assert.deepEqual(rosterStateBadge(ROSTER_STATE_WAITLISTED), { label: "Waitlist", tone: "info" });
  assert.deepEqual(rosterStateBadge(ROSTER_STATE_EVICTED), { label: "Evicted", tone: "off" });
  assert.deepEqual(rosterStateBadge(ROSTER_STATE_CANCELLED), { label: "Cancelled", tone: "off" });
});

test("badge is case-insensitive and fails open on unknown", () => {
  assert.deepEqual(rosterStateBadge("going"), { label: "Going", tone: "ok" });
  assert.deepEqual(rosterStateBadge("weird"), { label: "weird", tone: "unknown" });
  assert.deepEqual(rosterStateBadge(null), { label: "Unknown", tone: "unknown" });
});

// ---- merge -----------------------------------------------------------------------------------

test("merge: live entries first (going then waitlist), then past rows", () => {
  const roster = {
    entries: [
      { userId: 1, displayName: "Ada", state: "GOING", overCapacity: false },
      { userId: 2, displayName: "Ben", state: "WAITLISTED", overCapacity: false },
    ],
    pastEntries: [
      { userId: 3, displayName: "Cy", lastState: "EVICTED", at: "2026-07-01T10:00:00Z", byAdmin: true },
      { userId: 4, displayName: "Di", lastState: "CANCELLED", at: "2026-07-02T10:00:00Z", byAdmin: false },
    ],
  };
  const rows = mergeRosterRows(roster);
  assert.deepEqual(rows.map((r) => [r.userId, r.state]), [
    [1, "GOING"],
    [2, "WAITLISTED"],
    [3, "EVICTED"],
    [4, "CANCELLED"],
  ]);
  // Live rows carry no history (they never left); past rows carry their timestamp + byAdmin.
  assert.equal(rows[0].history, null);
  assert.equal(rows[2].at, "2026-07-01T10:00:00Z");
  assert.equal(rows[2].byAdmin, true);
  assert.equal(rows[3].byAdmin, false);
});

test("merge: over-capacity flag carries through on a live GOING row", () => {
  const rows = mergeRosterRows({
    entries: [{ userId: 1, displayName: "Ada", state: "GOING", overCapacity: true }],
    pastEntries: [],
  });
  assert.equal(rows[0].overCapacity, true);
});

test("merge: rejoined-after-evict is ONE live Going row + a history affordance (supersession)", () => {
  // User 5 was evicted, then rejoined => a live GOING row. The backend already drops them from
  // pastEntries, but even if a stray past row is present, merge must NOT double-list them, and their
  // live row must carry the latest past state + timestamp as a history affordance.
  const roster = {
    entries: [{ userId: 5, displayName: "Eve", state: "GOING", overCapacity: false }],
    pastEntries: [{ userId: 5, displayName: "Eve", lastState: "EVICTED", at: "2026-06-30T09:00:00Z", byAdmin: true }],
  };
  const rows = mergeRosterRows(roster);
  const forFive = rows.filter((r) => r.userId === 5);
  assert.equal(forFive.length, 1, "not double-listed");
  assert.equal(forFive[0].state, "GOING", "shows as the live Going row");
  assert.deepEqual(forFive[0].history, { lastState: "EVICTED", at: "2026-06-30T09:00:00Z", byAdmin: true });
});

test("merge: collapses to the most-recent past exit when payload has several for one user", () => {
  // pastEntries is newest-first; the FIRST occurrence per user is their most-recent exit.
  const rows = mergeRosterRows({
    entries: [],
    pastEntries: [
      { userId: 7, displayName: "Gil", lastState: "CANCELLED", at: "2026-07-05T10:00:00Z", byAdmin: false },
      { userId: 7, displayName: "Gil", lastState: "EVICTED", at: "2026-07-01T10:00:00Z", byAdmin: true },
    ],
  });
  const forSeven = rows.filter((r) => r.userId === 7);
  assert.equal(forSeven.length, 1, "collapsed to one row");
  assert.equal(forSeven[0].state, "CANCELLED", "kept the most-recent exit");
});

test("merge: tolerates missing / absent arrays", () => {
  assert.deepEqual(mergeRosterRows({}), []);
  assert.deepEqual(mergeRosterRows(), []);
  assert.deepEqual(mergeRosterRows({ entries: null, pastEntries: undefined }), []);
});

// ---- client-side chip filter (NO refetch) ----------------------------------------------------

function sampleRows() {
  return mergeRosterRows({
    entries: [
      { userId: 1, displayName: "Ada", state: "GOING", overCapacity: false },
      { userId: 2, displayName: "Ben", state: "WAITLISTED", overCapacity: false },
    ],
    pastEntries: [
      { userId: 3, displayName: "Cy", lastState: "EVICTED", at: "2026-07-01T10:00:00Z", byAdmin: true },
      { userId: 4, displayName: "Di", lastState: "CANCELLED", at: "2026-07-02T10:00:00Z", byAdmin: false },
    ],
  });
}

test("filter: default selection shows Going + Waitlist, hides Evicted + Cancelled", () => {
  const visible = filterRosterRows(sampleRows(), defaultChipSelection());
  assert.deepEqual(visible.map((r) => r.state), ["GOING", "WAITLISTED"]);
});

test("filter: Going is ALWAYS shown even with an empty chip selection", () => {
  const visible = filterRosterRows(sampleRows(), new Set());
  assert.deepEqual(visible.map((r) => r.state), ["GOING"]);
});

test("filter: enabling Evicted + Cancelled reveals the past rows (no refetch — same input rows)", () => {
  const rows = sampleRows();
  const all = filterRosterRows(rows, new Set([ROSTER_STATE_WAITLISTED, ROSTER_STATE_EVICTED, ROSTER_STATE_CANCELLED]));
  assert.deepEqual(all.map((r) => r.state), ["GOING", "WAITLISTED", "EVICTED", "CANCELLED"]);
  // The SAME already-fetched rows array drives every selection — proving the filter is pure/client-side.
  const onlyEvicted = filterRosterRows(rows, new Set([ROSTER_STATE_EVICTED]));
  assert.deepEqual(onlyEvicted.map((r) => r.state), ["GOING", "EVICTED"]);
});

test("filter: accepts an array selection too, and fails open on an unknown state", () => {
  const rows = [
    { userId: 1, state: "GOING" },
    { userId: 9, state: "MYSTERY" },
    { userId: 2, state: "WAITLISTED" },
  ];
  const visible = filterRosterRows(rows, ["WAITLISTED"]);
  // GOING always, MYSTERY fails open (never silently hidden), WAITLISTED selected.
  assert.deepEqual(visible.map((r) => r.userId), [1, 9, 2]);
});
