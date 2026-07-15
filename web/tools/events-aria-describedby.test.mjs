// Guard: every disabled control's aria-describedby in events.js resolves to a real element id (TM-727).
// Framework-free — Node's built-in test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// The event detail renders disabled buttons (a blocked RSVP; a not-yet-open chat entry) that point their
// `aria-describedby` at the muted reason paragraph explaining WHY the button is inert. The RSVP reason
// previously carried only a `data-testid` and no `id`, so the button's aria-describedby="event-action-reason"
// dangled — a screen reader announced a disabled button with no reason. This is a source-level guard
// (events.js can't be imported in Node: a transitive `https:` Firebase import in the api/auth chain isn't
// resolvable by the default ESM loader), like events-map-link-a11y.test.mjs: it asserts that for every
// id an aria-describedby references, some el(...) in the same file actually sets `id: "<that id>"`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "../src/assets/events.js"), "utf8");

// Every literal-string id that an aria-describedby points at. Handles both a plain
// `"aria-describedby": "id"` and a conditional `"aria-describedby": cond ? "id" : null` by scanning up
// to the end of the property value (the next `,` or `}`) for the referenced string literal.
function referencedIds(src) {
  const ids = new Set();
  const re = /"aria-describedby":\s*([^,}\n]+)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const literal = m[1].match(/"([^"]+)"/);
    if (literal) ids.add(literal[1]);
  }
  return ids;
}

// Every literal-string id an element declares via `id: "..."`.
function declaredIds(src) {
  const ids = new Set();
  const re = /\bid:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(src)) !== null) ids.add(m[1]);
  return ids;
}

test("every aria-describedby target in events.js is a real element id", () => {
  const referenced = referencedIds(SRC);
  const declared = declaredIds(SRC);
  // Sanity: we actually found the describedby references we care about, so the regex didn't silently miss.
  assert.ok(referenced.has("event-action-reason"), "found the disabled-RSVP reason reference");
  assert.ok(referenced.has("event-chat-entry-reason"), "found the disabled-chat-entry reason reference");
  for (const id of referenced) {
    assert.ok(declared.has(id), `aria-describedby="${id}" has no matching element with id="${id}"`);
  }
});
