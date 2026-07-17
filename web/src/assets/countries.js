// Country dial-code data for the profile phone picker (TM-781) — pure, DOM-free, Node-importable
// (unit-tested in web/tools/countries.test.mjs, the same extraction pattern as profile-core.js).
//
// WHY hand-rolled: the app's CSP is self-only (no CDN/external assets), so libphonenumber or a flag
// sprite can't be pulled in. Flags are therefore Unicode regional-indicator EMOJI derived from the
// ISO-3166 alpha-2 code (`flagOf`) — the emoji IS the asset — and the dial-code list is a small
// curated dataset here. Dial codes are stable ITU E.164 assignments; the list is near-complete
// ISO-3166 (~240 entries) so any user can pick their country.
//
// Consumers: profile-core.js (splitE164/composeE164/defaultCountryFor — the pure E.164 rules) and
// profile.js (renders the <select> options as "<emoji flag> <Country name> +<dial>").

// The raw ISO-3166 → ITU dial-code dataset, alphabetical by name for maintainability. Ordering here
// is NOT the display order — COUNTRIES below pins GB + AE first and name-sorts the rest, so an
// entry added anywhere in this list still lands in the right place.
//
// Shared dial codes (several territories on one code, e.g. +1, +7, +44, +590) are deliberately
// listed on EVERY territory so each appears in the picker; which one a stored number resolves to is
// decided by DIAL_TIEBREAK / NANP_PREFIXES below, not list order.
//
// NANP note: every North American Numbering Plan member (US, Canada, the Caribbean territories)
// carries dial "1" — the ONE country code they all share and the only thing composeE164 may emit.
// The three-digit AREA code that identifies the territory stays inside the national number; it is
// used purely to RESOLVE the picker country on split (NANP_PREFIXES). Composing with a
// per-territory "dial" like "1809" was a TM-781 review HIGH finding: a stored +1829/+1849/+1939/
// +1658 number re-composed onto the territory's primary code, silently rewriting the phone to a
// different subscriber's number on any profile save.
//
// `keepsTrunkZero` marks countries whose E.164 form KEEPS the national trunk "0" (the Italian
// numbering plan: IT, VA, and SM landlines) — nationalDigits in profile-core must not strip it,
// or a correctly stored "+3906…" number would be corrupted on re-save (a TM-781 review finding).
const RAW = [
  { name: "Afghanistan", iso2: "AF", dial: "93" },
  { name: "Albania", iso2: "AL", dial: "355" },
  { name: "Algeria", iso2: "DZ", dial: "213" },
  { name: "American Samoa", iso2: "AS", dial: "1" },
  { name: "Andorra", iso2: "AD", dial: "376" },
  { name: "Angola", iso2: "AO", dial: "244" },
  { name: "Anguilla", iso2: "AI", dial: "1" },
  { name: "Antigua and Barbuda", iso2: "AG", dial: "1" },
  { name: "Argentina", iso2: "AR", dial: "54" },
  { name: "Armenia", iso2: "AM", dial: "374" },
  { name: "Aruba", iso2: "AW", dial: "297" },
  { name: "Australia", iso2: "AU", dial: "61" },
  { name: "Austria", iso2: "AT", dial: "43" },
  { name: "Azerbaijan", iso2: "AZ", dial: "994" },
  { name: "Bahamas", iso2: "BS", dial: "1" },
  { name: "Bahrain", iso2: "BH", dial: "973" },
  { name: "Bangladesh", iso2: "BD", dial: "880" },
  { name: "Barbados", iso2: "BB", dial: "1" },
  { name: "Belarus", iso2: "BY", dial: "375" },
  { name: "Belgium", iso2: "BE", dial: "32" },
  { name: "Belize", iso2: "BZ", dial: "501" },
  { name: "Benin", iso2: "BJ", dial: "229" },
  { name: "Bermuda", iso2: "BM", dial: "1" },
  { name: "Bhutan", iso2: "BT", dial: "975" },
  { name: "Bolivia", iso2: "BO", dial: "591" },
  { name: "Bosnia and Herzegovina", iso2: "BA", dial: "387" },
  { name: "Botswana", iso2: "BW", dial: "267" },
  { name: "Brazil", iso2: "BR", dial: "55" },
  { name: "British Indian Ocean Territory", iso2: "IO", dial: "246" },
  { name: "British Virgin Islands", iso2: "VG", dial: "1" },
  { name: "Brunei", iso2: "BN", dial: "673" },
  { name: "Bulgaria", iso2: "BG", dial: "359" },
  { name: "Burkina Faso", iso2: "BF", dial: "226" },
  { name: "Burundi", iso2: "BI", dial: "257" },
  { name: "Cambodia", iso2: "KH", dial: "855" },
  { name: "Cameroon", iso2: "CM", dial: "237" },
  { name: "Canada", iso2: "CA", dial: "1" },
  { name: "Cape Verde", iso2: "CV", dial: "238" },
  { name: "Caribbean Netherlands", iso2: "BQ", dial: "599" },
  { name: "Cayman Islands", iso2: "KY", dial: "1" },
  { name: "Central African Republic", iso2: "CF", dial: "236" },
  { name: "Chad", iso2: "TD", dial: "235" },
  { name: "Chile", iso2: "CL", dial: "56" },
  { name: "China", iso2: "CN", dial: "86" },
  { name: "Christmas Island", iso2: "CX", dial: "61" },
  { name: "Cocos (Keeling) Islands", iso2: "CC", dial: "61" },
  { name: "Colombia", iso2: "CO", dial: "57" },
  { name: "Comoros", iso2: "KM", dial: "269" },
  { name: "Congo (DRC)", iso2: "CD", dial: "243" },
  { name: "Congo (Republic)", iso2: "CG", dial: "242" },
  { name: "Cook Islands", iso2: "CK", dial: "682" },
  { name: "Costa Rica", iso2: "CR", dial: "506" },
  { name: "Côte d'Ivoire", iso2: "CI", dial: "225" },
  { name: "Croatia", iso2: "HR", dial: "385" },
  { name: "Cuba", iso2: "CU", dial: "53" },
  { name: "Curaçao", iso2: "CW", dial: "599" },
  { name: "Cyprus", iso2: "CY", dial: "357" },
  { name: "Czechia", iso2: "CZ", dial: "420" },
  { name: "Denmark", iso2: "DK", dial: "45" },
  { name: "Djibouti", iso2: "DJ", dial: "253" },
  { name: "Dominica", iso2: "DM", dial: "1" },
  { name: "Dominican Republic", iso2: "DO", dial: "1" },
  { name: "Ecuador", iso2: "EC", dial: "593" },
  { name: "Egypt", iso2: "EG", dial: "20" },
  { name: "El Salvador", iso2: "SV", dial: "503" },
  { name: "Equatorial Guinea", iso2: "GQ", dial: "240" },
  { name: "Eritrea", iso2: "ER", dial: "291" },
  { name: "Estonia", iso2: "EE", dial: "372" },
  { name: "Eswatini", iso2: "SZ", dial: "268" },
  { name: "Ethiopia", iso2: "ET", dial: "251" },
  { name: "Falkland Islands", iso2: "FK", dial: "500" },
  { name: "Faroe Islands", iso2: "FO", dial: "298" },
  { name: "Fiji", iso2: "FJ", dial: "679" },
  { name: "Finland", iso2: "FI", dial: "358" },
  { name: "France", iso2: "FR", dial: "33" },
  { name: "French Guiana", iso2: "GF", dial: "594" },
  { name: "French Polynesia", iso2: "PF", dial: "689" },
  { name: "Gabon", iso2: "GA", dial: "241" },
  { name: "Gambia", iso2: "GM", dial: "220" },
  { name: "Georgia", iso2: "GE", dial: "995" },
  { name: "Germany", iso2: "DE", dial: "49" },
  { name: "Ghana", iso2: "GH", dial: "233" },
  { name: "Gibraltar", iso2: "GI", dial: "350" },
  { name: "Greece", iso2: "GR", dial: "30" },
  { name: "Greenland", iso2: "GL", dial: "299" },
  { name: "Grenada", iso2: "GD", dial: "1" },
  { name: "Guadeloupe", iso2: "GP", dial: "590" },
  { name: "Guam", iso2: "GU", dial: "1" },
  { name: "Guatemala", iso2: "GT", dial: "502" },
  { name: "Guernsey", iso2: "GG", dial: "44" },
  { name: "Guinea", iso2: "GN", dial: "224" },
  { name: "Guinea-Bissau", iso2: "GW", dial: "245" },
  { name: "Guyana", iso2: "GY", dial: "592" },
  { name: "Haiti", iso2: "HT", dial: "509" },
  { name: "Honduras", iso2: "HN", dial: "504" },
  { name: "Hong Kong", iso2: "HK", dial: "852" },
  { name: "Hungary", iso2: "HU", dial: "36" },
  { name: "Iceland", iso2: "IS", dial: "354" },
  { name: "India", iso2: "IN", dial: "91" },
  { name: "Indonesia", iso2: "ID", dial: "62" },
  { name: "Iran", iso2: "IR", dial: "98" },
  { name: "Iraq", iso2: "IQ", dial: "964" },
  { name: "Ireland", iso2: "IE", dial: "353" },
  { name: "Isle of Man", iso2: "IM", dial: "44" },
  { name: "Israel", iso2: "IL", dial: "972" },
  { name: "Italy", iso2: "IT", dial: "39", keepsTrunkZero: true },
  { name: "Jamaica", iso2: "JM", dial: "1" },
  { name: "Japan", iso2: "JP", dial: "81" },
  { name: "Jersey", iso2: "JE", dial: "44" },
  { name: "Jordan", iso2: "JO", dial: "962" },
  { name: "Kazakhstan", iso2: "KZ", dial: "7" },
  { name: "Kenya", iso2: "KE", dial: "254" },
  { name: "Kiribati", iso2: "KI", dial: "686" },
  { name: "Kosovo", iso2: "XK", dial: "383" },
  { name: "Kuwait", iso2: "KW", dial: "965" },
  { name: "Kyrgyzstan", iso2: "KG", dial: "996" },
  { name: "Laos", iso2: "LA", dial: "856" },
  { name: "Latvia", iso2: "LV", dial: "371" },
  { name: "Lebanon", iso2: "LB", dial: "961" },
  { name: "Lesotho", iso2: "LS", dial: "266" },
  { name: "Liberia", iso2: "LR", dial: "231" },
  { name: "Libya", iso2: "LY", dial: "218" },
  { name: "Liechtenstein", iso2: "LI", dial: "423" },
  { name: "Lithuania", iso2: "LT", dial: "370" },
  { name: "Luxembourg", iso2: "LU", dial: "352" },
  { name: "Macau", iso2: "MO", dial: "853" },
  { name: "Madagascar", iso2: "MG", dial: "261" },
  { name: "Malawi", iso2: "MW", dial: "265" },
  { name: "Malaysia", iso2: "MY", dial: "60" },
  { name: "Maldives", iso2: "MV", dial: "960" },
  { name: "Mali", iso2: "ML", dial: "223" },
  { name: "Malta", iso2: "MT", dial: "356" },
  { name: "Marshall Islands", iso2: "MH", dial: "692" },
  { name: "Martinique", iso2: "MQ", dial: "596" },
  { name: "Mauritania", iso2: "MR", dial: "222" },
  { name: "Mauritius", iso2: "MU", dial: "230" },
  { name: "Mayotte", iso2: "YT", dial: "262" },
  { name: "Mexico", iso2: "MX", dial: "52" },
  { name: "Micronesia", iso2: "FM", dial: "691" },
  { name: "Moldova", iso2: "MD", dial: "373" },
  { name: "Monaco", iso2: "MC", dial: "377" },
  { name: "Mongolia", iso2: "MN", dial: "976" },
  { name: "Montenegro", iso2: "ME", dial: "382" },
  { name: "Montserrat", iso2: "MS", dial: "1" },
  { name: "Morocco", iso2: "MA", dial: "212" },
  { name: "Mozambique", iso2: "MZ", dial: "258" },
  { name: "Myanmar", iso2: "MM", dial: "95" },
  { name: "Namibia", iso2: "NA", dial: "264" },
  { name: "Nauru", iso2: "NR", dial: "674" },
  { name: "Nepal", iso2: "NP", dial: "977" },
  { name: "Netherlands", iso2: "NL", dial: "31" },
  { name: "New Caledonia", iso2: "NC", dial: "687" },
  { name: "New Zealand", iso2: "NZ", dial: "64" },
  { name: "Nicaragua", iso2: "NI", dial: "505" },
  { name: "Niger", iso2: "NE", dial: "227" },
  { name: "Nigeria", iso2: "NG", dial: "234" },
  { name: "Niue", iso2: "NU", dial: "683" },
  { name: "Norfolk Island", iso2: "NF", dial: "672" },
  { name: "North Korea", iso2: "KP", dial: "850" },
  { name: "North Macedonia", iso2: "MK", dial: "389" },
  { name: "Northern Mariana Islands", iso2: "MP", dial: "1" },
  { name: "Norway", iso2: "NO", dial: "47" },
  { name: "Oman", iso2: "OM", dial: "968" },
  { name: "Pakistan", iso2: "PK", dial: "92" },
  { name: "Palau", iso2: "PW", dial: "680" },
  { name: "Palestine", iso2: "PS", dial: "970" },
  { name: "Panama", iso2: "PA", dial: "507" },
  { name: "Papua New Guinea", iso2: "PG", dial: "675" },
  { name: "Paraguay", iso2: "PY", dial: "595" },
  { name: "Peru", iso2: "PE", dial: "51" },
  { name: "Philippines", iso2: "PH", dial: "63" },
  { name: "Poland", iso2: "PL", dial: "48" },
  { name: "Portugal", iso2: "PT", dial: "351" },
  { name: "Puerto Rico", iso2: "PR", dial: "1" },
  { name: "Qatar", iso2: "QA", dial: "974" },
  { name: "Réunion", iso2: "RE", dial: "262" },
  { name: "Romania", iso2: "RO", dial: "40" },
  { name: "Russia", iso2: "RU", dial: "7" },
  { name: "Rwanda", iso2: "RW", dial: "250" },
  { name: "Saint Barthélemy", iso2: "BL", dial: "590" },
  { name: "Saint Helena", iso2: "SH", dial: "290" },
  { name: "Saint Kitts and Nevis", iso2: "KN", dial: "1" },
  { name: "Saint Lucia", iso2: "LC", dial: "1" },
  { name: "Saint Martin", iso2: "MF", dial: "590" },
  { name: "Saint Pierre and Miquelon", iso2: "PM", dial: "508" },
  { name: "Saint Vincent and the Grenadines", iso2: "VC", dial: "1" },
  { name: "Samoa", iso2: "WS", dial: "685" },
  { name: "San Marino", iso2: "SM", dial: "378", keepsTrunkZero: true },
  { name: "São Tomé and Príncipe", iso2: "ST", dial: "239" },
  { name: "Saudi Arabia", iso2: "SA", dial: "966" },
  { name: "Senegal", iso2: "SN", dial: "221" },
  { name: "Serbia", iso2: "RS", dial: "381" },
  { name: "Seychelles", iso2: "SC", dial: "248" },
  { name: "Sierra Leone", iso2: "SL", dial: "232" },
  { name: "Singapore", iso2: "SG", dial: "65" },
  { name: "Sint Maarten", iso2: "SX", dial: "1" },
  { name: "Slovakia", iso2: "SK", dial: "421" },
  { name: "Slovenia", iso2: "SI", dial: "386" },
  { name: "Solomon Islands", iso2: "SB", dial: "677" },
  { name: "Somalia", iso2: "SO", dial: "252" },
  { name: "South Africa", iso2: "ZA", dial: "27" },
  { name: "South Korea", iso2: "KR", dial: "82" },
  { name: "South Sudan", iso2: "SS", dial: "211" },
  { name: "Spain", iso2: "ES", dial: "34" },
  { name: "Sri Lanka", iso2: "LK", dial: "94" },
  { name: "Sudan", iso2: "SD", dial: "249" },
  { name: "Suriname", iso2: "SR", dial: "597" },
  { name: "Sweden", iso2: "SE", dial: "46" },
  { name: "Switzerland", iso2: "CH", dial: "41" },
  { name: "Syria", iso2: "SY", dial: "963" },
  { name: "Taiwan", iso2: "TW", dial: "886" },
  { name: "Tajikistan", iso2: "TJ", dial: "992" },
  { name: "Tanzania", iso2: "TZ", dial: "255" },
  { name: "Thailand", iso2: "TH", dial: "66" },
  { name: "Timor-Leste", iso2: "TL", dial: "670" },
  { name: "Togo", iso2: "TG", dial: "228" },
  { name: "Tokelau", iso2: "TK", dial: "690" },
  { name: "Tonga", iso2: "TO", dial: "676" },
  { name: "Trinidad and Tobago", iso2: "TT", dial: "1" },
  { name: "Tunisia", iso2: "TN", dial: "216" },
  { name: "Turkey", iso2: "TR", dial: "90" },
  { name: "Turkmenistan", iso2: "TM", dial: "993" },
  { name: "Turks and Caicos Islands", iso2: "TC", dial: "1" },
  { name: "Tuvalu", iso2: "TV", dial: "688" },
  { name: "Uganda", iso2: "UG", dial: "256" },
  { name: "Ukraine", iso2: "UA", dial: "380" },
  { name: "United Arab Emirates", iso2: "AE", dial: "971" },
  { name: "United Kingdom", iso2: "GB", dial: "44" },
  { name: "United States", iso2: "US", dial: "1" },
  { name: "Uruguay", iso2: "UY", dial: "598" },
  { name: "US Virgin Islands", iso2: "VI", dial: "1" },
  { name: "Uzbekistan", iso2: "UZ", dial: "998" },
  { name: "Vanuatu", iso2: "VU", dial: "678" },
  { name: "Vatican City", iso2: "VA", dial: "39", keepsTrunkZero: true },
  { name: "Venezuela", iso2: "VE", dial: "58" },
  { name: "Vietnam", iso2: "VN", dial: "84" },
  { name: "Wallis and Futuna", iso2: "WF", dial: "681" },
  { name: "Western Sahara", iso2: "EH", dial: "212" },
  { name: "Yemen", iso2: "YE", dial: "967" },
  { name: "Zambia", iso2: "ZM", dial: "260" },
  { name: "Zimbabwe", iso2: "ZW", dial: "263" },
];

