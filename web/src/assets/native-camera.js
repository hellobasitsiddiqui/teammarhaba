// Native camera / gallery picker for the avatar flow (TM-281, epic TM-277).
//
// On a Capacitor native platform (the Android shell from TM-278) this lets the avatar control use the
// device's native capture / gallery picker via `@capacitor/camera` instead of the web `<input type=
// "file">`. The picked image is returned as a plain `File` so it flows into the EXISTING upload path
// (storage.js `uploadAvatar` → Firebase Storage → photoURL) — there is no parallel upload mechanism.
//
// Design notes:
//   * No bundler: the web SPA is hosted (capacitor.config.json `server.url`) and the Android shell
//     injects `window.Capacitor`. The native Camera plugin is reached through the auto-registered
//     bridge proxy `window.Capacitor.Plugins.Camera` — we deliberately DON'T import the `@capacitor/
//     camera` JS dist (there's nothing to bundle/serve it here); the npm dep exists so the Android
//     project compiles the native side in (`cap sync`).
//   * Off-device (any normal browser) `isNativeCameraAvailable()` is false, so profile.js keeps using
//     the unchanged web file-input flow. This module never touches the DOM and never assumes a browser.
//   * Permissions, cancel and deny are handled here and mapped to a small, predictable result/Error so
//     the UI can stay graceful (a cancel is a no-op, a deny is a friendly message).
//
// The pure helpers (`dataUrlToFile`, `classifyCameraError`, `filenameFor`) carry the logic that can be
// unit-tested without a device/browser — see web/tools/native-camera.test.mjs.
//
// TM-337 — DON'T LET THE PICKER TRIP THE BIOMETRIC APP-LOCK:
// Launching the native picker BACKGROUNDS the Capacitor app, so on return `@capacitor/app` emits
// `appStateChange { isActive: true }` and the biometric app-lock (TM-282) used to engage → the user
// got re-prompted for a fingerprint mid-avatar-flow even though they never left the app. This is an
// in-app-INITIATED excursion, not the user leaving. We bracket the picker call with the biometric
// lock's trusted-excursion API (the same suppression the TM-334 prompt uses) so the resume it causes
// doesn't re-lock. It's a safe no-op off the native shell / when the lock isn't active, so the web
// flow is untouched. Fingerprinter-safe `./x.js` import.

import { beginTrustedExcursion, endTrustedExcursion } from "./biometric-lock.js";

// Camera plugin enums, inlined so we don't depend on importing the plugin's JS. These mirror the
// `@capacitor/camera` `CameraResultType` / `CameraSource` string values the bridge expects.
const RESULT_TYPE_DATA_URL = "dataUrl";
const SOURCE_PROMPT = "PROMPT"; // let the OS offer "Camera" vs "Photos" — covers both ACs in one tap.

/**
 * The live Capacitor bridge object, or null when not running inside the native shell. Injectable for
 * tests. We treat the platform as native only when Capacitor says so AND the Camera plugin proxy is
 * actually present, so a misconfigured shell degrades to the web flow rather than throwing.
 * @param {object} [win=globalThis]
 * @returns {any|null}
 */
function capacitor(win = globalThis) {
  const cap = win && win.Capacitor;
  return cap || null;
}

/**
 * Is the native camera usable here? True only inside a Capacitor native platform whose Camera plugin
 * proxy is registered. False in every normal browser — which keeps the existing web file-input avatar
 * flow in place off-device.
 * @param {object} [win=globalThis] injectable for tests.
 * @returns {boolean}
 */
export function isNativeCameraAvailable(win = globalThis) {
  const cap = capacitor(win);
  if (!cap) return false;
  const isNative =
    typeof cap.isNativePlatform === "function" ? cap.isNativePlatform() : Boolean(cap.isNative);
  if (!isNative) return false;
  return Boolean(cap.Plugins && cap.Plugins.Camera);
}

/** A stable filename for the captured image, derived from its mime type. */
export function filenameFor(mimeType) {
  const ext =
    mimeType === "image/png"
      ? "png"
      : mimeType === "image/webp"
        ? "webp"
        : mimeType === "image/gif"
          ? "gif"
          : "jpg";
  return `avatar.${ext}`;
}

