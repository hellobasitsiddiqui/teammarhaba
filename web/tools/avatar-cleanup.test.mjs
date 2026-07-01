// Tests for the avatar re-upload cleanup decision logic (TM-335). Framework-free — Node's built-in
// test runner, same harness as native-camera.test.mjs and picked up by the CI glob
// `node --test web/tools/*.test.mjs`.
//
// These guard the pure PATH-comparison logic that decides whether a previous avatar object should be
// deleted on re-upload — the fix for the self-delete regression. avatar-cleanup.js has no Firebase
// imports so it runs directly under Node; storage.js wires legacyAvatarPathToDelete() to deleteObject.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  avatarPath,
  storageObjectPathFromURL,
  legacyAvatarPathToDelete,
} from "../src/assets/avatar-cleanup.js";

const UID = "user-abc-123";
const PATH = avatarPath(UID); // "avatars/user-abc-123"

// A Firebase Storage download URL for the per-uid object, with a given token. getDownloadURL() mints a
// fresh token each call, so two URLs for the SAME object differ only by this token — the TM-335 trap.
function downloadURL(objectPath, token) {
  const enc = encodeURIComponent(objectPath); // e.g. avatars%2Fuser-abc-123
  return `https://firebasestorage.googleapis.com/v0/b/tm-app.appspot.com/o/${enc}?alt=media&token=${token}`;
}

// The Storage emulator serves the same /v0/b/.../o/<path> shape from its own host.
function emulatorURL(objectPath, token) {
  const enc = encodeURIComponent(objectPath);
  return `http://127.0.0.1:9199/v0/b/tm-app.appspot.com/o/${enc}?alt=media&token=${token}`;
}

// ---- storageObjectPathFromURL ---------------------------------------------------------------

test("storageObjectPathFromURL decodes the object path from a real download URL", () => {
  assert.equal(storageObjectPathFromURL(downloadURL(PATH, "tok-1")), PATH);
});

test("storageObjectPathFromURL decodes the object path from an emulator URL", () => {
  assert.equal(storageObjectPathFromURL(emulatorURL(PATH, "tok-1")), PATH);
});

test("storageObjectPathFromURL returns null for a non-Storage URL (e.g. a Google social photo)", () => {
  assert.equal(storageObjectPathFromURL("https://lh3.googleusercontent.com/a/default-user=s96"), null);
  assert.equal(storageObjectPathFromURL(""), null);
  assert.equal(storageObjectPathFromURL(null), null);
  assert.equal(storageObjectPathFromURL(undefined), null);
});

// ---- legacyAvatarPathToDelete (the core TM-335 decision) ------------------------------------

test("REGRESSION: same per-uid path, DIFFERENT token → do NOT delete (returns null)", () => {
  // Previous and new URLs point at the SAME object `avatars/{uid}` but carry different tokens (each
  // getDownloadURL() mints a fresh one). The old code compared token'd URLs, saw them differ, and
  // deleted the object it had just uploaded. The path-compare fix must skip deletion here.
  const previous = downloadURL(PATH, "old-token");
  const current = downloadURL(PATH, "new-token");
  assert.notEqual(previous, current, "the URLs must differ by token for this to be a real regression guard");
  assert.equal(legacyAvatarPathToDelete(UID, previous, current), null);
});

test("a DIFFERENT/legacy path → delete IS requested at that legacy path", () => {
  const legacyPath = `avatars/legacy/${UID}`;
  const previous = downloadURL(legacyPath, "old-token");
  const current = downloadURL(PATH, "new-token");
  assert.equal(legacyAvatarPathToDelete(UID, previous, current), legacyPath);
});

test("no previous photoURL → not requested (null)", () => {
  assert.equal(legacyAvatarPathToDelete(UID, "", downloadURL(PATH, "t")), null);
  assert.equal(legacyAvatarPathToDelete(UID, null, downloadURL(PATH, "t")), null);
});

test("an external (non-Storage) previous photoURL → not requested (null)", () => {
  const previous = "https://lh3.googleusercontent.com/a/default-user=s96"; // Google social photo
  assert.equal(legacyAvatarPathToDelete(UID, previous, downloadURL(PATH, "t")), null);
});

test("previous URL identical to the new URL → not requested (null)", () => {
  const same = downloadURL(PATH, "same-token");
  assert.equal(legacyAvatarPathToDelete(UID, same, same), null);
});
