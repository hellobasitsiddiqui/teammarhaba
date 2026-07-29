// TM-1145 — the phone field was visually cramped (a long "flag + country name + dial code" option
// plus a leading handset icon ate the width). Fixed to the intl-tel-input compact standard: the country
// selector shows FLAG + DIAL CODE only (no name), and the phone field drops its leading icon. Source-
// guard over the option-building + field-build code on both surfaces (onboarding gate + profile edit).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const onboarding = readFileSync(join(HERE, "../src/assets/onboarding.js"), "utf8");
const profile = readFileSync(join(HERE, "../src/assets/profile.js"), "utf8");

// The compact option: flag + `+dial`, NO `${c.name}`.
const COMPACT = /text:\s*`\$\{flagOf\(c\.iso2\)\}\s*\+\$\{c\.dial\}`/;
// The old crowded option: flag + name + dial. (The nationality picker's flag+name WITHOUT a dial code
// is a different field and is intentionally left alone.)
const WITH_NAME = /text:\s*`\$\{flagOf\(c\.iso2\)\}\s*\$\{c\.name\}\s*\+\$\{c\.dial\}`/;

test("TM-1145: phone country options are flag + dial code, NO country name (onboarding + profile)", () => {
  assert.match(onboarding, COMPACT, "onboarding phone options are flag + dial code");
  assert.match(profile, COMPACT, "profile phone options are flag + dial code");
  assert.ok(!WITH_NAME.test(onboarding), "onboarding no longer uses flag + name + code");
  assert.ok(!WITH_NAME.test(profile), "profile no longer uses flag + name + code");
});

test("TM-1145: the onboarding phone field has no leading handset icon", () => {
  assert.ok(!/\bphone:\s*\(\)\s*=>\s*fieldIcon/.test(onboarding), "FIELD_ICONS.phone removed");
  assert.ok(!/\[icon,\s*country,\s*input\]/.test(onboarding), "the phone row no longer includes the leading icon");
  assert.match(onboarding, /\[country,\s*input\]/, "the phone row is just [country, input]");
});
