// Source-level wiring guards for the profile Security section's device controls (TM-924).
// Framework-free — Node's built-in test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// biometric-settings.js now statically imports api.js (getMyDevices / signOutEverywhere), whose
// Firebase-CDN import chain can NEVER be loaded under `node --test` (Node's ESM loader rejects the
// gstatic `https:` import) — so, exactly like home.js / membership-receipts.js, its live render is an
// e2e concern and the wiring that's easy to regress silently is pinned here over the module TEXT. The
// pure decision layer it delegates to (devices-core.js) is behaviourally unit-tested in
// devices-core.test.mjs; these guards assert the shell actually WIRES that core + the two endpoints +
// the required honest copy + the confirm-then-signout dance.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "../src/assets/biometric-settings.js"), "utf8");

// --- Your devices: fetch → tested view-model → render -------------------------------------------

test("the devices block fetches GET /me/devices and renders via the tested deviceListView", () => {
  assert.match(
    SRC,
    /import\s*\{\s*getMyDevices\s*,\s*signOutEverywhere\s*\}\s*from\s*"\.\/api\.js"/,
    "imports the two new api helpers (getMyDevices + signOutEverywhere)",
  );
  assert.match(
    SRC,
    /import\s*\{\s*deviceListView\s*\}\s*from\s*"\.\/devices-core\.js"/,
    "delegates ordering/normalization to the tested devices-core, not a local copy",
  );
  assert.match(SRC, /getMyDevices\(\)/, "the block calls getMyDevices() to load the caller's devices");
  assert.match(SRC, /deviceListView\(devices\)/, "…and paints them through the tested deviceListView(devices)");
});

test("a failed devices load is caught (never white-screens the profile) and shows an inline message", () => {
  // The fetch chain has a .catch — a load error must not throw out of the section render.
  assert.match(
    SRC,
    /getMyDevices\(\)[\s\S]{0,600}\.catch\(/,
    "the getMyDevices() promise has a .catch so a load failure never breaks the profile page",
  );
});

test("HONEST COPY: the devices note says a push-less browser session may NOT appear (not a full session list)", () => {
  // The load-bearing acceptance criterion: the copy must make clear this is push-registered devices,
  // NOT every session — so the list is never mistaken for a session registry.
  assert.match(SRC, /turned on notifications/i, "the note ties the list to notification-enabled devices");
  assert.match(
    SRC,
    /may not appear here[\s\S]{0,80}isn't every place you're signed in/i,
    "the note explicitly says a device without notifications may not appear (not every signed-in place)",
  );
});

// --- Sign out everywhere: confirm → revoke → local sign-out --------------------------------------

test("Sign out everywhere confirms via the styled confirmDialog before doing anything", () => {
  const block = SRC.slice(SRC.indexOf("function buildSignOutEverywhereBlock"));
  assert.match(block, /confirmDialog\(\{/, "it opens the styled confirmDialog (never native confirm())");
  assert.match(block, /confirmLabel:\s*"Sign out everywhere"/, "the confirm CTA is labelled");
  assert.match(block, /danger:\s*true/, "it's a danger confirm");
  // Cancelling is a no-op — a falsy confirm returns before any endpoint call.
  assert.match(block, /if\s*\(!confirmed\)\s*return;/, "cancel / Escape / backdrop is a no-op (no revoke)");
});

test("on confirm it POSTs the revoke endpoint, THEN signs this tab out locally", () => {
  const block = SRC.slice(SRC.indexOf("function buildSignOutEverywhereBlock"));
  // Order matters: revoke server-side first, then local signOut() to clear this tab.
  const revokeAt = block.indexOf("signOutEverywhere(");
  const localAt = block.indexOf("signOut(");
  assert.ok(revokeAt > -1, "it calls the signOutEverywhere() api helper (the revoke endpoint)");
  assert.ok(localAt > revokeAt, "…and then calls the local auth signOut() to clear this tab (after the revoke)");
});

test("a revoke error is toasted and does NOT sign the tab out (the sessions weren't revoked)", () => {
  const block = SRC.slice(SRC.indexOf("function buildSignOutEverywhereBlock"));
  // The signOutEverywhere() call is wrapped so a failure surfaces a toast and returns before signOut().
  assert.match(
    block,
    /try\s*\{\s*await\s+signOutEverywhere\(\)[\s\S]{0,200}catch[\s\S]{0,200}toast\([\s\S]{0,120}return;/,
    "a failed revoke toasts an error and returns — it must not sign the tab out on a server failure",
  );
});

test("the section stays XSS-safe: el() only, no innerHTML sink", () => {
  // Guard the actual sink (a `.innerHTML` property access/assignment), not the word in the doc-comment
  // that promises we avoid it. Rendering is el()/textContent only.
  assert.ok(!/\.innerHTML\b/.test(SRC), "no `.innerHTML` sink in the security section (el()/textContent only)");
});
