// Tests for the Profile screen pure logic (TM-514). Framework-free — Node's built-in test runner,
// the same harness as account-badges.test.mjs / tabbar-core.test.mjs, picked up by the CI glob
// `node --test web/tools/*.test.mjs`.
//
// These guard the PURE core the refreshed Profile / Edit-profile / Public-profile screens read: the
// identity summary, the completeness ("profile strength") model + nudge, the public-profile preview
// model, and the route→mode mapping. The DOM renderer (profile.js) is a thin map over these, so
// testing them here covers the behaviour without needing a browser.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PROFILE_ROUTE,
  PROFILE_PUBLIC_ROUTE,
  profileMode,
  identitySummary,
  accountContact,
  nationalityDisplay,
  bioDisplay,
  circleUserId,
  profileStrength,
  strengthRingGeometry,
  publicSummary,
  formatJoined,
  phoneFormatError,
  nameFormatError,
  validateProfileField,
  splitE164,
  composeE164,
  defaultCountryFor,
  phonePartsError,
  interestCount,
  nextDayInterestsNudge,
  INTERESTS_MAX_FALLBACK,
  GENDER_OPTIONS,
  GENDER_VALUES,
  genderChoiceError,
  CITY_OPTIONS,
  CITY_FALLBACK,
  cityOptionsFrom,
  cityChoiceError,
  PROFILE_SECTIONS,
  profileSectionsStateKey,
  resolveSectionState,
  toggleSectionState,
} from "../src/assets/profile-core.js";

// The real Profile field shapes profile.js feeds validateProfileField (TM-162) — so these tests
// pin the ACTUAL validation path (char-pattern + digit guard together) and the wiring, not just the
// phoneFormatError helper in isolation.
const PHONE_FIELD = { key: "phone", type: "tel", maxLength: 32, pattern: "^\\+?[0-9 ()./-]{3,32}$" };
const CITY_FIELD = { key: "city", type: "text", maxLength: 120 };
const FIRSTNAME_FIELD = { key: "firstName", type: "text", maxLength: 255 };
const LASTNAME_FIELD = { key: "lastName", type: "text", maxLength: 255 };
const AGE_FIELD = { key: "age", type: "number", min: 13, max: 120 };
const NOTIF_FIELD = { key: "notificationPref", type: "select" };

// A realistic /me payload (real MeResponse shape): firstName/lastName/city/age/phone at the top
// level, plus the Firebase-owned `accountState` block. That block mirrors the actual backend
// AccountState contract (TM-164) — emailVerified/mfaEnabled/phoneVerified/photoURL/lastLoginAt —
// and deliberately has NO `createdAt`: `/me` carries no account-creation timestamp, so a fixture
// must not fabricate one (that false-green is exactly what TM-534 fixes).
function me(overrides = {}) {
  return {
    uid: "abc",
    email: "basit@example.com",
    firstName: "Basit",
    lastName: "Siddiqui",
    displayName: "Basit Siddiqui",
    city: "Milton Keynes",
    age: 29,
    phone: "+44 7700 900123",
    accountState: {
      emailVerified: true,
      mfaEnabled: false,
      phoneVerified: false,
      photoURL: null,
      lastLoginAt: "2026-07-01T09:00:00Z",
    },
    ...overrides,
  };
}

// ---- profileMode ------------------------------------------------------------------------------

test("profileMode maps the public route to 'public' and everything else to 'view'", () => {
  assert.equal(profileMode(PROFILE_PUBLIC_ROUTE), "public");
  assert.equal(profileMode(PROFILE_ROUTE), "view");
  assert.equal(profileMode("#/profile"), "view");
  assert.equal(profileMode("#/anything-else"), "view");
});

// ---- accountContact (TM-783) ------------------------------------------------------------------

test("accountContact surfaces the account's email and phone from the /me payload", () => {
  const c = accountContact(me());
  assert.equal(c.email, "basit@example.com");
  assert.equal(c.phone, "+44 7700 900123");
  assert.equal(c.hasPhone, true);
  assert.equal(c.phoneDisplay, "+44 7700 900123");
});

test("accountContact shows a friendly prompt (not a blank line) when no phone is on file", () => {
  const c = accountContact(me({ phone: "" }));
  assert.equal(c.phone, "");
  assert.equal(c.hasPhone, false);
  assert.equal(c.phoneDisplay, "No phone number added");
});

test("accountContact trims whitespace and tolerates a missing/empty /me object", () => {
  assert.equal(accountContact({ email: "  a@b.com  ", phone: "  123 456 7890  " }).email, "a@b.com");
  assert.equal(accountContact({ email: "  a@b.com  ", phone: "  123 456 7890  " }).phone, "123 456 7890");
  const empty = accountContact(null);
  assert.equal(empty.email, "");
  assert.equal(empty.hasPhone, false);
  assert.equal(empty.phoneDisplay, "No phone number added");
});

// ---- nationalityDisplay (TM-1134) -------------------------------------------------------------

test("nationalityDisplay resolves a stored iso2 code to its flag + country name", () => {
  const n = nationalityDisplay(me({ nationality: "GB" }));
  assert.equal(n.code, "GB");
  assert.equal(n.name, "United Kingdom");
  assert.equal(n.hasNationality, true);
  assert.match(n.display, /United Kingdom/, "the display line names the country");
});

test("nationalityDisplay upper-cases + trims a lower-case/padded stored code", () => {
  const n = nationalityDisplay(me({ nationality: "  ae  " }));
  assert.equal(n.code, "AE");
  assert.equal(n.name, "United Arab Emirates");
  assert.equal(n.hasNationality, true);
});

test("nationalityDisplay reports no nationality for a null/blank/unknown code (line hidden)", () => {
  for (const val of [null, undefined, "", "   ", "ZZ", "not-a-code"]) {
    const n = nationalityDisplay(me({ nationality: val }));
    assert.equal(n.hasNationality, false, `${JSON.stringify(val)} → no nationality`);
    assert.equal(n.display, "", `${JSON.stringify(val)} → empty display (renderer hides the line)`);
  }
  // A missing field and a null /me object are both safe.
  assert.equal(nationalityDisplay({}).hasNationality, false);
  assert.equal(nationalityDisplay(null).hasNationality, false);
});

// ---- bioDisplay (TM-1139) ---------------------------------------------------------------------

test("bioDisplay returns the stored bio text and marks it present", () => {
  const b = bioDisplay(me({ bio: "Coffee, code and long walks." }));
  assert.equal(b.bio, "Coffee, code and long walks.");
  assert.equal(b.hasBio, true);
  assert.equal(b.display, "Coffee, code and long walks.", "the display line is the bio text");
});

test("bioDisplay trims surrounding whitespace off the stored bio", () => {
  const b = bioDisplay(me({ bio: "   Hello there   " }));
  assert.equal(b.bio, "Hello there");
  assert.equal(b.display, "Hello there");
  assert.equal(b.hasBio, true);
});

test("bioDisplay reports no bio for a null/blank bio (line hidden)", () => {
  for (const val of [null, undefined, "", "   ", "\n\t "]) {
    const b = bioDisplay(me({ bio: val }));
    assert.equal(b.hasBio, false, `${JSON.stringify(val)} → no bio`);
    assert.equal(b.display, "", `${JSON.stringify(val)} → empty display (renderer hides the line)`);
  }
  // A missing field and a null /me object are both safe.
  assert.equal(bioDisplay({}).hasBio, false);
  assert.equal(bioDisplay(null).hasBio, false);
});

// ---- circleUserId (TM-1105) -------------------------------------------------------------------

test("circleUserId surfaces the numeric users.id, its copy value and a present flag", () => {
  const c = circleUserId({ uid: "firebase-uid-xyz", circleUserId: 4242 });
  assert.equal(c.id, 4242);
  assert.equal(c.value, "4242", "the copy value is the id as a string");
  assert.equal(c.hasId, true);
  assert.equal(c.display, "4242");
});

