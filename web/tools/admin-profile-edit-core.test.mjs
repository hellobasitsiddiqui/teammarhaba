// Unit tests for the admin user-detail PROFILE edit core (TM-172). Framework-free — Node's built-in
// test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// WHY THIS EXISTS: TM-172 adds an admin edit of ANOTHER user's profile fields. The hard requirement is
// that the admin edit REUSES the SAME validation as the user's own self-edit (no looser fork). These
// pin that: the admin validators delegate to the shared profile-core rules (off-list city, out-of-band
// age, bad phone, numeric name all reject), the off-list-city / grandfathered-age allowances carry
// over, and the patch builder only sends the fields that actually changed (partial PATCH).

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ADMIN_PROFILE_FIELDS,
  EDITABLE_ADMIN_PROFILE_FIELDS,
  validateAdminField,
  validateAdminForm,
  buildAdminProfilePatch,
} from "../src/assets/admin-profile-edit-core.js";

const field = (key) => ADMIN_PROFILE_FIELDS.find((f) => f.key === key);

test("ADMIN_PROFILE_FIELDS is the TM-162 display set (notificationPref still SHOWN read-only, TM-1109)", () => {
  const keys = ADMIN_PROFILE_FIELDS.map((f) => f.key);
  assert.deepEqual(keys, [
    "firstName",
    "lastName",
    "city",
    "age",
    "phone",
    "notificationPref",
    "timezone",
    "locale",
  ]);
});

test("notificationPref is marked read-only in the display field list (TM-1109)", () => {
  assert.equal(field("notificationPref").readOnly, true);
  // No other field is read-only — the rest stay editable.
  for (const f of ADMIN_PROFILE_FIELDS) {
    if (f.key !== "notificationPref") assert.notEqual(f.readOnly, true, `${f.key} must stay editable`);
  }
});

test("EDITABLE_ADMIN_PROFILE_FIELDS EXCLUDES notificationPref — the admin can't edit it (TM-1109)", () => {
  const editableKeys = EDITABLE_ADMIN_PROFILE_FIELDS.map((f) => f.key);
  assert.deepEqual(editableKeys, [
    "firstName",
    "lastName",
    "city",
    "age",
    "phone",
    "timezone",
    "locale",
  ]);
  assert.ok(!editableKeys.includes("notificationPref"), "notificationPref must not be an editable field");
});

test("validateAdminField reuses the shared rules: off-list city rejects, allow-list + blank pass", () => {
  assert.notEqual(validateAdminField(field("city"), "Dubai", {}), ""); // off-list → error
  assert.equal(validateAdminField(field("city"), "London", {}), ""); // allow-list → ok
  assert.equal(validateAdminField(field("city"), "", {}), ""); // blank = leave unchanged → ok
});

test("validateAdminField keeps a target's already-saved OFF-LIST city valid (TM-877 allowance)", () => {
  // A user saved "Dubai" before the list existed; an admin editing another field must not be forced to
  // change it — re-selecting the saved off-list value passes, exactly as the self-edit allows.
  assert.equal(validateAdminField(field("city"), "Dubai", { city: "Dubai" }), "");
});

test("validateAdminField ACCEPTS a city in the passed-in offeredNames but NOT in CITY_FALLBACK (TM-1174)", () => {
  // "Marhabaville" is an admin-added catalogue city — absent from the hardcoded fallback four. Before
  // TM-1174 validateAdminField took no offered list and hardcoded the fallback, so this REJECTED
  // (fail-before). With the offeredNames param it passes when supplied the admin-managed catalogue.
  const catalogue = ["London", "Milton Keynes", "Sharjah", "Karachi", "Marhabaville"];
  assert.equal(validateAdminField(field("city"), "Marhabaville", {}, catalogue), "");
  // A city NOT in the offered list is still rejected (the client-side courtesy check still bites).
  assert.notEqual(validateAdminField(field("city"), "Atlantis", {}, catalogue), "");
  // …but the target's already-saved off-list city stays valid even against the fresh catalogue.
  assert.equal(validateAdminField(field("city"), "Dubai", { city: "Dubai" }, catalogue), "");
});

test("validateAdminField city defaults to CITY_FALLBACK when no offeredNames is passed (TM-1174)", () => {
  // Existing callers/tests that pass no offered list keep the pre-catalogue behaviour: the fallback
  // four validate, an off-fallback catalogue-only city rejects (there's no list to say it's offered).
  assert.equal(validateAdminField(field("city"), "London", {}), ""); // fallback city → ok
  assert.notEqual(validateAdminField(field("city"), "Marhabaville", {}), ""); // no offered list → rejected
});

test("validateAdminForm ACCEPTS a catalogue-only city via the offeredNames arg (TM-1174)", () => {
  const catalogue = ["London", "Marhabaville"];
  // Fails-before: without the offeredNames param the whole-form validator hardcoded the fallback, so a
  // catalogue-only city surfaced as a `city` error. With the arg the form is valid.
  const good = validateAdminForm(
    { firstName: "Aisha", lastName: "Khan", city: "Marhabaville", age: "30", phone: "+442079460958", timezone: "Europe/London", locale: "en-GB" },
    {},
    catalogue,
  );
  assert.deepEqual(good, {});
  // And a city off BOTH the catalogue and the saved value still fails.
  const bad = validateAdminForm({ firstName: "Aisha", city: "Atlantis" }, {}, catalogue);
  assert.ok(bad.city);
});

