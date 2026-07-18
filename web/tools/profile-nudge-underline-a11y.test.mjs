// Strength-card / interests-CTA prompt underline guard — WCAG 1.4.1 Use of Color (TM-901).
// Framework-free — Node's built-in test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// TM-892 review finding (PR #590 L1): the profile screen's tappable prompts — the strength nudge's
// inline "Add …" gap buttons (.tm-pf-nudge-gap, TM-881) and the next-day interests CTA
// (.tm-pf-nudge-interests, TM-777) — were distinguishable from the surrounding text by ACCENT COLOUR
// ALONE in their default state; the underline only appeared on :hover, which touch users never see.
// A colour-vision-deficient touch user couldn't discover the prompts were tappable — regressing to
// the inert-text bug (TM-881) for exactly them. WCAG 1.4.1 (Level A) requires a non-colour cue.
//
// The fix gives BOTH classes a persistent `text-decoration: underline dotted` in the DEFAULT rule
// (hover keeps its solid underline, so the two states stay distinct). styles.css can't be "imported",
// so — like theme-tokens.test.mjs / events-map-link-a11y.test.mjs — this is a source-level guard: it
// isolates each class's default rule block and asserts the dotted underline is present (and that the
// hover affordance survives). It FAILS on the pre-fix stylesheet (`text-decoration: none`), so a later
// restyle can't silently reintroduce the colour-only affordance.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(HERE, "../src/assets/styles.css"), "utf8");

/**
 * The declaration body of a class's DEFAULT rule — the block whose selector is exactly
 * `.<className> {` (anchored at a line start so `:hover` / `:focus-visible` variants and any
 * compound selectors can't match). Asserts the block exists and is unique so the guard below
 * can't silently pass against the wrong rule.
 * @param {string} className the bare class name, without the leading dot.
 * @returns {string} the CSS declarations between the braces.
 */
function defaultRuleBlock(className) {
  const re = new RegExp(`^\\.${className}\\s*\\{([^}]*)\\}`, "gm");
  const matches = [...CSS.matchAll(re)];
  assert.equal(matches.length, 1, `expected exactly one default \`.${className} { … }\` rule in styles.css`);
  return matches[0][1];
}

for (const className of ["tm-pf-nudge-gap", "tm-pf-nudge-interests"]) {
  test(`.${className} default state carries a persistent dotted underline — WCAG 1.4.1 (TM-901)`, () => {
    const block = defaultRuleBlock(className);
    // The load-bearing declaration: tappability must be marked by MORE than accent colour in the
    // state every user sees. `underline dotted` (in either property-order) is the shipped cue.
    assert.match(
      block,
      /text-decoration:\s*(underline\s+dotted|dotted\s+underline)\s*;/,
      `.${className} must declare \`text-decoration: underline dotted\` in its DEFAULT rule — ` +
        "colour alone may not mark the prompt as tappable (WCAG 1.4.1); hover-only underlines " +
        "never reach touch users",
    );
    // Guard the specific regression: the pre-TM-901 `text-decoration: none` (or a later removal of
    // the declaration entirely) — both would leave the default state colour-only again.
    assert.doesNotMatch(
      block,
      /text-decoration:\s*none\s*;/,
      `.${className} must not reset its default text-decoration to none (the pre-TM-901 colour-only state)`,
    );
  });

  test(`.${className} keeps its solid :hover underline (the pointer affordance stays distinct)`, () => {
    // The fix ADDS the persistent cue; it must not cost the existing hover feedback. Solid-on-hover
    // over dotted-by-default keeps the "you are on it" state visibly different from "it is tappable".
    assert.match(
      CSS,
      new RegExp(`\\.${className}:hover\\s*\\{[^}]*text-decoration:\\s*underline\\s*;[^}]*\\}`),
      `.${className}:hover must keep its solid underline`,
    );
  });
}
