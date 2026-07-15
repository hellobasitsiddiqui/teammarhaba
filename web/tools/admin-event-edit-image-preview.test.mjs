// Admin event edit form — existing-image preview guard (TM-712). Framework-free — Node's built-in
// test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// The bug: when the admin opened the edit form for an event that already had an image,
// admin-events.js `buildImageControl()` used `event.imagePath` ONLY to word a text hint ("An image is
// already set…"). The preview <img> was only ever set from `URL.createObjectURL(picked)` on a file
// change, so a stored image never previewed on edit-open — the 🗓️ placeholder showed instead. The fix
// seeds the preview from the existing `imagePath` on open: classify it with the pure `eventImageRef`
// (a URL is used directly; a Storage object path is resolved via `downloadUrlForPath`), and never
// clobber a newer picked-file preview.
//
// Two layers of coverage:
//   1. The pure resolution decision (`eventImageRef`) — stored path → resolve; url → direct; none →
//      placeholder. This is the source of the preview src, exercised directly.
//   2. A source-level guard that the DOM shell (`buildImageControl`) actually WIRES that resolution
//      into the preview <img>. The full admin-events.js module can't be imported in Node (a transitive
//      `https:` Firebase import in its api/auth chain isn't resolvable by the default ESM loader), so —
//      like events-map-link-a11y.test.mjs — the wiring is asserted against the module source. This is
//      what fails BEFORE the fix (those symbols weren't referenced in the image-control seam) and
//      passes AFTER, so a later edit can't silently drop the existing-image preview again.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { eventImageRef } from "../src/assets/events-core.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "../src/assets/admin-events.js"), "utf8");

// --- Layer 1: the pure preview-source resolution the fix relies on -------------------------------

test("no stored image → eventImageRef is null → nothing to preview, placeholder stays (TM-712)", () => {
  // When the form has no imagePath, the seeding block never runs and the preview <img> stays hidden,
  // leaving the 🗓️ placeholder visible. eventImageRef returning null is that gate.
  assert.equal(eventImageRef(null), null);
  assert.equal(eventImageRef(undefined), null);
  assert.equal(eventImageRef(""), null);
  assert.equal(eventImageRef("   "), null);
});

test("stored Storage object path → resolve via downloadUrlForPath before previewing (TM-712)", () => {
  // What uploadEventImage persists (`event-images/{id}`) — the case the bug missed. Classified as a
  // path so the shell resolves it to a fresh download URL and sets it as the preview src.
  assert.deepEqual(eventImageRef("event-images/123"), { kind: "path", value: "event-images/123" });
  assert.deepEqual(eventImageRef("  event-images/123  "), { kind: "path", value: "event-images/123" });
});

test("stored http(s) URL → used directly as the preview src (legacy / external) (TM-712)", () => {
  assert.deepEqual(eventImageRef("https://cdn.example.com/e.jpg"), { kind: "url", value: "https://cdn.example.com/e.jpg" });
  assert.deepEqual(eventImageRef("http://cdn.example.com/e.jpg"), { kind: "url", value: "http://cdn.example.com/e.jpg" });
});

// --- Layer 2: the DOM shell wires that resolution into the preview <img> -------------------------

/** Isolate the `buildImageControl(event)` function body so the wiring assertions can't match an unrelated seam. */
function imageControlBody() {
  const start = SRC.indexOf("function buildImageControl(");
  assert.ok(start !== -1, "could not locate buildImageControl() in admin-events.js");
  // The venue picker section follows; bound the search there so we scan only this function.
  const end = SRC.indexOf("async function fetchActiveVenues(", start);
  assert.ok(end !== -1 && end > start, "could not bound buildImageControl()");
  return SRC.slice(start, end);
}

test("buildImageControl seeds the preview from the existing event.imagePath (TM-712)", () => {
  const body = imageControlBody();
  // It classifies the stored image path with the pure helper (not just the text hint) …
  assert.match(
    body,
    /eventImageRef\(\s*event\?\.imagePath\s*\)/,
    "buildImageControl must classify the existing event.imagePath via eventImageRef to seed the preview",
  );
  // … resolves a Storage object path to a download URL …
  assert.match(
    body,
    /downloadUrlForPath\(/,
    "a stored Storage object path must be resolved via downloadUrlForPath before previewing",
  );
  // … and actually assigns the resolved source to the preview <img> (not just the text hint).
  assert.match(
    body,
    /preview\.src\s*=\s*url/,
    "the resolved existing-image URL must be set as the preview <img> src",
  );
});

test("a newer picked file is never clobbered by the async existing-image resolve (TM-712)", () => {
  const body = imageControlBody();
  // The showExisting guard must bail when a file has since been picked, so the object-URL preview wins.
  assert.match(
    body,
    /if\s*\(\s*!url\s*\|\|\s*pendingFile\s*\)\s*return/,
    "the existing-image resolve must not overwrite a newer picked-file preview (pendingFile guard)",
  );
});
