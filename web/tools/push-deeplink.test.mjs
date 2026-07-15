// Tests for the push deep-link parsing (TM-285). Framework-free — Node's built-in test runner, same
// harness as push-env.test.mjs and picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// Guards the TM-285 trust boundary: a notification payload is turned into a SAFE in-app hash route
// (one of the known routes) or null — and an absolute/scheme'd/off-origin target can never leak
// through to become a navigation. push.js itself can't be imported here (it pulls in the Firebase
// SDK from a CDN via auth.js), which is exactly why the parse lives in the Firebase-free
// push-deeplink.js.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  rawRouteFromNotification,
  normaliseRoute,
  routeFromNotification,
  KNOWN_ROUTES,
  DEFAULT_ROUTE,
  EVENT_DETAIL_ROUTE,
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

test("normaliseRoute accepts server-built event-detail routes and rejects invalid ids (TM-747)", () => {
  // A valid #/events/{id} (what the backend PushRoutes.EVENT_DETAIL emits) normalises to ITSELF —
  // before the fix this returned null and every event push fell back to DEFAULT_ROUTE (#/home).
  assert.equal(normaliseRoute("#/events/42"), "#/events/42");
  assert.equal(normaliseRoute("/events/42"), "#/events/42"); // path shape coerces then matches
  assert.equal(normaliseRoute("#/events/1"), "#/events/1");
  assert.equal(normaliseRoute("#/events/9223372036854775807"), "#/events/9223372036854775807"); // 19-digit max
  // Invalid ids and anything but a bare event-detail route are still rejected (mirrors the backend
  // regex: positive, no leading zero, no sign, id-only path segment).
  assert.equal(normaliseRoute("#/events/0"), null); // leading-zero / zero id rejected
  assert.equal(normaliseRoute("#/events/007"), null); // leading zero rejected
  assert.equal(normaliseRoute("#/events/-1"), null); // sign rejected
  assert.equal(normaliseRoute("#/events/x"), null); // non-numeric rejected
  assert.equal(normaliseRoute("#/events"), null); // bare list route is not a push target
  assert.equal(normaliseRoute("#/events/"), null); // trailing slash / missing id
  assert.equal(normaliseRoute("#/events/42/edit"), null); // deeper path rejected
  // An existing known exact route still passes unchanged.
  assert.equal(normaliseRoute("#/profile"), "#/profile");
});