/**
 * Validate that `dataUrl` is a well-formed `data:` URL carrying an image, returning its mime type.
 * Shared by the sync and async converters so both reject a malformed/non-image capture identically.
 * @param {string} dataUrl
 * @returns {string} the image mime type, e.g. "image/jpeg".
 * @throws {Error} with a friendly message on a malformed or non-image data URL.
 */
function imageMimeFromDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") throw new Error("No image was returned.");
  // TM-838: allow an EMPTY mime segment ([^;,]* not +) — Android's camera/gallery picker sometimes
  // returns "data:;base64,<bytes>" with no mime, which used to fail the match entirely and throw
  // "unexpected format". A blank mime defaults to image/jpeg (the capture is an image regardless).
  const match = /^data:([^;,]*)(;base64)?,/s.exec(dataUrl);
  if (!match) throw new Error("The captured image was in an unexpected format.");
  const mime = match[1] || "image/jpeg";
  if (!mime.startsWith("image/")) throw new Error("That capture wasn't an image.");
  return mime;
}

/**
 * Convert a `data:` URL (what the Camera plugin returns with `resultType: dataUrl`) into a `File`, so
 * the captured image can flow straight into the existing `uploadAvatar(file)` path. Throws on a
 * malformed/non-image data URL so the caller surfaces a friendly error rather than uploading garbage.
 *
 * SYNCHRONOUS variant — decodes the base64 char-by-char on the calling thread. For a 1 MB+ image this
 * is a long synchronous block (TM-335: on a WebView this blocked the main thread and triggered ANR).
 * Kept for unit-testability and as a fallback; the device capture path uses `dataUrlToFileAsync`.
 * @param {string} dataUrl e.g. "data:image/jpeg;base64,/9j/4AAQ..."
 * @returns {File}
 */
export function dataUrlToFile(dataUrl) {
  const mime = imageMimeFromDataUrl(dataUrl);
  // TM-838: [^;,]* (not +) so a blank-mime "data:;base64,…" still matches — mirrors imageMimeFromDataUrl.
  const match = /^data:[^;,]*(;base64)?,(.*)$/s.exec(dataUrl);
  const isBase64 = Boolean(match[1]);
  const data = match[2];

  let bytes;
  if (isBase64) {
    const binary = atob(data);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(data));
  }
  return new File([bytes], filenameFor(mime), { type: mime });
}

/**
 * Async `data:` URL → `File`, off the main thread (TM-335). Lets the browser/WebView decode the base64
 * `data:` URL natively via `fetch(dataUrl).blob()` instead of the synchronous `atob` + per-byte loop in
 * `dataUrlToFile`, which blocked the WebView main thread for a 1 MB+ image and raised Android ANR
 * ("TeamMarhaba isn't responding") — a user tapping "Close app" on that dialog lost the in-flight
 * upload, so the avatar "didn't persist". We still validate the mime up front so a malformed/non-image
 * capture throws the SAME friendly error before any decode work.
 * @param {string} dataUrl e.g. "data:image/jpeg;base64,/9j/4AAQ..."
 * @returns {Promise<File>}
 * @throws {Error} with a friendly message on a malformed/non-image data URL or a decode failure.
 */
export async function dataUrlToFileAsync(dataUrl) {
  // Validate (and reject non-images) synchronously and cheaply before doing any decode work.
  const mime = imageMimeFromDataUrl(dataUrl);
  let blob;
  try {
    const res = await fetch(dataUrl);
    blob = await res.blob();
  } catch {
    // TM-838 regression fix: some Android System WebView / Samsung Internet versions do NOT support
    // fetch() on data: URLs, so the TM-335 async switch broke avatar capture entirely on those devices
    // ("unexpected format", both camera and gallery — worked on desktop). Fall back to the synchronous
    // atob decoder — exactly the pre-#259 behaviour that worked — instead of failing the upload. The
    // main-thread block this fallback reintroduces (the TM-335 ANR risk) only happens on the affected
    // devices, and a brief block beats a total failure; the fast fetch() path stays primary everywhere
    // it works.
    return dataUrlToFile(dataUrl);
  }
  const type = blob.type && blob.type.startsWith("image/") ? blob.type : mime;
  return new File([blob], filenameFor(type), { type });
}

