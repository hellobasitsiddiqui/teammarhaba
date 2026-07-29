// TM-1139 — the onboarding gate's SHORT BIO wiring. The bio shipped as a DISABLED "Soon" stub
// (TM-684): a textarea with `disabled: true` / an `aria-disabled` and a "Soon" tag, NOT read by
// collectBody(). TM-1139 turns it into a REAL, OPTIONAL field: a functional textarea (no "Soon" tag,
// not disabled), captured into the onboarding payload only when non-blank so the gate still submits
// with an empty bio.
//
// onboarding.js is DOM/Firebase/api.js-heavy and has no eval harness (its collectBody/buildShell are
// module-private), so — exactly like verified-phone-flag.test.mjs pins the onboarding.js flag wiring —
// this pins the bio wiring at the SOURCE level. The pure behaviour (present/hidden + the trimmed value)
// is covered by bioDisplay in profile-core.test.mjs; the DOM edit-form field + counter are covered in
// profile-edit-behaviour.test.mjs; these pins prove the GATE side is wired the same way.
//
// Framework-free — Node's built-in runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(HERE, rel), "utf8");
/** Strip `//` line comments + block comments so doc-comment mentions of a token can't false-positive. */
const stripComments = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");

const SRC = stripComments(read("../src/assets/onboarding.js"));

test("onboarding.js builds a REAL bio textarea (not the disabled 'Soon' stub) (TM-1139)", () => {
  // There must be a bio-field builder, and it must NOT render the field disabled or carry the "Soon" tag
  // any more (those were the TM-684 stub markers). A functional textarea named `bio` is what gets built.
  assert.match(SRC, /function buildBioField\s*\(/, "a real buildBioField() must exist");
  assert.doesNotMatch(SRC, /buildBioStub/, "the disabled buildBioStub() must be gone");
  // The bio textarea carries name="bio" and is NOT disabled (it's a real, editable field now).
  assert.match(SRC, /name:\s*"bio"/, "the bio textarea is named 'bio'");
  assert.doesNotMatch(
    SRC,
    /class:\s*"tm-input tm-textarea"[^}]*disabled:\s*true/,
    "the bio textarea must no longer be disabled",
  );
});

test("collectBody() includes the bio in the onboarding payload, but ONLY when non-blank (TM-1139)", () => {
  // The gate body builder must read the bio off the shell and add it to the request body only when the
  // user actually typed one — so an empty bio is omitted and the gate still submits (bio is OPTIONAL).
  assert.match(SRC, /shell\.bio\b/, "collectBody must read the bio textarea off the shell");
  assert.match(
    SRC,
    /if\s*\(\s*bio\s*!==\s*""\s*\)\s*body\.bio\s*=\s*bio/,
    "the bio is added to the payload only when it's non-blank (empty bio omitted → gate still submits)",
  );
});

test("the bio textarea is NOT part of the REQUIRED FIELDS array (it must not gate submission) (TM-1139)", () => {
  // Every entry in the FIELDS array is treated as REQUIRED by validateAll; the OPTIONAL bio must NOT be
  // in it, or a blank bio would block onboarding. Pin that the FIELDS array carries only the five
  // required fields and no `field: "bio"` descriptor.
  assert.doesNotMatch(SRC, /field:\s*"bio"/, "bio must not be a FIELDS descriptor (that array is all-required)");
});

test("prefill() restores a returning user's saved bio into the gate textarea (TM-1139)", () => {
  // A half-onboarded user re-entering the gate keeps their typed bio — prefill reads me.bio onto the
  // shell's bio textarea.
  assert.match(SRC, /shell\.bio\.value\s*=/, "prefill must fill the bio textarea from the profile");
  assert.match(SRC, /profile\?\.bio\b|profile\.bio\b/, "prefill must read the saved bio off the /me profile");
});
