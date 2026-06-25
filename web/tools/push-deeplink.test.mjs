// Tests for the push deep-link parsing (TM-285). Framework-free — Node's built-in test runner, same
// harness as push-env.test.mjs and picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// Guards the TM-285 trust boundary: a notification payload is turned into a SAFE in-app hash route
// (one of the known routes) or null — and an absolute/scheme'd/off-origin target can never leak
// through to become a navigation. push.js itself can't be imported here (it pulls in the Firebase
// SDK from a CDN via auth.js), which is exactly why the parse lives in the Firebase-free
// push-deeplink.js.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  rawRouteFromNotification,
  normaliseRoute,
  routeFromNotification,
  KNOWN_ROUTES,
  DEFAULT_ROUTE,
} from "../src/assets/push-deeplink.js";

test("rawRouteFromNotification reads data.route, then data.url", () => {
  assert.equal(rawRouteFromNotification({ data: { route: "#/profile" } }), "#/profile");
  assert.equal(rawRouteFromNotification({ data: { url: "#/admin" } }), "#/admin");
  // route wins over url when both present
  assert.equal(rawRouteFromNotification({ data: { route: "#/home", url: "#/admin" } }), "#/home");
});

test("rawRouteFromNotification tolerates a flattened payload (no .data wrapper)", () => {
  assert.equal(rawRouteFromNotification({ route: "#/help" }), "#/help");
});

test("rawRouteFromNotification returns null for missing/blank/non-object input", () => {
  assert.equal(rawRouteFromNotification(null), null);
  assert.equal(rawRouteFromNotification(undefined), null);
  assert.equal(rawRouteFromNotification({}), null);
  assert.equal(rawRouteFromNotification({ data: {} }), null);
  assert.equal(rawRouteFromNotification({ data: { route: "   " } }), null);
  assert.equal(rawRouteFromNotification({ data: { route: 42 } }), null);
});

test("normaliseRoute accepts a hash route as-is", () => {
  assert.equal(normaliseRoute("#/profile"), "#/profile");
  assert.equal(normaliseRoute("#/admin"), "#/admin");
});

test("normaliseRoute coerces path / bare / #-prefixed shapes to the hash route", () => {
  assert.equal(normaliseRoute("/profile"), "#/profile");
  assert.equal(normaliseRoute("profile"), "#/profile");
  assert.equal(normaliseRoute("#profile"), "#/profile");
});

test("normaliseRoute is case-insensitive and tolerates a trailing slash", () => {
  assert.equal(normaliseRoute("#/PROFILE"), "#/profile");
  assert.equal(normaliseRoute("/Help/"), "#/help");
});

test("normaliseRoute rejects unknown routes (caller falls back)", () => {
  assert.equal(normaliseRoute("#/not-a-real-view"), null);
  assert.equal(normaliseRoute("settings"), null);
});

test("normaliseRoute rejects absolute / scheme-relative / scheme'd targets (trust boundary)", () => {
  assert.equal(normaliseRoute("https://evil.example/#/home"), null);
  assert.equal(normaliseRoute("http://evil.example"), null);
  assert.equal(normaliseRoute("//evil.example"), null);
  assert.equal(normaliseRoute("javascript:alert(1)"), null);
  assert.equal(normaliseRoute("JavaScript:alert(1)"), null);
  assert.equal(normaliseRoute("data:text/html,x"), null);
});

test("normaliseRoute returns null for empty/non-string", () => {
  assert.equal(normaliseRoute(""), null);
  assert.equal(normaliseRoute("   "), null);
  assert.equal(normaliseRoute(null), null);
  assert.equal(normaliseRoute(undefined), null);
  assert.equal(normaliseRoute(123), null);
});

test("routeFromNotification: end-to-end payload → safe route", () => {
  assert.equal(routeFromNotification({ data: { route: "/profile" } }), "#/profile");
  assert.equal(routeFromNotification({ data: { url: "admin" } }), "#/admin");
  // unusable / unsafe payloads → null (push.js then falls back to DEFAULT_ROUTE)
  assert.equal(routeFromNotification({ data: { route: "https://evil.example" } }), null);
  assert.equal(routeFromNotification({}), null);
  assert.equal(routeFromNotification(null), null);
});

test("every KNOWN_ROUTE normalises to itself, and DEFAULT_ROUTE is known", () => {
  for (const r of KNOWN_ROUTES) assert.equal(normaliseRoute(r), r);
  assert.ok(KNOWN_ROUTES.includes(DEFAULT_ROUTE));
});
