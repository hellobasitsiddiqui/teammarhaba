// Unit tests for the footer's pure core (TM-666) — the login/marketing fragment visibility rules and
// the labelled build-stamp formatting.
//
// Framework-free — Node's built-in test runner, picked up by the CI glob
// `node --test web/tools/*.test.mjs` (ci.yml web-build job). No DOM/Firebase, so it runs in plain
// Node exactly like tabbar-core.test.mjs. These pin the TM-666 acceptance criteria:
//   • Service-status link + phone-privacy note render ONLY on the login / logged-out screen.
//   • "A product of 10xAI" byline renders ONLY on login + Profile + Home.
//   • The build stamp LABELS which SHA is web vs backend.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  footerVisibility,
  formatBuildStamp,
  BUILD_STAMP_LABELS,
  LOGIN_ROUTE,
  HOME_ROUTE,
  PROFILE_ROUTE,
  HELP_ROUTE,
} from "../src/assets/footer-core.js";

// The footer-core route constants MUST mirror router.js's LOGIN / HOME / PROFILE / HELP (footer-core
// can't import router.js — that pulls the DOM/Firebase graph into a pure module). Pin the exact values
// so a drift is caught here rather than silently mis-scoping the footer.
test("route constants mirror router.js's LOGIN / HOME / PROFILE / HELP (TM-666, TM-1177)", () => {
  assert.equal(LOGIN_ROUTE, "#/login");
  assert.equal(HOME_ROUTE, "#/home");
  assert.equal(PROFILE_ROUTE, "#/profile");
  assert.equal(HELP_ROUTE, "#/help"); // TM-1177: badges + stamp are Help-scoped (router.js HELP = "#/help")
});

test("AC: Service-status + phone-privacy show ONLY when logged out (login screen)", () => {
  // Logged out → both visible (the login screen is the only signed-out route the shell renders).
  const out = footerVisibility({ signedIn: false, route: LOGIN_ROUTE });
  assert.equal(out.serviceStatus, true);
  assert.equal(out.phonePrivacy, true);

  // Signed in → both hidden, on EVERY in-app route (this is the bug: they used to show everywhere).
  for (const route of [HOME_ROUTE, PROFILE_ROUTE, "#/events", "#/chat", "#/admin", "#/notifications"]) {
    const v = footerVisibility({ signedIn: true, route });
    assert.equal(v.serviceStatus, false, `service-status must be hidden when signed in on ${route}`);
    assert.equal(v.phonePrivacy, false, `phone-privacy must be hidden when signed in on ${route}`);
  }
});

test("AC: the 10xAI byline shows ONLY on login + Home + Profile", () => {
  // Login / logged out → shown.
  assert.equal(footerVisibility({ signedIn: false, route: LOGIN_ROUTE }).byline, true);
  // Signed-in Home and Profile → shown.
  assert.equal(footerVisibility({ signedIn: true, route: HOME_ROUTE }).byline, true);
  assert.equal(footerVisibility({ signedIn: true, route: PROFILE_ROUTE }).byline, true);
  // A Profile SUB-route (e.g. the public-profile view) still counts as "on Profile".
  assert.equal(footerVisibility({ signedIn: true, route: "#/profile/public" }).byline, true);

  // Every other signed-in screen → hidden (no longer repeated on every screen).
  for (const route of ["#/events", "#/events/42", "#/chat", "#/chat/7", "#/admin", "#/notifications", "#/help"]) {
    assert.equal(
      footerVisibility({ signedIn: true, route }).byline,
      false,
      `byline must be hidden when signed in on ${route}`,
    );
  }
});

