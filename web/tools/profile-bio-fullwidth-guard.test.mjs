// TM-1154 — the Short bio is a tall free-text textarea, so it spans the FULL width of the profile edit
// 2-column grid instead of pairing lopsidedly beside a single-line field. Source-guard over the wiring
// (the bio field flagged `wide`, buildField emits the class) + the CSS (spans first-to-last column).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const profile = readFileSync(join(HERE, "../src/assets/profile.js"), "utf8");
const css = readFileSync(join(HERE, "../src/assets/styles.css"), "utf8");
const wideBlock = (css.match(/\.tm-form-field-wide\s*\{[^}]*\}/s) || [""])[0];

test("TM-1154: the bio FIELDS entry is flagged wide", () => {
  assert.match(profile, /key:\s*"bio"[\s\S]{0,500}?wide:\s*true/, "the bio field carries wide: true");
});

test("TM-1154: buildField adds .tm-form-field-wide for a wide field", () => {
  assert.match(
    profile,
    /class:\s*`tm-form-field\$\{field\.wide\s*\?\s*" tm-form-field-wide"\s*:\s*""\}`/,
    "the field wrapper adds tm-form-field-wide when field.wide",
  );
});

test("TM-1154: .tm-form-field-wide spans the full grid width", () => {
  assert.ok(wideBlock, ".tm-form-field-wide rule exists");
  assert.match(wideBlock, /grid-column:\s*1\s*\/\s*-1/, "spans first-to-last column (correct at any column count)");
});
