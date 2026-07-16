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
 * @param {object|null|undefined} me a `/me`-shaped object
 * @param {{ hasPhoto?: boolean }} [opts] whether the Firebase user currently has a photoURL
 * @returns {{ percent: number, filled: number, total: number, missing: string[], complete: boolean,
 *   nudge: string }}
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
  const missing = STRENGTH_FIELDS.filter((f) => !present[f.key]).map((f) => f.label);
  const filled = total - missing.length;
  const percent = Math.round((filled / total) * 100);
  const complete = missing.length === 0;
  // The nudge names at most the first two gaps so it stays a short line (e.g. "Add a photo + your city").
  const nudge = complete ? "Your profile is all set" : `Add ${missing.slice(0, 2).join(" + ")}`;
  return { percent, filled, total, missing, complete, nudge };
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

/**
 * TM-752: the profile phone field's character pattern (^\+?[0-9 ()./-]{3,32}$) validates the allowed
 * CHARACTERS but not the digit COUNT, so "+", "12" and "()." pass as "valid". A real phone number has
 * 7–15 digits (national minimum ~7; E.164 maximum 15). Returns a user-facing error for an out-of-range
 * digit count, or "" when acceptable. Empty/blank is allowed (blank = leave the field unchanged).
 * @param {string} value the raw phone input.
 * @returns {string} an error message, or "" if acceptable.
 */
export function phoneFormatError(value) {
  const v = String(value ?? "").trim();
  if (v === "") return "";
  const digits = (v.match(/[0-9]/g) || []).length;
  if (digits < 7 || digits > 15) return "Enter a valid phone number (7 to 15 digits).";
  return "";
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
    const phoneErr = phoneFormatError(value);
    if (phoneErr) return phoneErr;
  }
  if (NAME_LIKE_KEYS.has(field.key)) {
    const nameErr = nameFormatError(value);
    if (nameErr) return nameErr;
  }
  return "";
}