test("AC (TM-1177): app-download badges + build/version stamp show ONLY on Help + signed-out login", () => {
  // Signed-out login screen → both shown (the pre-auth screen a new user first lands on).
  const loggedOut = footerVisibility({ signedIn: false, route: LOGIN_ROUTE });
  assert.equal(loggedOut.storeBadges, true, "store badges must show on the signed-out login screen");
  assert.equal(loggedOut.versionStamp, true, "version stamp must show on the signed-out login screen");

  // Signed-in, on the Help page (#/help) → both shown (Help is the app-download / info surface).
  const help = footerVisibility({ signedIn: true, route: HELP_ROUTE });
  assert.equal(help.storeBadges, true, "store badges must show on #/help when signed in");
  assert.equal(help.versionStamp, true, "version stamp must show on #/help when signed in");

  // Signed-out AND on Help (defensive) → still both shown.
  const helpOut = footerVisibility({ signedIn: false, route: HELP_ROUTE });
  assert.equal(helpOut.storeBadges, true);
  assert.equal(helpOut.versionStamp, true);

  // Every OTHER signed-in screen → both HIDDEN (Home, Events, Chat, Profile, and all Admin screens).
  const hiddenRoutes = [
    HOME_ROUTE,
    "#/events",
    "#/events/42",
    "#/chat",
    "#/chat/7",
    PROFILE_ROUTE,
    "#/profile/public",
    "#/admin",
    "#/admin/users",
    "#/admin/events",
    "#/admin/venues",
    "#/admin/interests",
    "#/admin/cities",
    "#/admin/messages",
    "#/admin/notifications",
    "#/admin/ops",
    "#/notifications",
  ];
  for (const route of hiddenRoutes) {
    const v = footerVisibility({ signedIn: true, route });
    assert.equal(v.storeBadges, false, `store badges must be HIDDEN when signed in on ${route}`);
    assert.equal(v.versionStamp, false, `version stamp must be HIDDEN when signed in on ${route}`);
  }
});

test("AC (TM-1177): store badges and version stamp share the SAME visibility rule", () => {
  // They're driven by one appMarketing flag, so they must always agree — pin that so a future edit
  // can't accidentally diverge them.
  for (const signedIn of [true, false]) {
    for (const route of [LOGIN_ROUTE, HOME_ROUTE, HELP_ROUTE, "#/events", "#/admin", PROFILE_ROUTE]) {
      const v = footerVisibility({ signedIn, route });
      assert.equal(
        v.storeBadges,
        v.versionStamp,
        `badges/stamp must agree for signedIn=${signedIn} route=${route}`,
      );
    }
  }
});

test("footerVisibility is defensive against missing state", () => {
  // No args → treated as logged out (the safe default: the pre-auth login footer).
  const out = footerVisibility();
  assert.equal(out.serviceStatus, true);
  assert.equal(out.phonePrivacy, true);
  assert.equal(out.byline, true);
  // Logged-out is the app-marketing state, so the badges + stamp default to shown too (TM-1177).
  assert.equal(out.storeBadges, true);
  assert.equal(out.versionStamp, true);
});

test("AC: the build stamp LABELS which SHA is web vs backend", () => {
  // Before the backend answers (web only): labelled as the WEB build, not a bare hash.
  assert.equal(formatBuildStamp({ webSha: "08c87f9" }), "web 08c87f9");

  // Web and backend deployed from the same commit → collapse to ONE unlabelled SHA (one describes
  // both surfaces), carrying the revision suffix.
  assert.equal(
    formatBuildStamp({ webSha: "08c87f9", apiSha: "08c87f9", revSuffix: " · r00219" }),
    "08c87f9 · r00219",
  );

  // Web and backend DRIFTED → split and LABEL each surface so the stale one is obvious.
  assert.equal(
    formatBuildStamp({ webSha: "08c87f9", apiSha: "a1b2c3d", revSuffix: " · r00219" }),
    "web 08c87f9 · backend a1b2c3d · r00219",
  );
  // The split output names both surfaces explicitly.
  const split = formatBuildStamp({ webSha: "08c87f9", apiSha: "a1b2c3d" });
  assert.ok(split.includes(BUILD_STAMP_LABELS.web), "split stamp must label the web build");
  assert.ok(split.includes(BUILD_STAMP_LABELS.api), "split stamp must label the backend build");
  assert.equal(BUILD_STAMP_LABELS.api, "backend");
});
