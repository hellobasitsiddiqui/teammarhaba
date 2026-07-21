// TM-935 source-guard: the four admin consoles overflowed the viewport on a phone (horizontal scroll
// + clipped columns). The fix is a pure-CSS data-label stack — every body `<td>` carries a
// `data-label` so the ≤30rem media block can hide the header row and paint each row as a labelled
// card via `td::before { content: attr(data-label) }`. The console DOM modules can't be imported
// under `node --test` (they pull api.js → the Firebase CDN chain), so this guards the SOURCE TEXT
// instead: it asserts each console sets data-label in its row-building code AND that styles.css hides
// the table header inside the phone media block. Kept in its own file so a revert of the source files
// (leaving this test) goes red cleanly, proving the guard bites. Picked up by `node --test web/tools/`.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, "..", "src", "assets");
const read = (name) => readFileSync(join(assets, name), "utf8");

// Every console builds body rows with el("td", …) and must tag each field cell with data-label so the
// stacked-card CSS can label it. We require at least the number of labelled fields each COLUMNS array
// carries (control cells — checkbox / Actions — are deliberately unlabelled, so we assert ">=", not "=").
const CONSOLES = [
  { file: "admin.js", minLabels: 6 }, // Email, Name, Role, Status, Push, ID
  { file: "admin-events.js", minLabels: 5 }, // Event, Start, Status, Going / Waitlist, Capacity
  { file: "admin-venues.js", minLabels: 4 }, // Venue, City / area, Capacity, Status
  { file: "admin-interests.js", minLabels: 5 }, // Interest, Category, Weight, Featured, Status
];

for (const { file, minLabels } of CONSOLES) {
  test(`${file} sets data-label on its body cells`, () => {
    const src = read(file);
    // Count only the object-KEY form `"data-label":` (the actual el() prop). A bare /data-label/ also
    // matches the TM-935 explainer comment in each console (+1), which would let a real td label be
    // dropped while the comment kept the count above threshold — the exact regression this guards.
    const count = (src.match(/["']data-label["']\s*:/g) || []).length;
    assert.ok(
      count >= minLabels,
      `${file} should tag its body <td>s with data-label (found ${count}, expected >= ${minLabels}). ` +
        `Without data-label the ≤30rem stacked-card CSS can't label the fields (TM-935).`,
    );
  });
}

// The phone media block must hide the table header — that's the switch from a scrolling table to the
// stacked-card layout. We scope the check to the FIRST `@media (max-width: 30rem)` block (the one that
// owns the table rules) so a stray `thead`/`display:none` elsewhere can't satisfy it.
test("styles.css hides the table header inside the @media (max-width: 30rem) block", () => {
  const css = read("styles.css");
  const start = css.indexOf("@media (max-width: 30rem)");
  assert.ok(start !== -1, "expected a @media (max-width: 30rem) block in styles.css");

  // Slice to the end of this media block by matching braces from the block's opening `{`.
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
  const block = css.slice(start, end + 1);

  assert.ok(/\.tm-table\s+thead/.test(block), "expected a `.tm-table thead` rule inside the 30rem block");
  // thead must be display:none (header hidden) — allow whitespace variation.
  assert.ok(
    /thead\s*\{[^}]*display\s*:\s*none/.test(block),
    "expected `.tm-table thead { display: none }` inside the 30rem block (TM-935 stacked-card layout)",
  );
  // And the value must be exposed for the ::before label pump.
  assert.ok(
    /content\s*:\s*attr\(data-label\)/.test(block),
    "expected `content: attr(data-label)` (td::before) inside the 30rem block",
  );
  // TM-935 a11y layer: the injected `.tm-cell-label` span must be exposed to AT inside the phone block
  // (block-display strips the <thead> association, so ::before alone isn't a reliable SR label). Here it
  // becomes a visually-hidden but readable node — assert it's NOT display:none in this block.
  const cellLabel = block.match(/\.tm-cell-label\s*\{[^}]*\}/);
  assert.ok(cellLabel, "expected a `.tm-cell-label` rule inside the 30rem block (SR field-label exposure)");
  assert.ok(
    !/display\s*:\s*none/.test(cellLabel[0]),
    "`.tm-cell-label` must NOT be display:none inside the 30rem block — it has to reach the a11y tree there",
  );
});

// The `.tm-cell-label` span is desktop-hidden (display:none → out of the a11y tree, no redundant
// "Status:" over the still-intact <thead> association). Pin that base rule so an edit can't leave it
// exposed on desktop.
test("styles.css hides .tm-cell-label by default (desktop, outside the phone block)", () => {
  const css = read("styles.css");
  const media = css.indexOf("@media (max-width: 30rem)");
  const desktop = css.slice(0, media === -1 ? css.length : media);
  assert.ok(
    /\.tm-cell-label\s*\{[^}]*display\s*:\s*none/.test(desktop),
    "expected `.tm-cell-label { display: none }` in the base (desktop) styles",
  );
});
