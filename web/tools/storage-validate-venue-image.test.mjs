// TM-738 P1 (venues) characterization tests for storage.js venue-photo helpers — the client-side
// mirror of the venue-images/ Storage rules. Framework-free (Node's built-in test runner), picked up
// by the CI glob `node --test web/tools/*.test.mjs`. Mirrors storage-validate-avatar.test.mjs.
//
// WHY THESE GAPS MATTER:
//   1. validateVenueImageFile (error/edge) is the browser pre-check that fails a doomed venue-photo
//      upload fast with a friendly message, mirroring the same three refusals the Storage rules make:
//        - non-image content-types (text/*, application/*, missing type) — rejected first;
//        - SVG (image/svg+xml) — an ACTIVE document → stored-XSS on the public-read venue-images
//          origin (TM-722), refused even though its type starts with "image/";
//        - over-size files (> MAX_VENUE_IMAGE_BYTES = 5 MB) — refused so we never round-trip bytes the
//          rules deny (the rule caps at `request.resource.size < 5 * 1024 * 1024`).
//      If any arm regresses, the browser stops mirroring the rules and offers up doomed/dangerous
//      uploads (only the rules — if they haven't also drifted — would then catch them).
//   2. uploadVenueImage guards that a venue id is present BEFORE touching Storage: a venue photo lives
//      at `venue-images/{venueId}`, and the id can't exist before the venue is created (the house
//      avatar/photoPath pattern). A null/blank id must throw "Save the venue before adding a photo."
//      rather than silently uploading to a malformed `venue-images/` path.
//
// storage.js STATICALLY imports the Firebase JS SDK from the gstatic CDN (and, via ./auth.js, more of
// it), so it can't be `import`ed under `node --test` (ERR_UNSUPPORTED_ESM_URL_SCHEME). Like the
// avatar sibling, we load the REAL source, neutralise ONLY the top-level import statements, and
// evaluate it as a data: URL. validateVenueImageFile (and uploadVenueImage's early file+id guards,
// which run before getStorageOrNull() is ever called) use NONE of the imported symbols, so the code
// under test is the exact shipped body — a behavioural proof, not a source-text grep or a re-impl.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

// Load storage.js, strip its top-level `import … from …;` statements (the CDN + relative ones that
// pull gstatic transitively), and import the result as a data: module so the REAL functions run.
function loadStorageModule() {
  const src = readFileSync(join(HERE, "../src/assets/storage.js"), "utf8");
  const stripped = src.replace(/^import[\s\S]*?;$/gm, (m) =>
    m.includes("from") ? "/* import stripped for unit eval */" : m,
  );
  // Guard: no CDN or relative import may survive — if one does, the strip broke and the module would
  // fail to load, so surface it loudly rather than silently testing a half-neutered module.
  assert.doesNotMatch(
    stripped,
    /gstatic\.com|from ["']\.\//,
    "all top-level imports must be stripped before evaluating storage.js in isolation",
  );
  const url = "data:text/javascript;base64," + Buffer.from(stripped).toString("base64");
  return import(url);
}

const storage = await loadStorageModule();
const { validateVenueImageFile, uploadVenueImage, MAX_VENUE_IMAGE_BYTES } = storage;

// A minimal File stand-in: the code under test only reads `.type` and `.size`.
function fakeFile(type, size) {
  return { type, size };
}

// --- validateVenueImageFile_rejectsWrongTypeAndOversize -----------------------------------------

test("validateVenueImageFile: the mirror constant matches the 5 MB rules cap", () => {
  assert.equal(MAX_VENUE_IMAGE_BYTES, 5 * 1024 * 1024);
});

test("validateVenueImageFile ACCEPTS a normal in-bounds raster image (empty message = OK)", () => {
  assert.equal(validateVenueImageFile(fakeFile("image/png", 1024)), "");
  assert.equal(validateVenueImageFile(fakeFile("image/jpeg", MAX_VENUE_IMAGE_BYTES)), "");
});

test("validateVenueImageFile REJECTS a WRONG (non-image) content-type before anything else", () => {
  assert.equal(validateVenueImageFile(fakeFile("text/plain", 100)), "That file isn't an image.");
  assert.equal(validateVenueImageFile(fakeFile("application/pdf", 100)), "That file isn't an image.");
  // Missing/blank type is treated as not-an-image too.
  assert.equal(validateVenueImageFile(fakeFile("", 100)), "That file isn't an image.");
});

test("validateVenueImageFile REJECTS svg (stored-XSS vector, TM-722) though its type starts with image/", () => {
  // Browsers normalise File.type to lowercase, so the real-world SVG is image/svg+xml: it passes the
  // "image/" prefix check, then hits the SVG-specific guard with the friendly message.
  assert.equal(
    validateVenueImageFile(fakeFile("image/svg+xml", 100)),
    "SVG images aren't supported. Use a PNG or JPEG.",
  );
  // Security-negative invariant: an upper-cased SVG is STILL rejected — it just fails the
  // case-sensitive "image/" prefix check first, so it never reaches Storage either way.
  assert.equal(validateVenueImageFile(fakeFile("IMAGE/SVG+XML", 100)), "That file isn't an image.");
});

test("validateVenueImageFile REJECTS an OVER-SIZE image (> 5 MB)", () => {
  assert.equal(
    validateVenueImageFile(fakeFile("image/png", MAX_VENUE_IMAGE_BYTES + 1)),
    "Image must be 5 MB or smaller.",
  );
});

test("validateVenueImageFile REJECTS a missing file with a choose-an-image prompt", () => {
  assert.equal(validateVenueImageFile(null), "Choose an image to upload.");
  assert.equal(validateVenueImageFile(undefined), "Choose an image to upload.");
});

// --- uploadVenueImage_throwsWhenVenueIdMissing --------------------------------------------------
//
// uploadVenueImage validates the file, THEN the id, and only then touches Storage. With a valid file,
// a null/blank id must throw the "save the venue first" message from that id guard — reached before
// getStorageOrNull() is ever called, so no Firebase/Storage machinery is exercised here.

test("uploadVenueImage THROWS 'Save the venue before adding a photo.' when the venue id is missing", async () => {
  const validFile = fakeFile("image/png", 1024); // passes validateVenueImageFile

  for (const badId of [null, undefined, "", "   "]) {
    await assert.rejects(
      () => uploadVenueImage(badId, validFile),
      (err) => {
        assert.equal(err.message, "Save the venue before adding a photo.");
        return true;
      },
      `a ${JSON.stringify(badId)} venue id must be refused before any upload`,
    );
  }
});

test("uploadVenueImage still validates the file BEFORE the id guard (invalid file wins)", async () => {
  // Ordering pin: an invalid file with a missing id surfaces the FILE message, not the id message —
  // proving the file check runs first (the doomed upload fails as early as possible).
  await assert.rejects(
    () => uploadVenueImage(null, fakeFile("application/pdf", 100)),
    (err) => {
      assert.equal(err.message, "That file isn't an image.");
      return true;
    },
  );
});
