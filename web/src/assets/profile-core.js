// Profile screen — pure logic core (TM-514).
//
// The visual refresh of the Profile / Edit-profile / Public-profile screens to the approved paper
// wireframes (design-kit/pages/paper-profile, paper-edit-profile, paper-public-profile) keeps its
// DOM-free, framework-free rules HERE so they can be unit-tested in plain Node (`node --test`), the
// same extraction pattern as account-badges.js / tabbar-core.js / events-core.js (see
// docs/agents/conventions/AGENTIC-LESSONS "extract the pure logic to test it"). The DOM half lives in
// profile.js; the markup styling lives in styles.css.
//
// NONE of these functions touch the DOM, Firebase, or the network — they take a `/me`-shaped object
// (backend MeResponse, see web/src/api-docs/openapi.json) plus a couple of plain booleans and return
// plain data the renderer maps to elements.

// Country dial-code data (TM-781) — pure and Node-importable like this module, so importing it here
// keeps profile-core testable under `node --test` with no DOM/browser shims.
import { countryByIso2, countryForDial, DIALS_LONGEST_FIRST, cityCountryHint } from "./countries.js";

// The Profile routes. `#/profile` is the Profile hub + inline edit form (kept as ONE route so the
// existing self-service edit e2e — which navigates to #/profile and expects #profile-form — stays
// green); `#/profile/public` is the additive "how others see you" public-profile preview. Both live in
// the single #profile-view container and both light the bottom-nav Profile tab (tabbar-core treats any
// `#/profile/...` sub-path as the Profile tab).
export const PROFILE_ROUTE = "#/profile";
export const PROFILE_PUBLIC_ROUTE = "#/profile/public";

/**
 * Which Profile layout a hash route wants.
 * @param {string} hash the current `window.location.hash`
 * @returns {"public"|"view"} "public" for the public-profile preview, "view" for the hub + edit form.
 */
export function profileMode(hash) {
  return hash === PROFILE_PUBLIC_ROUTE ? "public" : "view";
}

/** The email local-part (before the @), or "" — a friendly display fallback when no name is set. */
function emailLocalPart(email) {
  if (typeof email !== "string") return "";
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}

/** The first letter of `s` uppercased, or "" if there isn't one. */
function firstInitial(s) {
  const m = typeof s === "string" ? s.trim().match(/[A-Za-z0-9]/) : null;
  return m ? m[0].toUpperCase() : "";
}

/**
 * The identity block shown at the top of the Profile hub (paper-profile: avatar + name + "City · age").
 *
 * @param {object|null|undefined} me a `/me`-shaped object
 * @returns {{ full: string, short: string, initial: string, metaLine: string,
 *   city: string, age: (number|null) }}
 *   `full` = best full name; `short` = "First L." (wireframe style) when both parts exist, else `full`;
 *   `initial` = avatar glyph (a letter, or "🙂" when nothing is known); `metaLine` = "City · age".
 */
export function identitySummary(me) {
  const m = me || {};
  const first = (m.firstName || "").trim();
  const last = (m.lastName || "").trim();
  const joined = [first, last].filter(Boolean).join(" ");
  const full = joined || (m.displayName || "").trim() || emailLocalPart(m.email) || "Your profile";
  // "First L." — the wireframe's compact identity (e.g. "Basit S."). Falls back to the full name.
  const short = first && last ? `${first} ${last[0].toUpperCase()}.` : full;
  const city = (m.city || "").trim();
  const age = Number.isFinite(m.age) && m.age > 0 ? m.age : null;
  const metaLine = [city, age != null ? String(age) : ""].filter(Boolean).join(" · ");
  return {
    full,
    short,
    // The avatar glyph is drawn from a REAL identity source (name / displayName / email), never the
    // "Your profile" placeholder — so a brand-new, empty profile shows the friendly 🙂 (matching the
    // avatar fallback in profile.js) rather than a "Y".
    initial: firstInitial(first || last || (m.displayName || "").trim() || emailLocalPart(m.email)) || "🙂",
    metaLine,
    city,
    age,
  };
}