test("circleUserId copies the numeric id, NOT the Firebase uid string", () => {
  // The whole point of TM-1105: the id shown/copied is the numeric users.id, distinct from the uid.
  const c = circleUserId({ uid: "firebase-uid-xyz", circleUserId: 7 });
  assert.equal(c.value, "7");
  assert.notEqual(c.value, "firebase-uid-xyz");
});

test("circleUserId treats a missing/null id as 'no id' with a muted prompt (never a blank line)", () => {
  for (const raw of [undefined, null]) {
    const c = circleUserId({ circleUserId: raw });
    assert.equal(c.hasId, false);
    assert.equal(c.id, null);
    assert.equal(c.value, "", "nothing to copy when there's no id");
    assert.equal(c.display, "Not available yet");
  }
  const missing = circleUserId({});
  assert.equal(missing.hasId, false);
  assert.equal(missing.display, "Not available yet");
});

test("circleUserId tolerates a null/undefined /me object", () => {
  for (const me of [null, undefined]) {
    const c = circleUserId(me);
    assert.equal(c.hasId, false);
    assert.equal(c.value, "");
    assert.equal(c.display, "Not available yet");
  }
});

test("circleUserId accepts 0 as a real id (presence is a null-check, not truthiness)", () => {
  const c = circleUserId({ circleUserId: 0 });
  assert.equal(c.hasId, true);
  assert.equal(c.id, 0);
  assert.equal(c.value, "0");
  assert.equal(c.display, "0");
});

test("circleUserId rejects a non-numeric id (a string) as 'no id' — the contract is a number", () => {
  // The backend types circleUserId as a Long → JSON number; a stray string is malformed, not an id.
  const c = circleUserId({ circleUserId: "4242" });
  assert.equal(c.hasId, false);
  assert.equal(c.display, "Not available yet");
});

// ---- identitySummary --------------------------------------------------------------------------

test("identitySummary builds the full name, the compact 'First L.' and the City · age meta line", () => {
  const id = identitySummary(me());
  assert.equal(id.full, "Basit Siddiqui");
  assert.equal(id.short, "Basit S.");
  assert.equal(id.initial, "B");
  assert.equal(id.metaLine, "Milton Keynes · 29");
  assert.equal(id.city, "Milton Keynes");
  assert.equal(id.age, 29);
});

test("identitySummary falls back to displayName, then email local-part, then 'Your profile'", () => {
  assert.equal(identitySummary({ displayName: "Sam Doe" }).full, "Sam Doe");
  assert.equal(identitySummary({ email: "jules@x.com" }).full, "jules");
  assert.equal(identitySummary({}).full, "Your profile");
  assert.equal(identitySummary(null).full, "Your profile");
});

test("identitySummary uses the emoji glyph and an empty meta line when nothing is known", () => {
  const id = identitySummary({});
  assert.equal(id.initial, "🙂");
  assert.equal(id.metaLine, "");
  assert.equal(id.age, null);
});

test("identitySummary omits a missing city or age from the meta line", () => {
  // Use an on-list city (TM-877 dropdown value) so this pins the "age missing → city alone" case
  // without depending on off-list-city behaviour (guarded separately in the TM-1023 test below).
  assert.equal(identitySummary({ firstName: "A", city: "London" }).metaLine, "London");
  assert.equal(identitySummary({ firstName: "A", age: 40 }).metaLine, "40");
});

// TM-1023: the identity meta line echoed WHATEVER string was stored in `city`, so an account whose
// stored city is an off-list/junk value ("Location" — seen live as the literal header "Location · 32")
// rendered it verbatim. The city dropdown (TM-877) can only ever store a CITY_OPTIONS value, so an
// off-list stored value is garbage — it must be dropped from the meta line, letting profile.js's
// existing empty-state fallback ("Add your city and age", shown when metaLine is "") take over. A
// valid on-list city still renders exactly as before.
test("identitySummary drops an off-list junk city from the meta line (TM-1023)", () => {
  // The exact live regression: stored city "Location", age 32 → the header must NOT echo "Location".
  const junk = identitySummary({ firstName: "A", city: "Location", age: 32 });
  assert.ok(!junk.metaLine.includes("Location"), `off-list city must not appear in metaLine, got: ${junk.metaLine}`);
  assert.equal(junk.metaLine, "32"); // only the age survives; profile.js shows the empty state when it's "" too
  // An off-list city with no age → empty meta line → the "Add your city and age" empty state shows.
  assert.equal(identitySummary({ firstName: "A", city: "Location" }).metaLine, "");
  // A valid on-list city still renders exactly as today (with and without an age).
  assert.equal(identitySummary({ firstName: "A", city: "London", age: 30 }).metaLine, "London · 30");
  assert.equal(identitySummary({ firstName: "A", city: "London" }).metaLine, "London");
});

// TM-1165: the junk guard uses the OFFERED catalogue names (passed in), not just the hardcoded
// fallback — so an ADMIN-ADDED city ("Marhabaville") renders in the meta line instead of being
// dropped as junk, while a genuine junk value ("Location") is still dropped. Default (no offered
// arg) keeps the pre-cutover fallback behaviour.
test("identitySummary keeps an admin-added offered city in the meta line, still drops junk (TM-1165)", () => {
  const offered = ["London", "Marhabaville"];
  // fail-before: with the OLD hardcoded set "Marhabaville" would have been dropped; passing the
  // offered list keeps it.
  assert.equal(identitySummary({ firstName: "A", city: "Marhabaville", age: 20 }, offered).metaLine, "Marhabaville · 20");
  // A value NOT in the offered list is still dropped as junk.
  assert.equal(identitySummary({ firstName: "A", city: "Location", age: 20 }, offered).metaLine, "20");
  // Default (no offered arg) → the hard fallback → an admin-added city not in the fallback is dropped.
  assert.equal(identitySummary({ firstName: "A", city: "Marhabaville", age: 20 }).metaLine, "20");
});

// ---- cityOptionsFrom (TM-1165 pure mapping) ---------------------------------------------------

test("cityOptionsFrom maps catalogue rows to trimmed unique names, preserving order (TM-1165)", () => {
  const rows = [
    { name: "London", country: "United Kingdom" },
    { name: " Marhabaville ", country: "Testland" }, // trimmed
    { name: "London", country: "dup" }, // duplicate dropped
    { name: "", country: "blank" }, // blank skipped
    { country: "no-name" }, // missing name skipped
  ];
  assert.deepEqual(cityOptionsFrom(rows), ["London", "Marhabaville"]);
});

test("cityOptionsFrom falls back to CITY_FALLBACK when the payload is missing/empty/unusable (TM-1165)", () => {
  // The field must never break offline: a null/non-array/empty payload (or one with no usable name)
  // yields the four hard-fallback cities so the picker still works.
  assert.deepEqual(cityOptionsFrom(null), [...CITY_FALLBACK]);
  assert.deepEqual(cityOptionsFrom(undefined), [...CITY_FALLBACK]);
  assert.deepEqual(cityOptionsFrom("nope"), [...CITY_FALLBACK]);
  assert.deepEqual(cityOptionsFrom([]), [...CITY_FALLBACK]);
  assert.deepEqual(cityOptionsFrom([{ name: "" }, { country: "x" }]), [...CITY_FALLBACK]);
  // CITY_FALLBACK is exactly the four seeded cities (and aliases the historical CITY_OPTIONS export).
  assert.deepEqual([...CITY_FALLBACK], ["London", "Milton Keynes", "Sharjah", "Karachi"]);
  assert.equal(CITY_FALLBACK, CITY_OPTIONS);
  // An explicit fallback is honoured too.
  assert.deepEqual(cityOptionsFrom([], ["Solo"]), ["Solo"]);
});

