// TM-1145 — the onboarding phone field packs three controls into one input box (leading icon + country
// picker + national number), so the default 18px icon + its gap/padding crowded the picker and number.
// The phone row now tightens JUST its icon footprint (smaller icon + slimmer gap/padding), scoped via
// :has(.tm-phone-country) so other fields keep their comfortable 18px icon. Source-guard over the CSS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(HERE, "../src/assets/styles.css"), "utf8");
const rowBlock = (css.match(/#onboarding-view \.tm-field-input:has\(\.tm-phone-country\)\s*\{[^}]*\}/s) || [""])[0];
const iconBlock = (css.match(/#onboarding-view \.tm-field-input:has\(\.tm-phone-country\) \.tm-field-icon\s*\{[^}]*\}/s) || [""])[0];

test("TM-1145: the phone row tightens its icon gap + left padding (was 0.55rem / 0.65rem)", () => {
  assert.ok(rowBlock, "phone-row :has(.tm-phone-country) rule exists");
  assert.match(rowBlock, /gap:\s*0\.4rem/, "slimmer gap so the icon crowds the picker/number less");
  assert.match(rowBlock, /padding-left:\s*0\.5rem/, "slimmer left padding");
});

test("TM-1145: the phone row's leading icon is smaller than the default 18px", () => {
  assert.ok(iconBlock, "phone-row .tm-field-icon rule exists");
  assert.match(iconBlock, /width:\s*15px/, "icon width shrunk to 15px");
  assert.match(iconBlock, /height:\s*15px/, "icon height shrunk to 15px");
});