/**
 * The account-contact block shown on the Profile hub (TM-783): the email and phone number the account
 * is registered with, read from the same `/me` payload the hub already loads. Email is the account's
 * identity and is effectively always present; phone is optional, so `phoneDisplay` falls back to a
 * friendly prompt when it's blank so the line is never silently omitted.
 *
 * @param {object|null|undefined} me a `/me`-shaped object
 * @returns {{ email: string, phone: string, hasPhone: boolean, phoneDisplay: string }}
 */
export function accountContact(me) {
  const m = me || {};
  const email = (m.email || "").trim();
  const phone = (m.phone || "").trim();
  return {
    email,
    phone,
    hasPhone: Boolean(phone),
    phoneDisplay: phone || "No phone number added",
  };
}

// The fields that count toward "profile strength" (the paper-profile completeness bar) and the
// friendly label each contributes to the "what's missing" nudge. Photo is tracked separately (it's a
// Firebase photoURL, not a /me field) but counts the same. Kept declarative so the bar, the percentage
// and the nudge always agree.
const STRENGTH_FIELDS = [
  { key: "name", label: "a name" },
  { key: "city", label: "your city" },
  { key: "age", label: "your age" },
  { key: "phone", label: "a phone" },
  { key: "photo", label: "a photo" },
];

/**
 * The profile-completeness / "profile strength" model (paper-profile). Returns the percentage, the
 * filled/total counts, the ordered list of what's still missing, and a short call-to-action nudge —
 * the restyled continuation of the shipped completeness prompt (TM-514 AC: preserved + restyled).
 *
 * `gaps` (TM-881) is the keyed twin of `missing`: the same ordered list but as `{key, label}`
 * objects, so the renderer can turn each named gap into a REAL control that jumps to the matching
 * field (the key is what maps onto a `profile-<field>` DOM id). `missing` (labels only) stays —
 * the nudge copy and existing consumers read it.
 *
 * @param {object|null|undefined} me a `/me`-shaped object
 * @param {{ hasPhoto?: boolean }} [opts] whether the Firebase user currently has a photoURL
 * @returns {{ percent: number, filled: number, total: number, missing: string[],
 *   gaps: {key: string, label: string}[], complete: boolean, nudge: string }}
 */
export function profileStrength(me, { hasPhoto = false } = {}) {
  const m = me || {};
  const present = {
    name: Boolean((m.firstName || "").trim() || (m.lastName || "").trim() || (m.displayName || "").trim()),
    city: Boolean((m.city || "").trim()),
    age: Number.isFinite(m.age) && m.age > 0,
    phone: Boolean((m.phone || "").trim()),
    photo: Boolean(hasPhoto),
  };
  const total = STRENGTH_FIELDS.length;
  const gaps = STRENGTH_FIELDS.filter((f) => !present[f.key]).map((f) => ({ key: f.key, label: f.label }));
  const missing = gaps.map((g) => g.label);
  const filled = total - missing.length;
  const percent = Math.round((filled / total) * 100);
  const complete = missing.length === 0;
  // The nudge names at most the first two gaps so it stays a short line (e.g. "Add a photo + your city").
  const nudge = complete ? "Your profile is all set" : `Add ${missing.slice(0, 2).join(" + ")}`;
  return { percent, filled, total, missing, gaps, complete, nudge };
}

/**
 * The public-profile preview model (paper-public-profile: avatar + name + city).
 *
 * Renders how OTHERS see the signed-in user; a real other-user endpoint (`GET /users/{id}`) doesn't
 * exist yet (noted as a TM-514 follow-up), so the preview is built from the caller's own `/me`.
 *
 * The wireframe's meta line reads "City · joined Mon YYYY", but the "joined Mon YYYY" clause is
 * DEFERRED (TM-534): `/me` (MeResponse / AccountState — see web/src/api-docs/openapi.json) carries
 * no account-creation timestamp (`AccountState` is emailVerified/mfaEnabled/phoneVerified/photoURL/
 * lastLoginAt; `MeResponse` has no `createdAt`), so there was never a real value to format and the
 * clause silently collapsed to "" for every real user. Rather than read a field the API never
 * returns, the preview shows the city alone until a real joined date exists. Re-adding it — a
 * backend `createdAt` on `MeResponse` wired through `formatJoined` — is the TM-534 / TM-514
 * follow-up.
 *
 * @param {object|null|undefined} me a `/me`-shaped object
 * @returns {{ short: string, initial: string, metaLine: string, city: string }}
 */
