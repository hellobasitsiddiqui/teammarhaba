// Firebase Storage helper for avatar uploads (TM-166).
//
// The decided design splits the avatar into a POINTER and BYTES: the image bytes live in Firebase
// Storage (object path `avatars/{uid}`), and the avatar URL is Firebase Auth's `photoURL` — the
// single source of truth. We store NO image bytes and NO avatar column in our own DB; TM-164 already
// surfaces `photoURL` from Firebase on GET /me, and the client reads it straight off the Firebase
// `User` for the preview + nav. This module owns only the Storage half: upload the bytes, hand back
// the download URL, and clean up the previous object on re-upload.
//
// Uses the SAME modular Firebase JS SDK + version pinned in auth.js (10.13.2, gstatic CDN, no
// bundler). It reuses the already-initialised Firebase app from auth.js rather than re-initialising,
// so there is exactly one app instance.
//
// Graceful degradation: Storage isn't enabled in prod until the HITL TM-184 lands. If the configured
// app has no `storageBucket`, `isStorageConfigured()` returns false and the profile page disables the
// control instead of hard-failing the page.

import {
  getStorage,
  connectStorageEmulator,
  ref,
  uploadBytesResumable,
  getDownloadURL,
  deleteObject,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-storage.js";
import { updateProfile } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import { app, auth } from "./auth.js";
import { avatarPath, legacyAvatarPathToDelete } from "./avatar-cleanup.js";

// Client-side guardrails that MIRROR the Storage security rules (storage.rules). The rules are the
// real authority — these just let us fail fast in the browser with a friendly message instead of
// round-tripping a doomed upload.
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024; // 5 MB — must match storage.rules.
const ACCEPTED_PREFIX = "image/"; // image content-type only — must match storage.rules.

let storage = null;
let storageInitFailed = false;

/**
 * Whether Firebase Storage is configured for this build. False when the app has no `storageBucket`
 * (e.g. prod before the HITL TM-184 enables Storage), so callers can disable the upload control
 * gracefully rather than crash the page.
 * @returns {boolean}
 */
export function isStorageConfigured() {
  return Boolean(app?.options?.storageBucket) && !storageInitFailed;
}

/** Lazily get the Storage instance, wiring the emulator under e2e. Returns null if unconfigured. */
function getStorageOrNull() {
  if (!isStorageConfigured()) return null;
  if (storage) return storage;
  try {
    storage = getStorage(app);
    // Browser-e2e only (mirrors auth.js's emulator wiring): when the runtime config points at a
    // local Storage emulator, route uploads through it. `storageEmulatorHost` is null in dev/prod,
    // so this is a no-op there and production Storage is untouched.
    const emulatorHost =
      typeof window !== "undefined" &&
      window.TEAMMARHABA_CONFIG &&
      window.TEAMMARHABA_CONFIG.storageEmulatorHost;
    if (emulatorHost) {
      const [host, port] = emulatorHost.split(":");
      connectStorageEmulator(storage, host, Number(port));
    }
    return storage;
  } catch (err) {
    // Defensive: never let a Storage init failure take down the profile page.
    console.warn("[storage] could not initialise Firebase Storage:", err?.code ?? err);
    storageInitFailed = true;
    storage = null;
    return null;
  }
}

/** A user-facing validation message for a file that the rules would reject, or "" if acceptable. */
export function validateAvatarFile(file) {
  if (!file) return "Choose an image to upload.";
  if (!file.type || !file.type.startsWith(ACCEPTED_PREFIX)) return "That file isn't an image.";
  if (file.size > MAX_AVATAR_BYTES) return "Image must be 5 MB or smaller.";
  return "";
}

/**
 * Upload an avatar image to Firebase Storage, set the Firebase user's `photoURL` to the resulting
 * download URL, and clean up any previously-stored object. The object path is scoped per-uid
 * (`avatars/{uid}`) so a re-upload overwrites the same path — and we additionally best-effort delete
 * the prior object when its URL pointed elsewhere, so no orphaned bytes linger.
 *
 * @param {File} file the image the user picked.
 * @param {(fraction: number) => void} [onProgress] called with 0..1 as bytes transfer.
 * @returns {Promise<string>} the new download URL (also now the user's photoURL).
 * @throws {Error} with a user-friendly `.message` on validation/upload failure.
 */
export async function uploadAvatar(file, onProgress) {
  const message = validateAvatarFile(file);
  if (message) throw new Error(message);

  const user = auth.currentUser;
  if (!user) throw new Error("You must be signed in to upload an avatar.");

  const store = getStorageOrNull();
  if (!store) throw new Error("Avatar uploads aren't available right now.");

  // Remember the previous object so we can clean it up after a successful re-upload. We only delete
  // when the old URL is a Storage download URL for THIS user's object (never an external/Google one).
  const previousPhotoURL = user.photoURL || "";

  const objectRef = ref(store, avatarPath(user.uid));
  // The content-type rides along so the (content-type-restricted) rules accept it and the served
  // object reports the right type. Resumable upload gives us progress for the UI.
  const task = uploadBytesResumable(objectRef, file, { contentType: file.type });

  await new Promise((resolve, reject) => {
    task.on(
      "state_changed",
      (snapshot) => {
        if (typeof onProgress === "function" && snapshot.totalBytes > 0) {
          onProgress(snapshot.bytesTransferred / snapshot.totalBytes);
        }
      },
      (err) => reject(mapUploadError(err)),
      resolve,
    );
  });

  const downloadURL = await getDownloadURL(objectRef);

  // photoURL is the single source of truth — set it on the Firebase user. The bytes already live in
  // Storage; nothing is persisted on our side (TM-164 surfaces photoURL on GET /me from Firebase).
  await updateProfile(user, { photoURL: downloadURL });

  // Old-avatar cleanup: if the user previously pointed at a DIFFERENT Storage object (e.g. a legacy
  // path), best-effort delete it. The common case — re-uploading to the same `avatars/{uid}` path —
  // already overwrote the bytes, so this is a no-op there. Never fail the upload on a cleanup error.
  await cleanupPreviousAvatar(store, user.uid, previousPhotoURL, downloadURL);

  return downloadURL;
}

/**
 * Best-effort delete of a superseded avatar object. Swallows errors (cleanup must never fail upload).
 *
 * TM-335: the object path is fixed per-uid (`avatars/{uid}`), so a re-upload OVERWRITES the same path.
 * getDownloadURL() mints a fresh `?token=` each call, so the previous and new download URLs differ
 * even though they point at the SAME object — comparing the token'd URLs (as before) would then delete
 * the object we JUST uploaded, 404-ing the avatar. So we compare by object PATH and NEVER delete the
 * current per-uid path (the overwrite already replaced its bytes); we only delete a genuinely
 * DIFFERENT legacy path. See avatar-cleanup.js for the pure decision logic.
 */
async function cleanupPreviousAvatar(store, uid, previousPhotoURL, newURL) {
  const legacyPath = legacyAvatarPathToDelete(uid, previousPhotoURL, newURL);
  if (!legacyPath) return; // no previous, external URL, or the current per-uid path — nothing to do.
  try {
    await deleteObject(ref(store, legacyPath));
  } catch (err) {
    console.warn("[storage] could not delete previous avatar (non-fatal):", err?.code ?? err);
  }
}

/** Map a Firebase Storage upload error to a concise, user-friendly Error. */
function mapUploadError(err) {
  const code = err?.code || "";
  if (code === "storage/unauthorized") {
    return new Error("You're not allowed to upload that — check it's an image under 5 MB.");
  }
  if (code === "storage/canceled") return new Error("Upload cancelled.");
  if (code === "storage/retry-limit-exceeded" || code === "storage/quota-exceeded") {
    return new Error("Upload failed — please try again.");
  }
  return new Error("Could not upload your avatar. Please try again.");
}

// --- event images (TM-395, epic TM-390) -------------------------------------------------------
//
// Event images ride the SAME house Storage pattern as avatars (TM-166), reusing the init + emulator
// seam above so there is one Storage app instance and one emulator wiring. The difference is the
// object path and where the pointer lives: bytes go to `event-images/{eventId}` (admin-only per
// storage.rules — the `role == ADMIN` custom-claim gate) and the OBJECT PATH is persisted on the
// event row via the admin API (`PATCH /api/v1/admin/events/{id}` imagePath, TM-392), not a photoURL.
// The path is stored (not a download URL) because the URL carries a rotating `?token=`; the path is
// stable and the public/event views resolve it to a URL when they render. The admin form keeps the
// returned download URL only for its own immediate preview.

/** Event-image size cap — mirrors storage.rules (`< 5 MB`), same as avatars. */
export const MAX_EVENT_IMAGE_BYTES = 5 * 1024 * 1024;

/** A user-facing validation message for an event image the rules would reject, or "" if acceptable. */
export function validateEventImageFile(file) {
  if (!file) return "Choose an image to upload.";
  if (!file.type || !file.type.startsWith("image/")) return "That file isn't an image.";
  if (file.size > MAX_EVENT_IMAGE_BYTES) return "Image must be 5 MB or smaller.";
  return "";
}

/**
 * Upload an event image to Firebase Storage at `event-images/{eventId}` and return its object PATH
 * (for the imagePath PATCH) plus the download URL (for the form's preview). Admin-only at the rules
 * layer (`request.auth.token.role == 'ADMIN'`); this mirrors that with a fast client pre-check. A
 * re-upload overwrites the same per-event path, so an event never accumulates orphan objects.
 *
 * @param {number|string} eventId the persisted event id (the path segment). MUST exist — for a NEW
 *   event the caller creates the event first, then uploads to the returned id (the id can't exist
 *   before creation, so the create body carries no image; the house avatar/imagePath pattern, TM-392).
 * @param {File} file the image the admin picked.
 * @param {(fraction: number) => void} [onProgress] called with 0..1 as bytes transfer.
 * @returns {Promise<{path: string, url: string}>} the stored object path + its download URL.
 * @throws {Error} with a user-friendly `.message` on validation/upload failure.
 */
export async function uploadEventImage(eventId, file, onProgress) {
  const message = validateEventImageFile(file);
  if (message) throw new Error(message);
  if (eventId == null || String(eventId).trim() === "") {
    throw new Error("Save the event before adding an image.");
  }

  const store = getStorageOrNull();
  if (!store) throw new Error("Event image uploads aren't available right now.");

  const path = `event-images/${eventId}`;
  const objectRef = ref(store, path);
  const task = uploadBytesResumable(objectRef, file, { contentType: file.type });

  await new Promise((resolve, reject) => {
    task.on(
      "state_changed",
      (snapshot) => {
        if (typeof onProgress === "function" && snapshot.totalBytes > 0) {
          onProgress(snapshot.bytesTransferred / snapshot.totalBytes);
        }
      },
      (err) => reject(mapEventImageUploadError(err)),
      resolve,
    );
  });

  const url = await getDownloadURL(objectRef);
  return { path, url };
}

/** Map a Firebase Storage upload error to a concise, user-friendly Error (event-image wording). */
function mapEventImageUploadError(err) {
  const code = err?.code || "";
  if (code === "storage/unauthorized") {
    return new Error("You're not allowed to upload that — admins only, and it must be an image under 5 MB.");
  }
  if (code === "storage/canceled") return new Error("Upload cancelled.");
  if (code === "storage/retry-limit-exceeded" || code === "storage/quota-exceeded") {
    return new Error("Upload failed — please try again.");
  }
  return new Error("Could not upload the event image. Please try again.");
}
