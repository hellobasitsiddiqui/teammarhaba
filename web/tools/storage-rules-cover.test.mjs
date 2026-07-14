import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { missingStoragePathCoverage, REQUIRED_STORAGE_PATHS } from "./storage-rules-cover.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// The exact state prod was in during the TM-704 outage: avatars/ was deployed (TM-184), but the
// event-images/ (TM-392) and venue-images/ (TM-519) blocks never reached the released ruleset.
const STALE_AVATARS_ONLY = `
service firebase.storage {
  match /b/{bucket}/o {
    match /avatars/{uid} {
      allow read: if true;
      allow create, update: if request.auth.uid == uid;
    }
  }
}`;

test("reproduces the TM-704 outage: a stale avatars-only ruleset misses the image paths", () => {
  // On the buggy (stale-deployed) ruleset the checker reports exactly what was default-denied —
  // this is the failing-first condition the fix must clear.
  assert.deepEqual(missingStoragePathCoverage(STALE_AVATARS_ONLY), ["event-images", "venue-images"]);
});

test("the committed storage.rules covers every required path", () => {
  const rules = readFileSync(join(repoRoot, "storage.rules"), "utf8");
  assert.deepEqual(missingStoragePathCoverage(rules), []);
});

test("dropping any single block is caught (guards future edits)", () => {
  const withoutVenues = STALE_AVATARS_ONLY + "\n    match /event-images/{id} { allow write: if true; }";
  assert.deepEqual(missingStoragePathCoverage(withoutVenues), ["venue-images"]);
});

test("REQUIRED_STORAGE_PATHS is the set the app actually writes to", () => {
  assert.deepEqual([...REQUIRED_STORAGE_PATHS].sort(), ["avatars", "event-images", "venue-images"]);
});