export function publicSummary(me) {
  const id = identitySummary(me);
  // Meta line = city only (the "joined" clause is deferred — see the note above). `id.city` is
  // already "" when no city is set, which the renderer (profile.js) swaps for its own prompt.
  return { short: id.short, initial: id.initial, metaLine: id.city, city: id.city };
}

/**
 * Format an ISO instant as "Mon YYYY" (e.g. "Jun 2026"); "" for a missing/invalid/future value.
 *
 * Retained (exported + unit-tested) even though `publicSummary` no longer calls it: it is the
 * ready-made formatter for the deferred "joined Mon YYYY" clause, to be wired back up once a real
 * account-creation timestamp lands on `/me` (the TM-534 / TM-514 follow-up).
 */
export function formatJoined(iso, now = new Date()) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()) || d.getTime() > now.getTime()) return "";
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()];
  return `${month} ${d.getFullYear()}`;
}

// The phone validation messages, shared so the digit guard reads identically whichever path raises
// it, and the "pick a country" prompt is the same in the field error and the stored-value check.
// PHONE_PICK_COUNTRY_MESSAGE is exported: the renderer (profile.js setFieldError) needs to know
// when a phone error faults the COUNTRY PICKER (this message) rather than the national input, so
// the aria-invalid/red-ring state lands on the control the user must actually change.
const PHONE_DIGIT_RANGE_MESSAGE = "Enter a valid phone number (7 to 15 digits).";
export const PHONE_PICK_COUNTRY_MESSAGE = "Pick a country for this phone number.";
const PHONE_NATIONAL_ONLY_MESSAGE = "Enter the national number only — pick the country from the list.";

/**
 * TM-752: the profile phone field's character pattern (^\+?[0-9 ()./-]{3,32}$) validates the allowed
 * CHARACTERS but not the digit COUNT, so "+", "12" and "()." pass as "valid". A real phone number has
 * 7–15 digits (national minimum ~7; E.164 maximum 15). Returns a user-facing error for an out-of-range
 * digit count, or "" when acceptable. Empty/blank is allowed (blank = leave the field unchanged).
 * Since TM-781 the LIVE phone paths (phonePartsError / validateProfileField) inline a refined rule
 * — floor of 7 on the national part, E.164 ceiling of 15 on dial+national — so this whole-value
 * helper is retained as the exported, unit-tested TM-752 primitive (like formatJoined) rather than
 * being on the hot path.
 * @param {string} value the raw phone input.
 * @returns {string} an error message, or "" if acceptable.
 */
export function phoneFormatError(value) {
  const v = String(value ?? "").trim();
  if (v === "") return "";
  const digits = (v.match(/[0-9]/g) || []).length;
  if (digits < 7 || digits > 15) return PHONE_DIGIT_RANGE_MESSAGE;
  return "";
}

// ---- E.164 phone split/compose (TM-781) ---------------------------------------------------------
//
// The profile phone is stored as E.164 ("+<dial><national>") and edited as a (country picker,
// national number) PAIR. These pure rules do the translation both ways plus the picker's default:
//   splitE164          stored value → { iso2, national }   (form load)
//   composeE164        picker + input → stored value        (form save)
//   defaultCountryFor  which country the picker starts on   (no saved phone)
//   phonePartsError    validation of the live (picker, input) pair

