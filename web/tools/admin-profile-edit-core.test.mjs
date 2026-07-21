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
  validateAdminField,
  validateAdminForm,
  buildAdminProfilePatch,
} from "../src/assets/admin-profile-edit-core.js";

const field = (key) => ADMIN_PROFILE_FIELDS.find((f) => f.key === key);

test("ADMIN_PROFILE_FIELDS is exactly the TM-162 admin-editable set (no identity/role/enabled/theme/interests)", () => {
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