test("validateAdminForm city defaults to CITY_FALLBACK when no offeredNames is passed (TM-1174)", () => {
  // The default keeps existing call sites (and the tests above) working: fallback city passes, an
  // off-fallback city fails when no offered list is supplied.
  assert.deepEqual(validateAdminForm({ firstName: "Aisha", city: "London" }, {}), {});
  assert.ok(validateAdminForm({ firstName: "Aisha", city: "Marhabaville" }, {}).city);
});

test("validateAdminField rejects an out-of-band age but passes a grandfathered UNCHANGED age (TM-884)", () => {
  assert.notEqual(validateAdminField(field("age"), "15", {}), ""); // new value below floor → error
  assert.notEqual(validateAdminField(field("age"), "120", {}), ""); // new value above ceiling → error
  assert.equal(validateAdminField(field("age"), "30", {}), ""); // in-band → ok
  // A saved 15 (grandfathered) re-sent unchanged must pass so the admin can still edit other fields.
  assert.equal(validateAdminField(field("age"), "15", { age: 15 }), "");
});

test("validateAdminField rejects a bad phone and a numeric name, reusing the shared rules", () => {
  assert.notEqual(validateAdminField(field("phone"), "07700900000", {}), ""); // bare national → error
  assert.equal(validateAdminField(field("phone"), "+442079460958", {}), ""); // E.164 → ok
  assert.notEqual(validateAdminField(field("firstName"), "676767", {}), ""); // numeric name → error (TM-771)
  assert.equal(validateAdminField(field("firstName"), "Aisha", {}), ""); // real name → ok
});

test("validateAdminForm returns only the failing fields; empty object means valid", () => {
  const bad = validateAdminForm(
    { firstName: "676767", city: "Dubai", age: "15", phone: "07700", notificationPref: "BOTH" },
    {},
  );
  assert.ok(bad.firstName && bad.city && bad.age && bad.phone);
  assert.equal(bad.notificationPref, undefined); // valid enum value → not in the error map

  const good = validateAdminForm(
    { firstName: "Aisha", lastName: "Khan", city: "London", age: "30", phone: "+442079460958", notificationPref: "EMAIL", timezone: "Europe/London", locale: "en-GB" },
    {},
  );
  assert.deepEqual(good, {});
});

test("buildAdminProfilePatch sends only CHANGED fields (partial PATCH)", () => {
  const saved = { firstName: "Old", lastName: "Name", city: "London", age: 40, phone: "+441234567890", notificationPref: "BOTH", timezone: "Europe/London", locale: "en-GB" };
  const patch = buildAdminProfilePatch(
    { firstName: "New", lastName: "Name", city: "London", age: "40", phone: "+441234567890", notificationPref: "BOTH", timezone: "Europe/London", locale: "en-GB" },
    saved,
  );
  assert.deepEqual(patch, { firstName: "New" }); // only firstName differs
});

test("buildAdminProfilePatch yields an empty object when nothing changed", () => {
  const saved = { firstName: "Same", city: "London", age: 30, notificationPref: "EMAIL" };
  const patch = buildAdminProfilePatch(
    { firstName: "Same", lastName: "", city: "London", age: "30", phone: "", notificationPref: "EMAIL", timezone: "", locale: "" },
    saved,
  );
  assert.deepEqual(patch, {});
});

test("buildAdminProfilePatch coerces age to a Number and only when it changes", () => {
  assert.deepEqual(buildAdminProfilePatch({ age: "31" }, { age: 30 }), { age: 31 });
  assert.equal(typeof buildAdminProfilePatch({ age: "31" }, { age: 30 }).age, "number");
  assert.deepEqual(buildAdminProfilePatch({ age: "30" }, { age: 30 }), {}); // unchanged → omitted
});

test("buildAdminProfilePatch sends an explicit '' to CLEAR a previously-set text field", () => {
  assert.deepEqual(buildAdminProfilePatch({ city: "" }, { city: "London" }), { city: "" });
  // clearing an already-empty field is a no-op (not sent)
  assert.deepEqual(buildAdminProfilePatch({ city: "" }, { city: null }), {});
});

test("buildAdminProfilePatch trims whitespace before comparing (a padded no-op is omitted)", () => {
  assert.deepEqual(buildAdminProfilePatch({ firstName: "  Aisha  " }, { firstName: "Aisha" }), {});
  assert.deepEqual(buildAdminProfilePatch({ firstName: "  Aisha  " }, { firstName: "Old" }), { firstName: "Aisha" });
});

test("buildAdminProfilePatch NEVER sends notificationPref, even when it differs from saved (TM-1109)", () => {
  // The admin form can't produce a pref value (no control), but even if one is injected into the raw
  // values the patch builder must drop it — notificationPref is view-only, so it can never be PATCHed.
  const saved = { notificationPref: "BOTH", firstName: "Aisha" };
  const patch = buildAdminProfilePatch({ notificationPref: "EMAIL", firstName: "Aisha" }, saved);
  assert.deepEqual(patch, {}); // the changed pref is dropped; firstName is unchanged → nothing to send
  assert.equal(patch.notificationPref, undefined);

  // And it stays dropped even when a REAL editable field also changes — the editable change goes
  // through, the pref change does not.
  const mixed = buildAdminProfilePatch({ notificationPref: "PUSH", firstName: "New" }, saved);
  assert.deepEqual(mixed, { firstName: "New" });
  assert.equal(mixed.notificationPref, undefined);
});

test("validateAdminForm NEVER flags notificationPref — it isn't an editable field (TM-1109)", () => {
  // Even a bogus pref value must not surface as a form error (the control doesn't exist to fix it).
  const errors = validateAdminForm({ firstName: "Aisha", notificationPref: "NONSENSE" }, {});
  assert.equal(errors.notificationPref, undefined);
  assert.deepEqual(errors, {}); // firstName is valid, pref is ignored → no errors at all
});
