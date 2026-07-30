// TM-684 — the onboarding gate's AVATAR wiring. The avatar shipped as a DISABLED "Soon" stub
// (buildAvatarStub: a dashed circle + a "Soon" tag, no file input, never uploads). TM-684 turns it into
// a REAL, OPTIONAL uploader: the shared buildAvatarUploader() (avatar-upload.js) that reuses the SAME
// storage.uploadAvatar → Firebase photoURL → announceAvatarChanged (TM-846) path as the profile avatar.
//
// avatar-upload.js is DOM/Firebase/Storage-heavy (buildAvatarUploader mounts real elements + wires a
// Storage upload), so — exactly like onboarding-bio-wiring.test.mjs pins the bio wiring — this pins the
// avatar wiring at the SOURCE level on both the shared module and the onboarding gate. The pure upload
// mechanics (validate/upload/boundary) are covered by storage-validate-avatar.test.mjs and
// storage-avatar-boundary.test.mjs.
//
// Framework-free — Node's built-in runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(HERE, rel), "utf8");
/** Strip `//` line comments + block comments so doc-comment mentions of a token can't false-positive. */
const stripComments = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");

const AVATAR = stripComments(read("../src/assets/avatar-upload.js"));
const ONB = stripComments(read("../src/assets/onboarding.js"));
// Raw (un-stripped) source — for assertions on string literals that contain `/*` (e.g. "image/*"),
// which stripComments would otherwise mangle as a block-comment open.
const AVATAR_RAW = read("../src/assets/avatar-upload.js");

test("avatar-upload.js reuses the SAME storage + broadcast path as the profile avatar (TM-684)", () => {
  // Reuse, not a parallel mechanism: it pulls the upload/validation primitives from storage.js, the
  // repaint broadcast from avatar-events.js, and the live user (photoURL source of truth) from auth.js.
  assert.match(AVATAR, /import\s*\{[^}]*\buploadAvatar\b[^}]*\bvalidateAvatarFile\b[^}]*\}\s*from\s*"\.\/storage\.js"/s,
    "must import uploadAvatar + validateAvatarFile from storage.js");
  assert.match(AVATAR, /import\s*\{[^}]*\bMAX_AVATAR_BYTES\b[^}]*\}\s*from\s*"\.\/storage\.js"/s,
    "must reuse MAX_AVATAR_BYTES from storage.js (single size cap)");
  assert.match(AVATAR, /import\s*\{\s*announceAvatarChanged\s*\}\s*from\s*"\.\/avatar-events\.js"/,
    "must import announceAvatarChanged (TM-846 broadcast)");
  assert.match(AVATAR, /import\s*\{\s*currentUser\s*\}\s*from\s*"\.\/auth\.js"/,
    "must read the live user (photoURL SoT) from auth.js");
  assert.match(AVATAR, /export function buildAvatarUploader\s*\(/, "must export buildAvatarUploader()");
});

test("the uploader validates BEFORE uploading, then broadcasts AFTER (TM-684 / TM-846)", () => {
  // Client-side validate → upload → announce, in that order. Assert each call exists and the broadcast
  // follows the upload (a stale-avatar-until-reload bug is exactly a missing/mis-ordered announce).
  assert.match(AVATAR, /validateAvatarFile\s*\(\s*file\s*\)/, "must validate the picked file first");
  const up = AVATAR.indexOf("uploadAvatar(");
  const announce = AVATAR.indexOf("announceAvatarChanged()");
  assert.ok(up !== -1 && announce !== -1, "must call uploadAvatar and announceAvatarChanged");
  assert.ok(announce > up, "announceAvatarChanged() must fire AFTER uploadAvatar()");
  // The picker accepts images and is the file entry point.
  assert.match(AVATAR_RAW, /accept:\s*"image\/\*"/, "the file input accepts images");
});

test("onboarding.js builds the REAL uploader (not the disabled 'Soon' stub) (TM-684)", () => {
  assert.match(ONB, /import\s*\{\s*buildAvatarUploader\s*\}\s*from\s*"\.\/avatar-upload\.js"/,
    "onboarding must import the shared buildAvatarUploader");
  assert.match(ONB, /buildAvatarUploader\s*\(\s*\{\s*idPrefix:\s*"onboarding-avatar"\s*\}\s*\)/,
    "onboarding must build the uploader (idPrefix onboarding-avatar)");
  assert.doesNotMatch(ONB, /buildAvatarStub/, "the disabled buildAvatarStub() must be gone");
  assert.doesNotMatch(ONB, /tm-soon-tag/, "the 'Soon' tag must be gone from the gate");
});

test("the avatar is OPTIONAL — never part of the REQUIRED FIELDS array (TM-684)", () => {
  // Every FIELDS entry is treated as REQUIRED by validateAll; the OPTIONAL avatar (like the bio) must
  // NOT be a FIELDS descriptor, or a missing photo would block onboarding.
  assert.doesNotMatch(ONB, /field:\s*"avatar"/, "avatar must not be a FIELDS descriptor (that array is all-required)");
  // It also must not be read into the onboarding request body (it persists via photoURL, not the payload).
  assert.doesNotMatch(ONB, /body\.avatar\s*=/, "avatar must not be added to the onboarding request body");
});
