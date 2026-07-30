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

import { validateProfileField, cityChoiceError, CITY_OPTIONS, CITY_FALLBACK } from "./profile-core.js";

/**
 * The admin PROFILE fields, in display order, and their client-side rules — mirroring the backend's
 * AdminUpdateProfileRequest bean validation + the shared UserService.applyProfileFields rules (the
 * SAME rule set the self-edit form (profile.js FIELDS) declares). Identity/role/enabled are NOT here
 * (out of scope — governed by the TM-111 endpoints); themeAccent/themeSketchy/interests are also out
 * (the user's own personalisation, not admin-edited).
 *
 * A field marked `readOnly: true` is DISPLAY-ONLY: the admin sees its current value in the summary
 * but gets no editable control, and it is never validated or sent in a PATCH. `notificationPref` is
 * read-only for admins (TM-1109) — the notification preference is the user's own personal delivery
 * choice, edited only via their own profile, so the backend refuses an admin change (422). The
 * summary loop uses this full list; the EDITABLE subset (below) drives the form + validation + patch.
 * @type {ReadonlyArray<{key:string,label:string,type:string,readOnly?:boolean,options?:Array,min?:number,max?:number,maxLength?:number,hint?:string}>}
 */
export const ADMIN_PROFILE_FIELDS = Object.freeze([
  { key: "firstName", label: "First name", type: "text", maxLength: 255, hint: "Letters, spaces, hyphens and apostrophes only." },
  { key: "lastName", label: "Last name", type: "text", maxLength: 255, hint: "Letters, spaces, hyphens and apostrophes only." },
  { key: "city", label: "City", type: "select", options: [["", "Choose a city…"], ...CITY_OPTIONS.map((c) => [c, c])] },
  { key: "age", label: "Age", type: "number", min: 18, max: 99, hint: "Between 18 and 99." },
  { key: "phone", label: "Phone", type: "tel", maxLength: 32, hint: "Full number with country code, e.g. +44 20 7946 0958." },
  {
    // TM-1109: VIEW-ONLY for admins. Shown in the read-only summary (so an admin can see the user's
    // current choice) but NOT rendered as an editable control, never validated, never PATCHed — and
    // the backend rejects an attempted change (422). Kept in this list so the summary still displays it.
    key: "notificationPref",
    label: "Notifications",
    type: "select",
    readOnly: true,
    options: [["EMAIL", "Email"], ["PUSH", "Push"], ["BOTH", "Email and push"]],
  },
  { key: "timezone", label: "Time zone", type: "text", maxLength: 64, hint: "IANA name, e.g. Europe/London." },
  { key: "locale", label: "Locale", type: "text", maxLength: 35, hint: "BCP-47 tag, e.g. en-GB." },
]);

/**
 * The admin-EDITABLE subset of {@link ADMIN_PROFILE_FIELDS} — every field an admin may actually change,
 * i.e. all but the `readOnly` ones (TM-1109: notificationPref is view-only). This drives the edit form
 * (buildForm), the whole-form validation and the changed-fields PATCH, so a read-only field can never
 * get an editable control, be validated, or be sent to the server. The display summary keeps using the
 * full list so a read-only field is still SHOWN.
 * @type {ReadonlyArray<{key:string,label:string,type:string,options?:Array,min?:number,max?:number,maxLength?:number,hint?:string}>}
 */
export const EDITABLE_ADMIN_PROFILE_FIELDS = Object.freeze(
  ADMIN_PROFILE_FIELDS.filter((f) => !f.readOnly),
);

/**
 * Validate one admin-edit field's raw value, reusing the SAME shared validators as the self-edit
 * (TM-172). Returns an error message, or "" when acceptable. Empty is always allowed (blank = leave
 * unchanged, matching the backend's partial-PATCH semantics).
 *
 * - `city` → cityChoiceError against the OFFERED list, PLUS the target's already-saved off-list city is
 *   preserved (kept selectable), exactly like the self-edit — so editing another field never
 *   invalidates a legacy off-list city. The offered names are PASSED IN (TM-1174: the admin renderer
 *   supplies the admin-managed catalogue via offeredCityNames()); they default to {@link CITY_FALLBACK}
 *   so existing callers/tests keep the pre-catalogue behaviour and this module stays api.js-free
 *   (node-testable) — it must NOT import city-catalogue.js.
 * - `age` → the target's UNCHANGED saved age passes even if out-of-band (grandfathered, TM-884),
 *   mirroring the self-edit; a NEW value must be in 18–99 (via validateProfileField).
 * - everything else → validateProfileField (names get the name-like rule, phone the E.164 stored-shape
 *   rule, notificationPref the enum, sizes the caps).
 *
 * @param {{key:string,type?:string,min?:number,max?:number,maxLength?:number}} field
 * @param {string} raw the raw input value.
 * @param {object|null|undefined} saved the target user's currently-saved profile (off-list-city + grandfathered-age allowance).
 * @param {ReadonlyArray<string>} [offeredNames] the offered city names to validate against (defaults to {@link CITY_FALLBACK}).
 * @returns {string} an error message, or "".
 */
export function validateAdminField(field, raw, saved, offeredNames = CITY_FALLBACK) {
  if (field.key === "city") {
    return cityChoiceError(raw, saved ? saved.city : null, offeredNames);
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
 * @param {ReadonlyArray<string>} [offeredNames] the offered city names to validate against (defaults to {@link CITY_FALLBACK}, TM-1174).
 * @returns {Record<string,string>} field key → error message, for failing fields only.
 */
export function validateAdminForm(values, saved, offeredNames = CITY_FALLBACK) {
  const errors = {};
  // Only the EDITABLE fields are validated — a read-only field (notificationPref, TM-1109) has no
  // editable control, so it must never be validated or flagged.
  for (const field of EDITABLE_ADMIN_PROFILE_FIELDS) {
    const err = validateAdminField(field, values[field.key], saved, offeredNames);
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
  // Only the EDITABLE fields can be sent — a read-only field (notificationPref, TM-1109) is never
  // included in the PATCH, so an admin can never mutate it (the backend also rejects a change, 422).
  for (const field of EDITABLE_ADMIN_PROFILE_FIELDS) {
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

    // Text/select/tel fields: send when the trimmed value differs from the saved value (treating a
    // null/absent saved value as ""). This sends an explicit "" to clear a previously-set field.
    const savedStr = savedValue == null ? "" : String(savedValue).trim();
    if (trimmed === savedStr) continue;
    patch[field.key] = trimmed;
  }
  return patch;
}
