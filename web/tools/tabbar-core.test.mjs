// Unit tests for the bottom tab bar's pure core (TM-434) — the active-tab + visibility rules.
//
// Framework-free — Node's built-in test runner, picked up by the CI glob
// `node --test web/tools/*.test.mjs` (ci.yml web-build job). No DOM/Firebase, so it runs in plain
// Node exactly like async-util.test.mjs / events-core.test.mjs.

import assert from "node:assert/strict";
import { test } from "node:test";

import { TABS, TAB_IDS, ADMIN_TAB, HELP_TAB, tabsFor, activeTab, shouldShowTabbar } from "../src/assets/tabbar-core.js";

test("the tab order is LOCKED to Home · Events · Chat · Profile (TM-434 clarification)", () => {
  assert.deepEqual(TAB_IDS, ["home", "events", "chat", "profile"]);
  // Each tab maps to its documented route (the AC's route table).
  assert.deepEqual(
    TABS.map((t) => `${t.id}:${t.route}`),
    ["home:#/home", "events:#/events", "chat:#/chat", "profile:#/profile"],
  );
  // TM-915: the Admin tab is NOT part of the locked table — it stays separate so TABS is frozen.
  assert.equal(TABS.some((t) => t.id === "admin"), false, "Admin must not leak into the locked TABS");
});

test("tabsFor: a normal user gets the four PLUS the Help tab as the 5th (TM-1092), never an admin affordance", () => {
  assert.deepEqual(tabsFor({ isAdmin: false }).map((t) => t.id), ["home", "events", "chat", "profile", "help"]);
  // Fail-safe: missing/partial state is treated as non-admin (the flag defaults false) — still Help, never Admin.
  assert.deepEqual(tabsFor().map((t) => t.id), ["home", "events", "chat", "profile", "help"]);
  assert.deepEqual(tabsFor({}).map((t) => t.id), ["home", "events", "chat", "profile", "help"]);
  // The core four are unchanged in place; Help is purely additive at the end; Admin never leaks in.
  assert.deepEqual(tabsFor({ isAdmin: false }).slice(0, 4), TABS);
  assert.equal(tabsFor({ isAdmin: false }).some((t) => t.id === "admin"), false, "a non-admin must never get the Admin tab");
  assert.deepEqual(HELP_TAB, { id: "help", route: "#/help", prefix: "#/help" });
});

test("tabsFor: an admin gets the four PLUS the Admin tab appended last — and NO Help tab (TM-915/TM-1092)", () => {
  assert.deepEqual(tabsFor({ isAdmin: true }).map((t) => t.id), ["home", "events", "chat", "profile", "admin"]);
  assert.deepEqual(ADMIN_TAB, { id: "admin", route: "#/admin", prefix: "#/admin" });
  // The user four are unchanged in place — the admin entry is purely additive at the end.
  assert.deepEqual(tabsFor({ isAdmin: true }).slice(0, 4), TABS);
  assert.equal(tabsFor({ isAdmin: true }).some((t) => t.id === "help"), false, "an admin must not get the Help tab");
});

test("both roles get EXACTLY five tabs — Admin or Help as the 5th, never both (TM-1092)", () => {
  assert.equal(tabsFor({ isAdmin: true }).length, 5);
  assert.equal(tabsFor({ isAdmin: false }).length, 5);
  assert.equal(tabsFor({ isAdmin: true }).at(-1).id, "admin");
  assert.equal(tabsFor({ isAdmin: false }).at(-1).id, "help");
});

test("activeTab lights the matching tab for each exact route", () => {
  assert.equal(activeTab("#/home"), "home");
  assert.equal(activeTab("#/events"), "events");
  assert.equal(activeTab("#/chat"), "chat");
  assert.equal(activeTab("#/profile"), "profile");
});

test("activeTab reflects the right tab for a sub-path / detail deep-link", () => {
  // An event detail deep-link (#/events/{id}) still lights the Events tab.
  assert.equal(activeTab("#/events/42"), "events");
  assert.equal(activeTab("#/events/abc-def"), "events");
  // A future #/chat/{eventId} sub-route (TM-433) lights the Chat tab with no core change.
  assert.equal(activeTab("#/chat/99"), "chat");
});

test("activeTab lights the Admin tab for every #/admin* route (TM-915)", () => {
  // Exact route + every deep sub-path (the existing consoles keep their own hashes) → "admin".
  assert.equal(activeTab("#/admin"), "admin");
  assert.equal(activeTab("#/admin/events"), "admin");
  assert.equal(activeTab("#/admin/venues/new"), "admin");
  assert.equal(activeTab("#/admin/interests/42/edit"), "admin");
  assert.equal(activeTab("#/admin/messages"), "admin");
  // A pure route→id map: it returns "admin" regardless of role — a non-admin simply has no
  // #tab-admin link in the DOM, so nothing lights (visibility is enforced in tabbar.js).
});

test("activeTab lights the Help tab for #/help and its sub-paths (TM-1092)", () => {
  assert.equal(activeTab("#/help"), "help");
  assert.equal(activeTab("#/help/faq"), "help");
});

test("activeTab is null for non-tab routes (admin + help routes now excepted)", () => {
  for (const hash of ["#/login", "#/onboarding", "#/terms", "#/diagnostics"]) {
    assert.equal(activeTab(hash), null, `${hash} should not activate a tab`);
  }
  // Near-misses on the admin / help prefixes must not false-match (exact-or-sub-path guard).
  assert.equal(activeTab("#/administrators"), null);
  assert.equal(activeTab("#/helpdesk"), null);
});

test("activeTab never throws on empty / non-string input (fails safe to null)", () => {
  assert.equal(activeTab(""), null);
  assert.equal(activeTab(undefined), null);
  assert.equal(activeTab(null), null);
  // A near-miss must not false-match a tab (prefix guard is exact-or-sub-path only).
  assert.equal(activeTab("#/homepage"), null);
  assert.equal(activeTab("#/events-archive"), null);
});

test("shouldShowTabbar: shown only for a signed-in, un-gated user", () => {
  assert.equal(shouldShowTabbar({ signedIn: true, gated: false }), true);
});

test("shouldShowTabbar: hidden when signed out (auth gate)", () => {
  assert.equal(shouldShowTabbar({ signedIn: false, gated: false }), false);
  assert.equal(shouldShowTabbar({ signedIn: false, gated: true }), false);
});

test("shouldShowTabbar: hidden while gated (onboarding / terms) even when signed in", () => {
  assert.equal(shouldShowTabbar({ signedIn: true, gated: true }), false);
});

test("shouldShowTabbar: defensive against missing/partial state", () => {
  assert.equal(shouldShowTabbar(), false);
  assert.equal(shouldShowTabbar({}), false);
  assert.equal(shouldShowTabbar({ signedIn: true }), true); // gated undefined → not gated
});
