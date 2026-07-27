// TM-1099 — the profile hub's "Public profile" action row reads "Your public profile" with a muted
// subtitle "See how people see your profile" (clarifies it's a PREVIEW of the outward-facing profile,
// not a privacy setting). Source-guard over the profile.js wiring + the subtitle CSS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const profileJs = readFileSync(join(HERE, "../src/assets/profile.js"), "utf8");
const css = readFileSync(join(HERE, "../src/assets/styles.css"), "utf8");
const labelcolBlock = (css.match(/\.tm-pf-menu-labelcol\s*\{[^}]*\}/s) || [""])[0];
const subBlock = (css.match(/\.tm-pf-menu-sub\s*\{[^}]*\}/s) || [""])[0];

test('TM-1099: the row reads "Your public profile" with the "see how people see your profile" subtitle', () => {
  assert.match(
    profileJs,
    /menuRow\("Your public profile",\s*\{[^}]*to:\s*PROFILE_PUBLIC_ROUTE[^}]*sub:\s*"See how people see your profile"/,
    'Public profile row → "Your public profile" + subtitle, still routing to the public preview',
  );
  // The old bare label is gone.
  assert.ok(!/menuRow\("Public profile"/.test(profileJs), 'the old "Public profile" label is replaced');
});

test("TM-1099: menuRow renders an optional subtitle as a stacked title + muted sub", () => {
  assert.match(profileJs, /menuRow\(label,\s*\{[^}]*\bsub\s*=\s*null/, "menuRow accepts a sub param");
  assert.match(profileJs, /class:\s*"tm-pf-menu-labelcol"/, "subtitle rows use a label column");
  assert.match(profileJs, /class:\s*"tm-pf-menu-title"/, "the main label is the title span");
  assert.match(profileJs, /class:\s*"tm-pf-menu-sub",\s*text:\s*sub/, "the sub span carries the subtitle text");
});

test("TM-1099: the subtitle CSS stacks the column and styles the sub as muted help text", () => {
  assert.ok(labelcolBlock, ".tm-pf-menu-labelcol rule must exist");
  assert.match(labelcolBlock, /flex-direction:\s*column/, "title + sub stack vertically");
  assert.ok(subBlock, ".tm-pf-menu-sub rule must exist");
  assert.match(subBlock, /color:\s*var\(--muted\)/, "sub is muted");
  assert.match(subBlock, /font-size:\s*var\(--fs-2\)/, "sub is smaller than the fs-4 title");
});