/**
 * Normalise a national-number input to bare digits for the given country: drop the allowed
 * formatting characters (space ( ) . / -) and ONE leading trunk "0" (users naturally type
 * "07700 900123"; E.164 wants "+447700900123", not "+4407700900123") — UNLESS the country's E.164
 * form keeps its trunk 0 (`keepsTrunkZero` in countries.js: the Italian numbering plan). Without
 * that flag a correctly stored "+390612345678" would reload as national "0612345678" and re-save
 * as "+39612345678" — a different subscriber's number — on ANY profile save (a TM-781 review
 * finding; splitE164→composeE164 must be identity for every valid stored value).
 *
 * NB a leading "00" is NOT a trunk zero — it's the international-dialling prefix ("0044…"): the
 * callers reject that shape outright (hasInternationalPrefix) rather than half-stripping it.
 */
function nationalDigits(raw, country) {
  const digits = String(raw ?? "").replace(/[^0-9]/g, "");
  return country && country.keepsTrunkZero ? digits : digits.replace(/^0/, "");
}

/**
 * True when the input's digits open with "00" — the international-dialling idiom ("0044 7700…"),
 * the keypad twin of pasting a "+44…" number. Composing it would store a double-dialled value
 * (the trunk strip drops only ONE zero → "+440447700900123" passes every length check), so both
 * phonePartsError and composeE164 treat it exactly like the "+"-paste case (a TM-781 review
 * finding — "00" is the real dialling prefix in GB/AE/SA, the app's primary user base).
 */
function hasInternationalPrefix(raw) {
  return /^00/.test(String(raw ?? "").replace(/[^0-9]/g, ""));
}

/**
 * Split a stored E.164 phone back into its picker parts — the form-load half of the TM-781 pair.
 *
 * Longest dial code wins ("+1242…" → Bahamas, not +1 US), and dial codes shared by several
 * territories resolve to their canonical owner (+44 → GB, +7 → RU — see countries.js). Stored
 * formatting from pre-TM-781 saves ("+44 7700 900123") is tolerated; the returned national part is
 * always bare digits.
 *
 * @param {string|null|undefined} value the stored phone.
 * @returns {{iso2: string, national: string}|null} null when the value isn't E.164-shaped — blank,
 *   a legacy bare number with no +dial (the form's confirm-country state), or not a phone at all.
 */
export function splitE164(value) {
  const s = String(value ?? "").trim();
  if (!s.startsWith("+")) return null;
  const rest = s.slice(1);
  // Only digits + the backend-allowed formatting chars may follow the "+"; anything else (letters…)
  // means this isn't a phone number and there is nothing sensible to split.
  if (rest === "" || /[^0-9 ()./-]/.test(rest)) return null;
  const digits = rest.replace(/[^0-9]/g, "");
  if (digits === "") return null;
  // DIALS_LONGEST_FIRST is pre-sorted longest→shortest, so the first prefix hit IS the longest match.
  for (const dial of DIALS_LONGEST_FIRST) {
    if (digits.startsWith(dial)) {
      const country = countryForDial(dial);
      // The COUNTRY's own compose code (country.dial) decides where the national part starts, not
      // the matched prefix. For NANP prefixes ("1242", "1829"…) that code is "1": the prefix only
      // picks the country and the area code STAYS in the national part — so composeE164 reproduces
      // the exact stored value instead of re-composing a secondary code (+1829…) onto the
      // territory's primary (+1809…), which silently rewrote real numbers (TM-781 review, HIGH).
      return { iso2: country.iso2, national: digits.slice(country.dial.length) };
    }
  }
  return null; // no known dial code (e.g. "+0…", or an unassigned prefix)
}

