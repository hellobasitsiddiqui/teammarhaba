// P0 characterization test for storage.js `validateAvatarFile` (TM-738 coverage audit, profile surface).
// Framework-free — Node's built-in test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// WHY THIS GAP MATTERS (security-negative): validateAvatarFile is the client-side mirror of the Firebase
// Storage rules (storage.rules) for avatar uploads. It fails a doomed upload fast in the browser with a
// friendly message, and — critically — it rejects the three shapes the rules also reject:
//   1. SVG (image/svg+xml) — an SVG is an ACTIVE document (can carry inline <script>/onload). Because
//      avatar objects are publicly readable, a stored SVG is a stored-XSS vector (TM-722). It must be
//      refused even though its content-type starts with "image/".
//   2. Non-image content-types (text/*, application/*, missing type) — rejected before anything else.
//   3. Over-size files (> MAX_AVATAR_BYTES = 5 MB) — rejected so we never round-trip bytes the rules deny.
// If any of these arms regresses, the browser stops mirroring the rules: SVGs/oversize files would be
// offered up to Storage (only the rules would then catch them, or — if the rules ever drift — not at all).
//
// storage.js STATICALLY imports the Firebase JS SDK from the gstatic CDN (and, transitively via
// ./auth.js, more of it), so it cannot be `import`ed under `node --test` (ERR_UNSUPPORTED_ESM_URL_SCHEME).
// Like the other un-importable-module tests in this dir, we load the REAL source, but instead of
// re-implementing the logic we neutralise ONLY the top-level import statements and evaluate the module as
// a data: URL. validateAvatarFile and its whole dependency chain (MAX_AVATAR_BYTES, the "image/" prefix
// check, and isDisallowedImageType) use NONE of the imported symbols, so the function under test is the
// exact shipped body — this is a behavioural proof, not a source-text grep and not a re-implementation.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

// Load storage.js, strip its top-level `import … from …;` statements (the CDN + relative ones that pull
// gstatic transitively), and import the result as a data: module so the REAL validateAvatarFile runs.
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
const { validateAvatarFile, MAX_AVATAR_BYTES } = storage;

// A minimal File stand-in: validateAvatarFile only reads `.type` and `.size`.
function fakeFile(type, size) {
  return { type, size };
}

test("validateAvatarFile: the mirror constant matches the 5 MB rules cap", () => {
  assert.equal(MAX_AVATAR_BYTES, 5 * 1024 * 1024);
});

test("validateAvatarFile ACCEPTS a normal in-bounds raster image (empty message = OK)", () => {
  assert.equal(validateAvatarFile(fakeFile("image/png", 1024)), "");
  assert.equal(validateAvatarFile(fakeFile("image/jpeg", MAX_AVATAR_BYTES)), "");
});

test("validateAvatarFile REJECTS svg (stored-XSS vector, TM-722) even though type starts with image/", () => {
  // Browsers normalise File.type to lowercase, so the real-world SVG is image/svg+xml: it passes the
  // "image/" prefix check, then hits the SVG-specific guard.
  assert.equal(
    validateAvatarFile(fakeFile("image/svg+xml", 100)),
    "SVG images aren't supported. Use a PNG or JPEG.",
  );
  // Security-negative invariant: an upper-cased SVG is STILL rejected — it just fails the case-sensitive
  // "image/" prefix check first (rejected as not-an-image), so it never reaches Storage either way.
  assert.notEqual(
    validateAvatarFile(fakeFile("IMAGE/SVG+XML", 100)),
    "",
    "an upper-cased SVG content-type must never be accepted",
  );
  assert.equal(validateAvatarFile(fakeFile("IMAGE/SVG+XML", 100)), "That file isn't an image.");
});

test("validateAvatarFile REJECTS a non-image content-type before anything else", () => {
  assert.equal(validateAvatarFile(fakeFile("text/plain", 100)), "That file isn't an image.");
  assert.equal(validateAvatarFile(fakeFile("application/pdf", 100)), "That file isn't an image.");
  // Missing/blank type is treated as not-an-image too.
  assert.equal(validateAvatarFile(fakeFile("", 100)), "That file isn't an image.");
});

test("validateAvatarFile REJECTS an over-size image (> 5 MB)", () => {
  assert.equal(
    validateAvatarFile(fakeFile("image/png", MAX_AVATAR_BYTES + 1)),
    "Image must be 5 MB or smaller.",
  );
});

test("validateAvatarFile REJECTS a missing file with a choose-an-image prompt", () => {
  assert.equal(validateAvatarFile(null), "Choose an image to upload.");
  assert.equal(validateAvatarFile(undefined), "Choose an image to upload.");
});
