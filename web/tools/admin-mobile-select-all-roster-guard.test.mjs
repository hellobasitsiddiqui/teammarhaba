// TM-963 + TM-967 source-guard for the admin console phone layout.
//
// TM-963 (MAJOR): the users console's BROADCAST select-all checkbox lives in the table header
// (`th.tm-check-cell` holding `#admin-select-all`). TM-935's stacked-card layout hides the whole
// header on a phone (`.tm-table thead { display: none }` inside the ≤30rem block), so on mobile an
// admin could never select-all to send a broadcast. The fix keeps the rest of the header hidden but
// reveals JUST the select-all cell as a labelled control strip — scoped with `:has(.tm-check-cell)`
// so ONLY the users console (the sole console with a select-all) is affected; every other console's
// thead stays fully hidden and its TM-935 stacking is untouched.
//
// TM-967: tidy the admin-events roster/capacity panel (`.tm-event-roster-row`) on a phone so the
// stacked-card `td` rules don't right-align the panel or wrap it in a redundant second card border.
//
// Like admin-table-mobile-stack-guard.test.mjs, the console DOM modules can't be imported under
// `node --test` (they pull the Firebase CDN chain via api.js), so this guards the SOURCE TEXT: it
// asserts the exact CSS rules exist inside the ≤30rem media block. Kept in its own file so a revert of
// styles.css (leaving this test) goes red cleanly, proving the guard bites. Run via
// `node --test web/tools/`.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, "..", "src", "assets");
const read = (name) => readFileSync(join(assets, name), "utf8");

/** Return the text of the FIRST `@media (max-width: 30rem)` block (the one that owns the table rules),
 *  sliced by brace-matching from its opening `{`. */
function firstPhoneBlock(css) {
  const start = css.indexOf("@media (max-width: 30rem)");
  assert.ok(start !== -1, "expected a @media (max-width: 30rem) block in styles.css");
  const open = css.indexOf("{", start);
  let depth = 0;
  let end = open;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  return css.slice(start, end + 1);
}

// ---- TM-963: the select-all header survives the mobile thead-hide -----------------------------

test("admin.js still puts the select-all in a th.tm-check-cell header (the element the CSS reveals)", () => {
  const src = read("admin.js");
  // The header <th> carrying the select-all must have class tm-check-cell — that's the hook the CSS
  // `:has(.tm-check-cell)` reveal targets. If the console stops using that class the fix silently
  // stops applying, so pin it here alongside the id.
  assert.ok(
    /el\("th",\s*\{[^}]*class:\s*"tm-check-cell"/.test(src),
    "admin.js should render the select-all header as `el(\"th\", { class: \"tm-check-cell\" })` (the CSS reveal hook)",
  );
  assert.ok(
    /id:\s*"admin-select-all"/.test(src),
    "admin.js should give the select-all checkbox id `admin-select-all`",
  );
});

test("styles.css reveals ONLY the select-all header on a phone (TM-963) without un-hiding the whole thead", () => {
  const css = read("styles.css");
  const block = firstPhoneBlock(css);

  // TM-935 must remain: the blanket header-hide is still there (the stacked-card switch).
  assert.ok(
    /\.tm-table\s+thead\s*\{[^}]*display\s*:\s*none/.test(block),
    "expected the base `.tm-table thead { display: none }` to REMAIN inside the 30rem block (don't regress TM-935 stacking)",
  );

  // TM-963: the select-all-bearing header is brought back as a block via :has(.tm-check-cell).
  assert.ok(
    /\.tm-table\s+thead:has\(\.tm-check-cell\)\s*\{[^}]*display\s*:\s*block/.test(block),
    "expected `.tm-table thead:has(.tm-check-cell) { display: block }` inside the 30rem block (TM-963: keep the broadcast select-all reachable on mobile)",
  );

  // Only the select-all cell shows — the other header labels stay hidden.
  assert.ok(
    /\.tm-table\s+thead:has\(\.tm-check-cell\)\s+th:not\(\.tm-check-cell\)\s*\{[^}]*display\s*:\s*none/.test(block),
    "expected `thead:has(.tm-check-cell) th:not(.tm-check-cell) { display: none }` — only the select-all cell should show, not the column labels",
  );

  // The surviving control needs a visible label since the column header text is gone on mobile.
  assert.ok(
    /th\.tm-check-cell::after\s*\{[^}]*content\s*:\s*"Select all"/.test(block),
    "expected a `th.tm-check-cell::after { content: \"Select all\" }` label on the revealed select-all control",
  );
});

test("the select-all reveal is scoped so other consoles' theads stay fully hidden (no bare thead un-hide)", () => {
  const css = read("styles.css");
  const block = firstPhoneBlock(css);

  // A regression to guard against: someone "fixes" TM-963 by un-hiding the whole thead unconditionally
  // (a bare `.tm-table thead { display: block }`), which would re-break the TM-935 stacked layout on
  // EVERY console. Every reveal rule that flips thead/its th to a visible display must be gated by
  // `:has(.tm-check-cell)`. So: no `.tm-table thead { display: <visible> }` rule may exist that is NOT
  // the `:has(.tm-check-cell)` form. We check there is no bare `.tm-table thead {` block whose body
  // sets a non-none display.
  const bareTheadRules = block.match(/\.tm-table\s+thead(?!:has)[^{]*\{[^}]*\}/g) || [];
  for (const rule of bareTheadRules) {
    // The only allowed bare thead rule is the display:none one.
    if (/display\s*:/.test(rule)) {
      assert.ok(
        /display\s*:\s*none/.test(rule),
        `a non-:has() \`.tm-table thead\` rule sets a visible display — that would un-hide the header on EVERY console and regress TM-935: ${rule}`,
      );
    }
  }
});

// ---- TM-967: roster panel is tidy on a phone ---------------------------------------------------

test("styles.css tidies the roster panel row on a phone (TM-967)", () => {
  const css = read("styles.css");
  const block = firstPhoneBlock(css);

  // The full-width roster row must NOT inherit the stacked-card border (it would double up with the
  // panel's own left-accent styling) — it's reset to a plain, unbordered container on mobile.
  const rosterRow = block.match(/\.tm-table\s+tbody\s+tr\.tm-event-roster-row\s*\{[^}]*\}/);
  assert.ok(rosterRow, "expected a `.tm-table tbody tr.tm-event-roster-row` reset rule inside the 30rem block (TM-967)");
  assert.ok(
    /border\s*:\s*none/.test(rosterRow[0]),
    "the roster row should drop the stacked-card border on mobile (TM-967) so it doesn't double-border the panel",
  );

  // The roster cell (no data-label) must be reset off the right-aligned flex `td` layout, so the panel
  // reads left-to-right like on desktop rather than being squeezed + right-aligned.
  const rosterCell = block.match(/\.tm-event-roster-row\s*>\s*td\s*\{[^}]*\}/);
  assert.ok(rosterCell, "expected a `.tm-event-roster-row > td` mobile reset rule inside the 30rem block (TM-967)");
  assert.ok(
    /text-align\s*:\s*left/.test(rosterCell[0]),
    "the roster cell must be text-align:left on mobile (TM-967) — the stacked-card `td` default is right-aligned",
  );
  assert.ok(
    /display\s*:\s*block/.test(rosterCell[0]),
    "the roster cell must be display:block on mobile (TM-967) so the panel isn't forced into the space-between flex row",
  );
});
