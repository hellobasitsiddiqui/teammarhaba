// admin-profile-edit-core.js — pure logic for the admin user-detail PROFILE edit form (TM-172).
//
// The admin console lets an admin edit ANOTHER user's admin-editable profile fields (the TM-162 set:
// names / city / age / phone / notification preference / timezone / locale). This module holds the
// pure, DOM-free pieces so they're unit-testable under `node --test` (admin.js itself can't be
// imported there — it pulls api.js → the Firebase CDN chain).
//
// The whole point (TM-172): REUSE the SAME validation the user's own self-edit uses. So this module
// imports the shared pure validators from profile-core.js — `validateProfileField`, `cityChoiceError`,
// `nameFormatError` — rather than forking a weaker copy. An admin edit therefore can never accept a
// value the user's own edit would reject (off-list city, out-of-band age, bad phone, numeric name).

import { validateProfileField, cityChoiceError, CITY_OPTIONS, NOTIFICATION_PREFS } from "./profile-core.js";

/**
 * The admin-editable profile fields and their client-side rules, mirroring the backend's
 * AdminUpdateProfileRequest bean validation + the shared UserService.applyProfileFields rules — the
 * SAME rule set the self-edit form (profile.js FIELDS) declares. Identity/role/enabled are NOT here
 * (out of scope — governed by the TM-111 endpoints); themeAccent/themeSketchy/interests are also out
 * (the user's own personalisation, not admin-edited).
 * @type {ReadonlyArray<{key:string,label:string,type:string,options?:Array,min?:number,max?:number,maxLength?:number,hint?:string}>}
 */
export const ADMIN_PROFILE_FIELDS = Object.freeze([
  { key: "firstName", label: "First name", type: "text", maxLength: 255, hint: "Letters, spaces, hyphens and apostrophes only." },
  { key: "lastName", label: "Last name", type: "text", maxLength: 255, hint: "Letters, spaces, hyphens and apostrophes only." },
  { key: "city", label: "City", type: "select", options: [["", "Choose a city…"], ...CITY_OPTIONS.map((c) => [c, c])] },
  { key: "age", label: "Age", type: "number", min: 18, max: 99, hint: "Between 18 and 99." },
  { key: "phone", label: "Phone", type: "tel", maxLength: 32, hint: "Full number with country code, e.g. +44 20 7946 0958." },
  {
    key: "notificationPref",
    label: "Notifications",
    type: "select",
    options: [["EMAIL", "Email"], ["PUSH", "Push"], ["BOTH", "Email and push"]],
  },
  { key: "timezone", label: "Time zone", type: "text", maxLength: 64, hint: "IANA name, e.g. Europe/London." },
  { key: "locale", label: "Locale", type: "text", maxLength: 35, hint: "BCP-47 tag, e.g. en-GB." },
]);

/**
 * Validate one admin-edit field's raw value, reusing the SAME shared validators as the self-edit
 * (TM-172). Returns an error message, or "" when acceptable. Empty is always allowed (blank = leave
 * unchanged, matching the backend's partial-PATCH semantics).
 *
 * - `city` → cityChoiceError against the allow-list, PLUS the target's already-saved off-list city is
 *   preserved (kept selectable), exactly like the self-edit — so editing another field never
 *   invalidates a legacy off-list city.
 * - `age` → the target's UNCHANGED saved age passes even if out-of-band (grandfathered, TM-884),
 *   mirroring the self-edit; a NEW value must be in 18–99 (via validateProfileField).
 * - everything else → validateProfileField (names get the name-like rule, phone the E.164 stored-shape
 *   rule, notificationPref the enum, sizes the caps).
 *
 * @param {{key:string,type?:string,min?:number,max?:number,maxLength?:number}} field
 * @param {string} raw the raw input value.
 * @param {object|null|undefined} saved the target user's currently-saved profile (off-list-city + grandfathered-age allowance).
 * @returns {string} an error message, or "".
 */
export function validateAdminField(field, raw, saved) {
  if (field.key === "city") {
    return cityChoiceError(raw, saved ? saved.city : null);
  }
  if (field.key === "age") {
    const v = String(raw ?? "").trim();
    if (v !== "" && saved && saved.age != null && v === String(saved.age)) return "";
  }
  return validateProfileField(field, raw);
}

/**
 * Validate the WHOLE admin-edit form at once (TM-172). Returns a map of `{ [key]: errorMessage }`
 * carrying only the fields that failed — an empty object means the form is valid.
 * @param {Record<string,string>} values raw form values keyed by field key.
 * @param {object|null|undefined} saved the target's saved profile (off-list-city + grandfathered-age allowance).
 * @returns {Record<string,string>} field key → error message, for failing fields only.
 */
export function validateAdminForm(values, saved) {
  const errors = {};
  for (const field of ADMIN_PROFILE_FIELDS) {
    const err = validateAdminField(field, values[field.key], saved);
    if (err) errors[field.key] = err;
  }
  return errors;
}

/**
 * Build the PATCH body for the admin profile edit from raw form values, against the target's saved
 * profile (TM-172). Only CHANGED fields are included — an unchanged or blank-that-was-already-blank
 * field is omitted so the backend leaves it untouched (partial PATCH), and a no-change form yields an
 * empty object (the caller then skips the request entirely). This mirrors the self-edit's collectPatch
 * omission discipline: don't send fields the admin didn't actually change.
 *
 * Normalisation before comparison: text/select values are trimmed; `age` is sent as a Number.
 * A cleared text field (raw "") that had a saved value is sent as "" (explicit clear), which the
 * backend accepts (blank clears). notificationPref is only sent when it differs from saved.
 *
 * @param {Record<string,string>} values raw form values keyed by field key.
 * @param {object|null|undefined} saved the target's saved profile (`/admin/users/{id}`-shaped).
 * @returns {Record<string, string|number>} the minimal PATCH body (may be empty).
 */
export function buildAdminProfilePatch(values, saved) {
  const patch = {};
  const savedProfile = saved || {};
  for (const field of ADMIN_PROFILE_FIELDS) {
    const raw = values[field.key];
    if (raw == null) continue;
    const trimmed = String(raw).trim();
    const savedValue = savedProfile[field.key];

    if (field.key === "age") {
      // Number field: "" = "leave/clear" — only send when the numeric value actually changes. A blank
      // stays omitted (age has no explicit "clear" to null via this form; blank = no change).
      if (trimmed === "") continue;
      const n = Number(trimmed);
      if (!Number.isInteger(n)) continue; // invalid; validation already flags it, never send garbage
      if (savedValue != null && n === Number(savedValue)) continue;
      patch.age = n;
      continue;
    }

    if (field.key === "notificationPref") {
      if (trimmed === "" || !NOTIFICATION_PREFS.has(trimmed)) continue;
      if (trimmed === savedValue) continue;
      patch.notificationPref = trimmed;
      continue;
    }

    // Text/select/tel fields: send when the trimmed value differs from the saved value (treating a
    // null/absent saved value as ""). This sends an explicit "" to clear a previously-set field.
    const savedStr = savedValue == null ? "" : String(savedValue).trim();
    if (trimmed === savedStr) continue;
    patch[field.key] = trimmed;
  }
  return patch;
}