// The product rule for picker ordering: United Kingdom then United Arab Emirates are ALWAYS pinned
// at the top (the app's primary user bases), everything else follows sorted by name.
const PINNED = ["GB", "AE"];

/**
 * The display-ordered country list for the phone picker: GB, AE, then the rest name-sorted.
 * Frozen (entries too) — it's shared module-level data; nothing should mutate it at runtime.
 * @type {ReadonlyArray<{name: string, iso2: string, dial: string, keepsTrunkZero?: boolean}>}
 */
export const COUNTRIES = Object.freeze([
  ...PINNED.map((iso2) => RAW.find((c) => c.iso2 === iso2)),
  ...RAW.filter((c) => !PINNED.includes(c.iso2)).sort((a, b) => a.name.localeCompare(b.name, "en")),
].map(Object.freeze));

// iso2 → entry lookup, built once. Keys are uppercase; countryByIso2 normalises its input.
const BY_ISO2 = new Map(COUNTRIES.map((c) => [c.iso2, c]));

/**
 * WHO owns a dial code that several territories share. Without this, splitE164's resolution would
 * fall to alphabetical accident (+1 → "American Samoa", +7 → "Kazakhstan"), misfiling almost every
 * real +1/US or +7/RU number. The canonical owner is the country the vast majority of numbers on
 * that code belong to (the same convention libphonenumber's "main country for code" uses).
 */