/**
 * Compose the stored E.164 value from the picker + national input — the form-save half.
 *
 * A blank national number composes to "" (the caller omits the field → "blank stays blank"): a
 * dial-code-only value like "+44" is NEVER produced. Formatting characters and one trunk "0" are
 * stripped from the national part (see nationalDigits — countries flagged keepsTrunkZero keep
 * theirs). An unknown/unconfirmed iso2 also returns "" — there's no dial code to compose with —
 * and so does a "00…" international-prefix input: composing it would store a double-dialled
 * number ("+44" + "0447700…"), so the pure function refuses outright. Validation
 * (phonePartsError) blocks both those paths with a targeted message before any real save.
 *
 * @param {string|null|undefined} iso2 the picker selection (case-insensitive).
 * @param {string|null|undefined} national the national-number input, as typed.
 * @returns {string} "+<dial><digits>", or "".
 */
export function composeE164(iso2, national) {
  const country = countryByIso2(iso2);
  if (!country) return "";
  if (hasInternationalPrefix(national)) return "";
  const digits = nationalDigits(national, country);
  if (digits === "") return "";
  return `+${country.dial}${digits}`;
}

/**
 * Which country the phone picker should start on: the saved phone's own country when one is stored
 * (so changing city later never flips an existing phone), else the curated city hint
 * (London → GB, Dubai → AE, Riyadh → SA, …), else GB. This is a SOFT default — the renderer must
 * not apply it over a selection the user made explicitly (profile.js tracks that).
 *
 * @param {{phone?: string, city?: string}} [me] the relevant `/me` fields.
 * @returns {string} an iso2 code (always resolves — GB is the final fallback).
 */
export function defaultCountryFor({ phone, city } = {}) {
  const parsed = splitE164(phone);
  if (parsed) return parsed.iso2;
  return cityCountryHint(city) || "GB";
}

/**
 * Validate the live (country picker, national input) pair — the rule the edit form runs on every
 * keystroke and on save (TM-781). Returns an error message, or "" when acceptable.
 *
 * The cases, in order:
 *   • blank national → "" — blank = leave unchanged, clearing is never blocked (TM-188 semantics);
 *   • national starting "+" OR "00" → redirected to the picker. Composing "+44" + "+447…" (or
 *     "+44" + "0044 7…" — "00" is the international-dialling idiom in GB/AE/SA) would silently
 *     double the dial code, so a pasted full international number gets a targeted message instead;
 *   • no/unknown country (the legacy confirm-country placeholder) → "pick a country" — this is what
 *     blocks saving a legacy bare number until the user confirms where it belongs;
 *   • bad characters in the national part → format error (mirrors the backend char-pattern);
 *   • then the digit guard: at least 7 NATIONAL digits (the TM-752 floor, counted post trunk-0
 *     strip so validation counts exactly what composeE164 would store), and at most 15 digits
 *     INCLUDING the dial code — the E.164 ceiling, which is also what the backend's stored-value
 *     pattern enforces (TM-781), so nothing the client accepts can 400 on save.
 *
 * @param {string|null|undefined} iso2 the picker selection ("" = the confirm-country placeholder).
 * @param {string|null|undefined} national the national-number input, as typed.
 * @returns {string} an error message, or "".
 */
export function phonePartsError(iso2, national) {
  const raw = String(national ?? "").trim();
  if (raw === "") return "";
  // Both international-input idioms redirect to the picker — checked before anything else so the
  // message is the same whether or not a country is currently confirmed.
  if (raw.startsWith("+") || hasInternationalPrefix(raw)) return PHONE_NATIONAL_ONLY_MESSAGE;
  const country = countryByIso2(iso2);
  if (!country) return PHONE_PICK_COUNTRY_MESSAGE;
  if (!/^[0-9 ()./-]{1,32}$/.test(raw)) return "Format looks invalid.";
  const digits = nationalDigits(raw, country);
  // Floor on the national part, ceiling on the composed total (dial + national ≤ 15, per E.164).
  if (digits.length < 7 || country.dial.length + digits.length > 15) return PHONE_DIGIT_RANGE_MESSAGE;
  return "";
}

// ---- City dropdown (TM-877) ---------------------------------------------------------------------

/**
 * The interim allowed city list (TM-877): the profile city is now picked from a fixed dropdown
 * rather than typed free-text. Deliberately tiny — the cities the user base actually lives in —
 * and superseded by the admin-managed location list (TM-878). Each entry must have a
 * `cityCountryHint` mapping (countries.js) so the phone picker's soft default keeps resolving.
 */
