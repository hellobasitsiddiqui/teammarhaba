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
  composeErrorsToShow,
  routeOptionsFrom,
  humanizeRoute,
  summariseBroadcast,
  maskPhone,
  uidPrefix,
  displayIdentifier,
  contactCell,
  searchHaystack,
  USERS_PAGE_SIZE,
  MAX_USER_FETCH_PAGES,
  fetchAllUsers,
  selectionCapMessage,
  coverageNote,
  isPushEligible,
  pushStatusLabel,
  eligibleRecipients,
  PUSH_INELIGIBLE_HINT,
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

// --- composeErrorsToShow: the pristine-panel display gate (TM-976 / QA-roam A8) --------------

const UNTOUCHED = { title: false, body: false, recipients: false };

test("A8 regression: a pristine, untouched panel shows NO errors even though validateBroadcast reports them", () => {
  // validateBroadcast on an empty draft DOES report all three required errors (that's the Send-gate)...
  const v = validateBroadcast({ title: "", body: "", selectionSize: 0 });
  assert.match(v.title, /required/i);
  assert.match(v.body, /required/i);
  assert.match(v.recipients, /select at least one/i);
  // ...but the DISPLAY gate must strip them all while nothing is touched (the bug was showing them).
  const show = composeErrorsToShow(v, UNTOUCHED);
  assert.equal(show.title, "");
  assert.equal(show.body, "");
  assert.equal(show.recipients, "");
});

test("a field's error surfaces only once that field is touched", () => {
  const v = validateBroadcast({ title: "", body: "", selectionSize: 1 });
  assert.equal(composeErrorsToShow(v, { ...UNTOUCHED }).title, "", "untouched title stays quiet");
  const show = composeErrorsToShow(v, { ...UNTOUCHED, title: true });
  assert.match(show.title, /required/i, "touched-but-empty title shows its error");
  assert.equal(show.body, "", "untouched body still quiet");
});

test("the recipient error surfaces once the admin has ENGAGED any field (composing intent)", () => {
  const v = validateBroadcast({ title: "Hi", body: "Body", selectionSize: 0 });
  assert.equal(composeErrorsToShow(v, UNTOUCHED).recipients, "", "pristine → no recipient nag");
  assert.match(composeErrorsToShow(v, { ...UNTOUCHED, title: true }).recipients, /select at least one/i,
    "typing a title reveals the 'pick a recipient' guidance");
  assert.match(composeErrorsToShow(v, { ...UNTOUCHED, recipients: true }).recipients, /select at least one/i,
    "interacting with the list then clearing it also reveals it");
});

test("touched + valid → no error (the gate never invents an error)", () => {
  const v = validateBroadcast({ title: "Hi", body: "Body", selectionSize: 2 });
  const show = composeErrorsToShow(v, { title: true, body: true, recipients: true });
  assert.equal(show.title, "");
  assert.equal(show.body, "");
  assert.equal(show.recipients, "");
});

