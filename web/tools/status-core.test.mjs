// Tests for the public status page's pure core (TM-182). Framework-free — Node's built-in test
// runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// status-core.js has zero DOM/fetch/timer deps, so we can assert the whole behaviour here: how the
// two health signals map to the overall banner, how samples bucket into 15-minute windows, and how
// each bar's green/amber "deviation" colour is decided.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Overall,
  classifyOverall,
  BUCKET_MS,
  DAY_BUCKETS,
  bucketStart,
  dayBucketStarts,
  rollup,
  latencyBaseline,
  Level,
  latencyLevel,
  availabilityLevel,
} from "../src/status/status-core.js";

// A fixed "now" on a clean 15-minute boundary keeps bucket maths easy to reason about.
const NOW = Date.UTC(2026, 6, 9, 12, 0, 0); // 2026-07-09T12:00:00Z

test("classifyOverall: both signals up → AVAILABLE", () => {
  const r = classifyOverall({ backendUp: true, webReachable: true });
  assert.equal(r.level, Overall.AVAILABLE);
  assert.match(r.title, /operational/i);
});

test("classifyOverall: both down → OUTAGE", () => {
  const r = classifyOverall({ backendUp: false, webReachable: false });
  assert.equal(r.level, Overall.OUTAGE);
  assert.match(r.title, /outage/i);
});

test("classifyOverall: exactly one down → DEGRADED, and the detail names the impaired half", () => {
  const apiDown = classifyOverall({ backendUp: false, webReachable: true });
  assert.equal(apiDown.level, Overall.DEGRADED);
  assert.match(apiDown.detail, /API/i, "API-down detail mentions the API");

  const webDown = classifyOverall({ backendUp: true, webReachable: false });
  assert.equal(webDown.level, Overall.DEGRADED);
  assert.match(webDown.detail, /website/i, "web-down detail mentions the website");

  // The two degraded details are distinct, so the page tells the user which side is impaired.
  assert.notEqual(apiDown.detail, webDown.detail);
});

test("classifyOverall: an unresolved signal holds on CHECKING (never flashes red before first probe)", () => {
  assert.equal(classifyOverall({ backendUp: null, webReachable: true }).level, Overall.CHECKING);
  assert.equal(classifyOverall({ backendUp: true, webReachable: null }).level, Overall.CHECKING);
  assert.equal(classifyOverall({}).level, Overall.CHECKING);
  assert.equal(classifyOverall(undefined).level, Overall.CHECKING);
});

test("bucketStart: floors to the 15-minute window; samples in the same window share a key", () => {
  const t = NOW + 3 * 60 * 1000; // 12:03
  const t2 = NOW + 14 * 60 * 1000 + 59 * 1000; // 12:14:59 — same window
  assert.equal(bucketStart(t), NOW);
  assert.equal(bucketStart(t2), NOW);
  assert.equal(bucketStart(NOW + BUCKET_MS), NOW + BUCKET_MS, "next window is a new key");
});

test("dayBucketStarts: 96 ascending 15-min buckets ending in the current window", () => {
  const starts = dayBucketStarts(NOW + 60 * 1000); // 12:01 → current bucket is 12:00
  assert.equal(starts.length, DAY_BUCKETS);
  assert.equal(starts[starts.length - 1], NOW, "last bucket is the current window");
  assert.equal(starts[0], NOW - (DAY_BUCKETS - 1) * BUCKET_MS, "first bucket is 24h - 15min ago");
  // strictly ascending, one bucket apart
  for (let i = 1; i < starts.length; i++) assert.equal(starts[i] - starts[i - 1], BUCKET_MS);
});

test("rollup: aggregates avg latency + success ratio per window; empty windows are 'no data'", () => {
  const samples = [
    { ts: NOW + 60_000, latencyMs: 100, ok: true },
    { ts: NOW + 120_000, latencyMs: 200, ok: true },
    { ts: NOW + 180_000, latencyMs: null, ok: false }, // failed request: hits availability, not latency avg
  ];
  const buckets = rollup(samples, { nowMs: NOW + 60_000 });
  const current = buckets[buckets.length - 1];
  assert.equal(current.start, NOW);
  assert.equal(current.count, 3);
  assert.equal(current.avgLatencyMs, 150, "mean of the two measurable latencies (100, 200)");
  assert.equal(current.successRatio, 2 / 3, "2 of 3 responses were ok");
  assert.equal(current.hasData, true);

  // An earlier, untouched window is empty.
  const empty = buckets[0];
  assert.equal(empty.hasData, false);
  assert.equal(empty.avgLatencyMs, null);
  assert.equal(empty.successRatio, null);
  assert.equal(empty.count, 0);
});

test("rollup: samples outside the Day window are dropped", () => {
  const stale = [{ ts: NOW - 2 * 24 * 3600 * 1000, latencyMs: 50, ok: true }]; // 2 days ago
  const buckets = rollup(stale, { nowMs: NOW });
  assert.ok(
    buckets.every((b) => !b.hasData),
    "nothing lands in the axis for a sample older than the Day window",
  );
});

test("latencyBaseline: median of non-empty buckets (a single spike doesn't drag it up)", () => {
  const buckets = [
    { avgLatencyMs: 100 },
    { avgLatencyMs: null }, // empty windows ignored
    { avgLatencyMs: 110 },
    { avgLatencyMs: 90 },
    { avgLatencyMs: 5000 }, // spike — median resists it
  ];
  // Non-null values sorted: [90, 100, 110, 5000] → even count → median = (100 + 110) / 2 = 105.
  assert.equal(latencyBaseline(buckets), 105, "median resists the 5000ms spike");
});

test("latencyBaseline: null when there's nothing measurable yet", () => {
  assert.equal(latencyBaseline([{ avgLatencyMs: null }, { avgLatencyMs: null }]), null);
  assert.equal(latencyBaseline([]), null);
});

test("latencyLevel: amber only when a window deviates > 1.5x the baseline", () => {
  assert.equal(latencyLevel(120, 100), Level.NORMAL, "1.2x baseline → normal");
  assert.equal(latencyLevel(160, 100), Level.DEVIATION, "1.6x baseline → deviation (amber)");
  assert.equal(latencyLevel(150, 100), Level.NORMAL, "exactly 1.5x is not yet a deviation");
  assert.equal(latencyLevel(null, 100), Level.NODATA, "no data → no bar");
  assert.equal(latencyLevel(999, null), Level.NORMAL, "no baseline yet → can't call a deviation");
});

test("availabilityLevel: amber below the 99.5% non-5xx success threshold", () => {
  assert.equal(availabilityLevel(1.0), Level.NORMAL, "100% → green");
  assert.equal(availabilityLevel(0.995), Level.NORMAL, "exactly the threshold → green");
  assert.equal(availabilityLevel(0.98), Level.DEVIATION, "98% → amber");
  assert.equal(availabilityLevel(0), Level.DEVIATION, "total failure → amber");
  assert.equal(availabilityLevel(null), Level.NODATA, "no data → no bar");
});
