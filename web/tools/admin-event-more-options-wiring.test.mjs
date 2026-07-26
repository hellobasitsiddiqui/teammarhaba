// Admin event form — "More options" venue-timezone wiring guard (TM-1066). Framework-free — Node's
// built-in test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// The pure derive-precedence rule (deriveVenueTimezone) is unit-tested directly in event-form.test.mjs.
// This file guards the DOM SHELL (admin-events.js) that wires it, which can't be imported in Node (a
// transitive Firebase `https:` import in its api/auth chain isn't resolvable by the default ESM loader),
// so — like admin-event-edit-image-preview.test.mjs / events-map-link-a11y.test.mjs — the wiring is
// asserted against the module source. These fail BEFORE the change (the symbols/seams don't exist) and
// pass AFTER, so a later edit can't silently drop:
//   1. the venue → timezone derive (through the pure deriveVenueTimezone precedence rule),
//   2. the "More options" <details> the timezone field moves under,
//   3. the auto-open of that disclosure when the (required) timezone is in error (so it's never hidden),
//   4. the initial-echo skip that stops an edit-open from clobbering a saved timezone.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "../src/assets/admin-events.js"), "utf8");

test("admin-events.js imports the pure deriveVenueTimezone precedence rule (TM-1066)", () => {
  assert.match(
    SRC,
    /import\s*\{[^}]*\bderiveVenueTimezone\b[^}]*\}\s*from\s*["']\.\/event-form\.js["']/s,
    "the venue-timezone derive must go through the pure event-form.js helper (unit-tested precedence)",
  );
});

test("the venue onSelect derives the timezone via deriveVenueTimezone + ensureZoneOption (TM-1066)", () => {
  // The derive must run in the venue picker's onSelect (the same hook that prefills Location + City),
  // apply the pure precedence rule, and register the zone as an option before setting the select.
  assert.match(
    SRC,
    /deriveVenueTimezone\(\s*chosen\s*,\s*tzUserEdited\s*\)/,
    "the derive must pass the chosen venue + the manual-edit flag to deriveVenueTimezone",
  );
  assert.match(SRC, /ensureZoneOption\(\s*tzInput\s*,\s*derived\s*\)/, "the derived zone must be added as a select option before use");
});

test("a genuine user edit of the timezone pins it against a later re-pick (tzUserEdited) (TM-1066)", () => {
  // The manual-edit flag must be flipped from a real user edit of the tz select (native change/input, or
  // the "Use mine" button which dispatches "input"), and START false so the first pick derives.
  assert.match(SRC, /let\s+tzUserEdited\s*=\s*false/, "the manual-edit flag must start false so the derive is active until a real edit");
  assert.match(SRC, /tzUserEdited\s*=\s*true/, "a real user edit of the timezone must pin it (set tzUserEdited = true)");
  // "Use mine" dispatches an input event so it flows through revalidate + the manual-edit flag.
  assert.match(SRC, /dispatchEvent\(\s*new Event\(\s*["']input["']/, '"Use mine" must dispatch an input event so it counts as a manual edit');
});

test("the timezone field moves under a 'More options' <details> disclosure (TM-1066)", () => {
  // A native <details> reusing the TM-398 .tm-event-calendar-toggle look, with a stable summary id the
  // e2e opens before selecting the timezone.
  assert.match(SRC, /el\(\s*["']details["']/, "the More options section must be a native <details> disclosure");
  assert.match(SRC, /id:\s*["']event-more-options-toggle["']/, "the summary needs a stable id for the e2e + a11y focus");
  assert.match(SRC, /More options/, "the disclosure summary must read 'More options'");
  assert.match(SRC, /tm-event-calendar-toggle/, "reuse the TM-398 disclosure toggle styling");
  // The moved field is the timezone field node (pulled out of the main layout by key).
  assert.match(SRC, /timezoneNode\s*=\s*byKey\.get\(\s*["']timezone["']\s*\)/, "the timezone field node must be the one relocated under More options");
});

test("a timezone error force-opens More options + focuses the field on submit (TM-1066)", () => {
  // A hidden required-timezone error would otherwise be invisible under the collapsed disclosure — the
  // paint-all-errors (submit) path must open it AND move focus to the field; setFieldError opens it for
  // live/server errors too.
  assert.match(SRC, /errors\.timezone\s*&&\s*moreOptions/, "the submit paint path must detect a timezone error to reveal More options");
  assert.match(SRC, /moreOptions\.open\s*=\s*true/, "a timezone error must force the disclosure open");
});

test("the initial venue auto-echo does NOT clobber a saved timezone on edit-open (TM-1066)", () => {
  // The async venue-list load echoes the current selection with { initial: true }; the derive must be
  // skipped for it so a SAVED event timezone (prefilled) isn't overwritten by its venue's zone on edit.
  assert.match(SRC, /\{\s*initial:\s*true\s*\}/, "the initial venue auto-echo must be flagged initial:true");
  assert.match(SRC, /if\s*\(\s*!initial\s*\)/, "the timezone derive must be skipped on the initial auto-echo (edit-open guard)");
});
