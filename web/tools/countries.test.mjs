// Tests for the country dial-code data behind the profile phone picker (TM-781). Framework-free —
// Node's built-in test runner, the same harness as profile-core.test.mjs, picked up by the CI glob
// `node --test web/tools/*.test.mjs`.
//
// These guard the DATA INVARIANTS the picker and the E.164 split/compose logic depend on:
//   • pinning — 🇬🇧 United Kingdom then 🇦🇪 United Arab Emirates ALWAYS lead the list, the rest is
//     name-sorted (the product rule for the <select> ordering);
//   • shape — every entry is a { name, iso2, dial } with a 2-letter ISO code and a 1–4 digit dial
//     code, iso2 unique (duplicate iso2 would make split→select round-trips ambiguous);
//   • flags — flagOf derives the emoji from the iso2 via Unicode regional indicators (CSP is
//     self-only: no flag sprites/CDN allowed, the emoji IS the asset);
//   • city hints — cityCountryHint is the curated city→country soft-default map (case/whitespace
//     insensitive, null for unknown so the caller can apply its own GB fallback);
//   • dial resolution — countryForDial resolves shared dial codes to their canonical owner
//     (+1 → US not Canada/the NANP islands, +7 → RU not KZ, +44 → GB not the Crown dependencies),
//     which is what makes splitE164's longest-match deterministic;
//   • NANP model — every NANP member carries dial "1" (the one code composeE164 may emit); the
//     "1"+area-code entries exist only to RESOLVE the country on split, so split→compose is a
//     strict round-trip and a +1829… number is never rewritten onto +1809… (TM-781 review, HIGH);
//   • trunk-zero — keepsTrunkZero marks exactly the Italian-plan countries whose E.164 keeps the
//     national "0", so composeE164 must not strip it (TM-781 review).

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COUNTRIES,
  flagOf,
  cityCountryHint,
  countryByIso2,
  countryForDial,
  DIALS_LONGEST_FIRST,
} from "../src/assets/countries.js";

// ---- pinning + ordering -------------------------------------------------------------------------

test("COUNTRIES pins United Kingdom then United Arab Emirates at the top", () => {
  assert.equal(COUNTRIES[0].iso2, "GB");
  assert.equal(COUNTRIES[0].name, "United Kingdom");
  assert.equal(COUNTRIES[0].dial, "44");
  assert.equal(COUNTRIES[1].iso2, "AE");
  assert.equal(COUNTRIES[1].name, "United Arab Emirates");
  assert.equal(COUNTRIES[1].dial, "971");
});

test("COUNTRIES after the pinned pair is sorted by name", () => {
  const rest = COUNTRIES.slice(2);
  for (let i = 1; i < rest.length; i++) {
    assert.ok(
      rest[i - 1].name.localeCompare(rest[i].name, "en") <= 0,
      `'${rest[i - 1].name}' must sort before '${rest[i].name}'`,
    );
  }
  // The pinned two must not ALSO appear in the sorted tail (no duplicates from the pinning step).
  assert.ok(!rest.some((c) => c.iso2 === "GB" || c.iso2 === "AE"));
});

// ---- shape --------------------------------------------------------------------------------------

test("COUNTRIES covers the ISO-3166 list with well-formed entries and unique iso2 codes", () => {
  // ~240 ISO-3166 entries with ITU dial codes; the floor guards against the list being accidentally
  // truncated in a refactor without pinning the exact count (small curation changes are fine).
  assert.ok(COUNTRIES.length >= 230, `expected a near-complete list, got ${COUNTRIES.length}`);
  const seen = new Set();
  for (const c of COUNTRIES) {
    assert.ok(typeof c.name === "string" && c.name.trim() !== "", "every country has a name");
    assert.match(c.iso2, /^[A-Z]{2}$/, `iso2 '${c.iso2}' must be two uppercase letters`);
    assert.match(c.dial, /^[1-9][0-9]{0,3}$/, `dial '${c.dial}' must be 1–4 digits, no leading 0`);
    assert.ok(!seen.has(c.iso2), `duplicate iso2 '${c.iso2}'`);
    seen.add(c.iso2);
  }
});

test("COUNTRIES includes the dial codes the split tests rely on", () => {
  // Bahamas COMPOSES on the shared NANP "+1" (its area code 242 lives in the national number);
  // "+1242…" still RESOLVES to it via the prefix table — see the longest-match tests below.
  assert.equal(countryByIso2("BS").dial, "1");
  assert.equal(countryForDial("1242").iso2, "BS");
  assert.equal(countryByIso2("US").dial, "1");
  assert.equal(countryByIso2("SA").dial, "966"); // Saudi Arabia — a city-hint target
});

test("every NANP member composes on the single '+1' country code (TM-781 review: split/compose symmetry)", () => {
  // If any of these carried a "1XXX" dial, composeE164 would emit "+1XXX"+national while splitE164
  // keeps the area code in the national part — the asymmetry that silently rewrote +1829… numbers
  // to +1809… on every save. The area codes belong in the RESOLUTION prefixes only.
  const nanp = ["US", "CA", "BS", "BB", "AI", "AG", "VG", "VI", "KY", "BM", "GD", "TC", "JM",
    "MS", "MP", "GU", "AS", "SX", "LC", "DM", "VC", "PR", "DO", "TT", "KN"];
  for (const iso2 of nanp) {
    assert.equal(countryByIso2(iso2)?.dial, "1", `${iso2} must compose on +1`);
  }
});

