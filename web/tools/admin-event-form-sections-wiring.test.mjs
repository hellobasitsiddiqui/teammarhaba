// Admin event form — 5-section regroup wiring guard (TM-1195), plus the TM-1066 venue→timezone derive
// carried over from the retired More-options guard. Framework-free — Node's built-in test runner, picked
// up by the CI glob `node --test web/tools/*.test.mjs`.
//
// buildEventForm (admin-events.js) can't be imported in Node (a transitive Firebase `https:` import in its
// api/auth chain isn't resolvable by the default ESM loader), so — like the other admin-event wiring guards
// (admin-event-sticky-save-bar-wiring.test.mjs / admin-event-form-batch-wiring.test.mjs) — the structure is
// asserted against the module SOURCE. These fail BEFORE the change (the seams don't exist / the retired
// More-options fold is still present) and pass AFTER, so a later edit can't silently:
//   1. drop any of the 5 collapsible sections (Basics · When · Where · Who can join · Booking rules),
//   2. change which section a field is grouped into (the LOCKED field-in-section mapping),
//   3. change the default open/collapsed state (Basics/When/Where open; Who-can-join/Booking-rules closed),
//   4. re-introduce the retired standalone "More options" <details> fold (TM-1066),
//   5. drop the section force-open that keeps timezone / booking-cutoff reachable on error,
//   6. drop the TM-1066 venue→timezone derive precedence (carried over — the fold moved, the derive stays).
//
// This is a LAYOUT-ONLY ticket: readDraft / validateEventDraft / buildEventPayload / server-error routing
// are UNCHANGED. Those contracts are asserted by event-form.test.mjs (the pure core) — this file only guards
// the DOM grouping.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "../src/assets/admin-events.js"), "utf8");

// --- TM-1195: the 5 collapsible sections exist, via buildFormSection ---------------------------

test("TM-1195: the form imports the buildFormSection component (TM-1186)", () => {
  assert.match(
    SRC,
    /import\s*\{[^}]*\bbuildFormSection\b[^}]*\}\s*from\s*["']\.\/ui\.js["']/s,
    "the sections must be built with the shared buildFormSection component",
  );
});

