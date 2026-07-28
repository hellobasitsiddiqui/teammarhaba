// Admin event form — TM-1112 + TM-1101 + TM-1113 DOM-wiring guards. Framework-free — Node's built-in
// test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// The PURE cores (isDirtyDraft / blankFormModel / DESCRIPTION_TEMPLATES, and the validate/paint rules) are
// unit-tested directly in event-form.test.mjs. This file guards the DOM SHELL (admin-events.js) that wires
// them, which can't be imported in Node (a transitive Firebase `https:` import in its api/auth chain isn't
// resolvable by the default ESM loader) — so, like admin-event-more-options-wiring.test.mjs, the wiring is
// asserted against the module SOURCE. These fail BEFORE the change (the seams don't exist) and pass AFTER,
// so a later edit can't silently drop:
//   TM-1112 — the venue picker's `initial` echo must NOT paint the pristine `locationText` required error;
//   TM-1101 — the dirty-guard (isDirtyDraft) gating Cancel + the "← Events" back link + a Clear/Reset button;
//   TM-1113 — the description template chips (DESCRIPTION_TEMPLATES) rendered above the Description textarea.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "../src/assets/admin-events.js"), "utf8");

// --- TM-1112: initial-echo must not paint the pristine required error ------------------------

test("TM-1112: the venue onSelect skips the locationText paint on the `initial` echo", () => {
  // The load-bearing fix: on the one-shot initial echo (fires on LOAD, before any input), revalidate with
  // NO changedKey so a pristine required field isn't painted; a REAL pick still passes "locationText".
  assert.match(
    SRC,
    /revalidate\(\s*initial\s*\?\s*undefined\s*:\s*["']locationText["']\s*\)/,
    "the initial echo must revalidate with no changedKey (so no pristine required error), a real pick with 'locationText'",
  );
});

test("TM-1112: the fix is scoped to the initial echo, not a blanket removal of live location validation", () => {
  // A real (non-initial) venue pick / edit must still validate the location line live — the ternary keeps
  // the "locationText" changedKey for that branch, so this guards against a regression that just drops it.
  assert.match(SRC, /initial\s*\?\s*undefined\s*:\s*["']locationText["']/, "a real change must still pass locationText");
});

// --- TM-1101: dirty-guard on exit + Clear/Reset ----------------------------------------------

test("TM-1101: the form imports the pure dirty-check helpers", () => {
  assert.match(
    SRC,
    /import\s*\{[^}]*\bisDirtyDraft\b[^}]*\}\s*from\s*["']\.\/event-form\.js["']/s,
    "the dirty check must go through the pure event-form.js helper (unit-tested)",
  );
});

test("TM-1101: isDirty ORs the pure draft-diff with a freshly-picked image, and treats busy as safe", () => {
  assert.match(SRC, /isDirtyDraft\(\s*readDraft\(\)\s*,\s*baselineDraft\s*\)\s*\|\|\s*image\.getFile\(\)\s*!=\s*null/,
    "isDirty must compare the live draft to the opened baseline and OR in a picked (not-yet-uploaded) image");
  // The baseline is snapshotted from readDraft() AFTER the controls seed their defaults, so a fresh form is pristine.
  assert.match(SRC, /baselineDraft\s*=\s*readDraft\(\)/, "the dirty baseline must be captured from the opened form's values");
});

test("TM-1101: a dirty exit is gated on confirmDialog; a pristine exit is silent", () => {
  // confirmExit returns true (safe to leave) for a pristine/busy form, else awaits a confirmDialog.
  assert.match(SRC, /confirmExit\s*=\s*async\s*\(\)\s*=>\s*\{/, "there must be a confirmExit gate");
  assert.match(SRC, /if\s*\(\s*busy\s*\|\|\s*!isDirty\(\)\s*\)\s*return\s+true/, "a pristine (or busy) form must leave without a prompt");
  // Both the Cancel button and the back link must run confirmExit before navigating.
  assert.match(SRC, /if\s*\(\s*await\s+confirmExit\(\)\s*\)\s*onCancel\?\.\(\)/, "Cancel must gate on confirmExit");
  assert.match(SRC, /formHeader\(\s*title\s*,\s*confirmExit\s*\)/, "the back-link header must receive confirmExit");
  assert.match(SRC, /confirmExit\(\)\.then\(\(ok\)\s*=>\s*\{[^}]*window\.location\.hash/s, "the back link must confirm before navigating");
});

test("TM-1101: a Clear all / Reset button re-mounts the form to its opened state", () => {
  assert.match(SRC, /id:\s*["']event-reset["']/, "there must be a Reset/Clear-all button");
  // create → 'Clear all', edit → 'Reset'.
  assert.match(SRC, /mode\s*===\s*["']create["']\s*\?\s*["']Clear all["']\s*:\s*["']Reset["']/, "the label is Clear all on create, Reset on edit");
  // Reset routes through onReset, which mountEventForm wires to a full re-mount of the same target.
  assert.match(SRC, /onReset\?\.\(\)/, "Reset must invoke the onReset callback");
  assert.match(SRC, /doReset\s*=\s*\(\)\s*=>\s*mountEventForm\(\s*view\s*,\s*mode\s*,\s*event\s*\)/, "onReset must re-mount the same form target");
});

// --- TM-1113: description template chips ------------------------------------------------------

test("TM-1113: the form imports and renders the description templates above the textarea", () => {
  assert.match(
    SRC,
    /import\s*\{[^}]*\bDESCRIPTION_TEMPLATES\b[^}]*\}\s*from\s*["']\.\/event-form\.js["']/s,
    "the description templates must come from the single event-form.js source",
  );
  // Mounted via the shared template-chip helper (same primitive as the opening-message templates).
  assert.match(SRC, /mountTemplateChips\(\s*["']description["']\s*,\s*DESCRIPTION_TEMPLATES\s*,/,
    "the description chips must mount above the description textarea via the shared helper");
});

test("TM-1113: tapping a description chip seeds the textarea then revalidates (cap unchanged)", () => {
  // The shared helper seeds the field, focuses it, and revalidates the SAME field key — the TM-382/TM-1065
  // seeding contract. It does not touch maxLength, so DESCRIPTION_MAX is unchanged.
  assert.match(SRC, /input\.value\s*=\s*value/, "a tapped template must seed the textarea value");
  assert.match(SRC, /revalidate\(\s*fieldKey\s*\)/, "seeding a template must revalidate that field");
  // The opening-message templates still render (the refactor must not drop them).
  assert.match(SRC, /mountTemplateChips\(\s*["']openingMessage["']\s*,\s*OPENING_MESSAGE_TEMPLATES\s*,/,
    "the opening-message templates must still be rendered");
});