test("composeErrorsToShow tolerates missing args without throwing", () => {
  assert.deepEqual(composeErrorsToShow(), { title: "", body: "", recipients: "" });
  assert.deepEqual(composeErrorsToShow({ title: "x" }), { title: "", body: "", recipients: "" });
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

// --- humanizeRoute: the friendly fallback for an unlabeled route (TM-617) ---------------------

test("humanizeRoute turns a raw hash token into a sentence-cased label", () => {
  // The core fix: an unmapped route must read as words, not a "#/…" token, in the picker.
  assert.equal(humanizeRoute("#/event-detail"), "Event detail");
  assert.equal(humanizeRoute("#/home"), "Home");
});

test("humanizeRoute treats /, - and _ as word breaks and collapses whitespace", () => {
  assert.equal(humanizeRoute("#/events/detail"), "Events detail");
  assert.equal(humanizeRoute("#/my_saved-events"), "My saved events");
});

test("humanizeRoute never returns a raw token or a blank string for degenerate input", () => {
  // "#/", empty and non-string all land on the app's default label — never a token, never blank.
  assert.equal(humanizeRoute("#/"), "App home");
  assert.equal(humanizeRoute(""), "App home");
  assert.equal(humanizeRoute(null), "App home");
  assert.equal(humanizeRoute(undefined), "App home");
});

test("humanizeRoute tolerates a token missing the leading hash or slash", () => {
  assert.equal(humanizeRoute("events"), "Events");
  assert.equal(humanizeRoute("/profile"), "Profile");
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

// --- fetchAllUsers: the full-account-set page walk (TM-370) ------------------------------------
//
// The bug: the console fetched ONE page (100 accounts) and select-all silently operated over only
// those. These tests drive the walk with a fake page fetcher and assert it exhausts the endpoint,
// reports the true total, survives mid-walk failures as PARTIAL (never silent), and never loops.

/** Rows `from..to` inclusive, as minimal admin-list items keyed by id (selection is by id, TM-358). */
function rows(from, to) {
  const out = [];
  for (let id = from; id <= to; id += 1) out.push({ id });
  return out;
}

/** A fake pager over `all` rows serving the server's envelope shape, recording each call. */
function fakePager(all, { envelope = (x) => x } = {}) {
  const calls = [];
  const fetchPage = async (page, size) => {
    calls.push([page, size]);
    const items = all.slice(page * size, page * size + size);
    return envelope({ items, page, size, totalElements: all.length, totalPages: Math.ceil(all.length / size) });
  };
  return { calls, fetchPage };
}

test("the page-walk defaults mirror the server: 100/page (MAX_PAGE_SIZE), bounded pages", () => {
  assert.equal(USERS_PAGE_SIZE, 100);
  assert.ok(MAX_USER_FETCH_PAGES >= 10); // ceiling stays comfortably above the current scale
});

test("fetchAllUsers walks every page and returns the WHOLE set, in order, complete", async () => {
  // 250 accounts at 100/page — the exact >100 shape the bug silently truncated to page one.
  const { calls, fetchPage } = fakePager(rows(1, 250));
  const r = await fetchAllUsers(fetchPage, { pageSize: 100 });
  assert.equal(r.users.length, 250);
  assert.equal(r.users[0].id, 1);
  assert.equal(r.users[249].id, 250);
  assert.equal(r.total, 250);
  assert.equal(r.complete, true);
  assert.deepEqual(calls, [[0, 100], [1, 100], [2, 100]]);
});

test("fetchAllUsers stops after one request when the first page is short (≤100 accounts)", async () => {
  const { calls, fetchPage } = fakePager(rows(1, 40));
  const r = await fetchAllUsers(fetchPage, { pageSize: 100 });
  assert.equal(r.users.length, 40);
  assert.equal(r.complete, true);
  assert.deepEqual(calls, [[0, 100]]); // the pre-TM-370 cost for a small base: unchanged, one call
});

test("fetchAllUsers trusts the server's totalPages — no wasted empty request on an exact multiple", async () => {
  const { calls, fetchPage } = fakePager(rows(1, 200)); // 200 = exactly 2 full pages
  const r = await fetchAllUsers(fetchPage, { pageSize: 100 });
  assert.equal(r.users.length, 200);
  assert.equal(r.complete, true);
  assert.deepEqual(calls, [[0, 100], [1, 100]]); // not a third fetch for an empty page 2
});

test("fetchAllUsers falls back to short-page detection when the envelope has no metadata", async () => {
  const { calls, fetchPage } = fakePager(rows(1, 5), {
    envelope: ({ items }) => ({ items }), // no totalElements / totalPages at all
  });
  const r = await fetchAllUsers(fetchPage, { pageSize: 2 });
  assert.equal(r.users.length, 5);
  assert.equal(r.total, 5); // derived from what was fetched
  assert.equal(r.complete, true);
  assert.deepEqual(calls, [[0, 2], [1, 2], [2, 2]]); // last page short (1 row) ends the walk
});

test("fetchAllUsers on an empty account list is complete with zero users", async () => {
  // Spring reports totalPages 0 for an empty result — must not be treated as 'more to fetch'.
  const { calls, fetchPage } = fakePager([]);
  const r = await fetchAllUsers(fetchPage, { pageSize: 100 });
  assert.deepEqual(r, { users: [], total: 0, complete: true });
  assert.equal(calls.length, 1);
});

test("fetchAllUsers de-dupes a row that slides across a page boundary mid-walk", async () => {
  // A deletion between requests shifts rows down: page 1 re-serves id 3. Selection is by id, so a
  // duplicate row would double-render; the walk must keep the first sighting only.
  const pages = [
    { items: rows(1, 3), totalElements: 5, totalPages: 2 },
    { items: [{ id: 3 }, { id: 4 }, { id: 5 }], totalElements: 5, totalPages: 2 },
  ];
  const r = await fetchAllUsers(async (page) => pages[page], { pageSize: 3 });
  assert.deepEqual(r.users.map((u) => u.id), [1, 2, 3, 4, 5]);
  assert.equal(r.complete, true);
});

test("fetchAllUsers rethrows a FIRST-page failure — nothing loaded is a real load error", async () => {
  const boom = new Error("403");
  await assert.rejects(
    () => fetchAllUsers(async () => { throw boom; }),
    (err) => err === boom, // the caller's typed ApiError must arrive intact for its 403 copy
  );
});

test("fetchAllUsers keeps the loaded pages and flags PARTIAL when a later page fails", async () => {
  const fetchPage = async (page, size) => {
    if (page >= 1) throw new Error("blip");
    return { items: rows(1, size), totalElements: 9, totalPages: 3 };
  };
  const r = await fetchAllUsers(fetchPage, { pageSize: 3 });
  assert.deepEqual(r.users.map((u) => u.id), [1, 2, 3]); // what loaded survives
  assert.equal(r.total, 9); // the server total still reported — the warning can say "3 of 9"
  assert.equal(r.complete, false); // never silently pretend coverage is whole
});

test("fetchAllUsers never loops: the runaway page guard trips and reports partial", async () => {
  // A pathological server that always claims more pages must not hang the console.
  const { calls, fetchPage } = fakePager(rows(1, 1000));
  const r = await fetchAllUsers(fetchPage, { pageSize: 10, maxPages: 3 });
  assert.equal(calls.length, 3);
  assert.equal(r.users.length, 30);
  assert.equal(r.total, 1000); // the true total still surfaces for the coverage warning
  assert.equal(r.complete, false);
});

test("fetchAllUsers tolerates a garbage envelope without throwing (treated as an empty last page)", async () => {
  const r = await fetchAllUsers(async () => ({ nonsense: true }), { pageSize: 100 });
  assert.deepEqual(r, { users: [], total: 0, complete: true });
});

// --- selectionCapMessage: the honest MAX_RECIPIENTS warning (TM-370) ---------------------------

test("selectionCapMessage is silent at and below the recipient cap", () => {
  assert.equal(selectionCapMessage(0), "");
  assert.equal(selectionCapMessage(3), "");
  assert.equal(selectionCapMessage(MAX_RECIPIENTS), ""); // exactly at the cap is sendable
});

test("selectionCapMessage names the count and the cap once the selection exceeds it", () => {
  const msg = selectionCapMessage(MAX_RECIPIENTS + 112);
  assert.ok(msg.includes(`${MAX_RECIPIENTS + 112} selected`));
  assert.ok(msg.includes(`at most ${MAX_RECIPIENTS} recipients`));
});

test("selectionCapMessage tolerates garbage input as zero", () => {
  assert.equal(selectionCapMessage(undefined), "");
  assert.equal(selectionCapMessage("not a number"), "");
});

// --- coverageNote: the partial-fetch warning copy (TM-370) -------------------------------------

test("coverageNote states loaded vs the true total, and that select-all covers only the loaded", () => {
  const note = coverageNote(300, 612);
  assert.ok(note.includes("300 of 612"));
  assert.match(note, /select all matching/i);
  assert.match(note, /refresh/i);
});

test("coverageNote degrades honestly when the true total is unknown", () => {
  const note = coverageNote(500, 500); // partial fetch but no bigger server total learned
  assert.match(note, /first 500/);
  assert.match(note, /more may exist/i);
});

test("coverageNote never reports a total smaller than what is loaded", () => {
  assert.ok(coverageNote(50, 10).includes("first 50")); // clamped, not "50 of 10"
});

// --- push-eligibility guard (TM-427): only reachable users can be selected -----------------------
//
// The bug: an admin could pick a user who couldn't receive push (push off, or no device) and the
// broadcast was silently lost. The backend now sends a per-user `pushEligible` flag; these guard the
// UI's "can this user be selected as a recipient?" decision (the DOM wiring in admin.js is thin over
// them: disabled checkboxes, eligible-only select-all, and the "Push"/"No push" badge).

test("isPushEligible is true ONLY for an explicit pushEligible === true", () => {
  assert.equal(isPushEligible({ pushEligible: true }), true);
  assert.equal(isPushEligible({ pushEligible: false }), false);
});

test("isPushEligible fails safe for a missing/absent or non-boolean flag", () => {
  // A row from an older payload (no field), or a truthy-but-not-true value, must NOT be selectable.
  assert.equal(isPushEligible({}), false);
  assert.equal(isPushEligible(), false);
  assert.equal(isPushEligible({ pushEligible: "true" }), false);
  assert.equal(isPushEligible({ pushEligible: 1 }), false);
  assert.equal(isPushEligible(null), false);
});

test("pushStatusLabel reads 'Push' when reachable and 'No push' when not", () => {
  assert.equal(pushStatusLabel({ pushEligible: true }), "Push");
  assert.equal(pushStatusLabel({ pushEligible: false }), "No push");
  assert.equal(pushStatusLabel({}), "No push");
});

test("eligibleRecipients keeps only reachable users, in order", () => {
  const users = [
    { id: 1, pushEligible: true },
    { id: 2, pushEligible: false }, // opted out or no device — excluded
    { id: 3, pushEligible: true },
    { id: 4 }, // no flag — excluded (fail safe)
  ];
  assert.deepEqual(eligibleRecipients(users).map((u) => u.id), [1, 3]);
});

test("eligibleRecipients tolerates non-array input without throwing", () => {
  assert.deepEqual(eligibleRecipients(null), []);
  assert.deepEqual(eligibleRecipients(undefined), []);
  assert.deepEqual(eligibleRecipients("nope"), []);
});

test("PUSH_INELIGIBLE_HINT is a non-empty explanation mentioning push", () => {
  assert.equal(typeof PUSH_INELIGIBLE_HINT, "string");
  assert.match(PUSH_INELIGIBLE_HINT, /push/i);
});
