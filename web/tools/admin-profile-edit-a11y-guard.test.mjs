// TM-172 source-guard for the admin profile-EDIT form's markup + a11y wiring. The console DOM module
// (admin.js) can't be imported under `node --test` (it pulls api.js → the Firebase CDN chain), so this
// guards the SOURCE TEXT of the buildForm/setControlError/showForm region — the same approach the
// TM-935 mobile-stack guard uses. It pins the four review fixes so a revert goes red cleanly:
//   1. the field wrapper uses the SHARED `.tm-form-field` class (not a bare `.tm-field` with no CSS),
//      so it inherits the self-edit's column stack + spacing + min-width:0 clip guard (TM-665);
//   2. an invalid field gets the `.tm-field-invalid` red ring (not aria-invalid alone), matching the
//      self-edit's setControlInvalid;
//   3. the per-field hint is exposed to screen readers (hint id + aria-describedby = hint AND error);
//   4. focus is managed when the disclosure opens/closes (into the first field, back to the edit btn).
// Kept in its own file so a revert of admin.js (leaving this test) goes red, proving the guard bites.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, "..", "src", "assets");
const read = (name) => readFileSync(join(assets, name), "utf8");

const adminSrc = read("admin.js");
const stylesSrc = read("styles.css");

// Scope to the profile-edit closure (buildForm … end of showForm) so the admin-BROADCAST form's own
// .tm-form-field usage lower in the file can't mask a regression in the profile-edit form.
function slice(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  assert.notEqual(start, -1, `marker not found: ${startMarker}`);
  const end = src.indexOf(endMarker, start);
  assert.notEqual(end, -1, `end marker not found: ${endMarker}`);
  return src.slice(start, end);
}

// buildForm() through the end of showForm() — the whole profile-edit form region.
const formRegion = slice(adminSrc, "function buildForm()", "form.addEventListener(\"submit\"");
const showFormRegion = slice(adminSrc, "function showForm(on)", "form.addEventListener(\"submit\"");

test("field wrapper uses the shared .tm-form-field class, not a bare .tm-field", () => {
  assert.match(formRegion, /class:\s*"tm-form-field"/, "profile-edit field must wrap in .tm-form-field");
  assert.doesNotMatch(
    formRegion,
    /class:\s*"tm-field"/,
    "bare .tm-field has NO CSS rule — it breaks the column stack + loses the TM-665 min-width guard",
  );
  // The label carries the shared label class so it inherits the self-edit's label styling.
  assert.match(formRegion, /class:\s*"tm-field-label"/, "label must use .tm-field-label");
});

test(".tm-form-field CSS actually exists (the class the guard requires is not a dead class)", () => {
  assert.match(stylesSrc, /\.tm-form-field\s*\{/, ".tm-form-field must have a real CSS rule");
  assert.match(stylesSrc, /\.tm-form-field \.tm-input\s*\{/, ".tm-form-field .tm-input min-width guard must exist");
});

test("setControlError toggles the .tm-field-invalid ring alongside aria-invalid", () => {
  assert.match(
    formRegion,
    /classList\.toggle\("tm-field-invalid",\s*!!message\)/,
    "an invalid admin field must get the red ring (.tm-field-invalid), not aria-invalid alone",
  );
  assert.match(stylesSrc, /\.tm-input\.tm-field-invalid\s*\{/, ".tm-field-invalid CSS rule must exist");
});

test("per-field hint is exposed to screen readers via aria-describedby (hint AND error)", () => {
  // A hint id is built and the control is described by the joined hint+error ids.
  assert.match(formRegion, /hintId\s*=\s*field\.hint\s*\?/, "hint must get an id when present");
  assert.match(
    formRegion,
    /describedBy\s*=\s*\[hintId,\s*errorId\]\.filter\(Boolean\)\.join\(" "\)/,
    "aria-describedby must reference BOTH the hint and error ids",
  );
  assert.match(formRegion, /"aria-describedby":\s*describedBy/, "controls must use the joined describedBy");
  // The hint <p> must actually carry that id, else describedBy points at nothing.
  assert.match(formRegion, /el\("p",\s*\{\s*id:\s*hintId/, "the hint <p> must carry the hint id");
  // Guard against the old error-only wiring reappearing.
  assert.doesNotMatch(formRegion, /"aria-describedby":\s*errorId\b/, "must not describe by the error id alone");
});

test("focus is managed when the profile-edit disclosure opens and closes", () => {
  assert.match(
    showFormRegion,
    /first\?\.input\?\.focus\(\)/,
    "opening the form must move focus into the first field (the clicked edit btn is now hidden)",
  );
  assert.match(showFormRegion, /editBtn\.focus\(\)/, "closing the form must return focus to the edit button");
});
