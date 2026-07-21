// Corner-bell chrome tests (TM-910). Framework-free — Node's built-in test runner, picked up by the
// CI glob `node --test web/tools/*.test.mjs`.
//
// THE CHANGE (TM-910, at 390px): the Profile surface is already self-headed (shell-brand-core hides
// the walking-skeleton wordmark), so the only remaining top chrome above the "Profile" heading is
// the floating account-nav row — the hamburger toggle (#nav-toggle) plus the notification bell that
// rides beside it on narrow screens. This ticket removes that floating row on Profile and pins the
// bell to the top-right corner, so "Profile" is the first content.
//
// THE MECHANISM (mirrors shell-brand): router.js's render() drives the chrome through the pure
// corner-bell-core.js rule via the corner-bell.js DOM bridge — the same router-driven single-source-
// of-truth mechanism as the shell-brand block / tab bar / footer. These tests pin
//   (1) the pure rule's truth table (fail-before if #/profile ever stops matching),
//   (2) the DOM bridge's `hidden`-attribute + class behaviour against a minimal fake document,
//   (3) the router wiring (source-level, like shell-brand-core.test.mjs — router.js can't be
//       imported under `node --test`: it sits on the api.js → Firebase CDN import chain).

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CORNER_BELL_ROUTES, bellPinnedToCorner } from "../src/assets/corner-bell-core.js";
import { updateCornerBell } from "../src/assets/corner-bell.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// --- (1) the pure rule -------------------------------------------------------------------------------

test("corner-bell applies on the Profile screens (TM-910)", () => {
  assert.equal(bellPinnedToCorner("#/profile"), true);
  assert.equal(bellPinnedToCorner("#/profile/public"), true, "the public preview is a profile sub-route");
});

test("corner-bell stays OFF every other route (login/home/events/chat/admin unchanged in this lane)", () => {
  // Home (#/home, TM-908) and Events (#/events, TM-909) take the treatment in their OWN lanes; this
  // TM-910 lane must not reshape their chrome, so they are false here until those lanes add them.
  for (const route of ["#/login", "#/home", "#/events", "#/events/42", "#/chat", "#/chat/7",
    "#/admin", "#/admin/events", "#/help", "#/notifications", "#/onboarding", "#/terms", "#/diagnostics"]) {
    assert.equal(bellPinnedToCorner(route), false, `expected corner-bell OFF on ${route}`);
  }
});

test("prefix matching is a real sub-path, not a string prefix", () => {
  // A hypothetical "#/profiles" route must NOT match "#/profile" (same rule shape as tabbar-core).
  assert.equal(bellPinnedToCorner("#/profiles"), false);
});

test("fails safe (off) on junk input", () => {
  assert.equal(bellPinnedToCorner(""), false);
  assert.equal(bellPinnedToCorner(null), false);
  assert.equal(bellPinnedToCorner(undefined), false);
  assert.equal(bellPinnedToCorner(42), false);
});

test("the corner-bell route list is frozen and the shared consumption point", () => {
  assert.ok(Object.isFrozen(CORNER_BELL_ROUTES));
  assert.deepEqual([...CORNER_BELL_ROUTES], ["#/profile"]);
});

// --- (2) the DOM bridge ------------------------------------------------------------------------------

/** Minimal fake nav DOM: the <nav.app-nav>, the hamburger toggle, and the collapsible items group. */
function fakeDoc({ withToggle = true, withItems = true, withNav = true } = {}) {
  const classNames = new Set();
  const nav = withNav
    ? {
        classList: {
          toggle(name, force) {
            const on = force === undefined ? !classNames.has(name) : Boolean(force);
            if (on) classNames.add(name);
            else classNames.delete(name);
            return on;
          },
          contains: (name) => classNames.has(name),
        },
      }
    : null;
  const toggle = withToggle ? { hidden: false } : null;
  const items = withItems ? { hidden: false } : null;
  return {
    nav,
    toggle,
    items,
    querySelector(sel) {
      return sel === "nav.app-nav" ? nav : null;
    },
    getElementById(id) {
      if (id === "nav-toggle") return toggle;
      if (id === "nav-items") return items;
      return null;
    },
  };
}

test("updateCornerBell hides the hamburger + pins the class on #/profile and restores on #/home", () => {
  const doc = fakeDoc();
  updateCornerBell({ route: "#/profile" }, doc);
  assert.equal(doc.toggle.hidden, true, "hamburger toggle hidden on Profile");
  // #nav-items is deliberately LEFT ALONE — the desktop inline nav (and #nav-profile within it) must
  // stay visible on #/profile at wide widths (onboarding-to-profile e2e asserts it); on mobile it's
  // already the collapsed display:none dropdown, so hiding only the toggle removes the floating row.
  assert.equal(doc.items.hidden, false, "the account-links group is untouched (stays visible on desktop)");
  assert.equal(doc.nav.classList.contains("app-nav--corner-bell"), true, "corner-bell class pinned");

  // Navigating away un-hides the toggle + drops the class (render() reruns this on every hashchange/
  // auth change), so leaving the corner route returns to the normal nav.
  updateCornerBell({ route: "#/home" }, doc);
  assert.equal(doc.toggle.hidden, false);
  assert.equal(doc.items.hidden, false);
  assert.equal(doc.nav.classList.contains("app-nav--corner-bell"), false);
});

test("updateCornerBell also covers the public-profile sub-route", () => {
  const doc = fakeDoc();
  updateCornerBell({ route: "#/profile/public" }, doc);
  assert.equal(doc.toggle.hidden, true);
  assert.equal(doc.nav.classList.contains("app-nav--corner-bell"), true);
});

test("updateCornerBell skips missing elements and a missing document without throwing", () => {
  assert.doesNotThrow(() => updateCornerBell({ route: "#/profile" }, fakeDoc({ withToggle: false })));
  assert.doesNotThrow(() => updateCornerBell({ route: "#/profile" }, fakeDoc({ withNav: false })));
  assert.doesNotThrow(() => updateCornerBell({ route: "#/profile" }, null));
  assert.doesNotThrow(() => updateCornerBell(undefined, fakeDoc()));
});

// --- (3) the router wiring (source-level guard) ------------------------------------------------------

test("router.js render() drives the corner-bell chrome (TM-910 wiring)", () => {
  const routerSrc = readFileSync(join(HERE, "../src/assets/router.js"), "utf8");
  assert.match(
    routerSrc,
    /import\s*\{\s*updateCornerBell\s*\}\s*from\s*"\.\/corner-bell\.js"/,
    "router.js imports the corner-bell DOM bridge",
  );
  assert.match(
    routerSrc,
    /updateCornerBell\(\s*\{\s*route\s*\}\s*\)/,
    "render() must call updateCornerBell({ route }) — the router is the single source of truth for shell chrome",
  );
});