/**
 * Map a Camera-plugin rejection into a small verdict the UI can act on without leaking plugin internals.
 *   * `{ cancelled: true }`        — the user dismissed the picker; the caller should no-op (no error).
 *   * `{ denied: true, message }`  — camera/photos permission was refused; show the message.
 *   * `{ message }`                — any other failure; show the message.
 *
 * Capacitor surfaces a cancel as an error whose message contains "cancel" (e.g. "User cancelled
 * photos app"), and a permissions refusal with "denied"/"permission". We match defensively on either
 * `code` or `message` so we stay robust across plugin versions.
 * @param {any} err
 * @returns {{cancelled?: boolean, denied?: boolean, message?: string}}
 */
export function classifyCameraError(err) {
  const raw = `${(err && (err.message || err.errorMessage)) || err || ""}`;
  const code = `${(err && err.code) || ""}`;
  const text = `${code} ${raw}`.toLowerCase();

  if (/cancel/.test(text)) return { cancelled: true };
  if (/denied|permission|unauthorized|not.?authorized/.test(text)) {
    return {
      denied: true,
      message: "Camera or photos access is off. Enable it in Settings to add a photo.",
    };
  }
  return { message: "Couldn't open the camera. Please try again." };
}

/**
 * Open the native capture / gallery picker and return the chosen image as a `File`, or `null` if the
 * user cancelled. Lets the OS prompt offer both "Camera" and "Photos" (the `PROMPT` source), so a
 * single entry point satisfies both the capture and gallery acceptance criteria.
 *
 * Permissions are requested by the plugin on demand; a refusal is mapped to a friendly Error (so the
 * caller can toast it) and a cancel resolves to `null` (a graceful no-op — the existing avatar stays).
 *
 * @param {object} [win=globalThis] injectable for tests.
 * @returns {Promise<File|null>} the captured image, or null on cancel.
 * @throws {Error} with a user-friendly `.message` on permission denial or any other failure.
 */
export async function captureAvatarImage(win = globalThis) {
  const cap = capacitor(win);
  const Camera = cap && cap.Plugins && cap.Plugins.Camera;
  if (!Camera) throw new Error("The camera isn't available on this device.");

  // TM-337: tell the biometric app-lock this background/foreground is an app-initiated excursion, so
  // the resume the picker causes doesn't re-lock the app. Cleared in `finally` on success, cancel AND
  // error. No-op off the native shell / when the lock isn't active.
  beginTrustedExcursion();
  let photo;
  try {
    photo = await Camera.getPhoto({
      resultType: RESULT_TYPE_DATA_URL,
      source: SOURCE_PROMPT,
      quality: 80,
      // TM-294: keep `allowEditing` OFF. With it on, the OS hands the capture to an external photo
      // editor whose result never makes it back into the `getPhoto` promise on device, so the avatar
      // silently never uploaded. We want the picked image to return straight to us as a `dataUrl` and
      // flow into the existing handlePickedFile → validateAvatarFile → uploadAvatar path untouched.
      allowEditing: false,
      // Friendly labels for the OS chooser sheet.
      promptLabelHeader: "Profile photo",
      promptLabelPhoto: "Choose from gallery",
      promptLabelPicture: "Take a photo",
    });
  } catch (err) {
    const verdict = classifyCameraError(err);
    if (verdict.cancelled) return null; // graceful no-op.
    throw new Error(verdict.message);
  } finally {
    endTrustedExcursion();
  }

  const dataUrl = photo && photo.dataUrl;
  if (!dataUrl) return null; // nothing chosen — treat as a cancel.
  // TM-335: decode off the main thread (`fetch().blob()`) so a 1 MB+ capture doesn't block the WebView
  // main thread and trigger an Android ANR that could drop the in-flight upload. Validation/friendly
  // errors are preserved by dataUrlToFileAsync.
  return dataUrlToFileAsync(dataUrl);
}