const DIAL_TIEBREAK = {
  1: "US", // NANP — not Canada / the islands (their area codes resolve via NANP_PREFIXES below)
  7: "RU", // not Kazakhstan
  39: "IT", // not Vatican City
  44: "GB", // not Guernsey / Isle of Man / Jersey
  61: "AU", // not Christmas / Cocos Islands
  212: "MA", // not Western Sahara
  262: "RE", // not Mayotte
  590: "GP", // not Saint Barthélemy / Saint Martin
  599: "CW", // not the Caribbean Netherlands
};

/**
 * NANP area-code prefixes → the territory they identify. Every NANP member composes on the shared
 * country code "+1" (its `dial` in RAW), so these prefixes exist purely for RESOLUTION: splitE164
 * matches "1"+prefix to pick the right picker country while the area code STAYS inside the national
 * number — which is what makes split→compose a strict round-trip ("+18295551234" → (DO,
 * "8295551234") → "+18295551234", never re-composed onto a different code). Includes the secondary
 * codes real stored numbers use (+1829/+1849 DO, +1939 PR, +1658 JM). Canada's many area codes are
 * deliberately not curated: an unlisted +1 number resolves to US (DIAL_TIEBREAK) — the accepted
 * "main country for code" convention.
 */
const NANP_PREFIXES = {
  242: "BS", // Bahamas
  246: "BB", // Barbados
  264: "AI", // Anguilla
  268: "AG", // Antigua and Barbuda
  284: "VG", // British Virgin Islands
  340: "VI", // US Virgin Islands
  345: "KY", // Cayman Islands
  441: "BM", // Bermuda
  473: "GD", // Grenada
  649: "TC", // Turks and Caicos Islands
  658: "JM", // Jamaica (secondary — primary 876)
  664: "MS", // Montserrat
  670: "MP", // Northern Mariana Islands
  671: "GU", // Guam
  684: "AS", // American Samoa
  721: "SX", // Sint Maarten
  758: "LC", // Saint Lucia
  767: "DM", // Dominica
  784: "VC", // Saint Vincent and the Grenadines
  787: "PR", // Puerto Rico
  809: "DO", // Dominican Republic
  829: "DO", // Dominican Republic (secondary)
  849: "DO", // Dominican Republic (secondary)
  868: "TT", // Trinidad and Tobago
  869: "KN", // Saint Kitts and Nevis
  876: "JM", // Jamaica
  939: "PR", // Puerto Rico (secondary)
};