// ---- cityChoiceError (TM-877/TM-1165) ---------------------------------------------------------

test("cityChoiceError accepts a value from the OFFERED list (admin-added city), rejects off-list (TM-1165)", () => {
  const offered = ["London", "Marhabaville"];
  assert.equal(cityChoiceError("Marhabaville", null, offered), "", "an offered (admin-added) city passes");
  assert.equal(cityChoiceError("London", null, offered), "");
  assert.match(cityChoiceError("Nowhere", null, offered), /list/i, "an off-list city is rejected");
});

test("cityChoiceError allows blank and the caller's own saved off-list city; defaults to the fallback (TM-877)", () => {
  assert.equal(cityChoiceError("", null, ["London"]), "", "blank = leave unchanged");
  // The caller's ALREADY-SAVED off-list city ("Dubai") stays valid so it's never overwritten.
  assert.equal(cityChoiceError("Dubai", "Dubai", ["London"]), "");
  // No offered arg → the hard fallback (the four seeded cities) is used.
  assert.equal(cityChoiceError("London"), "");
  assert.equal(cityChoiceError("Sharjah"), "");
  assert.match(cityChoiceError("Bristol"), /list/i, "off the fallback list, not the caller's saved value → rejected");
});

// TM-883: the identity header (and public preview) for a NAMED account — a /me carrying
// firstName/lastName renders the real name, preferred over displayName. The bug was upstream (the
// backend never seeded first/last name at onboarding, so /me carried null and the header fell back);
// this pins the render contract the fix feeds: named data in → name shown, both on the hub header
// (paintHub → id.short) and the public preview.
test("identity header and public preview show the name for a named account (TM-883)", () => {
  const named = me({ firstName: "Priya", lastName: "Sharma", displayName: "someone else" });
  const id = identitySummary(named);
  assert.equal(id.full, "Priya Sharma"); // first/last win over displayName
  assert.equal(id.short, "Priya S."); // what paintHub puts in the header's name slot
  assert.equal(id.initial, "P");
  const pub = publicSummary(named);
  assert.equal(pub.short, "Priya S.");
  assert.equal(pub.initial, "P");
});

// ---- profileStrength --------------------------------------------------------------------------

test("profileStrength is 100% with a nudge of 'all set' when every field + a photo are present", () => {
  const s = profileStrength(me(), { hasPhoto: true });
  assert.equal(s.percent, 100);
  assert.equal(s.filled, 5);
  assert.equal(s.total, 5);
  assert.deepEqual(s.missing, []);
  assert.equal(s.complete, true);
  assert.equal(s.nudge, "Your profile is all set");
});

test("profileStrength counts the missing photo (no photoURL) as one gap", () => {
  const s = profileStrength(me(), { hasPhoto: false });
  assert.equal(s.percent, 80);
  assert.equal(s.filled, 4);
  assert.deepEqual(s.missing, ["a photo"]);
  assert.equal(s.complete, false);
  assert.equal(s.nudge, "Add a photo");
});

test("profileStrength lists gaps in field order and names at most the first two in the nudge", () => {
  const s = profileStrength({ firstName: "A" }, { hasPhoto: false });
  // name present; city, age, phone, photo all missing → 1/5 = 20%.
  assert.equal(s.percent, 20);
  assert.deepEqual(s.missing, ["your city", "your age", "a phone", "a photo"]);
  assert.equal(s.nudge, "Add your city + your age");
});

test("profileStrength treats a blank/zero field as unfilled", () => {
  const s = profileStrength({ firstName: "", city: "  ", age: 0, phone: "" }, { hasPhoto: false });
  assert.equal(s.filled, 0);
  assert.equal(s.percent, 0);
});

test("profileStrength tolerates null input", () => {
  const s = profileStrength(null);
  assert.equal(s.percent, 0);
  assert.equal(s.complete, false);
});

// TM-881: `gaps` is the keyed twin of `missing` — the renderer maps each gap's KEY onto the
// `profile-<field>` control its "Add …" prompt must jump to, so the keys (not just the labels)
// are part of the contract.
test("profileStrength exposes keyed gaps (TM-881) — same order as missing, with the field keys", () => {
  const s = profileStrength({ firstName: "A" }, { hasPhoto: false });
  assert.deepEqual(s.gaps, [
    { key: "city", label: "your city" },
    { key: "age", label: "your age" },
    { key: "phone", label: "a phone" },
    { key: "photo", label: "a photo" },
  ]);
  // The label lists must never drift apart — gaps IS missing, keyed.
  assert.deepEqual(s.gaps.map((g) => g.label), s.missing);
});

test("profileStrength gaps is empty when the profile is complete (TM-881)", () => {
  assert.deepEqual(profileStrength(me(), { hasPhoto: true }).gaps, []);
});

// ---- publicSummary + formatJoined -------------------------------------------------------------

test("publicSummary builds the public-preview model (name, avatar, city) from the real /me shape", () => {
  const p = publicSummary(me());
  assert.equal(p.short, "Basit S.");
  assert.equal(p.initial, "B");
  assert.equal(p.city, "Milton Keynes");
  // Meta line is the city alone — the wireframe's "joined Mon YYYY" clause is deferred (TM-534)
  // because `/me` carries no account-creation timestamp. No fabricated `createdAt` in play.
  assert.equal(p.metaLine, "Milton Keynes");
});

test("publicSummary does not read a (non-existent) accountState.createdAt — the real contract has none", () => {
  // The realistic fixture has NO createdAt; even injecting one must NOT resurrect the deferred
  // 'joined' clause. This guards against the field silently creeping back into the meta line.
  assert.equal(publicSummary(me()).metaLine, "Milton Keynes");
  assert.equal(publicSummary(me({ accountState: { createdAt: "2026-06-14T10:00:00Z" } })).metaLine, "Milton Keynes");
});

test("publicSummary meta line is empty when no city is set", () => {
  const p = publicSummary(me({ city: "" }));
  assert.equal(p.metaLine, "");
  assert.equal(p.city, "");
});

test("formatJoined returns '' for missing, invalid and future dates", () => {
  const now = new Date("2026-07-08T00:00:00Z");
  assert.equal(formatJoined(null, now), "");
  assert.equal(formatJoined("not-a-date", now), "");
  assert.equal(formatJoined("2027-01-01T00:00:00Z", now), "");
  assert.equal(formatJoined("2026-01-15T00:00:00Z", now), "Jan 2026");
});

// TM-752: the profile phone field's character pattern (^\+?[0-9 ()./-]{3,32}$) checks allowed
// characters but NOT digit count, so "+", "12", "()." pass as valid. phoneFormatError adds the
// missing digit-count guard (a real number has 7–15 digits: national min ~7, E.164 max 15).
test("phoneFormatError: rejects too-few / digit-less phone strings (TM-752)", () => {
  assert.notEqual(phoneFormatError("12"), "");         // 2 digits
  assert.notEqual(phoneFormatError("+"), "");          // 0 digits
  assert.notEqual(phoneFormatError("()."), "");        // 0 digits, previously passed the pattern
  assert.notEqual(phoneFormatError("123456"), "");     // 6 digits, one short
  assert.notEqual(phoneFormatError("12345678901234567"), ""); // 17 digits, over E.164 max
});

test("phoneFormatError: accepts plausible numbers (7–15 digits, formatting allowed)", () => {
  assert.equal(phoneFormatError("+447700900123"), "");   // 12 digits
  assert.equal(phoneFormatError("020 7946 0000"), "");    // 11 digits
  assert.equal(phoneFormatError("+1 (555) 123-4567"), ""); // 11 digits
  assert.equal(phoneFormatError("1234567"), "");           // 7 digits (lower boundary)
  assert.equal(phoneFormatError("123456789012345"), "");   // 15 digits (upper boundary)
});