test("TM-1195: all 5 sections are built with the locked titles + open states", () => {
  // Basics / When / Where OPEN by default; Who can join / Booking rules COLLAPSED. Assert each section's
  // buildFormSection call with the exact title + open flag (the LOCKED decision).
  assert.match(SRC, /buildFormSection\(\s*\{\s*title:\s*["']Basics["']\s*,\s*open:\s*true/, "Basics must be open by default");
  assert.match(SRC, /whenSection\s*=\s*buildFormSection\(\s*\{\s*title:\s*["']When["']\s*,\s*open:\s*true/, "When must be open by default (and held in whenSection)");
  assert.match(SRC, /buildFormSection\(\s*\{\s*title:\s*["']Where["']\s*,\s*open:\s*true/, "Where must be open by default");
  assert.match(SRC, /buildFormSection\(\s*\{\s*title:\s*["']Who can join["']\s*,\s*open:\s*false/, "Who can join must be COLLAPSED by default");
  assert.match(SRC, /bookingRulesSection\s*=\s*buildFormSection\(\s*\{\s*title:\s*["']Booking rules["']\s*,\s*open:\s*false/, "Booking rules must be COLLAPSED by default (and held in bookingRulesSection)");
});

test("TM-1195: each section carries a stable id + toggle id for the e2e + a11y", () => {
  for (const id of ["event-section-basics", "event-section-when", "event-section-where", "event-section-who", "event-section-booking"]) {
    assert.match(SRC, new RegExp(`["']${id}["']`), `the ${id} section id must be present`);
  }
  assert.match(SRC, /`\$\{id\}-toggle`/, "each section's <summary> must get a stable {id}-toggle id");
});

// --- TM-1195: the LOCKED field-in-section mapping ---------------------------------------------

test("TM-1195: Basics groups heading, description, format, image (+ the opening-message content field)", () => {
  // The LOCKED Basics quartet: heading, description, format selector, image — in that order. The
  // group-chat opening message (an unlisted free-text content field) rides along at the end so no
  // FORM_FIELDS field is dropped (dropping one would change readDraft/payload — the load-bearing invariant).
  assert.match(
    SRC,
    /basicsChildren\s*=\s*\[\s*headingField\s*,\s*byKey\.get\(\s*["']description["']\s*\)\s*,\s*formatToggle\.node\s*,\s*image\.node\s*,\s*byKey\.get\(\s*["']openingMessage["']\s*\)\s*\]/,
    "Basics must contain heading + description + the format selector + the image control (+ openingMessage), in order",
  );
});

test("TM-1195: every FORM_FIELDS key is placed in exactly one section (no field dropped)", () => {
  // The load-bearing invariant: a field dropped from the DOM would silently change readDraft/payload. Each
  // FORM_FIELDS key must appear in a section's children list (directly by key, via its field-row group, or
  // via a composite control that re-homes it — ageMin/ageMax → ageBand; price → priceControl).
  const grouped = SRC.slice(SRC.indexOf("const basicsChildren"), SRC.indexOf("const basicsSection"));
  // Directly-placed keys.
  for (const key of ["description", "openingMessage", "timezone", "locationText", "city", "capacity", "bookingCutoffHours", "locationRevealHours"]) {
    assert.match(grouped, new RegExp(`byKey\\.get\\(\\s*["']${key}["']`), `${key} must be placed into a section`);
  }
  // heading via headingField; start/end via the 'when' row; map/online via the 'links' row; visibility
  // window via the 'visibility' row; age via ageBand; price via priceControl.
  assert.match(grouped, /headingField/, "heading must be placed (via headingField)");
  assert.match(grouped, /rowGroups\.get\(\s*["']when["']\s*\)/, "start/end must be placed (via the when row)");
  assert.match(grouped, /rowGroups\.get\(\s*["']links["']\s*\)/, "map/online must be placed (via the links row)");
  assert.match(grouped, /rowGroups\.get\(\s*["']visibility["']\s*\)/, "visibility window must be placed (via the visibility row)");
  assert.match(grouped, /ageBand\.node/, "age band (ageMin/ageMax) must be placed (via ageBand.node)");
  assert.match(grouped, /priceControl\.node/, "price must be placed (via priceControl.node)");
});

test("TM-1195: When groups start/end, recurrence, timezone", () => {
  // The start+end pair rides its 'when' field-row; recurrence (create-only) + the timezone field follow.
  assert.match(SRC, /whenChildren\s*=\s*\[/, "there must be a whenChildren group");
  assert.match(SRC, /rowGroups\.get\(\s*["']when["']\s*\)/, "When must include the start/end field-row");
  assert.match(SRC, /recurrence\s*\?\s*recurrence\.node\s*:\s*null/, "When must include the recurrence control (create-only)");
  assert.match(SRC, /byKey\.get\(\s*["']timezone["']\s*\)/, "When must include the timezone field (moved out of the retired More-options fold)");
});

test("TM-1195: Where groups location, venue, city, map/online URL", () => {
  assert.match(SRC, /whereChildren\s*=\s*\[\s*\n?\s*byKey\.get\(\s*["']locationText["']\s*\)/, "Where must lead with the location field");
  assert.match(SRC, /venuePicker\s*\?\s*venuePicker\.node\s*:\s*null/, "Where must include the venue picker");
  assert.match(SRC, /rowGroups\.get\(\s*["']links["']\s*\)/, "Where must include the map/online-URL field-row");
});

test("TM-1195: Who can join groups the visibility window, capacity, age band", () => {
  assert.match(SRC, /whoChildren\s*=\s*\[/, "there must be a whoChildren group");
  assert.match(SRC, /rowGroups\.get\(\s*["']visibility["']\s*\)/, "Who can join must include the visibility window field-row");
  assert.match(SRC, /byKey\.get\(\s*["']capacity["']\s*\)/, "Who can join must include the capacity field (split out of the limits row)");
  assert.match(SRC, /ageBand\s*\?\s*ageBand\.node\s*:\s*null/, "Who can join must include the age-band control");
});

test("TM-1195: Booking rules groups the booking cutoff, reveal hours, price", () => {
  assert.match(
    SRC,
    /bookingChildren\s*=\s*\[\s*\n?\s*byKey\.get\(\s*["']bookingCutoffHours["']\s*\)\s*,\s*\n?\s*byKey\.get\(\s*["']locationRevealHours["']\s*\)/,
    "Booking rules must lead with the RSVP cutoff then the reveal-hours field (split out of the limits row)",
  );
  assert.match(SRC, /priceControl\s*\?\s*priceControl\.node\s*:\s*null/, "Booking rules must include the price control");
});

// --- TM-1195: the retired More-options fold must be GONE --------------------------------------

test("TM-1195: the standalone 'More options' fold is retired (no fold, no id, no toggle)", () => {
  assert.doesNotMatch(SRC, /event-more-options/, "the #event-more-options fold id must be gone");
  assert.doesNotMatch(SRC, /event-more-options-toggle/, "the #event-more-options-toggle id must be gone");
  assert.doesNotMatch(SRC, /tm-event-more-options/, "the .tm-event-more-options class must be gone");
  // No <summary>/<details> should build a "More options" label (a bare mention survives only in retirement
  // comments; the retired UI construction must be gone). Assert no el() summary/details carries that text.
  assert.doesNotMatch(SRC, /el\(\s*["'](?:summary|details)["'][^)]*More options/, "no <summary>/<details> should build a 'More options' fold anymore");
  // The old mutable `moreOptions` ref is replaced by the section handles (whenSection / bookingRulesSection).
  // (A comment may still mention it in passing; assert no live JS declaration/assignment survives.)
  assert.doesNotMatch(SRC, /\bmoreOptions\s*=(?!=)/, "the moreOptions ref must be gone (replaced by section handles)");
  assert.doesNotMatch(SRC, /let\s+moreOptions\b/, "the moreOptions declaration must be gone");
});

// --- TM-1195: a collapsed section still force-opens when a field inside it errors --------------

test("TM-1195: an errored field force-opens its section (timezone + booking-cutoff reachable)", () => {
  // The generalised force-open: setFieldError resolves the field's section via sectionForField and opens it.
  assert.match(SRC, /sectionForField\s*=\s*\(key\)\s*=>/, "there must be a sectionForField mapper");
  assert.match(SRC, /if\s*\(key\s*===\s*["']timezone["']\)\s*return\s*whenSection/, "timezone must map to the When section");
  assert.match(SRC, /if\s*\(key\s*===\s*["']bookingCutoffHours["']\)\s*return\s*bookingRulesSection/, "booking-cutoff must map to the Booking rules section");
  assert.match(SRC, /section\.setOpen\(\s*true\s*\)/, "an errored field's section must be forced open via setOpen");
});

// --- TM-1066 (carried over): the venue→timezone derive precedence survives the regroup ---------

test("TM-1066: admin-events.js still imports the pure deriveVenueTimezone precedence rule", () => {
  assert.match(
    SRC,
    /import\s*\{[^}]*\bderiveVenueTimezone\b[^}]*\}\s*from\s*["']\.\/event-form\.js["']/s,
    "the venue-timezone derive must still go through the pure event-form.js helper",
  );
});

test("TM-1066: the venue onSelect still derives the timezone via deriveVenueTimezone + ensureZoneOption", () => {
  assert.match(SRC, /deriveVenueTimezone\(\s*chosen\s*,\s*tzUserEdited\s*\)/, "the derive must pass the chosen venue + the manual-edit flag");
  assert.match(SRC, /ensureZoneOption\(\s*tzInput\s*,\s*derived\s*\)/, "the derived zone must be added as a select option before use");
});

test("TM-1066: a genuine user edit of the timezone still pins it against a later re-pick", () => {
  assert.match(SRC, /let\s+tzUserEdited\s*=\s*false/, "the manual-edit flag must start false so the derive is active until a real edit");
  assert.match(SRC, /tzUserEdited\s*=\s*true/, "a real user edit of the timezone must pin it");
  assert.match(SRC, /dispatchEvent\(\s*new Event\(\s*["']input["']/, '"Use mine" must dispatch an input event so it counts as a manual edit');
});

test("TM-1066: the initial venue auto-echo still does NOT clobber a saved timezone on edit-open", () => {
  assert.match(SRC, /\{\s*initial:\s*true\s*\}/, "the initial venue auto-echo must be flagged initial:true");
  assert.match(SRC, /if\s*\(\s*!initial\s*\)/, "the timezone derive must be skipped on the initial auto-echo (edit-open guard)");
});
