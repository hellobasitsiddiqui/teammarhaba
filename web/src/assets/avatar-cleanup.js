// Pure decision logic for avatar re-upload cleanup (TM-335). No Firebase imports so it's unit-testable
// under Node's test runner (web/tools/avatar-cleanup.test.mjs); storage.js consumes these helpers to
// decide WHETHER to delete a previous avatar object, and Firebase does the actual deleteObject.
//
// The bug this guards against: avatar objects live at a fixed per-uid path `avatars/{uid}`, so a
// re-upload OVERWRITES that same path. But getDownloadURL() mints a fresh `?token=…` every call, so
// the previous and new download URLs differ (different tokens) even though they point at the SAME
// object. The old cleanup compared the token'd URLs, saw them differ, and deleted `avatars/{uid}` —
// the object it had JUST uploaded — yielding a 404 avatar on every re-upload. The fix is to compare by
// OBJECT PATH and never delete the current per-uid path (the overwrite already handled it); only a
// genuinely different LEGACY path is cleaned up.

/** The per-uid object path for a user's avatar. Single source so upload + cleanup agree. */
export function avatarPath(uid) {
  return `avatars/${uid}`;
}

/**
 * Extract the Storage object path from a Firebase Storage download URL. Firebase download URLs look
 * like `https://firebasestorage.googleapis.com/v0/b/<bucket>/o/<url-encoded-path>?alt=media&token=…`
 * (and the emulator serves the same `/v0/b/.../o/<path>` shape from its own host). The object path is
 * the URL-decoded segment between `/o/` and the query string.
 *
 * @param {string} url a photoURL that may or may not be one of our Storage download URLs.
 * @returns {string|null} the decoded object path (e.g. `avatars/{uid}`), or null if `url` isn't a
 *   Firebase Storage download URL we recognise (e.g. an external Google social photo).
 */
export function storageObjectPathFromURL(url) {
  if (!url || typeof url !== "string") return null;
  // Must look like a Firebase Storage download URL (real host or the emulator's /v0/b/ shape).
  if (!/firebasestorage\.googleapis\.com/.test(url) && !/\/v0\/b\//.test(url)) return null;
  const match = /\/o\/([^?]+)/.exec(url);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    // Malformed percent-encoding — treat as unrecognised rather than throw.
    return null;
  }
}

/**
 * Decide whether the previous avatar's Storage object should be deleted on re-upload, and at which
 * path. Returns the LEGACY object path to delete, or null to skip deletion.
 *
 * Skip (return null) when:
 *  - there's no previous photoURL, or it equals the new URL;
 *  - the previous photoURL isn't one of our Storage download URLs (e.g. a Google social photo);
 *  - the previous object path EQUALS the current per-uid path `avatars/{uid}` — the new upload lives
 *    there and the overwrite already replaced the bytes, so deleting it would delete what we just
 *    uploaded (the TM-335 regression).
 *
 * Only when the previous object is OUR Storage object at a DIFFERENT path do we return that path so
 * the caller best-effort deletes the orphaned legacy bytes.
 *
 * @param {string} uid the current user's uid.
 * @param {string} previousPhotoURL the user's photoURL before this upload (may be "" / external).
 * @param {string} newURL the fresh download URL just set as photoURL.
 * @returns {string|null} a legacy Storage object path to delete, or null to skip.
 */
export function legacyAvatarPathToDelete(uid, previousPhotoURL, newURL) {
  if (!previousPhotoURL || previousPhotoURL === newURL) return null;
  const previousPath = storageObjectPathFromURL(previousPhotoURL);
  // Not one of our Storage objects (external photo, or unparseable) → nothing for us to delete.
  if (!previousPath) return null;
  // Same per-uid path as the current upload → the overwrite already handled it; deleting here would
  // wipe the object we just uploaded. This is the core TM-335 fix.
  if (previousPath === avatarPath(uid)) return null;
  // A genuinely different (legacy) path we own → clean it up.
  return previousPath;
}