test("phoneFormatError: empty/blank is allowed (blank = leave unchanged)", () => {
  assert.equal(phoneFormatError(""), "");
  assert.equal(phoneFormatError("   "), "");
  assert.equal(phoneFormatError(null), "");
  assert.equal(phoneFormatError(undefined), "");
});

test("validateProfileField: the phone field applies BOTH the char-pattern AND the 7–15 digit guard (TM-752)", () => {
  assert.notEqual(validateProfileField(PHONE_FIELD, "12"), "");          // too few digits
  assert.notEqual(validateProfileField(PHONE_FIELD, "+"), "");           // no digits
  assert.notEqual(validateProfileField(PHONE_FIELD, "()."), "");         // no digits (passed the pattern before)
  assert.notEqual(validateProfileField(PHONE_FIELD, "abc1234567"), "");  // letters → rejected by the char-pattern
  assert.equal(validateProfileField(PHONE_FIELD, "+447700900123"), "");  // valid
  // TM-781 contract change: "020 7946 0000" used to be VALID here; a stored phone must now be
  // E.164 (+dial+national), so a bare national number is incomplete — see the TM-781 tests below.
  assert.notEqual(validateProfileField(PHONE_FIELD, "020 7946 0000"), "");
});

// ---- TM-781: E.164 split / compose / soft-default country / picker-pair validation ---------------
//
// The mandatory country picker stores phones as E.164 ("+<dial><national>", composed on save) and
// splits them back on load. These tests pin the pure rules: longest-dial-code matching, canonical
// owners for shared dial codes, blank-stays-blank composition, the saved-phone → city-hint → GB
// default chain, and the (picker, national) pair validation the form actually runs.

test("splitE164 splits a saved E.164 into country + national — longest dial code wins", () => {
  assert.deepEqual(splitE164("+447700900123"), { iso2: "GB", national: "7700900123" });
  assert.deepEqual(splitE164("+971501234567"), { iso2: "AE", national: "501234567" });
  // The load-bearing example from the product rule: +1242 (Bahamas) must beat +1 (US). The area
  // code stays in the NATIONAL part — every NANP member composes on the shared "+1", so split →
  // compose reproduces the stored value exactly (TM-781 review: split/compose symmetry).
  assert.deepEqual(splitE164("+12425550123"), { iso2: "BS", national: "2425550123" });
  assert.deepEqual(splitE164("+12025550123"), { iso2: "US", national: "2025550123" });
  // A NANP SECONDARY code resolves the country without being swallowed into the dial: +1829 is
  // Dominican, and its national part keeps the 829 (the review's corruption case).
  assert.deepEqual(splitE164("+18295551234"), { iso2: "DO", national: "8295551234" });
});

test("splitE164 tolerates stored formatting and resolves shared dial codes canonically", () => {
  // Pre-TM-781 values could carry legal formatting ("+44 7700 900123") — still splittable.
  assert.deepEqual(splitE164(" +44 7700 900123 "), { iso2: "GB", national: "7700900123" });
  // Shared dials resolve to the canonical owner (see countries.test.mjs): +7 → Russia, not KZ.
  assert.equal(splitE164("+79161234567").iso2, "RU");
});

test("splitE164 returns null for legacy bare numbers, blanks and non-phones", () => {
  assert.equal(splitE164("07700 900123"), null); // legacy bare national — no +dial to split on
  assert.equal(splitE164(""), null);
  assert.equal(splitE164("   "), null);
  assert.equal(splitE164(null), null);
  assert.equal(splitE164(undefined), null);
  assert.equal(splitE164("+"), null);
  assert.equal(splitE164("+0123456789"), null); // no dial code starts with 0
  assert.equal(splitE164("+44abc7700"), null);  // letters are not a phone
});

test("composeE164 composes +dial+national, stripping formatting and a single trunk 0", () => {
  assert.equal(composeE164("GB", "07700 900123"), "+447700900123");
  assert.equal(composeE164("GB", "7700900123"), "+447700900123");
  assert.equal(composeE164("AE", "(050) 123-4567"), "+971501234567");
  assert.equal(composeE164("gb", "7700900123"), "+447700900123"); // iso2 is case-insensitive
});

test("composeE164 returns '' for a blank national number — NEVER a dial-code-only value", () => {
  assert.equal(composeE164("GB", ""), "");
  assert.equal(composeE164("GB", "   "), "");
  assert.equal(composeE164("GB", "()."), "");        // formatting chars but zero digits
  assert.equal(composeE164("", "7700900123"), "");   // unconfirmed country can't compose
  assert.equal(composeE164("ZZ", "7700900123"), ""); // unknown country can't compose
});

test("composeE164 → splitE164 round-trips to the same country + national", () => {
  // A Bahamian types their full 10-digit number (area code included) against the "+1" picker entry.
  const composed = composeE164("BS", "242 555 0123");
  assert.equal(composed, "+12425550123");
  assert.deepEqual(splitE164(composed), { iso2: "BS", national: "2425550123" });
});

// TM-781 review (HIGH): DIAL-alias asymmetry silently rewrote stored +1829/+1849/+1939/+1658
// numbers onto the territory's primary code (+1809/+1787/+1876) on ANY profile save — a different
// subscriber's number. The fix models all NANP on the single "+1" compose code, so split→compose
// must now be a strict IDENTITY for every valid stored value, secondary codes included.
test("splitE164 → composeE164 is identity for stored E.164 values — incl. NANP secondary codes", () => {
  const stored = [
    "+447700900123", // GB
    "+971501234567", // AE
    "+966501234567", // SA
    "+12425550123", //  BS — island prefix
    "+12025550123", //  US
    "+18095551234", //  DO primary (+1809)
    "+18295551234", //  DO secondary (+1829) — the review's corruption case
    "+18495551234", //  DO secondary (+1849)
    "+17875551234", //  PR primary (+1787)
    "+19395551234", //  PR secondary (+1939)
    "+18765551234", //  JM primary (+1876)
    "+16585551234", //  JM secondary (+1658)
    "+390612345678", // IT — E.164 KEEPS the trunk 0 (the review's trunk-strip corruption case)
  ];
  for (const value of stored) {
    const parts = splitE164(value);
    assert.ok(parts, `${value} must split`);
    assert.equal(composeE164(parts.iso2, parts.national), value, `${value} must round-trip unchanged`);
  }
});

test("composeE164 keeps a NANP number on its OWN area code — never the territory's primary (TM-781 review)", () => {
  // Entering a Dominican +1829 number by hand: picker "Dominican Republic +1" + the 10 digits.
  // The old per-territory dial would have composed "+1809…" (or the unenterable "+18098295551234").
  assert.equal(composeE164("DO", "829 555 1234"), "+18295551234");
  assert.equal(composeE164("PR", "9395551234"), "+19395551234");
});

test("composeE164 preserves the trunk 0 for keep-trunk-zero countries, still strips it elsewhere (TM-781 review)", () => {
  // Italy's E.164 keeps the national 0: a stored "+390612345678" reloads as (IT, "0612345678") and
  // MUST re-compose byte-identical — the old unconditional strip made any unrelated profile save
  // (e.g. changing city) silently rewrite it to the undialable "+39612345678".
  assert.equal(composeE164("IT", "0612345678"), "+390612345678");
  assert.equal(composeE164("IT", "06 1234 5678"), "+390612345678");
  assert.equal(composeE164("IT", "3312345678"), "+393312345678"); // mobiles have no trunk 0 — unchanged
  assert.equal(phonePartsError("IT", "0612345678"), ""); // and validation accepts what compose stores
  // The GB/AE/SA trunk-strip behaviour is untouched.
  assert.equal(composeE164("GB", "07700 900123"), "+447700900123");
  assert.equal(composeE164("SA", "0501234567"), "+966501234567");
});

