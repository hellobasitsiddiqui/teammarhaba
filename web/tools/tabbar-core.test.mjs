// Unit tests for the bottom tab bar's pure core (TM-434) — the active-tab + visibility rules.
//
// Framework-free — Node's built-in test runner, picked up by the CI glob
// `node --test web/tools/*.test.mjs` (ci.yml web-build job). No DOM/Firebase, so it runs in plain
// Node exactly like async-util.test.mjs / events-core.test.mjs.

import assert from "node:assert/strict";
import { test } from "node:test";

import { TABS, TAB_IDS, activeTab, shouldShowTabbar } from "../src/assets/tabbar-core.js";

test("the tab order is LOCKED to Home · Events · Chat · Profile (TM-434 clarification)", () => {
  assert.deepEqual(TAB_IDS, ["home", "events", "chat", "profile"]);
  // Each tab maps to its documented route (the AC's route table).
  assert.deepEqual(
    TABS.map((t) => `${t.id}:${t.route}`),
    ["home:#/home", "events:#/events", "chat:#/chat", "profile:#/profile"],
  );
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

test("activeTab is null for routes that are not one of the four tabs", () => {
  for (const hash of ["#/admin", "#/admin/events", "#/help", "#/login", "#/onboarding", "#/terms", "#/diagnostics"]) {
    assert.equal(activeTab(hash), null, `${hash} should not activate a tab`);
  }
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