export const CITY_OPTIONS = Object.freeze(["London", "Milton Keynes", "Sharjah", "Karachi"]);

/**
 * Validate a city dropdown choice (TM-877). Returns an error message, or "" when acceptable.
 *
 * Blank is allowed (blank = leave unchanged, the TM-188 semantics). A value from CITY_OPTIONS is
 * allowed. Crucially, the caller's ALREADY-SAVED city is also allowed even when it's off-list
 * (e.g. "Dubai" saved before the list existed) — the renderer keeps it selectable as an extra
 * option, so an existing profile is never invalidated or silently overwritten on save.
 *
 * @param {string|null|undefined} value the selected city.
 * @param {string|null|undefined} savedCity the caller's currently-saved city (off-list allowance).
 * @returns {string} an error message, or "".
 */
export function cityChoiceError(value, savedCity) {
  const v = String(value ?? "").trim();
  if (v === "") return "";
  if (CITY_OPTIONS.includes(v)) return "";
  if (v === String(savedCity ?? "").trim()) return "";
  return "Choose a city from the list.";
}

// ---- Phone completion gate (TM-880) -------------------------------------------------------------

/**
 * Whether the signed-in caller must be routed to the first-use completion gate to supply a phone
 * number (TM-880: phone is mandatory; email stays optional). True when the `/me` profile carries no
 * VALID stored E.164 phone — that covers "no phone at all" AND a legacy bare number saved before
 * TM-781 (country-ambiguous, so the user must confirm its country: the same confirm-country rule
 * the edit form enforces). Applies to ALL users, existing phone-less accounts included — the gate
 * decision, not just a new-signup rule.
 *
 * Fails OPEN on a missing/degraded `/me` (null → false), exactly like the onboarding + terms gates
 * in router.js: a backend hiccup must never trap a user behind a gate. The backend is the real
 * authority — it refuses to mark onboarding complete without a valid phone.
 *
 * @param {object|null|undefined} me a `/me`-shaped object (reads `me.phone`).
 * @returns {boolean} true when the completion gate should intercept.
 */
export function needsPhoneNumber(me) {
  if (!me) return false;
  return !splitE164(me.phone);
}

/**
 * TM-771: firstName/lastName/city carried only a length cap, so a purely numeric value ("676767")
 * saved as a name or city. A name-like value must contain at least one letter (any script — Arabic,
 * accented Latin, etc.), and may only use letters, combining marks, spaces, hyphens, apostrophes and
 * periods. Returns a user-facing error, or "" when acceptable. Empty/blank is allowed (blank = leave
 * the field unchanged), matching phoneFormatError's contract.
 * @param {string} value the raw name/city input.
 * @returns {string} an error message, or "" if acceptable.
 */