test("defaultCountryFor: saved-phone country → city hint → GB", () => {
  // A saved E.164 phone always wins — changing city later must never flip an existing phone country.
  assert.equal(defaultCountryFor({ phone: "+966501234567", city: "London" }), "SA");
  // No parseable phone: the curated city map decides (a legacy bare number falls through too —
  // the FORM shows it as the confirm-country state, but the default chain itself uses the hint)…
  assert.equal(defaultCountryFor({ phone: "", city: "Dubai" }), "AE");
  assert.equal(defaultCountryFor({ phone: "07700900123", city: " riyadh " }), "SA");
  assert.equal(defaultCountryFor({ phone: "", city: "Milton Keynes" }), "GB");
  // …and an unknown/missing city falls back to GB.
  assert.equal(defaultCountryFor({ phone: "", city: "Paris" }), "GB");
  assert.equal(defaultCountryFor({}), "GB");
  assert.equal(defaultCountryFor(), "GB");
});

test("phonePartsError: blank national is allowed; a number without a confirmed country is not", () => {
  assert.equal(phonePartsError("GB", ""), "");
  assert.equal(phonePartsError("", "   "), "");
  // The legacy confirm-country state: picker on the '' placeholder + a real number → save blocked,
  // and the message tells the user to pick a country.
  assert.match(phonePartsError("", "07700 900123"), /country/i);
  assert.match(phonePartsError("ZZ", "07700 900123"), /country/i); // unknown iso2 blocks too
});

test("phonePartsError keeps the TM-752 checks on the national part", () => {
  assert.equal(phonePartsError("GB", "07700 900123"), "");
  assert.equal(phonePartsError("SA", "0501234567"), "");
  assert.match(phonePartsError("GB", "12345"), /7 to 15/);        // too few digits
  assert.match(phonePartsError("GB", "0123456"), /7 to 15/);      // trunk 0 stripped → only 6 left
  assert.match(phonePartsError("GB", "not-a-phone!"), /invalid/i); // char-pattern still applies
  assert.match(phonePartsError("GB", "()."), /7 to 15/);           // chars pass, zero digits
});

test("phonePartsError caps the COMPOSED value at the E.164 ceiling of 15 digits incl. the dial code", () => {
  // The backend stores +dial+national and enforces ≤15 digits TOTAL (the E.164 maximum, TM-781).
  // The client must count the same way, or a long national number would pass here and 400 on save.
  assert.equal(phonePartsError("GB", "1234567890123"), "");        // 13 national + 2 dial = 15 ✓
  assert.match(phonePartsError("GB", "12345678901234"), /7 to 15/); // 14 national + 2 dial = 16 ✗
  assert.match(phonePartsError("SA", "1234567890123"), /7 to 15/);  // 13 national + 3 dial = 16 ✗
});

test("phonePartsError redirects a pasted full +international number to the picker", () => {
  // Composing "+44" + "+447700900123" would double the dial code; catch it with a targeted message.
  assert.match(phonePartsError("GB", "+447700900123"), /country|national/i);
});

// TM-781 review: "00" is the international-dialling idiom in GB/AE/SA — the app's primary user
// base — and the keypad twin of pasting a "+…" number. The trunk strip drops only ONE zero, so
// unguarded it composed "+440447700900123" (15 digits — passes every length check, client AND
// backend) and silently stored a double-dialled number.
test("phonePartsError redirects a 00-international-prefix number to the picker, like the + paste", () => {
  assert.match(phonePartsError("GB", "0044 7700 900123"), /country|national/i);
  assert.match(phonePartsError("GB", "00447700900123"), /country|national/i);
  assert.match(phonePartsError("AE", "00971501234567"), /country|national/i);
  // Same redirect even from the legacy confirm-country state ('' selection).
  assert.match(phonePartsError("", "0044 7700 900123"), /country|national/i);
  // A SINGLE trunk zero is not the international prefix — the everyday GB form stays valid.
  assert.equal(phonePartsError("GB", "07700 900123"), "");
});

test("composeE164 refuses a 00-prefixed national outright — a double-dialled value is never composed", () => {
  assert.equal(composeE164("GB", "00447700900123"), "");
  assert.equal(composeE164("GB", "0044 7700 900123"), "");
  assert.equal(composeE164("IT", "0039 06 1234 5678"), ""); // keep-trunk-zero countries too
});

test("validateProfileField: a stored phone must parse as +dial — bare numbers ask for a country (TM-781)", () => {
  assert.match(validateProfileField(PHONE_FIELD, "07700 900123"), /country/i);
  assert.match(validateProfileField(PHONE_FIELD, "020 7946 0000"), /country/i);
  assert.equal(validateProfileField(PHONE_FIELD, "+447700900123"), "");
  assert.equal(validateProfileField(PHONE_FIELD, "+44 7700 900123"), ""); // stored formatting ok
});

test("validateProfileField: the 7–15 digit guard applies to the NATIONAL part of the E.164 value (TM-781)", () => {
  // 8 digits in total — the OLD whole-value guard would have passed this — but only 6 remain after
  // the +44 dial code, so it must fail. This is the guard moving to the national part.
  assert.match(validateProfileField(PHONE_FIELD, "+44123456"), /7 to 15/);
  // A dial-code-only value is never valid (0 national digits) — whatever message path it takes.
  assert.notEqual(validateProfileField(PHONE_FIELD, "+44"), "");
  // And the E.164 ceiling — 15 digits INCLUDING the dial code — matches the backend's stored-value
  // pattern, so nothing the client accepts can 400 on save.
  assert.equal(validateProfileField(PHONE_FIELD, "+441234567890123"), "");  // 15 digits total ✓
  assert.match(validateProfileField(PHONE_FIELD, "+4412345678901234"), /7 to 15/); // 16 total ✗
});

test("validateProfileField: the phone digit guard is phone-ONLY — it must not leak to other fields (TM-752 wiring)", () => {
  // "Rome" has ZERO digits, so if the 7–15 digit guard leaked onto city it would be rejected here.
  // (A numeric city like "12" is now rejected too, but by TM-771's name-like rule — tested below —
  // not by the phone guard; this test keeps pinning that the PHONE rule stays phone-scoped.)
  assert.equal(validateProfileField(CITY_FIELD, "Rome"), "");
});

test("validateProfileField: number field enforces integer + min/max (extraction preserves behaviour)", () => {
  assert.notEqual(validateProfileField(AGE_FIELD, "12"), "");    // below min 13
  assert.notEqual(validateProfileField(AGE_FIELD, "12.5"), "");  // not an integer
  assert.notEqual(validateProfileField(AGE_FIELD, "200"), "");   // above max 120
  assert.equal(validateProfileField(AGE_FIELD, "29"), "");
});

test("validateProfileField: notificationPref select rejects an unknown option, accepts a valid one", () => {
  assert.notEqual(validateProfileField(NOTIF_FIELD, "SMOKE"), "");
  assert.equal(validateProfileField(NOTIF_FIELD, "BOTH"), "");
});

test("validateProfileField: empty/blank is always allowed (blank = leave unchanged)", () => {
  assert.equal(validateProfileField(PHONE_FIELD, ""), "");
  assert.equal(validateProfileField(AGE_FIELD, "   "), "");
});

// TM-771: firstName/lastName/city had only a length cap, so a purely numeric value ("676767")
// saved as a name or city with a "Profile saved." confirmation. nameFormatError adds the missing
// name-like rule: at least one letter, and only letters/spaces/hyphens/apostrophes/periods.
test("nameFormatError: rejects purely numeric or letter-less values (TM-771)", () => {
  assert.notEqual(nameFormatError("676767"), "");   // Ghalia's repro value
  assert.notEqual(nameFormatError("123 456"), "");  // digits + space, still no letter
  assert.notEqual(nameFormatError("---"), "");      // allowed punctuation but no letter
  assert.notEqual(nameFormatError("London2"), "");  // digits mixed into a real name
});

