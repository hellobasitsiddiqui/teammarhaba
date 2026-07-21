// Tests for the admin roster capacity core logic (TM-592) — the browser-side mirror of the backend's
// CapacityAdjustResult derivation. Framework-free (node --test), picked up by `node --test web/tools/`.
//
// These pin the decided over-capacity behaviour on the client so the console renders the same warning
// the server returns, WITHOUT a round-trip: lowering below GOING is allowed (never an error), free-spot
// math clamps at >= 0 (never negative even while over cap), and unlimited has no ceiling.

import assert from "node:assert/strict";
import { test } from "node:test";

import { overCapacityState, overCapacityWarning } from "../src/assets/event-form.js";

test("overCapacityState: room to spare -> free spots, not over cap", () => {
  const s = overCapacityState(5, 2);
  assert.equal(s.capacity, 5);
  assert.equal(s.going, 2);
  assert.equal(s.freeSpots, 3);
  assert.equal(s.overCapacityBy, 0);
  assert.equal(s.isOverCapacity, false);
});

test("overCapacityState: exactly full -> zero free, not over cap", () => {
  const s = overCapacityState(3, 3);
  assert.equal(s.freeSpots, 0);
  assert.equal(s.overCapacityBy, 0);
  assert.equal(s.isOverCapacity, false);
});

test("overCapacityState: lowered below GOING -> over cap, free spots CLAMPED at 0 (never negative)", () => {
  const s = overCapacityState(1, 3);
  assert.equal(s.overCapacityBy, 2);
  assert.equal(s.isOverCapacity, true);
  assert.equal(s.freeSpots, 0, "free spots must clamp at >= 0, never negative while over cap");
});

test("overCapacityState: capacity 0 with attendees is fully over cap", () => {
  const s = overCapacityState(0, 2);
  assert.equal(s.overCapacityBy, 2);
  assert.equal(s.freeSpots, 0);
  assert.equal(s.isOverCapacity, true);
});

test("overCapacityState: unlimited (null/blank) has no ceiling", () => {
  for (const cap of [null, "", undefined]) {
    const s = overCapacityState(cap, 100);
    assert.equal(s.capacity, null);
    assert.equal(s.freeSpots, null, "unlimited has no free-spot ceiling");
    assert.equal(s.overCapacityBy, 0);
    assert.equal(s.isOverCapacity, false);
  }
});

test("overCapacityState: defensively clamps a negative/garbage going to 0", () => {
  assert.equal(overCapacityState(5, -3).going, 0);
  assert.equal(overCapacityState(5, "nope").going, 0);
  assert.equal(overCapacityState(5, "nope").freeSpots, 5);
});

test("overCapacityWarning: empty when at/under cap or unlimited", () => {
  assert.equal(overCapacityWarning(overCapacityState(5, 2)), "");
  assert.equal(overCapacityWarning(overCapacityState(3, 3)), "");
  assert.equal(overCapacityWarning(overCapacityState(null, 100)), "");
  assert.equal(overCapacityWarning({}), "");
});

test("overCapacityWarning: names the count and the limit, and says no one is removed", () => {
  const w = overCapacityWarning(overCapacityState(1, 3));
  assert.match(w, /2 attendees are over the new limit of 1/);
  assert.match(w, /No one is removed/);
  assert.match(w, /no new "going" joins/);
});

test("overCapacityWarning: singular for exactly one over cap", () => {
  const w = overCapacityWarning(overCapacityState(2, 3));
  assert.match(w, /1 attendee is over/);
});

test("overCapacityWarning: accepts a server CapacityAdjustResponse shape directly", () => {
  // The backend returns { overCapacityBy, capacity, ... } — the warning reads the same fields.
  const w = overCapacityWarning({ overCapacityBy: 2, capacity: 1 });
  assert.match(w, /2 attendees are over the new limit of 1/);
});
