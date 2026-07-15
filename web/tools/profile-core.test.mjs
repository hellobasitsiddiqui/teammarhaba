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
  profileStrength,
  publicSummary,
  formatJoined,
  phoneFormatError,
} from "../src/assets/profile-core.js";

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
  assert.equal(identitySummary({ firstName: "A", city: "Bath" }).metaLine, "Bath");
  assert.equal(identitySummary({ firstName: "A", age: 40 }).metaLine, "40");
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
