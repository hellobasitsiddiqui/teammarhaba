// Admin event CLONE/DUPLICATE wiring guard (TM-1061, absorbing TM-796). Framework-free — Node's built-in
// test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// The PURE clone logic (buildCloneDraft / shiftDraftTimes / pastStartWarning / CLONE_OFFSET_PRESETS) is
// unit-tested directly in event-form.test.mjs. This file guards the DOM SHELL (admin-events.js) that wires
// it — which can't be imported in Node (a transitive Firebase `https:` import in its api/auth chain isn't
// resolvable by the default ESM loader), so — like admin-event-more-options-wiring.test.mjs — the wiring is
// asserted against the module source. These fail BEFORE the change (the symbols/seams don't exist on main)
// and pass AFTER, so a later edit can't silently drop:
//   1. the Clone action on EVERY row branch (past, cancelled, active),
//   2. the offset-preset picker (LOCKED to the two presets, no free-form field),
//   3. the clone-mode prefill (from the pure buildCloneDraft) + the past-start warning,
//   4. the image duplication seam (fetch the source image → re-upload as a NEW object).

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "../src/assets/admin-events.js"), "utf8");

test("admin-events.js imports the pure clone helpers from event-form.js (TM-1061)", () => {
  assert.match(
    SRC,
    /import\s*\{[^}]*\bCLONE_OFFSET_PRESETS\b[^}]*\bbuildCloneDraft\b[^}]*\bpastStartWarning\b[^}]*\}\s*from\s*["']\.\/event-form\.js["']/s,
    "the clone offset presets + draft builder + past-start warning must come from the unit-tested pure module",
  );
});

test("every row branch (past, cancelled, active) offers a Clone action (TM-1061)", () => {
  // A single reusable Clone button wired to startCloneEvent, returned in all three rowActions branches so
  // a past OR cancelled OR active event can be cloned. The button label is "Clone".
  assert.match(SRC, /onClick:\s*\(\)\s*=>\s*startCloneEvent\(\s*event\s*\)/, "the Clone button must call startCloneEvent(event)");
  assert.match(SRC, /"aria-label":\s*`Clone \$\{event\.heading\}`/, "the Clone button needs an accessible per-event label");
  // The past-event branch (read-only Edit) still returns the clone button, and the cancelled branch too.
  assert.match(SRC, /disabled:\s*true[\s\S]*?"Edit",\s*\),\s*clone,/, "a PAST event row must still offer Clone");
  assert.match(SRC, /return\s*\[\s*edit\s*,\s*clone\s*\]/, "a CANCELLED event row must offer Edit + Clone");
});

test("the offset picker is LOCKED to CLONE_OFFSET_PRESETS — no free-form offset field (TM-1061)", () => {
  // The picker renders one button PER preset (mapped over CLONE_OFFSET_PRESETS) and carries no <input> for
  // a custom offset (deferred follow-up). An explicit pick is required (the admin taps a preset button).
  assert.match(SRC, /CLONE_OFFSET_PRESETS\.map\(/, "the picker must render a button per LOCKED preset");
  assert.match(SRC, /function\s+pickCloneOffset\b/, "there must be an offset-preset picker");
  // No free-form offset text/number input in the picker body.
  assert.doesNotMatch(SRC, /id:\s*["']clone-offset-custom["']/, "there must be NO free-form custom-offset field (deferred)");
});

test("startCloneEvent stashes buildCloneDraft(event, offset) then navigates to the create route (TM-1061)", () => {
  assert.match(SRC, /pendingClone\s*=\s*\{\s*source:\s*event\s*,\s*draft:\s*buildCloneDraft\(\s*event\s*,\s*offsetMs\s*\)\s*\}/, "the clone draft must be built from the pure buildCloneDraft with the chosen offset");
  assert.match(SRC, /window\.location\.hash\s*=\s*adminEventNewHash\(\)/, "a clone must open the CREATE route (nothing persisted until Save)");
});

test("the create route mounts in CLONE mode from the one-shot stash (TM-1061)", () => {
  // enterAdminEventForm's create branch takes-and-clears the pending clone so a plain New event / refresh
  // never re-opens a stale clone, and passes its draft into mountEventForm → buildEventForm.
  assert.match(SRC, /takePendingClone\(\)/, "the create branch must take (and clear) the one-shot clone stash");
  assert.match(SRC, /buildEventForm\(\{\s*mode\s*,\s*event\s*,\s*cloneDraft\s*,/, "buildEventForm must receive the clone draft");
  // Clone mode prefills the model from the clone draft (not a blank create).
  assert.match(SRC, /isClone\s*\?\s*cloneDraft\s*:\s*\{\s*timezone:\s*guessTimeZone\(\)\s*\}/, "clone mode must prefill from the clone draft");
});

test("the past-start warning is a NON-BLOCKING visible note recomputed on start/timezone change (TM-1061)", () => {
  assert.match(SRC, /id:\s*["']event-past-start-warning["']/, "there must be a stable past-start warning node for the e2e + a11y");
  assert.match(SRC, /pastStartWarning\(\s*readDraft\(\)\s*\)/, "the warning must be computed by the pure pastStartWarning from the live draft");
  assert.match(SRC, /refreshPastStartWarning\(\)/, "the warning must refresh on the start/timezone edits");
});

test("the clone image is duplicated to a NEW storage object, never a shared source URL (TM-1061)", () => {
  // seedCloneImage fetches the SOURCE image bytes and hands them to the image control as a pending File,
  // so the ordinary create submit re-uploads to event-images/{newId} — a distinct object.
  assert.match(SRC, /function\s+seedCloneImage\b/, "there must be a clone-image duplication helper");
  assert.match(SRC, /image\.setPendingFile\(\s*file\s*\)/, "the fetched source image must become the create form's pending upload");
  assert.match(SRC, /new File\(\s*\[\s*blob\s*\]/, "the source image bytes must be wrapped as a File for re-upload");
  assert.match(SRC, /if\s*\(\s*isClone\s*&&\s*cloneDraft\.imagePath\s*\)/, "the duplication runs only for a clone that has a source image");
});