// dial → canonical entry, built once: first-in-COUNTRIES wins by default (harmless for unshared
// codes), then DIAL_TIEBREAK overrides the shared ones, then the NANP "1"+prefix resolution
// entries are added on top.
const BY_DIAL = new Map();
for (const c of COUNTRIES) {
  if (!BY_DIAL.has(c.dial)) BY_DIAL.set(c.dial, c);
}
for (const [dial, iso2] of Object.entries(DIAL_TIEBREAK)) {
  BY_DIAL.set(dial, BY_ISO2.get(iso2));
}
for (const [prefix, iso2] of Object.entries(NANP_PREFIXES)) {
  BY_DIAL.set(`1${prefix}`, BY_ISO2.get(iso2));
}

/**
 * Every resolvable dial prefix (country codes + NANP "1"+area-code entries), longest first — the
 * iteration order that makes prefix matching in splitE164 longest-match ("+1242…" resolves to
 * Bahamas before "+1…" falls back to US).
 * @type {ReadonlyArray<string>}
 */
export const DIALS_LONGEST_FIRST = Object.freeze(
  [...BY_DIAL.keys()].sort((a, b) => b.length - a.length),
);

/**
 * Look up a country by its ISO-3166 alpha-2 code, case-insensitively.
 * @param {string|null|undefined} iso2
 * @returns {{name: string, iso2: string, dial: string}|null} null for unknown/blank codes.
 */
