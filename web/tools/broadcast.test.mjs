// Tests for the admin broadcast-compose logic (TM-365). Framework-free — Node's built-in test runner,
// the same harness as account-badges.test.mjs / push-deeplink.test.mjs, picked up by the CI glob
// `node --test web/tools/*.test.mjs`.
//
// These guard the PURE core of the compose UI (broadcast.js): the Send-gate validation (mirroring the
// backend DTO caps), the deep-link picker's defensive parse of the push-routes response, and the honest
// result summariser. The DOM wiring in admin.js is a thin layer over these, so testing them here tests
// the behaviour that matters without needing a browser / the Firebase SDK.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_TITLE,
  MAX_BODY,
  MAX_RECIPIENTS,
  NO_ROUTE,
  validateBroadcast,
  routeOptionsFrom,
  summariseBroadcast,
} from "../src/assets/broadcast.js";

// --- caps mirror the backend DTO (BroadcastPushRequest) --------------------------------------

test("length caps mirror the backend DTO", () => {
  assert.equal(MAX_TITLE, 200);
  assert.equal(MAX_BODY, 1000);
  assert.equal(MAX_RECIPIENTS, 500);
  assert.equal(NO_ROUTE, "");
});

// --- validateBroadcast: the Send-gate --------------------------------------------------------

test("a valid draft with recipients can send, no errors", () => {
  const r = validateBroadcast({ title: "Hi", body: "There is a meetup tonight.", selectionSize: 3 });
  assert.equal(r.canSend, true);
  assert.equal(r.title, "");
  assert.equal(r.body, "");
  assert.equal(r.recipients, "");
});

test("empty title and body are required errors, and block send", () => {
  const r = validateBroadcast({ title: "  ", body: "", selectionSize: 1 });
  assert.equal(r.canSend, false);
  assert.match(r.title, /required/i);
  assert.match(r.body, /required/i);
});

test("empty recipient selection blocks send with a clear hint", () => {
  const r = validateBroadcast({ title: "Hi", body: "Body", selectionSize: 0 });
  assert.equal(r.canSend, false);
  assert.match(r.recipients, /at least one/i);
});

test("title over the cap is rejected with the 'N characters or fewer' message", () => {
  const r = validateBroadcast({ title: "x".repeat(MAX_TITLE + 1), body: "Body", selectionSize: 1 });
  assert.equal(r.canSend, false);
  assert.equal(r.title, `Must be ${MAX_TITLE} characters or fewer.`);
});

test("title exactly at the cap is allowed", () => {
  const r = validateBroadcast({ title: "x".repeat(MAX_TITLE), body: "Body", selectionSize: 1 });
  assert.equal(r.title, "");
  assert.equal(r.canSend, true);
});

test("body over the cap is rejected", () => {
  const r = validateBroadcast({ title: "Hi", body: "y".repeat(MAX_BODY + 1), selectionSize: 1 });
  assert.equal(r.body, `Must be ${MAX_BODY} characters or fewer.`);
  assert.equal(r.canSend, false);
});

test("more recipients than the cap is rejected", () => {
  const r = validateBroadcast({ title: "Hi", body: "Body", selectionSize: MAX_RECIPIENTS + 1 });
  assert.equal(r.canSend, false);
  assert.match(r.recipients, new RegExp(`at most ${MAX_RECIPIENTS}`));
});

test("recipients exactly at the cap is allowed", () => {
  const r = validateBroadcast({ title: "Hi", body: "Body", selectionSize: MAX_RECIPIENTS });
  assert.equal(r.recipients, "");
  assert.equal(r.canSend, true);
});

test("whitespace-only title/body count as blank (server @NotBlank parity)", () => {
  const r = validateBroadcast({ title: "\t \n", body: "   ", selectionSize: 2 });
  assert.match(r.title, /required/i);
  assert.match(r.body, /required/i);
});

test("tolerates missing/garbage input without throwing", () => {
  assert.equal(validateBroadcast().canSend, false);
  assert.equal(validateBroadcast({}).canSend, false);
  assert.equal(validateBroadcast({ selectionSize: "3" }).recipients, "");
});

// --- routeOptionsFrom: defensive parse of the push-routes response ---------------------------

test("routeOptionsFrom returns the server routes, trimmed + de-duped + sorted", () => {
  const out = routeOptionsFrom({ routes: ["#/profile", "#/home", " #/home ", "#/admin"] });
  assert.deepEqual(out, ["#/admin", "#/home", "#/profile"]);
});

