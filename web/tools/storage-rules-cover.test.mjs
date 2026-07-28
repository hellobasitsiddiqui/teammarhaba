import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  missingStoragePathCoverage,
  REQUIRED_STORAGE_PATHS,
  matchBlockBodyFor,
  deniesAllAccess,
} from "./storage-rules-cover.mjs";

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

// --- chat-media (TM-1127, wave-chat-2) --------------------------------------------------------
//
// Chat media (images + voice notes) is uploaded/served ONLY through a backend-minted signed URL
// (task B). Signed URLs bypass Storage rules, so the rule for `chat-media/{conversationId}/{imageId}`
// must DENY every direct client access — public and authenticated alike. Unlike avatars/event/venue
// images (world-readable), a chat attachment is private to a conversation, so a public read (or any
// direct client write) would leak/allow-plant conversation media. Pin that deny here in the fast
// `node --test` gate against the real committed storage.rules.

test("the committed storage.rules has a chat-media block", () => {
  const rules = readFileSync(join(repoRoot, "storage.rules"), "utf8");
  assert.ok(
    matchBlockBodyFor(rules, "chat-media"),
    "expected a match /chat-media/{conversationId}/{imageId} block in storage.rules",
  );
});

test("chat-media denies all direct public/authenticated read and write", () => {
  const rules = readFileSync(join(repoRoot, "storage.rules"), "utf8");
  const body = matchBlockBodyFor(rules, "chat-media");
  assert.ok(body, "expected a chat-media block (guard: a missing block makes the deny vacuous)");
  assert.ok(
    deniesAllAccess(body),
    "chat-media must deny all direct client access (all reads/writes go via the backend signed URL, " +
      `which bypasses rules); got block body: ${body}`,
  );
});

test("deniesAllAccess: negative controls (a public allow is NOT a deny)", () => {
  // A block that grants any direct access must fail the deny check — proves the assertion pins the
  // real property, not merely block presence.
  assert.equal(deniesAllAccess("allow read: if true; allow write: if false;"), false);
  assert.equal(deniesAllAccess("allow read, write: if request.auth != null;"), false);
  // All-false (or no allow at all) is a genuine deny.
  assert.equal(deniesAllAccess("allow read: if false; allow write: if false;"), true);
  assert.equal(deniesAllAccess("// signed-URL only, no allow rules"), true);
});