export function nameFormatError(value) {
  const v = String(value ?? "").trim();
  if (v === "") return "";
  if (!/\p{L}/u.test(v) || !/^[\p{L}\p{M} .'’-]+$/u.test(v)) {
    return "Use letters — spaces, hyphens, apostrophes and periods are fine.";
  }
  return "";
}

/** The Profile fields that carry the TM-771 name-like rule (a letter required, digits rejected). */
const NAME_LIKE_KEYS = new Set(["firstName", "lastName", "city"]);

/** The valid notification-preference values (TM-162) — shared by the Profile form + its validator. */
export const NOTIFICATION_PREFS = new Set(["EMAIL", "PUSH", "BOTH"]);

/**
 * Validate one Profile field's raw value against its rules (TM-162 / TM-752 / TM-771). Pure — returns
 * an error message, or "" if valid. Empty is always allowed (blank = leave the field unchanged).
 * Extracted from profile.js so the WHOLE rule is guarded — including that the phone field gets the
 * 7–15 digit check (phoneFormatError) applied ON TOP of its character-pattern (TM-752), that
 * firstName/lastName/city get the name-like check (nameFormatError, TM-771), and that each check
 * stays scoped to its own fields. profile.js's validateField is now a thin delegate to this.
 * @param {{key:string,type?:string,min?:number,max?:number,maxLength?:number,pattern?:string}} field
 * @param {string} raw the raw input value.
 * @returns {string} an error message, or "" if valid.
 */
export function validateProfileField(field, raw) {
  const value = String(raw ?? "").trim();
  if (value === "") return "";
  if (field.type === "number") {
    const n = Number(value);
    if (!Number.isInteger(n)) return "Enter a whole number.";
    if (field.min != null && n < field.min) return `Must be ${field.min} or more.`;
    if (field.max != null && n > field.max) return `Must be ${field.max} or less.`;
    return "";
  }
  if (field.type === "select") {
    if (field.key === "notificationPref" && !NOTIFICATION_PREFS.has(value)) return "Choose a valid option.";
    return "";
  }
  if (field.maxLength != null && value.length > field.maxLength) {
    return `Must be ${field.maxLength} characters or fewer.`;
  }
  if (field.pattern && !new RegExp(field.pattern).test(value)) {
    return "Format looks invalid.";
  }
  if (field.key === "phone") {
    // TM-781: a stored-shape phone must be E.164 — parseable as +dial+national. A bare national
    // number (the pre-TM-781 legacy format) is now INCOMPLETE: the message points the user at the
    // country picker. The digit guard then applies as in phonePartsError: the TM-752 floor of 7 on
    // the NATIONAL part (so "+44123456" — 8 digits total, 6 national — correctly fails where a
    // whole-value count would pass) and the E.164 ceiling of 15 on the TOTAL (matching the
    // backend's stored-value pattern, so client-valid can't 400 server-side).
    const parsed = splitE164(value);
    if (!parsed) return PHONE_PICK_COUNTRY_MESSAGE;
    const totalDigits = (value.match(/[0-9]/g) || []).length;
    if (parsed.national.length < 7 || totalDigits > 15) return PHONE_DIGIT_RANGE_MESSAGE;
  }
  if (NAME_LIKE_KEYS.has(field.key)) {
    const nameErr = nameFormatError(value);
    if (nameErr) return nameErr;
  }
  return "";
}

// ---- Next-day completeness nudge (TM-777 / I5) --------------------------------------------------
//
// The Profile-strength card shows a gentle, once-a-day CTA inviting a user who has picked EXACTLY ONE
// interest to add a couple more (progressive profiling). This is the PURE decision — clock + the stored
// "last shown" timestamp are injected (exactly like `formatJoined(iso, now = new Date())` above), so it
// unit-tests under `node --test` with no `localStorage`, no `Date` globals, and no DOM. profile.js is the
// thin renderer: it reads the last-prompt time from per-uid localStorage, calls this, paints the CTA and
// stamps "shown today" so the same-day suppression below fires on the next paint.
//
// Interests come from `me.interests` (the array merged in by TM-775, now on main). `interestCount`
// still tolerates the field being absent — a missing/blank/non-array value reads as 0 picks, which is
// silent (no nudge). The pick count needs no extra call (it rides the already-loaded /me). The target
// MAX is sourced separately: the renderer best-effort fetches the public `GET /api/v1/interests/config`
// (TM-774) and injects `maxSelections` here, so the copy tracks the admin's runtime bound; on fetch
// failure it falls back to INTERESTS_MAX_FALLBACK. This pure fn stays frontend-only and side-effect-free
// — all IO (the /me read, the config fetch, localStorage) lives in profile.js's thin renderer.

/**
 * The FALLBACK interests maximum the nudge copy targets. Mirrors the backend's seeded
 * `InterestSelectionConfig.MAX_DEFAULT` (1/3 seeded defaults). Used only when the real runtime bound
 * can't be fetched: the renderer best-effort reads the public `GET /api/v1/interests/config` (TM-774,
 * any signed-in user; returns `minSelections`/`maxSelections`) and injects the real `maxSelections`
 * into `nextDayInterestsNudge`. If that fetch fails (offline / non-2xx), the nudge falls back to this
 * constant so the copy stays sensible rather than blank. So the copy tracks an admin's runtime max
 * change when the fetch succeeds, and degrades to this seeded default when it doesn't.
 */
export const INTERESTS_MAX_FALLBACK = 3;

/**
 * How many interests the user has picked. Reads `me.interests` (the I3/TM-775 array) defensively: a
 * missing field (pre-TM-775 /me), null, or any non-array value all read as 0 — never throws.
 * @param {object|null|undefined} me a `/me`-shaped object.
 * @returns {number} the pick count (0 when there's nothing to count).
 */
export function interestCount(me) {
  return Array.isArray(me?.interests) ? me.interests.length : 0;
}

/**
 * True when the ISO instant `iso` falls on the SAME LOCAL calendar day as `now`. Local (not UTC) on
 * purpose: "next day" is a user-perception thing — a prompt shown at 11pm shouldn't re-fire at 1am just
 * because the UTC date rolled. Returns `false` for a missing/invalid `iso` (so an unparseable stored
 * value is treated as "not today" → the caller stays eligible rather than crashing).
 */
function sameLocalDay(iso, now) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

/**
 * The I5 next-day completeness-nudge decision (TM-777) — pure and clock/last-prompt-injectable.
 *
 * Shows a CTA only when the user has picked EXACTLY ONE interest AND we haven't already prompted them
 * today. "Never shown" (a null/missing/invalid `lastPromptISO`) counts as eligible → it shows once, and
 * the renderer then records today's date so the same-day suppression fires on the next paint. 0 picks
 * (first-run / onboarding) and ≥2 picks (already engaged) are both silent — the nudge is aimed at the
 * exact "started but stalled at one" state.
 *
 * @param {object|null|undefined} me a `/me`-shaped object (reads `me.interests`).
 * @param {{ now?: Date, lastPromptISO?: (string|null), max?: number }} [opts]
 *   `now` = the clock (defaults to real time); `lastPromptISO` = the stored "last shown" timestamp
 *   (defaults to null = never shown); `max` = the interests-selection maximum the copy targets,
 *   injected by the renderer from the public `GET /api/v1/interests/config` (`maxSelections`). A
 *   missing/invalid `max` falls back to {@link INTERESTS_MAX_FALLBACK}. All injected so the whole
 *   decision is deterministic in tests.
 * @returns {{ show: boolean, count: number, max: number, remaining: number, message: string }}
 *   a STRUCTURED result (not a bare string) so the renderer can branch on `show` and reuse the counts.
 */
export function nextDayInterestsNudge(
  me,
  { now = new Date(), lastPromptISO = null, max = INTERESTS_MAX_FALLBACK } = {},
) {
  const count = interestCount(me);
  // The target max is INJECTED by the renderer from the public `GET /api/v1/interests/config`
  // (TM-774, `maxSelections`) so the copy tracks an admin's runtime bound. A missing/non-finite/
  // non-positive injected value (fetch failed, or the caller passed nothing) falls back to the seeded
  // default constant — we never read a `me.*` field for it (MeResponse carries no max).
  const injected = Number(max);
  const resolvedMax = Number.isFinite(injected) && injected > 0 ? injected : INTERESTS_MAX_FALLBACK;
  const remaining = resolvedMax - count;
  // Only the "picked exactly 1" state is a candidate: 0 = onboarding (don't nag before they start), ≥2 =
  // already engaged / at the typical max. `lastPromptISO` on the same local day suppresses (nagged today);
  // a missing/invalid value means "never shown" → eligible.
  const show = count === 1 && !(lastPromptISO != null && sameLocalDay(lastPromptISO, now));
  // Product copy uses a hyphen, not an em-dash (global "-" preference).
  const message = `You picked 1 interest - add ${remaining} more so people find you →`;
  return { show, count, max: resolvedMax, remaining, message };
}
