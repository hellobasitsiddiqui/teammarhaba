// Source guards for the "See similar events" route wiring (TM-827-C). router.js can't be imported under
// `node --test` (it sits on the api.js → Firebase CDN chain), so — like router-robustness.test.mjs — this
// pins the wiring with source assertions; the actual navigation behaviour is exercised by the e2e
// (events.spec: full event → CTA → #/events?similarTo=… → similar view; + a malformed id → plain list).

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTER = readFileSync(join(HERE, "../src/assets/router.js"), "utf8");
const EVENTS_JS = readFileSync(join(HERE, "../src/assets/events.js"), "utf8");

test("isEventsRoute tolerates a ?query on the list route (so #/events?similarTo=… is an events route)", () => {
  assert.match(ROUTER, /function isEventsRoute\(hash\)\s*\{[\s\S]*?startsWith\(`\$\{EVENTS\}\?`\)/);
});

test("eventsSimilarTo parses the similarTo query with URLSearchParams (lenient — TM-721 no-throw)", () => {
  assert.match(ROUTER, /function eventsSimilarTo\(hash\)/);
  assert.match(ROUTER, /new URLSearchParams\([\s\S]*?\)\.get\("similarTo"\)/);
  // Only the list-with-query form carries it (a detail route never does).
  assert.match(ROUTER, /if \(!hash\.startsWith\(`\$\{EVENTS\}\?`\)\) return null/);
});

test("the events dispatch threads similarTo through to enterEvents", () => {
  assert.match(ROUTER, /enterEvents\(eventDetailId\(route\),\s*\{\s*similarTo:\s*eventsSimilarTo\(route\)\s*\}\)/);
  // events.js consumes it: enterEvents(id, { similarTo }) → renderList(view, { similarTo }).
  assert.match(EVENTS_JS, /export function enterEvents\(eventId,\s*\{\s*similarTo\s*\}\s*=\s*\{\}\)/);
  assert.match(EVENTS_JS, /renderList\(view,\s*\{\s*similarTo\s*\}\)/);
});
