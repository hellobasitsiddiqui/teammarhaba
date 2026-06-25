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
 * Convert a `data:` URL (what the Camera plugin returns with `resultType: dataUrl`) into a `File`, so
 * the captured image can flow straight into the existing `uploadAvatar(file)` path. Throws on a
 * malformed/non-image data URL so the caller surfaces a friendly error rather than uploading garbage.
 * @param {string} dataUrl e.g. "data:image/jpeg;base64,/9j/4AAQ..."
 * @returns {File}
 */
export function dataUrlToFile(dataUrl) {
  if (typeof dataUrl !== "string") throw new Error("No image was returned.");
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) throw new Error("The captured image was in an unexpected format.");
  const mime = match[1] || "application/octet-stream";
  if (!mime.startsWith("image/")) throw new Error("That capture wasn't an image.");
  const isBase64 = Boolean(match[2]);
  const data = match[3];

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
  }

  const dataUrl = photo && photo.dataUrl;
  if (!dataUrl) return null; // nothing chosen — treat as a cancel.
  return dataUrlToFile(dataUrl);
}
