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
  maskPhone,
  uidPrefix,
  displayIdentifier,
  contactCell,
  searchHaystack,
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

// --- user display identity (TM-372): the no-blank-rows fallback chain -------------------------

// The bug's repro account: phone-auth sign-in, so no email and no display name — previously a
// completely blank, unfindable row in the admin table and the broadcast picker.
const PHONE_ONLY = { id: 42, email: null, displayName: null, phoneNumber: "+16505550100" };

test("maskPhone keeps the prefix and last four, elides the middle", () => {
  assert.equal(maskPhone("+16505550100"), "+1650…0100"); // the ticket's example account
  assert.equal(maskPhone("+447700900123"), "+4477…0123");
});

test("maskPhone leaves a number too short to elide as-is, and is '' for garbage", () => {
  assert.equal(maskPhone("+1650"), "+1650"); // nothing sensible to hide
  assert.equal(maskPhone("  +16505550100  "), "+1650…0100"); // trims first
  assert.equal(maskPhone(""), "");
  assert.equal(maskPhone(null), "");
  assert.equal(maskPhone(16505550100), ""); // numbers are not phone strings on the wire
});

test("uidPrefix truncates a long uid to 8 chars + ellipsis, passes short ones through", () => {
  assert.equal(uidPrefix("jLz3NDaBcDeFgH"), "jLz3NDaB…");
  assert.equal(uidPrefix("shortId"), "shortId");
  assert.equal(uidPrefix(undefined), "");
});

test("displayIdentifier walks the chain: displayName → email → masked phone → uid → User #id", () => {
  const full = { displayName: "Ayesha", email: "a@x.test", phoneNumber: "+16505550100", id: 1 };
  assert.equal(displayIdentifier(full), "Ayesha");
  assert.equal(displayIdentifier({ ...full, displayName: null }), "a@x.test");
  assert.equal(displayIdentifier(PHONE_ONLY), "+1650…0100"); // the TM-372 repro is now identifiable
  assert.equal(displayIdentifier({ firebaseUid: "jLz3NDaBcDeF", id: 7 }), "jLz3NDaB…");
  assert.equal(displayIdentifier({ uid: "jLz3NDaBcDeF", id: 7 }), "jLz3NDaB…"); // either uid key
  assert.equal(displayIdentifier({ id: 7 }), "User #7");
});

test("displayIdentifier never returns blank, and skips whitespace-only links", () => {
  assert.equal(displayIdentifier({}), "Unknown user");
  assert.equal(displayIdentifier(), "Unknown user");
  assert.equal(displayIdentifier({ displayName: "   ", email: "a@x.test" }), "a@x.test");
});

test("contactCell shows the email plainly when there is one", () => {
  assert.deepEqual(contactCell({ email: "a@x.test", id: 1 }), { text: "a@x.test", fallback: false });
});

test("contactCell falls back to the masked phone for a phone-only account", () => {
  assert.deepEqual(contactCell(PHONE_ONLY), { text: "+1650…0100", fallback: true });
  // ...even when the account has a name — the phone is still useful contact info.
  assert.deepEqual(
    contactCell({ displayName: "Ayesha", phoneNumber: "+16505550100", id: 3 }),
    { text: "+1650…0100", fallback: true },
  );
});

test("contactCell uses the uid/id tail only when the row has no name to identify it", () => {
  // Named, no email/phone: the Name cell already identifies the row — "—" beats "User #12" noise.
  assert.deepEqual(contactCell({ displayName: "Ayesha", id: 12 }), { text: "—", fallback: false });
  // Nameless with nothing else: the row MUST still say something.
  assert.deepEqual(contactCell({ id: 12 }), { text: "User #12", fallback: true });
  assert.deepEqual(contactCell({ firebaseUid: "jLz3NDaBcDeF", id: 12 }), { text: "jLz3NDaB…", fallback: true });
});

test("contactCell never yields a blank cell even for an empty object", () => {
  assert.deepEqual(contactCell({}), { text: "—", fallback: false });
});

test("searchHaystack finds a phone-only account by raw digits, masked form, or id", () => {
  const hay = searchHaystack(PHONE_ONLY);
  assert.ok(hay.includes("+16505550100")); // raw: typing "+1650555" or "0100" matches
  assert.ok(hay.includes("+1650…0100")); // masked: pasting the displayed identifier matches
  assert.ok(hay.includes("user #42")); // id: "42" / "#42" find the degraded row
});

test("searchHaystack still matches name and email, lowercased for the search box", () => {
  const hay = searchHaystack({ displayName: "Ayesha Khan", email: "Ayesha@X.Test", id: 2 });
  assert.ok(hay.includes("ayesha khan"));
  assert.ok(hay.includes("ayesha@x.test"));
  assert.equal(searchHaystack({}), "");
});
