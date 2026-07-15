// P1 characterization test for storage.js `validateAvatarFile` — the EXACT size boundary (TM-738
// coverage audit, profile surface: `validateAvatarFileBoundaryMaxBytes`). Framework-free — Node's
// built-in test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// WHY THIS GAP MATTERS (edge). validateAvatarFile is the client-side mirror of the Firebase Storage
// rules (storage.rules) for avatar uploads; its size guard is `file.size > MAX_AVATAR_BYTES` — a
// STRICT greater-than. That makes MAX_AVATAR_BYTES itself the last accepted size and MAX_AVATAR_BYTES+1
// the first rejected one. The existing P0 test (storage-validate-avatar.test.mjs) checks a value at the
// cap and one byte over; this pins the full THREE-point boundary — one under, exactly at, one over — so
// an off-by-one drift to `>=` (which would reject a legitimate exactly-5 MB image) or to a looser cap
// (which would offer over-size bytes the rules then deny) is caught. The rules are the real authority;
// this client mirror must fail a doomed upload fast without ever rejecting a valid boundary image.
//
// storage.js STATICALLY imports the Firebase JS SDK from the gstatic CDN (and, transitively via
// ./auth.js, more of it), so it cannot be `import`ed under `node --test` (ERR_UNSUPPORTED_ESM_URL_SCHEME).
// Exactly like storage-validate-avatar.test.mjs, we load the REAL source, neutralise ONLY the top-level
// import statements, and evaluate the module as a data: URL — validateAvatarFile + MAX_AVATAR_BYTES use
// NONE of the imported symbols, so the function under test is the exact shipped body (a behavioural
// proof, not a source-text grep and not a re-implementation).

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

test("validateAvatarFile ACCEPTS a raster image ONE byte under the 5 MB cap", () => {
  assert.equal(validateAvatarFile(fakeFile("image/png", MAX_AVATAR_BYTES - 1)), "");
});

test("validateAvatarFile ACCEPTS a raster image at EXACTLY the 5 MB cap (boundary is inclusive)", () => {
  // The guard is `size > MAX` (strict), so the cap itself is the last accepted size — a legitimate
  // exactly-5-MB image must NOT be rejected. A drift to `>=` would wrongly turn this red.
  assert.equal(validateAvatarFile(fakeFile("image/png", MAX_AVATAR_BYTES)), "");
  assert.equal(validateAvatarFile(fakeFile("image/jpeg", MAX_AVATAR_BYTES)), "");
});

test("validateAvatarFile REJECTS a raster image ONE byte over the 5 MB cap", () => {
  assert.equal(
    validateAvatarFile(fakeFile("image/png", MAX_AVATAR_BYTES + 1)),
    "Image must be 5 MB or smaller.",
  );
});

test("validateAvatarFile ACCEPTS a zero-byte image (only the upper bound is enforced here)", () => {
  // The size guard is one-sided (> MAX only); an empty/zero-length file is not rejected by size — any
  // "must have bytes" concern is the rules'/upload's, not this fast client mirror. Pins that the lower
  // edge is open so the boundary check stays purely about the 5 MB cap.
  assert.equal(validateAvatarFile(fakeFile("image/png", 0)), "");
});