test("keepsTrunkZero marks exactly the Italian-plan countries (TM-781 review: trunk-0 preservation)", () => {
  // Italy (and the states inside its numbering plan) KEEP the national trunk 0 in E.164 —
  // "+390612345678" is correct. Everyone else must NOT carry the flag, or composeE164 would stop
  // stripping the "07700…" trunk zero GB/AE/SA users naturally type.
  const flagged = COUNTRIES.filter((c) => c.keepsTrunkZero).map((c) => c.iso2).sort();
  assert.deepEqual(flagged, ["IT", "SM", "VA"]);
});

// ---- flagOf -------------------------------------------------------------------------------------

test("flagOf derives the emoji flag from the iso2 via regional indicators", () => {
  assert.equal(flagOf("GB"), "🇬🇧");
  assert.equal(flagOf("AE"), "🇦🇪");
  assert.equal(flagOf("ae"), "🇦🇪"); // case-insensitive — callers shouldn't have to normalise
});

test("flagOf returns '' for anything that isn't a 2-letter code", () => {
  assert.equal(flagOf(""), "");
  assert.equal(flagOf(null), "");
  assert.equal(flagOf("G"), "");
  assert.equal(flagOf("GBR"), "");
  assert.equal(flagOf("G1"), "");
});

// ---- cityCountryHint ----------------------------------------------------------------------------

test("cityCountryHint maps the curated cities, case- and whitespace-insensitively", () => {
  assert.equal(cityCountryHint("London"), "GB");
  assert.equal(cityCountryHint("  london  "), "GB");
  assert.equal(cityCountryHint("MANCHESTER"), "GB");
  assert.equal(cityCountryHint("Birmingham"), "GB");
  assert.equal(cityCountryHint("Milton  Keynes"), "GB"); // internal whitespace collapses too
  assert.equal(cityCountryHint("Dubai"), "AE");
  assert.equal(cityCountryHint("Abu Dhabi"), "AE");
  assert.equal(cityCountryHint("Sharjah"), "AE");
  assert.equal(cityCountryHint("Riyadh"), "SA");
  assert.equal(cityCountryHint("jeddah"), "SA");
  // TM-877: every city offered by the profile dropdown (profile-core CITY_OPTIONS) must resolve a
  // phone-picker soft default, or picking it would silently break the TM-781 country pre-select.
  assert.equal(cityCountryHint("Karachi"), "PK");
});

test("cityCountryHint returns null for unknown/blank cities (the caller owns the GB fallback)", () => {
  assert.equal(cityCountryHint("Paris"), null);
  assert.equal(cityCountryHint(""), null);
  assert.equal(cityCountryHint("   "), null);
  assert.equal(cityCountryHint(null), null);
  assert.equal(cityCountryHint(undefined), null);
});

// ---- countryByIso2 / countryForDial -------------------------------------------------------------

test("countryByIso2 looks up case-insensitively and returns null for unknowns", () => {
  assert.equal(countryByIso2("gb").name, "United Kingdom");
  assert.equal(countryByIso2("GB").dial, "44");
  assert.equal(countryByIso2("ZZ"), null);
  assert.equal(countryByIso2(""), null);
  assert.equal(countryByIso2(null), null);
});

test("countryForDial resolves SHARED dial codes to the canonical owner", () => {
  // These dials are shared by several territories; splitE164 must land on the country a user
  // would expect, not whichever happens to sort first alphabetically.
  assert.equal(countryForDial("1").iso2, "US"); // not Canada / the NANP islands
  assert.equal(countryForDial("7").iso2, "RU"); // not Kazakhstan
  assert.equal(countryForDial("44").iso2, "GB"); // not Guernsey/Isle of Man/Jersey
  assert.equal(countryForDial("39").iso2, "IT"); // not Vatican City
  assert.equal(countryForDial("61").iso2, "AU"); // not Christmas/Cocos Islands
  assert.equal(countryForDial("212").iso2, "MA"); // not Western Sahara
  assert.equal(countryForDial("1242").iso2, "BS"); // an island's area-code prefix resolves to it
  assert.equal(countryForDial("9999"), null);
});

test("countryForDial knows the NANP prefixes — including the secondary area codes", () => {
  // The Dominican Republic answers on 809/829/849, Puerto Rico on 787/939, Jamaica on 876/658 —
  // real stored numbers use them, so split must not misfile those users under +1 US. Each entry's
  // compose code stays "+1": the prefix picks the COUNTRY, the area code stays in the national part.
  assert.equal(countryForDial("1829").iso2, "DO");
  assert.equal(countryForDial("1849").iso2, "DO");
  assert.equal(countryForDial("1939").iso2, "PR");
  assert.equal(countryForDial("1658").iso2, "JM");
  assert.equal(countryForDial("1829").dial, "1");
  assert.equal(countryForDial("1242").dial, "1");
});

test("DIALS_LONGEST_FIRST is ordered longest→shortest so prefix matching is longest-match", () => {
  for (let i = 1; i < DIALS_LONGEST_FIRST.length; i++) {
    assert.ok(
      DIALS_LONGEST_FIRST[i - 1].length >= DIALS_LONGEST_FIRST[i].length,
      "a longer dial code must never appear after a shorter one",
    );
  }
  // Both the specific island code and the bare NANP code are present — the ordering above is what
  // makes '+1242…' hit Bahamas before '+1…' hits US.
  assert.ok(DIALS_LONGEST_FIRST.includes("1242"));
  assert.ok(DIALS_LONGEST_FIRST.includes("1"));
});