test("nameFormatError: accepts real names and cities, including punctuation and non-ASCII letters", () => {
  assert.equal(nameFormatError("Ghalia"), "");
  assert.equal(nameFormatError("O'Brien"), "");        // apostrophe
  assert.equal(nameFormatError("Jean-Luc"), "");       // hyphen
  assert.equal(nameFormatError("St. Albans"), "");     // period + space
  assert.equal(nameFormatError("São Paulo"), "");      // accented letter
  assert.equal(nameFormatError("غالية"), "");           // Arabic script
});

test("nameFormatError: empty/blank is allowed (blank = leave unchanged)", () => {
  assert.equal(nameFormatError(""), "");
  assert.equal(nameFormatError("   "), "");
  assert.equal(nameFormatError(null), "");
  assert.equal(nameFormatError(undefined), "");
});

test("validateProfileField: firstName/lastName/city apply the name-like rule (TM-771 wiring)", () => {
  assert.notEqual(validateProfileField(FIRSTNAME_FIELD, "676767"), "");
  assert.notEqual(validateProfileField(LASTNAME_FIELD, "676767"), "");
  assert.notEqual(validateProfileField(CITY_FIELD, "676767"), "");
  assert.equal(validateProfileField(FIRSTNAME_FIELD, "Ghalia"), "");
  assert.equal(validateProfileField(LASTNAME_FIELD, "Qazi"), "");
  assert.equal(validateProfileField(CITY_FIELD, "St. Albans"), "");
});

test("validateProfileField: the name-like rule is scoped to firstName/lastName/city only (TM-771 wiring)", () => {
  // A digits-only phone must stay valid — the name rule must not leak onto other text-ish fields.
  assert.equal(validateProfileField(PHONE_FIELD, "+447700900123"), "");
});

// ---- nextDayInterestsNudge (TM-777 / I5) ------------------------------------------------------
//
// The next-day completeness nudge: when the user has picked EXACTLY ONE interest and we haven't
// prompted them today, the strength card shows a CTA to add more (up to the max). The clock (`now`)
// and the stored "last shown" timestamp (`lastPromptISO`) are injected so the whole decision is
// deterministic with no localStorage / Date globals — the same injected-clock pattern as formatJoined.
// Interests are read from `me.interests`; the field is tolerated missing (pre-TM-775 /me → 0 picks).

// A YESTERDAY / EARLIER-TODAY pair relative to a fixed local "now", built from local calendar parts so
// the same-local-day comparison is exercised in the runner's local timezone (not UTC).
const NUDGE_NOW = new Date(2026, 6, 15, 14, 0, 0); // 15 Jul 2026, 14:00 local
const YESTERDAY = new Date(2026, 6, 14, 23, 30, 0).toISOString(); // prior calendar day
const EARLIER_TODAY = new Date(2026, 6, 15, 9, 0, 0).toISOString(); // same calendar day, earlier

test("nextDayInterestsNudge: 1 pick + never prompted → shows, names the remaining count", () => {
  const r = nextDayInterestsNudge({ interests: ["hiking"] }, { now: NUDGE_NOW, lastPromptISO: null });
  assert.equal(r.show, true);
  assert.equal(r.count, 1);
  assert.equal(r.max, 3);
  assert.equal(r.remaining, 2);
  assert.match(r.message, /2 more/);
  assert.match(r.message, /so people find you/); // matches the interests card's existing voice
  // Copy uses a hyphen, not an em-dash (global "-" product-owner preference).
  assert.match(r.message, /1 interest - add/);
  assert.doesNotMatch(r.message, /—/);
});

test("nextDayInterestsNudge: 1 pick + last prompt was YESTERDAY → shows (the core next-day case)", () => {
  const r = nextDayInterestsNudge({ interests: ["hiking"] }, { now: NUDGE_NOW, lastPromptISO: YESTERDAY });
  assert.equal(r.show, true);
});

test("nextDayInterestsNudge: 1 pick + last prompt was EARLIER TODAY → suppressed (don't nag same-day)", () => {
  const r = nextDayInterestsNudge({ interests: ["hiking"] }, { now: NUDGE_NOW, lastPromptISO: EARLIER_TODAY });
  assert.equal(r.show, false);
  assert.equal(r.count, 1); // the counts are still computed, only `show` is gated
});

test("nextDayInterestsNudge: 0 picks (empty array) → never nags (first-run / onboarding)", () => {
  const r = nextDayInterestsNudge({ interests: [] }, { now: NUDGE_NOW, lastPromptISO: null });
  assert.equal(r.show, false);
  assert.equal(r.count, 0);
});

test("nextDayInterestsNudge: 2 or 3 picks → silent (already engaged / at the typical max)", () => {
  assert.equal(nextDayInterestsNudge({ interests: ["a", "b"] }, { now: NUDGE_NOW }).show, false);
  assert.equal(nextDayInterestsNudge({ interests: ["a", "b", "c"] }, { now: NUDGE_NOW }).show, false);
});

test("nextDayInterestsNudge: an absent interests field (pre-TM-775 /me) → silent, count 0", () => {
  const r = nextDayInterestsNudge({ firstName: "Basit" }, { now: NUDGE_NOW, lastPromptISO: null });
  assert.equal(r.show, false);
  assert.equal(r.count, 0);
});

test("nextDayInterestsNudge: null me → does not throw, show:false (mirrors profileStrength tolerance)", () => {
  const r = nextDayInterestsNudge(null, { now: NUDGE_NOW, lastPromptISO: null });
  assert.equal(r.show, false);
  assert.equal(r.count, 0);
});

test("nextDayInterestsNudge: no injected max → falls back to the seeded constant (config fetch failed)", () => {
  // When the renderer can't fetch GET /api/v1/interests/config (offline / non-2xx) it passes no `max`,
  // so the nudge must fall back to the honest INTERESTS_MAX_FALLBACK (3) rather than a blank/NaN copy.
  // A realistic MeResponse carries an `interests` array; the max is NEVER read off the payload.
  const realMe = {
    uid: "u1",
    email: "a@b.co",
    displayName: "Ada",
    interests: [{ label: "hiking", category: "outdoors" }],
  };
  const r = nextDayInterestsNudge(realMe, { now: NUDGE_NOW });
  assert.equal(r.max, INTERESTS_MAX_FALLBACK);
  assert.equal(r.max, 3);
  assert.equal(r.remaining, 2);
  assert.match(r.message, /2 more/);
});

test("nextDayInterestsNudge: an injected max (from the public config) drives the copy — max 5 → 'add 4 more'", () => {
  // The renderer best-effort fetches GET /api/v1/interests/config (TM-774, public) and injects
  // `maxSelections`. When the admin has raised the bound to 5, a 1-pick user should be told to add 4
  // more (5 − 1), and both `max`/`remaining` reflect the real bound — proving the copy is config-driven.
  const r = nextDayInterestsNudge({ interests: ["hiking"] }, { now: NUDGE_NOW, max: 5 });
  assert.equal(r.show, true);
  assert.equal(r.count, 1);
  assert.equal(r.max, 5);
  assert.equal(r.remaining, 4);
  assert.match(r.message, /add 4 more/);
});

