// Shell brand-block scoping tests (TM-885 / TM-886). Framework-free — Node's built-in test runner,
// picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// THE BUG (TM-886, reproduced at 390×844): the walking-skeleton brand block at the top of
// <main class="app"> — the "Circle" wordmark h1, the "Find your people — complete your circle"
// tagline, and the #status "Ready when you are." line — painted above EVERY non-login screen,
// including the Profile screen (and the first-run gates), which render their own full-page headers.
// The leaked copy is the same brand copy as the auth landing card + boot splash, which is why the
// user report read as "the auth brand / boot splash isn't dismissed" on the profile.
//
// THE FIX: router.js's render() now drives the block's visibility through the pure
// shell-brand-core.js rule (hidden on the self-headed routes) via the shell-brand.js DOM bridge —
// the same router-driven single-source-of-truth mechanism as the tab bar / footer. These tests pin
//   (1) the pure rule's truth table,
//   (2) the DOM bridge's `hidden`-attribute behaviour against a minimal fake document, and
//   (3) the router wiring (source-level, like membership-route-wiring.test.mjs — router.js can't be
//       imported under `node --test`: it sits on the api.js → Firebase CDN import chain).

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SELF_HEADED_ROUTES, shellBrandHidden } from "../src/assets/shell-brand-core.js";
import { updateShellBrand } from "../src/assets/shell-brand.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// --- (1) the pure rule -------------------------------------------------------------------------------

test("brand block hides on the Profile screens (TM-885/TM-886)", () => {
  assert.equal(shellBrandHidden("#/profile"), true);
  assert.equal(shellBrandHidden("#/profile/public"), true, "the public preview is a profile sub-route");
});

test("brand block hides on the first-run gates (the re-gate screen the report was looking at)", () => {
  assert.equal(shellBrandHidden("#/onboarding"), true);
  assert.equal(shellBrandHidden("#/terms"), true);
});

test("brand block hides on the signed-in Home feed (content-first, TM-908)", () => {
  // Home opts into the self-headed rule: its "Events near you" heading is the first content, so the
  // walking-skeleton wordmark/tagline/#status must not paint above it. A hypothetical Home sub-route
  // (`#/home/...`) must match too, via the same prefix rule the profile sub-route uses.
  assert.equal(shellBrandHidden("#/home"), true);
  assert.equal(shellBrandHidden("#/home/feed"), true, "a Home sub-route matches via the prefix rule");
});

test("brand block stays on every other route (login/events/chat/admin unchanged)", () => {
  // #/home is NOW self-headed (TM-908) so it is deliberately absent here — see the Home test above.
  // #/login stays shown: the signed-out auth landing card owns its own lockup and is unaffected.
  for (const route of ["#/login", "#/events", "#/events/42", "#/chat", "#/chat/7",
    "#/admin", "#/admin/events", "#/help", "#/notifications", "#/diagnostics"]) {
    assert.equal(shellBrandHidden(route), false, `expected the brand block to stay on ${route}`);
  }
});

test("prefix matching is a real sub-path, not a string prefix", () => {
  // A hypothetical "#/profiles" route must NOT match "#/profile" (same rule shape as tabbar-core).
  assert.equal(shellBrandHidden("#/profiles"), false);
  assert.equal(shellBrandHidden("#/termsofuse"), false);
});

test("fails safe (shown) on junk input", () => {
  assert.equal(shellBrandHidden(""), false);
  assert.equal(shellBrandHidden(null), false);
  assert.equal(shellBrandHidden(undefined), false);
  assert.equal(shellBrandHidden(42), false);
});

test("the self-headed route list is frozen and exactly the decided set", () => {
  assert.ok(Object.isFrozen(SELF_HEADED_ROUTES));
  // #/home added by TM-908 (content-first Home); Events (#/events) is added by its own lane later.
  assert.deepEqual([...SELF_HEADED_ROUTES], ["#/profile", "#/home", "#/onboarding", "#/terms"]);
});

// --- (2) the DOM bridge ------------------------------------------------------------------------------

/** Minimal fake document: just the three brand nodes behind the exact selectors the bridge uses. */
function fakeDoc({ withStatus = true } = {}) {
  const h1 = { hidden: false };
  const tagline = { hidden: false };
  const status = withStatus ? { hidden: false } : null;
  return {
    h1,
    tagline,
    status,
    querySelector(sel) {
      if (sel === "main.app > h1") return h1;
      if (sel === "main.app > .tagline") return tagline;
      return null;
    },
    getElementById(id) {
      return id === "status" ? status : null;
    },
  };
}

test("updateShellBrand hides all three brand elements on #/profile and restores them on #/events", () => {
  const doc = fakeDoc();
  updateShellBrand({ route: "#/profile" }, doc);
  assert.deepEqual([doc.h1.hidden, doc.tagline.hidden, doc.status.hidden], [true, true, true]);
  // Navigating to a route that still shows the block restores it (render() reruns this on every
  // hashchange/auth change). #/events is chosen deliberately: #/home is now self-headed (TM-908) and
  // would keep the block hidden, so it can no longer stand in for a "block restored" route here.
  updateShellBrand({ route: "#/events" }, doc);
  assert.deepEqual([doc.h1.hidden, doc.tagline.hidden, doc.status.hidden], [false, false, false]);
});

test("updateShellBrand also hides the block on the signed-in Home feed (TM-908)", () => {
  const doc = fakeDoc();
  updateShellBrand({ route: "#/home" }, doc);
  assert.deepEqual([doc.h1.hidden, doc.tagline.hidden, doc.status.hidden], [true, true, true]);
});

test("updateShellBrand skips missing elements and a missing document without throwing", () => {
  const doc = fakeDoc({ withStatus: false });
  assert.doesNotThrow(() => updateShellBrand({ route: "#/profile" }, doc));
  assert.equal(doc.h1.hidden, true);
  assert.doesNotThrow(() => updateShellBrand({ route: "#/profile" }, null));
  assert.doesNotThrow(() => updateShellBrand(undefined, fakeDoc()));
});

// --- (3) the router wiring (source-level guard) ------------------------------------------------------

test("router.js render() drives the shell brand block (TM-885/TM-886 wiring)", () => {
  const routerSrc = readFileSync(join(HERE, "../src/assets/router.js"), "utf8");
  assert.match(
    routerSrc,
    /import\s*\{\s*updateShellBrand\s*\}\s*from\s*"\.\/shell-brand\.js"/,
    "router.js imports the shell-brand DOM bridge",
  );
  assert.match(
    routerSrc,
    /updateShellBrand\(\s*\{\s*route\s*\}\s*\)/,
    "render() must call updateShellBrand({ route }) — the router is the single source of truth for shell chrome",
  );
});
