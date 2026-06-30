// Tests for the native camera / gallery picker helpers (TM-281). Framework-free — Node's built-in
// test runner, same harness as auth-env.test.mjs and picked up by the CI glob
// `node --test web/tools/*.test.mjs`.
//
// These guard the pure logic that decides native-vs-web, turns a Camera-plugin dataUrl into the File
// the existing upload path consumes, and classifies cancel/deny so the UI stays graceful — none of
// which needs a real device. The DOM wiring in profile.js is a thin shell over these.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isNativeCameraAvailable,
  dataUrlToFile,
  dataUrlToFileAsync,
  filenameFor,
  classifyCameraError,
  captureAvatarImage,
} from "../src/assets/native-camera.js";

// A 1x1 transparent PNG as a base64 data URL — enough to exercise the decode path with real bytes.
const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

// ---- isNativeCameraAvailable ----------------------------------------------------------------

test("native camera is unavailable in a plain browser (no Capacitor)", () => {
  assert.equal(isNativeCameraAvailable({}), false);
  assert.equal(isNativeCameraAvailable({ Capacitor: undefined }), false);
});

test("native camera is unavailable when Capacitor reports a web platform", () => {
  const win = { Capacitor: { isNativePlatform: () => false, Plugins: { Camera: {} } } };
  assert.equal(isNativeCameraAvailable(win), false);
});

test("native camera is unavailable when the Camera plugin proxy is missing", () => {
  const win = { Capacitor: { isNativePlatform: () => true, Plugins: {} } };
  assert.equal(isNativeCameraAvailable(win), false);
});

test("native camera is available on a native platform with the Camera plugin", () => {
  const win = { Capacitor: { isNativePlatform: () => true, Plugins: { Camera: {} } } };
  assert.equal(isNativeCameraAvailable(win), true);
  // Also honour the legacy `isNative` boolean shape.
  const legacy = { Capacitor: { isNative: true, Plugins: { Camera: {} } } };
  assert.equal(isNativeCameraAvailable(legacy), true);
});

// ---- filenameFor ----------------------------------------------------------------------------

test("filenameFor maps mime types to sensible extensions, defaulting to jpg", () => {
  assert.equal(filenameFor("image/png"), "avatar.png");
  assert.equal(filenameFor("image/webp"), "avatar.webp");
  assert.equal(filenameFor("image/gif"), "avatar.gif");
  assert.equal(filenameFor("image/jpeg"), "avatar.jpg");
  assert.equal(filenameFor("application/octet-stream"), "avatar.jpg");
});

// ---- dataUrlToFile --------------------------------------------------------------------------

test("dataUrlToFile decodes a base64 image data URL into a File with the right type/name", () => {
  const file = dataUrlToFile(PNG_DATA_URL);
  assert.ok(file instanceof File);
  assert.equal(file.type, "image/png");
  assert.equal(file.name, "avatar.png");
  assert.ok(file.size > 0, "decoded bytes should be non-empty");
});

test("dataUrlToFile rejects a non-image or malformed data URL", () => {
  assert.throws(() => dataUrlToFile("data:text/plain;base64,aGVsbG8="), /wasn't an image/i);
  assert.throws(() => dataUrlToFile("not-a-data-url"), /unexpected format/i);
  assert.throws(() => dataUrlToFile(null), /No image/i);
});

// ---- dataUrlToFileAsync (TM-335: off-main-thread decode) -------------------------------------

test("dataUrlToFileAsync decodes a base64 image data URL into a File with the right type/name", async () => {
  const file = await dataUrlToFileAsync(PNG_DATA_URL);
  assert.ok(file instanceof File);
  assert.equal(file.type, "image/png");
  assert.equal(file.name, "avatar.png");
  assert.ok(file.size > 0, "decoded bytes should be non-empty");
});

test("dataUrlToFileAsync produces the same bytes as the synchronous decoder", async () => {
  const asyncFile = await dataUrlToFileAsync(PNG_DATA_URL);
  const syncFile = dataUrlToFile(PNG_DATA_URL);
  assert.equal(asyncFile.size, syncFile.size);
  const [a, b] = await Promise.all([asyncFile.arrayBuffer(), syncFile.arrayBuffer()]);
  assert.deepEqual(new Uint8Array(a), new Uint8Array(b));
});

test("dataUrlToFileAsync rejects a non-image or malformed data URL (same friendly errors)", async () => {
  await assert.rejects(() => dataUrlToFileAsync("data:text/plain;base64,aGVsbG8="), /wasn't an image/i);
  await assert.rejects(() => dataUrlToFileAsync("not-a-data-url"), /unexpected format/i);
  await assert.rejects(() => dataUrlToFileAsync(null), /No image/i);
});

// ---- classifyCameraError --------------------------------------------------------------------

test("a user cancel is classified as a graceful no-op (not an error)", () => {
  assert.deepEqual(classifyCameraError(new Error("User cancelled photos app")), { cancelled: true });
  assert.deepEqual(classifyCameraError({ message: "USER_CANCELLED" }), { cancelled: true });
});

test("a permission refusal is classified as denied with a friendly message", () => {
  const denied = classifyCameraError(new Error("User denied access to camera"));
  assert.equal(denied.denied, true);
  assert.match(denied.message, /Settings/i);
  assert.equal(classifyCameraError({ code: "permission_denied" }).denied, true);
});

test("any other failure falls back to a generic retry message", () => {
  const other = classifyCameraError(new Error("kaboom"));
  assert.equal(other.cancelled, undefined);
  assert.equal(other.denied, undefined);
  assert.match(other.message, /try again/i);
});

// ---- captureAvatarImage ---------------------------------------------------------------------

test("captureAvatarImage returns a File from the plugin's dataUrl", async () => {
  const win = {
    Capacitor: {
      isNativePlatform: () => true,
      Plugins: { Camera: { getPhoto: async () => ({ dataUrl: PNG_DATA_URL }) } },
    },
  };
  const file = await captureAvatarImage(win);
  assert.ok(file instanceof File);
  assert.equal(file.type, "image/png");
});

test("captureAvatarImage requests the photo without the editor detour (allowEditing: false)", async () => {
  // TM-294 regression guard: `allowEditing: true` routes the capture through an external editor whose
  // result never returns to the promise on device, so the avatar never uploads. Pin it OFF.
  let opts = null;
  const win = {
    Capacitor: {
      isNativePlatform: () => true,
      Plugins: {
        Camera: {
          getPhoto: async (o) => {
            opts = o;
            return { dataUrl: PNG_DATA_URL };
          },
        },
      },
    },
  };
  await captureAvatarImage(win);
  assert.equal(opts.allowEditing, false);
  assert.equal(opts.resultType, "dataUrl");
});

test("captureAvatarImage resolves null when the user cancels (no throw)", async () => {
  const win = {
    Capacitor: {
      isNativePlatform: () => true,
      Plugins: {
        Camera: {
          getPhoto: async () => {
            throw new Error("User cancelled photos app");
          },
        },
      },
    },
  };
  assert.equal(await captureAvatarImage(win), null);
});

test("captureAvatarImage throws a friendly error when permission is denied", async () => {
  const win = {
    Capacitor: {
      isNativePlatform: () => true,
      Plugins: {
        Camera: {
          getPhoto: async () => {
            throw new Error("User denied access to the camera");
          },
        },
      },
    },
  };
  await assert.rejects(() => captureAvatarImage(win), /Settings/i);
});