test("routeOptionsFrom falls back to the client list on a missing/empty body", () => {
  const fallback = ["#/home", "#/admin"];
  assert.deepEqual(routeOptionsFrom(null, fallback), ["#/admin", "#/home"]);
  assert.deepEqual(routeOptionsFrom({}, fallback), ["#/admin", "#/home"]);
  assert.deepEqual(routeOptionsFrom({ routes: [] }, fallback), ["#/admin", "#/home"]);
});

test("routeOptionsFrom ignores non-string / blank entries", () => {
  const out = routeOptionsFrom({ routes: ["#/home", 42, null, "", "  ", "#/help"] });
  assert.deepEqual(out, ["#/help", "#/home"]);
});

test("routeOptionsFrom with neither payload nor fallback is an empty list (never throws)", () => {
  assert.deepEqual(routeOptionsFrom(undefined), []);
});

// --- summariseBroadcast: the honest result line ----------------------------------------------

test("summariseBroadcast reads sent / delivered / skipped from the response", () => {
  // No reason rails set → the whole skipped count is the residual "no device" (TM-365 M1).
  const s = summariseBroadcast({ requested: 15, sent: 12, skipped: 3, targeted: 20, delivered: 18, pruned: 1, failed: 1 });
  assert.equal(s, "Sent to 12 users · 18 devices delivered · 3 skipped (3 no device)");
});

test("summariseBroadcast omits the skipped clause when nothing was skipped", () => {
  const s = summariseBroadcast({ sent: 5, skipped: 0, delivered: 9 });
  assert.equal(s, "Sent to 5 users · 9 devices delivered");
});

test("summariseBroadcast pluralises correctly for singular counts", () => {
  const s = summariseBroadcast({ sent: 1, skipped: 0, delivered: 1 });
  assert.equal(s, "Sent to 1 user · 1 device delivered");
});

test("summariseBroadcast tolerates a missing/empty response (all zeros)", () => {
  assert.equal(summariseBroadcast(), "Sent to 0 users · 0 devices delivered");
  assert.equal(summariseBroadcast({}), "Sent to 0 users · 0 devices delivered");
});

// --- summariseBroadcast: the honest skip breakdown (TM-365 review M1) -------------------------

test("summariseBroadcast reports an opted-out skip distinctly (not as 'no device')", () => {
  // The e2e's scenario: 2 sent, 0 delivered (no FCM in CI), 1 skipped — and that 1 is an opt-out.
  const s = summariseBroadcast({ sent: 2, skipped: 1, delivered: 0, skippedOptedOut: 1 });
  assert.equal(s, "Sent to 2 users · 0 devices delivered · 1 skipped (1 opted out)");
});

test("summariseBroadcast reports a disabled-account skip distinctly", () => {
  const s = summariseBroadcast({ sent: 4, skipped: 2, delivered: 6, skippedDisabled: 2 });
  assert.equal(s, "Sent to 4 users · 6 devices delivered · 2 skipped (2 disabled)");
});

test("summariseBroadcast reports a not-found skip distinctly", () => {
  const s = summariseBroadcast({ sent: 3, skipped: 1, delivered: 5, skippedNotFound: 1 });
  assert.equal(s, "Sent to 3 users · 5 devices delivered · 1 skipped (1 not found)");
});

test("summariseBroadcast derives 'no device' as the residual after the named rails", () => {
  // 5 skipped: 2 opted out + 1 disabled + 1 not found accounted for → 1 left over = no device.
  const s = summariseBroadcast({
    sent: 10, skipped: 5, delivered: 12,
    skippedOptedOut: 2, skippedDisabled: 1, skippedNotFound: 1,
  });
  assert.equal(s, "Sent to 10 users · 12 devices delivered · 5 skipped (2 opted out, 1 no device, 1 disabled, 1 not found)");
});

test("summariseBroadcast lists only the non-zero skip reasons", () => {
  // opted-out + no-device present, disabled/not-found zero → only the two non-zero reasons show.
  const s = summariseBroadcast({ sent: 8, skipped: 5, delivered: 9, skippedOptedOut: 3, skippedDisabled: 0, skippedNotFound: 0 });
  assert.equal(s, "Sent to 8 users · 9 devices delivered · 5 skipped (3 opted out, 2 no device)");
});

test("summariseBroadcast never shows a negative 'no device' if the rails over-count", () => {
  // Defensive: if the rails somehow sum to more than `skipped`, the residual clamps to 0 (no negative,
  // no phantom "no device") — the named reasons still show.
  const s = summariseBroadcast({ sent: 1, skipped: 1, delivered: 0, skippedOptedOut: 1, skippedDisabled: 1 });
  assert.equal(s, "Sent to 1 user · 0 devices delivered · 1 skipped (1 opted out, 1 disabled)");
});