export function countryByIso2(iso2) {
  return BY_ISO2.get(String(iso2 ?? "").trim().toUpperCase()) || null;
}

/**
 * The canonical country for an EXACT dial prefix string (shared codes resolve per DIAL_TIEBREAK,
 * NANP "1"+area-code prefixes per NANP_PREFIXES). This is a lookup, not a prefix match — splitE164
 * owns the matching. NB the returned entry's `.dial` is the country's COMPOSE code, which for a
 * NANP prefix lookup ("1242") is "1" — the area code belongs to the national number.
 * @param {string|null|undefined} dial e.g. "44", "1242"
 * @returns {{name: string, iso2: string, dial: string, keepsTrunkZero?: boolean}|null}
 */
export function countryForDial(dial) {
  return BY_DIAL.get(String(dial ?? "")) || null;
}

/**
 * The emoji flag for an ISO-3166 alpha-2 code, via Unicode regional-indicator symbols — each A–Z
 * letter maps to U+1F1E6…U+1F1FF and the PAIR renders as the flag. No image assets, so it works
 * under the self-only CSP. (Codes without an official flag glyph, e.g. XK Kosovo, fall back to the
 * platform's letter-pair rendering — readable, just not a flag on every OS.)
 * @param {string|null|undefined} iso2
 * @returns {string} the flag emoji, or "" when the input isn't a 2-letter code.
 */