test("EVENT_DETAIL_ROUTE mirrors the backend PushRoutes.EVENT_DETAIL regex (TM-747)", () => {
  // The client pattern must match the backend's `#/events/[1-9][0-9]{0,18}` whole-string form so a
  // route the backend emits is exactly one the client resolves. Parse the backend regex from source
  // (no JVM) and assert the two agree on a spread of ids — the same source-of-truth cross-check the
  // KNOWN_ROUTES symmetry test uses below.
  const src = readFileSync(PUSH_ROUTES_JAVA, "utf8");
  const m = src.match(/EVENT_DETAIL\s*=\s*Pattern\.compile\(\s*"([^"]+)"\s*\)/);
  assert.ok(m, `Could not find 'EVENT_DETAIL = Pattern.compile("...")' in ${PUSH_ROUTES_JAVA}`);
  const backendRe = new RegExp("^(?:" + m[1] + ")$");
  for (const id of ["1", "42", "9223372036854775807"]) {
    const route = "#/events/" + id;
    assert.ok(backendRe.test(route), `backend regex should match ${route}`);
    assert.ok(EVENT_DETAIL_ROUTE.test(route), `client EVENT_DETAIL_ROUTE should match ${route}`);
  }
  for (const bad of ["#/events/0", "#/events/007", "#/events/x", "#/events", "#/events/42/edit"]) {
    assert.equal(backendRe.test(bad), false, `backend regex should reject ${bad}`);
    assert.equal(EVENT_DETAIL_ROUTE.test(bad), false, `client EVENT_DETAIL_ROUTE should reject ${bad}`);
  }
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

// ---------------------------------------------------------------------------------------------
// Client ↔ backend allow-list symmetry (TM-360, epic TM-358).
//
// The deep-link allow-list is maintained in TWO hand-edited places that MUST stay byte-identical:
//   - client  : KNOWN_ROUTES here in web/src/assets/push-deeplink.js  (what a tap can navigate to)
//   - backend : PushRoutes.KNOWN in backend/.../notify/PushRoutes.java (what a push may emit; the
//               single source of truth the admin broadcast/test-push picker populates from — TM-360)
// Until now nothing cross-checked them, so an edit to one and not the other would silently drift:
// the backend could emit (or the picker offer) a route the client can't resolve, or vice versa.
// This test parses PushRoutes.KNOWN straight out of the Java source and asserts set-equality, so a
// one-sided edit fails the fast Node PR gate (`node --test web/tools/*.test.mjs`) — no JVM needed.
// A matching Java-side pin lives in PushRoutesSymmetryTest so a backend-only edit is also caught in
// the backend gate. (This is the guard the picker's "single source of truth" leans on.)

/** Absolute path to the backend allow-list source, resolved relative to this test file. */
const PUSH_ROUTES_JAVA = fileURLToPath(
  new URL("../../backend/src/main/java/com/teammarhaba/backend/notify/PushRoutes.java", import.meta.url),
);

/**
 * Extract the backend allow-list from PushRoutes.java by reading the `KNOWN = Set.of( ... )`
 * initialiser and pulling out its double-quoted string literals. Deliberately source-parsing (not
 * running the JVM) so this stays in the Firebase-free, browser-free Node gate alongside the rest of
 * this file. Throws if the constant can't be found, so a rename can't make the check silently vacuous.
 */
function backendKnownRoutes() {
  const src = readFileSync(PUSH_ROUTES_JAVA, "utf8");
  const m = src.match(/KNOWN\s*=\s*Set\.of\s*\(([\s\S]*?)\)\s*;/);
  assert.ok(m, `Could not find 'KNOWN = Set.of(...)' in ${PUSH_ROUTES_JAVA}`);
  const routes = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  assert.ok(routes.length > 0, "Parsed backend KNOWN set was empty — parser likely out of date");
  return routes;
}

test("client KNOWN_ROUTES and backend PushRoutes.KNOWN are the same set (TM-360)", () => {
  const backend = backendKnownRoutes();
  // Compare as sets: order/duplication is irrelevant, membership is the invariant.
  const clientSet = new Set(KNOWN_ROUTES);
  const backendSet = new Set(backend);
  assert.equal(backendSet.size, backend.length, "backend list has duplicate routes");
  assert.equal(clientSet.size, KNOWN_ROUTES.length, "client list has duplicate routes");

  const onlyClient = [...clientSet].filter((r) => !backendSet.has(r)).sort();
  const onlyBackend = [...backendSet].filter((r) => !clientSet.has(r)).sort();
  assert.deepEqual(
    { onlyClient, onlyBackend },
    { onlyClient: [], onlyBackend: [] },
    "Push deep-link allow-lists drifted — reconcile web/src/assets/push-deeplink.js KNOWN_ROUTES " +
      "with backend PushRoutes.KNOWN so they are the same set",
  );
});

test("the allow-list is exactly the 7 pinned routes and excludes non-push app routes (TM-360)", () => {
  // Pin the contract so neither side can quietly add/drop a route (e.g. introduce a #/events view
  // that doesn't exist yet) without this failing and being reviewed. Also asserts the two app-only
  // router views (#/terms, #/diagnostics) that are deliberately NOT push targets stay excluded.
  // #/membership joined in TM-620: subscription renewal/dunning/downgrade notifications deep-link to
  // the membership screen (flag-gated in the router; the default-route fallback catches a flag-off tap).
  const expected = ["#/admin", "#/help", "#/home", "#/login", "#/membership", "#/onboarding", "#/profile"];
  assert.deepEqual([...KNOWN_ROUTES].sort(), expected);
  assert.deepEqual([...backendKnownRoutes()].sort(), expected);
  for (const notATarget of ["#/terms", "#/diagnostics", "#/events"]) {
    assert.ok(!KNOWN_ROUTES.includes(notATarget), `${notATarget} must not be a push deep-link target`);
  }
});
