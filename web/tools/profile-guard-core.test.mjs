// Unsaved-changes guard tests (TM-1027). Framework-free — Node's built-in test runner, picked up by
// the CI glob `node --test web/tools/*.test.mjs`.
//
// WHAT THIS COVERS:
//   (1) the PURE dirty/guard decision (profile-guard-core.js):
//       • isProfileDirty — dirty when collectPatch is non-empty OR a pending avatar OR an in-flight
//         phone verify; clean when all three are false (so a saved form navigates freely);
//       • navGuardDecision — "prompt" ONLY when leaving the edit form while dirty; "allow" otherwise
//         (a clean form, or staying on the profile, never prompts → no false positive);
//       • isLeavingProfileEdit — true only for #/profile → elsewhere (the public preview + hub→hub
//         re-render are NOT departures, and the interests "Manage" in-place picker never routes here).
//   (2) router.js's restore-hash wiring (source-level asserts): router.js sits on the api.js → Firebase
//       CDN import chain, so it can't be `import`ed under `node --test` — we assert the wiring the same
//       way corner-bell-core.test.mjs / shell-brand-core.test.mjs do.
//   (3) profile.js's dirty-signal wiring (source-level asserts): the avatar in-flight flag, the
//       editFormIsDirty export, and the native beforeunload arming.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  isProfileDirty,
  navGuardDecision,
  isLeavingProfileEdit,
  UNSAVED_GUARD_DIALOG,
  BEFOREUNLOAD_PROMPT,
} from "../src/assets/profile-guard-core.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// --- (1a) isProfileDirty -----------------------------------------------------------------------------

test("a fresh/untouched form is CLEAN (no dirty signals)", () => {
  assert.equal(
    isProfileDirty({ patchNonEmpty: false, pendingAvatar: false, phoneVerifyInFlight: false }),
    false,
  );
  // No args at all (before the form mounts) is also clean.
  assert.equal(isProfileDirty(), false);
  assert.equal(isProfileDirty({}), false);
});

test("a non-empty patch (typed an edit) makes the form DIRTY", () => {
  assert.equal(
    isProfileDirty({ patchNonEmpty: true, pendingAvatar: false, phoneVerifyInFlight: false }),
    true,
  );
});

test("an in-flight avatar upload makes the form DIRTY even with no field edits", () => {
  assert.equal(
    isProfileDirty({ patchNonEmpty: false, pendingAvatar: true, phoneVerifyInFlight: false }),
    true,
  );
});

test("an in-flight phone verify makes the form DIRTY even with no field edits", () => {
  assert.equal(
    isProfileDirty({ patchNonEmpty: false, pendingAvatar: false, phoneVerifyInFlight: true }),
    true,
  );
});

test("dirty CLEARS once every signal is false (the state after a successful save)", () => {
  // A successful save re-fills the form from /me → collectPatch empties → patchNonEmpty false.
  assert.equal(
    isProfileDirty({ patchNonEmpty: false, pendingAvatar: false, phoneVerifyInFlight: false }),
    false,
  );
});

test("the signals are coerced to booleans (truthy non-booleans still read as dirty)", () => {
  // The real callers pass e.g. a verificationId string / an object-count > 0; a truthy value is dirty.
  assert.equal(isProfileDirty({ phoneVerifyInFlight: "abc-verification-id" }), true);
  assert.equal(isProfileDirty({ pendingAvatar: 1 }), true);
  assert.equal(isProfileDirty({ patchNonEmpty: 0 }), false); // falsy → clean
  assert.equal(isProfileDirty({ patchNonEmpty: null }), false);
});

// --- (1b) navGuardDecision ---------------------------------------------------------------------------

test("leaving the edit form WHILE DIRTY → prompt", () => {
  assert.equal(navGuardDecision({ dirty: true, isLeavingProfile: true }), "prompt");
});

test("leaving the edit form while CLEAN → allow (no false positive)", () => {
  assert.equal(navGuardDecision({ dirty: false, isLeavingProfile: true }), "allow");
});

test("NOT leaving the profile → allow, even if dirty (staying on the form never prompts)", () => {
  assert.equal(navGuardDecision({ dirty: true, isLeavingProfile: false }), "allow");
  assert.equal(navGuardDecision({ dirty: false, isLeavingProfile: false }), "allow");
});

test("navGuardDecision tolerates missing/undefined context (defaults to allow)", () => {
  assert.equal(navGuardDecision(), "allow");
  assert.equal(navGuardDecision({}), "allow");
});

// --- (1c) isLeavingProfileEdit -----------------------------------------------------------------------

test("leaving #/profile for another route IS a departure", () => {
  assert.equal(isLeavingProfileEdit("#/profile", "#/home"), true);
  assert.equal(isLeavingProfileEdit("#/profile", "#/events"), true);
  assert.equal(isLeavingProfileEdit("#/profile", "#/chat"), true);
});

test("hub → hub (identical hash, a re-render) is NOT a departure", () => {
  assert.equal(isLeavingProfileEdit("#/profile", "#/profile"), false);
});