export function flagOf(iso2) {
  const code = String(iso2 ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return "";
  return String.fromCodePoint(...[...code].map((ch) => 0x1f1e6 + (ch.charCodeAt(0) - 65)));
}

/**
 * The curated city → country soft-default map (TM-781): when a user has no saved phone, their
 * profile CITY suggests the picker's starting country. Deliberately tiny — just the cities the
 * user base actually lives in — and extendable by adding a line. Keys are normalised lowercase.
 */
const CITY_HINTS = new Map([
  ["london", "GB"],
  ["manchester", "GB"],
  ["birmingham", "GB"],
  ["milton keynes", "GB"],
  ["dubai", "AE"],
  ["abu dhabi", "AE"],
  ["sharjah", "AE"],
  ["riyadh", "SA"],
  ["jeddah", "SA"],
  ["karachi", "PK"],
]);

/**
 * The country a free-text city name hints at, case- and whitespace-insensitively ("  Milton  Keynes "
 * → "GB"). Returns null for unknown/blank cities so the caller can apply its own fallback — this is
 * a SOFT default only; an explicit user selection always outranks it (see profile.js fillForm).
 * @param {string|null|undefined} city the user's profile city, as typed.
 * @returns {string|null} an iso2 code, or null.
 */
export function cityCountryHint(city) {
  const key = String(city ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return CITY_HINTS.get(key) || null;
}
