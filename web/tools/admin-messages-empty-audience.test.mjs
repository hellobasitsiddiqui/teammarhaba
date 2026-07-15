// P2 characterization tests (TM-762, part of the TM-738 coverage audit) for the admin-compose core's
// EMPTY / not-yet-chosen audience boundaries — the "compose blocks send when the audience is empty"
// family (targetedMessageComposeBlocksSendWhenAudienceEmpty).
//
// The sibling admin-messages-core.test.mjs already asserts the happy validation paths and the single
// user-empty describe case; this file fills the empty-audience corners it leaves open, so the pure copy
// helpers (describeAudience / confirmCopy / resolvedRecipientCount / isLargeAudience) are pinned for the
// blank-city, no-events and no-target-chosen states too — the states a half-filled compose form sits in
// before Send is allowed. All assert EXISTING behaviour (no source change) and run on the PR gate via
// `node --test web/tools/*.test.mjs`.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  validateAdminMessage,
  describeAudience,
  confirmCopy,
  resolvedRecipientCount,
  isLargeAudience,
} from "../src/assets/admin-messages-core.js";

// The same baseline the sibling file uses (a valid user draft) — each test empties one audience.
const base = () => ({
  title: "Heads up",
  body: "The venue changed for tonight.",
  deepLink: "",
  targetType: "user",
  userIds: [7],
  city: "",
  eventIds: [],
});

// --- Send is blocked for an empty audience in EVERY dimension ----------------------------------
// The sibling file asserts each of these audience errors individually; here we pin the *whole*
// validation result (canSend:false with an otherwise-clean title/body) so the "empty audience ⇒ can't
// Send" invariant is locked as a unit for all three target types, not just as a per-dimension string.

test("an empty USER audience blocks Send but leaves title/body clean", () => {
  const v = validateAdminMessage({ ...base(), userIds: [] });
  assert.equal(v.canSend, false);
  assert.equal(v.audience, "Pick at least one recipient.");
  assert.equal(v.title, "");
  assert.equal(v.body, "");
});

test("a blank CITY audience blocks Send", () => {
  const v = validateAdminMessage({ ...base(), targetType: "city", userIds: [], city: "   " });
  assert.equal(v.canSend, false);
  assert.equal(v.audience, "Enter a city to send to.");
});

test("an empty EVENT audience blocks Send", () => {
  const v = validateAdminMessage({ ...base(), targetType: "event", userIds: [], eventIds: [] });
  assert.equal(v.canSend, false);
  assert.equal(v.audience, "Pick at least one event.");
});

test("no target type chosen at all blocks Send", () => {
  const v = validateAdminMessage({ ...base(), targetType: undefined, userIds: [] });
  assert.equal(v.canSend, false);
  assert.equal(v.audience, "Choose who to send to.");
});

// --- describeAudience is the empty string for every empty dimension ----------------------------
// The sibling file only pins the user-empty case ("" for zero userIds). City (blank city) and event
// (zero eventIds) also collapse to "", as does an unknown/absent target — so the compose summary line
// renders nothing (not a stray "everyone in " / "the attendees of 0 events") while the form is empty.

test("describeAudience is empty for a blank city, empty events, and no target", () => {
  assert.equal(describeAudience({ ...base(), targetType: "city", userIds: [], city: "   " }), "");
  assert.equal(describeAudience({ ...base(), targetType: "event", userIds: [], eventIds: [] }), "");
  assert.equal(describeAudience({ ...base(), targetType: "nope", userIds: [] }), "");
});

// --- resolvedRecipientCount + isLargeAudience for the empty edges ------------------------------
// A no-/unknown-target draft has no client-knowable count (null, same as city/event), and an empty
// KNOWN user audience is 0 recipients — which is a small (non-large) audience, so it never trips the
// heightened large-audience confirm even though it can't actually Send.

test("resolvedRecipientCount is 0 for an empty user draft and null for an unknown target", () => {
  assert.equal(resolvedRecipientCount({ ...base(), userIds: [] }), 0);
  assert.equal(resolvedRecipientCount({ ...base(), targetType: "nope" }), null);
});

test("an empty user audience is not treated as a large audience", () => {
  assert.equal(isLargeAudience({ ...base(), userIds: [] }), false);
});

// --- confirmCopy falls back gracefully when the audience is unknown AND undescribable ----------
// A city target whose city is still blank has an unknown count (null) and an empty description; the
// confirm copy must not read "delivered to ." — it falls back to "the resolved audience" and still
// carries the "resolved at send time" warning + the irreversibility note.

test("confirmCopy uses the 'resolved audience' fallback when the audience can't be described", () => {
  const copy = confirmCopy({ ...base(), targetType: "city", userIds: [], city: "" });
  assert.match(copy, /the resolved audience/);
  assert.match(copy, /calculated when you send/);
  assert.match(copy, /can't be undone/);
  // The fallback must not leave a dangling "delivered to ." with an empty who.
  assert.doesNotMatch(copy, /delivered to \./);
});