test("nextDayInterestsNudge: an invalid injected max (0 / NaN / negative) falls back to the seeded constant", () => {
  // A non-positive / non-finite injected value (garbage config, or `Number(undefined)` → NaN) must not
  // produce a nonsense "add 0 more" / "add NaN more" — it degrades to INTERESTS_MAX_FALLBACK (3).
  for (const bad of [0, -2, NaN, undefined, null, "nope"]) {
    const r = nextDayInterestsNudge({ interests: ["hiking"] }, { now: NUDGE_NOW, max: bad });
    assert.equal(r.max, INTERESTS_MAX_FALLBACK, `injected max ${String(bad)} should fall back to 3`);
    assert.equal(r.remaining, 2);
  }
});

test("nextDayInterestsNudge: the max is NEVER sourced from the payload — a stray me.interestsMax is ignored", () => {
  // Regression guard for the original phantom-field bug (TM-777): the pure fn must read the max only
  // from the injected `max` option, never from a `me.*` field (MeResponse carries no such field). With
  // no injected max, a stray `me.interestsMax` must be ignored and the fallback used.
  assert.equal(nextDayInterestsNudge({ interests: ["hiking"], interestsMax: 9 }, { now: NUDGE_NOW }).max, 3);
  // And an injected max wins over any payload field regardless.
  assert.equal(
    nextDayInterestsNudge({ interests: ["hiking"], interestsMax: 99 }, { now: NUDGE_NOW, max: 4 }).max,
    4,
  );
});

test("nextDayInterestsNudge: an invalid stored lastPromptISO is treated as never-shown → shows (no crash)", () => {
  const r = nextDayInterestsNudge({ interests: ["hiking"] }, { now: NUDGE_NOW, lastPromptISO: "not-a-date" });
  assert.equal(r.show, true);
});

test("nextDayInterestsNudge: defaults are safe — no opts uses real time + never-shown", () => {
  // Called with no opts at all (uses `now = new Date()`, `lastPromptISO = null`): 1 pick, never shown
  // → eligible. This pins that the whole options object is optional (the renderer always passes it,
  // but the default must not throw).
  assert.equal(nextDayInterestsNudge({ interests: ["hiking"] }).show, true);
});

// ---- interestCount (TM-777 / I5) --------------------------------------------------------------

test("interestCount: array → length; non-array / missing / null → 0 (tolerates pre-TM-775 /me)", () => {
  assert.equal(interestCount({ interests: ["a", "b"] }), 2);
  assert.equal(interestCount({ interests: [] }), 0);
  assert.equal(interestCount({ interests: "hiking" }), 0); // a string is not an array
  assert.equal(interestCount({ interests: null }), 0);
  assert.equal(interestCount({}), 0); // field absent
  assert.equal(interestCount(null), 0);
  assert.equal(interestCount(undefined), 0);
});

// ---- strengthRingGeometry (TM-913) — the progress-ring dashoffset math ---------------------------
// The profile-strength completeness now renders as a circular SVG progress ring (was a horizontal bar).
// The fill arc is a <circle> with stroke-dasharray = circumference and stroke-dashoffset =
// strengthRingGeometry(percent).dashoffset — the undrawn length, so a higher percent leaves LESS
// undrawn (a fuller arc). These pin the arc→percent relationship the ring depends on.

test("strengthRingGeometry: 0% leaves the WHOLE circle undrawn (empty ring)", () => {
  const g = strengthRingGeometry(0);
  assert.equal(g.circumference, 2 * Math.PI * 42);
  // dashoffset == circumference → nothing drawn.
  assert.equal(g.dashoffset, g.circumference);
});

test("strengthRingGeometry: 100% leaves nothing undrawn (full ring)", () => {
  const g = strengthRingGeometry(100);
  assert.equal(g.dashoffset, 0);
});

test("strengthRingGeometry: a partial percent offsets proportionally (60% → 40% undrawn)", () => {
  const g = strengthRingGeometry(60);
  // 60% filled → 40% of the circumference remains undrawn.
  assert.ok(Math.abs(g.dashoffset - g.circumference * 0.4) < 1e-9,
    "dashoffset must be (1 − percent/100) · circumference");
});

test("strengthRingGeometry: the five 20%-step strength values map to distinct, monotonic offsets", () => {
  // profileStrength() yields 0/20/40/60/80/100 (5 fields). The ring must shrink the undrawn arc
  // monotonically as strength rises — each step a smaller offset than the last.
  const offsets = [0, 20, 40, 60, 80, 100].map((p) => strengthRingGeometry(p).dashoffset);
  for (let i = 1; i < offsets.length; i++) {
    assert.ok(offsets[i] < offsets[i - 1], `offset must decrease as percent rises (step ${i})`);
  }
});

test("strengthRingGeometry: clamps out-of-range / degraded percent (no negative or over-full arc)", () => {
  const c = strengthRingGeometry(0).circumference;
  assert.equal(strengthRingGeometry(150).dashoffset, 0, "over-100 clamps to a full ring (offset 0)");
  assert.equal(strengthRingGeometry(-20).dashoffset, c, "negative clamps to an empty ring (offset = C)");
  assert.equal(strengthRingGeometry(NaN).dashoffset, c, "a NaN percent falls back to empty, not a broken arc");
});

test("strengthRingGeometry: the arc offset tracks the real profileStrength().percent", () => {
  // The ring is driven by the SAME data source (profileStrength().percent) — a full profile is a full
  // ring, an empty one an empty ring. Proves the ring reflects the computed strength end-to-end.
  const full = profileStrength({ firstName: "Ada", city: "London", age: 30, phone: "+447700900123" }, { hasPhoto: true });
  const empty = profileStrength({}, { hasPhoto: false });
  assert.equal(full.percent, 100);
  assert.equal(empty.percent, 0);
  assert.equal(strengthRingGeometry(full.percent).dashoffset, 0);
  assert.equal(strengthRingGeometry(empty.percent).dashoffset, strengthRingGeometry(0).circumference);
});

// ── Gender buckets + required-choice validator (TM-955) ─────────────────────────────────────────

test("GENDER_OPTIONS / GENDER_VALUES: mirror the backend Gender enum exactly (FEMALE/MALE/PREFER_NOT_TO_SAY)", () => {
  // The values are the enum NAMEs the backend accepts — the profile form + the onboarding gate both
  // build their <select> from this ONE list, so they can never disagree on the allowed set.
  assert.deepEqual(
    GENDER_OPTIONS.map(([value]) => value),
    ["FEMALE", "MALE", "PREFER_NOT_TO_SAY"],
  );
  // Every option carries a human label distinct from the raw enum value.
  for (const [value, label] of GENDER_OPTIONS) {
    assert.equal(typeof label, "string");
    assert.notEqual(label, "");
    assert.notEqual(label, value, "the label must be human copy, not the raw enum token");
  }
  assert.deepEqual([...GENDER_VALUES].sort(), ["FEMALE", "MALE", "PREFER_NOT_TO_SAY"]);
});

test("genderChoiceError: the required gate rule — a blank/absent choice is rejected", () => {
  // TM-955: the onboarding gate demands a choice (mirroring mandatory phone). The blank placeholder,
  // whitespace, null and undefined all fail with the friendly copy.
  for (const blank of ["", "   ", null, undefined]) {
    assert.notEqual(genderChoiceError(blank), "", `blank (${JSON.stringify(blank)}) must be rejected`);
  }
});

test("genderChoiceError: every valid bucket passes — including 'prefer not to say' as a real CHOICE", () => {
  // "Prefer not to say" SATISFIES the requirement — it's a deliberate choice, not the null/never-chose
  // state — so it must pass the gate rule exactly like FEMALE/MALE.
  for (const value of ["FEMALE", "MALE", "PREFER_NOT_TO_SAY"]) {
    assert.equal(genderChoiceError(value), "", `${value} must be accepted`);
  }
});

