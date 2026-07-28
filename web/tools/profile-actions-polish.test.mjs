// TM-1091 — profile actions polish: (1) the action-button labels match the section-header title font
// (so the top section cards and the bottom action buttons read as one family); (2) Sign out is a dark
// filled ACTION button — no chevron — not a muted nav row. Guard test over the markup + CSS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const profileJs = readFileSync(join(HERE, "../src/assets/profile.js"), "utf8");
const css = readFileSync(join(HERE, "../src/assets/styles.css"), "utf8");
const rowBlock = (css.match(/\.tm-pf-menu-row\s*\{[^}]*\}/s) || [""])[0];
const secTitleBlock = (css.match(/\.tm-pf-sec-title\s*\{[^}]*\}/s) || [""])[0];
const signoutBlock = (css.match(/\.tm-pf-menu-signout\s*\{[^}]*\}/s) || [""])[0];

test("TM-1091: action-button labels match the section-header title font (fs-4 / 700)", () => {
  // The section titles are the reference (fs-4, bold).
  assert.match(secTitleBlock, /font-size:\s*var\(--fs-4\)/, "section titles use fs-4 (reference)");
  // The action rows now match — same size + weight, so top and bottom read as one family.
  assert.match(rowBlock, /font-size:\s*var\(--fs-4\)/, "action rows must use the same fs-4, not fs-3");
  assert.match(rowBlock, /font-weight:\s*700/, "action rows must be bold like the section titles");
});

test("TM-1091: Sign out is a dark filled button (no chevron), not a muted nav row", () => {
  assert.match(
    profileJs,
    /menuRow\("Sign out",\s*\{\s*onClick:\s*doSignOut,\s*signout:\s*true/,
    "Sign out uses the signout variant",
  );
  assert.ok(!/menuRow\("Sign out"[^)]*muted:\s*true/.test(profileJs), "Sign out is no longer the muted nav row");
  // menuRow's signout branch renders the label only — no trailing chevron.
  assert.match(profileJs, /signout\s*\n?\s*\?\s*\[el\("span",\s*\{\s*text:\s*label\s*\}\)\]/, "signout row omits the chevron");
  // TM-1100: the filled-button styling exists and uses the user's MAIN APPEARANCE colour (--accent /
  // --on-accent — the same tokens .tm-btn-primary uses), so it follows the chosen theme (was --ink).
  assert.ok(signoutBlock, ".tm-pf-menu-signout rule must exist");
  assert.match(signoutBlock, /background:\s*var\(--accent\)/, "appearance-accent fill");
  assert.match(signoutBlock, /color:\s*var\(--on-accent\)/, "legible on-accent text");
  assert.ok(!/var\(--ink\)/.test(signoutBlock), "no longer the fixed dark ink fill");
});
