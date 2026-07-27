// Behavioural unit tests for the pure "Your devices" view-model (TM-924, devices-core.js).
// Framework-free — Node's built-in test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// This is the fail-before / pass-after evidence for the frontend feature: it imports the pure module
// directly (no DOM, no api.js, no Firebase CDN) and asserts the decisions the profile Security section
// renders from — platform labels, row normalization, newest-active-first ordering, and tolerance of a
// bad payload. The DOM shell that consumes these (biometric-settings.js) is api-coupled and so is
// pinned separately with source-level guards (biometric-settings-devices.test.mjs).

import assert from "node:assert/strict";
import { test } from "node:test";

import { platformLabel, deviceRowView, deviceListView } from "../src/assets/devices-core.js";

test("platformLabel maps each backend DevicePlatform enum to friendly copy (no raw enum token leaks)", () => {
  assert.equal(platformLabel("ANDROID"), "Android device");
  assert.equal(platformLabel("IOS"), "iPhone or iPad");
  assert.equal(platformLabel("WEB"), "Web browser");
  // Case-insensitive on the way in (defensive).
  assert.equal(platformLabel("web"), "Web browser");
  // An unknown / missing platform degrades to a safe generic — never the raw token or "undefined".
  assert.equal(platformLabel("BLACKBERRY"), "Device");
  assert.equal(platformLabel(null), "Device");
  assert.equal(platformLabel(undefined), "Device");
});

test("deviceRowView normalizes a raw payload row into a stable, label-carrying view-model", () => {
  const row = deviceRowView({
    id: 42,
    platform: "ANDROID",
    lastSeen: "2026-07-20T10:00:00Z",
    created: "2026-07-01T09:00:00Z",
  });
  assert.equal(row.id, 42);
  assert.equal(row.platform, "ANDROID");
  assert.equal(row.platformLabel, "Android device");
  assert.equal(row.lastSeen, "2026-07-20T10:00:00Z");
  assert.equal(row.created, "2026-07-01T09:00:00Z");
});

test("deviceRowView tolerates a partial row: missing platform → generic label, missing stamps → null", () => {
  const row = deviceRowView({ id: 7 });
  assert.equal(row.id, 7);
  assert.equal(row.platformLabel, "Device");
  assert.equal(row.lastSeen, null);
  assert.equal(row.created, null);
  // A totally absent row must not throw (never white-screens the section).
  const empty = deviceRowView(undefined);
  assert.equal(empty.id, null);
  assert.equal(empty.platformLabel, "Device");
});

test("deviceListView orders devices newest-active first (by lastSeen descending)", () => {
  const rows = deviceListView([
    { id: 1, platform: "WEB", lastSeen: "2026-07-01T00:00:00Z" },
    { id: 2, platform: "ANDROID", lastSeen: "2026-07-20T00:00:00Z" },
    { id: 3, platform: "IOS", lastSeen: "2026-07-10T00:00:00Z" },
  ]);
  assert.deepEqual(
    rows.map((r) => r.id),
    [2, 3, 1],
    "the most-recently-seen device sits at the top of the list",
  );
  // …and every row is the normalized view-model (labels resolved), not the raw payload.
  assert.equal(rows[0].platformLabel, "Android device");
});

test("deviceListView sorts a device with a missing/invalid lastSeen to the end (treated as oldest)", () => {
  const rows = deviceListView([
    { id: 1, platform: "WEB" }, // no lastSeen
    { id: 2, platform: "ANDROID", lastSeen: "2026-07-20T00:00:00Z" },
    { id: 3, platform: "IOS", lastSeen: "not-a-date" }, // invalid
  ]);
  assert.equal(rows[0].id, 2, "the one with a real lastSeen leads");
  // Both the missing and the invalid stamp sink to the bottom — neither poisons the comparison.
  assert.deepEqual(new Set(rows.slice(1).map((r) => r.id)), new Set([1, 3]));
});

test("deviceListView is tolerant of a non-array payload → an empty list (shell paints its empty state)", () => {
  assert.deepEqual(deviceListView(null), []);
  assert.deepEqual(deviceListView(undefined), []);
  assert.deepEqual(deviceListView({}), []);
  assert.deepEqual(deviceListView("boom"), []);
  assert.deepEqual(deviceListView([]), []);
});