test("genderChoiceError: an unknown bucket is rejected (closed enum)", () => {
  // The backend Gender enum is closed — a value outside the set can never persist, so the client
  // rejects it up front rather than round-tripping to a 400.
  for (const bad of ["OTHER", "female", "nonbinary", "M"]) {
    assert.notEqual(genderChoiceError(bad), "", `${bad} must be rejected`);
  }
});

// ── Collapsible profile sections (TM-879) — the pure disclosure model ──────────────────────────────
// These guard the section catalogue + defaults, the per-user localStorage key, and the resolve/toggle
// state decisions the profile.js renderer maps to disclosure buttons/panels. Fail-before/pass-after:
// each assertion pins a groomed contract (the exact default-open/collapsed layout, identity pinned,
// Sign out never inside a collapsible, per-uid persistence) so a regression flips it red.

test("PROFILE_SECTIONS: the groomed order + default open/collapsed states (TM-879)", () => {
  // The exact catalogue order the hub renders (identity header is NOT in it — it's pinned separately).
  assert.deepEqual(
    PROFILE_SECTIONS.map((s) => s.id),
    ["strength", "interests", "membership", "edit", "security", "appearance", "diagnostics"],
    "sections render in the groomed order",
  );
  // The groomed defaults: strength + interests OPEN, everything else COLLAPSED.
  const defaults = Object.fromEntries(PROFILE_SECTIONS.map((s) => [s.id, s.defaultOpen]));
  assert.equal(defaults.strength, true, "Profile strength defaults OPEN");
  assert.equal(defaults.interests, true, "Interests defaults OPEN");
  assert.equal(defaults.membership, false, "Membership defaults COLLAPSED");
  assert.equal(defaults.edit, false, "Edit profile defaults COLLAPSED");
  assert.equal(defaults.security, false, "Security defaults COLLAPSED");
  assert.equal(defaults.appearance, false, "Appearance defaults COLLAPSED");
  assert.equal(defaults.diagnostics, false, "Diagnostics defaults COLLAPSED");
});

test("PROFILE_SECTIONS: the identity header is PINNED — never a collapsible section (TM-879)", () => {
  // The identity/anchor header (avatar/name/city·age/email/phone/badges) is deliberately NOT in the
  // collapsible catalogue — it's rendered pinned above the sections. Guard that it never sneaks in.
  const ids = PROFILE_SECTIONS.map((s) => s.id);
  for (const pinned of ["identity", "header", "id"]) {
    assert.ok(!ids.includes(pinned), `the pinned identity header must not be a collapsible section (${pinned})`);
  }
});

test("PROFILE_SECTIONS: the action rows (incl. Sign out) are NEVER a collapsible section (TM-879)", () => {
  // Notifications / Public profile / Privacy / Sign out are action rows OUTSIDE the collapsible region
  // so Sign out (the app's only sign-out entry, TM-906) can never end up hidden inside a collapsed
  // section. None of those live in the section catalogue.
  const ids = PROFILE_SECTIONS.map((s) => s.id);
  for (const action of ["signout", "sign-out", "signOut", "notifications", "privacy", "menu", "actions", "public"]) {
    assert.ok(!ids.includes(action), `action row '${action}' must not be a collapsible section (Sign out stays reachable)`);
  }
});

test("profileSectionsStateKey: per-uid, versioned, anon fallback (TM-879)", () => {
  assert.equal(profileSectionsStateKey("abc123"), "tm.profileSections.v1.abc123");
  // Distinct uids → distinct keys, so one user's layout never leaks onto another on a shared device.
  assert.notEqual(profileSectionsStateKey("userA"), profileSectionsStateKey("userB"));
  // A falsy uid (signed-out / pre-load render) falls back to a stable "anon" key rather than crashing.
  assert.equal(profileSectionsStateKey(""), "tm.profileSections.v1.anon");
  assert.equal(profileSectionsStateKey(undefined), "tm.profileSections.v1.anon");
  assert.equal(profileSectionsStateKey(null), "tm.profileSections.v1.anon");
});

test("resolveSectionState: nothing stored → the groomed defaults verbatim (TM-879)", () => {
  const state = resolveSectionState(null);
  assert.deepEqual(state, {
    strength: true, interests: true, membership: false, edit: false,
    security: false, appearance: false, diagnostics: false,
  });
  // A completely empty saved object is also just the defaults.
  assert.deepEqual(resolveSectionState({}), state);
});

test("resolveSectionState: a saved override is layered over the defaults (TM-879)", () => {
  // The user collapsed strength and expanded edit + security — those overrides win; the rest default.
  const state = resolveSectionState({ strength: false, edit: true, security: true });
  assert.equal(state.strength, false, "a saved collapse of a default-open section is honoured");
  assert.equal(state.edit, true, "a saved expand of a default-collapsed section is honoured");
  assert.equal(state.security, true);
  assert.equal(state.interests, true, "an unmentioned section keeps its default (open)");
  assert.equal(state.membership, false, "an unmentioned section keeps its default (collapsed)");
  // Always a COMPLETE map — every catalogue section is present regardless of what was saved.
  assert.deepEqual(Object.keys(state).sort(), PROFILE_SECTIONS.map((s) => s.id).sort());
});

test("resolveSectionState: a stale/unknown id or a non-boolean value is ignored (TM-879)", () => {
  // A key from an earlier catalogue (a since-removed section) must not poison the map, and a non-boolean
  // value (a corrupt blob, a stringy "true") must fall back to the section's default — a section always
  // resolves to a real, known state rather than vanishing or carrying junk.
  const state = resolveSectionState({ ghostSection: true, edit: "true", strength: 0, interests: null });
  assert.ok(!("ghostSection" in state), "an unknown id is dropped");
  assert.equal(state.edit, false, "a stringy 'true' is ignored → the default (collapsed) stands");
  assert.equal(state.strength, true, "a numeric 0 is ignored → the default (open) stands");
  assert.equal(state.interests, true, "a null is ignored → the default (open) stands");
});

test("toggleSectionState: flips one section, returns a complete NEW blob, never mutates input (TM-879)", () => {
  const current = resolveSectionState(null); // defaults
  const next = toggleSectionState(current, "edit"); // edit was collapsed → now open
  assert.equal(next.edit, true, "toggling a collapsed section opens it");
  assert.equal(current.edit, false, "the input state is not mutated");
  assert.notStrictEqual(next, current, "a NEW object is returned");
  // Every OTHER section is unchanged — an independent (not single-open) accordion.
  assert.equal(next.strength, true);
  assert.equal(next.interests, true);
  assert.equal(next.membership, false);
  // Toggling back closes it again.
  assert.equal(toggleSectionState(next, "edit").edit, false, "toggling an open section collapses it");
});

test("toggleSectionState: independent (multi-open) — toggling one leaves the others' state intact (TM-879)", () => {
  // Prove it is NOT a single-open accordion: opening a second section does not close the first.
  let state = resolveSectionState(null); // strength + interests open
  state = toggleSectionState(state, "membership", true); // open a 3rd
  state = toggleSectionState(state, "security", true); //   open a 4th
  assert.equal(state.strength, true, "the originally-open strength stays open");
  assert.equal(state.interests, true, "the originally-open interests stays open");
  assert.equal(state.membership, true);
  assert.equal(state.security, true, "opening a section does NOT collapse the others (multi-open)");
});

test("toggleSectionState: an explicit `open` forces the value; an unknown id is a safe no-op (TM-879)", () => {
  const current = resolveSectionState(null);
  // Forcing open an already-open section is idempotent (stays open, not toggled shut).
  assert.equal(toggleSectionState(current, "strength", true).strength, true);
  // Forcing collapsed.
  assert.equal(toggleSectionState(current, "strength", false).strength, false);
  // An unknown id can't poison the blob — the state comes back a valid, complete default map.
  const noop = toggleSectionState(current, "ghost");
  assert.deepEqual(noop, current, "toggling an unknown section id is a no-op");
});
