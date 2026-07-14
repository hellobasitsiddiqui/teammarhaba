// Guard for the animated boot splash (TM-705). Framework-free — Node's built-in test runner, picked up
// by the CI glob `node --test web/tools/*.test.mjs`. Reads index.html directly (no browser) and asserts
// the ring→smiley marks and the two brand lines are present and in order, so the sequence's markup/copy
// can't silently regress. The animation itself is CSS (styles.css) and dismiss timing is boot-screen.js.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "../src/index.html"), "utf8");

test("boot screen carries the animated ring→smiley marks", () => {
  for (const cls of ["boot-ring", "boot-eye", "boot-smile"]) {
    assert.ok(html.includes(cls), `#boot-screen should include the .${cls} element (TM-705)`);
  }
});

test("boot screen shows the two brand lines in order", () => {
  const first = html.indexOf("Find your people");
  const second = html.indexOf("Complete your circle");
  assert.notEqual(first, -1, "boot screen should include 'Find your people'");
  assert.notEqual(second, -1, "boot screen should include 'Complete your circle'");
  assert.ok(first < second, "'Find your people' should appear before 'Complete your circle'");
});