test("the public-profile preview is NOT the edit form — leaving it never guards", () => {
  // #/profile/public → elsewhere is not a departure FROM the edit form.
  assert.equal(isLeavingProfileEdit("#/profile/public", "#/home"), false);
  // And hub → public preview is a departure from the edit form (so it WILL be guarded if dirty) —
  // this is intentional: switching to the preview would abandon typed edits just like any other nav.
  assert.equal(isLeavingProfileEdit("#/profile", "#/profile/public"), true);
});

test("arriving AT the profile (from elsewhere) is not a departure", () => {
  assert.equal(isLeavingProfileEdit("#/home", "#/profile"), false);
});

// --- (1d) the shared dialog copy is the locked 2-button decision -------------------------------------

test("the dialog is the locked 2-button 'Discard changes? / Keep editing' shape", () => {
  assert.equal(UNSAVED_GUARD_DIALOG.title, "Discard changes?");
  assert.equal(UNSAVED_GUARD_DIALOG.confirmLabel, "Discard changes");
  assert.equal(UNSAVED_GUARD_DIALOG.cancelLabel, "Keep editing");
  assert.equal(UNSAVED_GUARD_DIALOG.danger, true);
  // It's a plain options object for confirmDialog — NOT a third "Save" button anywhere.
  assert.equal("saveLabel" in UNSAVED_GUARD_DIALOG, false);
  assert.equal(typeof BEFOREUNLOAD_PROMPT, "string");
  assert.ok(BEFOREUNLOAD_PROMPT.length > 0, "beforeunload needs a non-empty string to arm the prompt");
});

// --- (2) router.js restore-hash wiring (source-level guard) ------------------------------------------

const routerSrc = readFileSync(join(HERE, "../src/assets/router.js"), "utf8");

test("router.js imports the pure guard decision + the profile dirty signal", () => {
  assert.match(
    routerSrc,
    /import\s*\{[^}]*\benterProfile\b[^}]*\beditFormIsDirty\b[^}]*\}\s*from\s*"\.\/profile\.js"/,
    "router imports editFormIsDirty from profile.js",
  );
  assert.match(
    routerSrc,
    /from\s*"\.\/profile-guard-core\.js"/,
    "router imports the pure guard-core decision",
  );
  assert.match(routerSrc, /confirmDialog/, "router uses the styled 2-button confirmDialog (never native confirm)");
});

test("router.js drives the hashchange through the restore-hash intercept, not bare guard()", () => {
  // The listener must be the wrapping intercept (onHashChange), and the restore idiom must set the
  // hash back to the previous (committed) route on a cancelled/prompted nav.
  assert.match(
    routerSrc,
    /addEventListener\(\s*"hashchange"\s*,\s*onHashChange\s*\)/,
    "hashchange must go through onHashChange (the intercept), not bare guard",
  );
  assert.match(routerSrc, /navGuardDecision\(/, "the intercept consults the pure navGuardDecision");
  assert.match(routerSrc, /window\.location\.hash\s*=\s*from/, "cancelling restores the previous hash");
});

test("router.js records the committed hash after a successful render (the restore target)", () => {
  assert.match(routerSrc, /lastCommittedHash\s*=\s*window\.location\.hash/);
});

// --- (3) profile.js dirty-signal wiring (source-level guard) -----------------------------------------

const profileSrc = readFileSync(join(HERE, "../src/assets/profile.js"), "utf8");

test("profile.js exports editFormIsDirty combining the three signals via the pure rule", () => {
  assert.match(profileSrc, /export\s+function\s+editFormIsDirty\s*\(/);
  assert.match(profileSrc, /isProfileDirty\(\s*\{/, "editFormIsDirty delegates to the pure isProfileDirty");
  // All three signals must be gathered: a patch that CHANGES a stored field (not merely a non-empty
  // patch — collectPatch re-sends untouched populated fields), avatar in-flight, phone verify in-flight.
  assert.match(profileSrc, /patchChangesStoredProfile\(\)/, "dirty diffs the patch against the stored profile");
  assert.match(profileSrc, /pendingAvatar:\s*avatarUploadInFlight/);
  assert.match(profileSrc, /phoneVerifyInFlight:\s*phoneVerifyInFlight\(\)/);
});

test("profile.js tracks the avatar upload in-flight window (set before upload, cleared in finally)", () => {
  assert.match(profileSrc, /avatarUploadInFlight\s*=\s*true/, "flag set when an upload starts");
  assert.match(profileSrc, /avatarUploadInFlight\s*=\s*false/, "flag cleared when the upload settles");
});

test("profile.js arms the native beforeunload off the same dirty signal (TM-1027)", () => {
  assert.match(
    profileSrc,
    /addEventListener\(\s*"beforeunload"/,
    "profile.js registers a beforeunload handler",
  );
  assert.match(profileSrc, /if\s*\(\s*!editFormIsDirty\(\)\s*\)\s*return/, "beforeunload is inert when clean");
});
