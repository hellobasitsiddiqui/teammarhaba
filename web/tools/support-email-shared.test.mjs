// TM-1019 (d) — the support contact email must have ONE canonical value, never a second hardcoded
// literal that can silently drift out of step with the help page. help.js owns + EXPORTS SUPPORT_EMAIL.
//
// Post-TM-1018 the phone-collision recovery mailto (TM-987) moved OUT of onboarding.js into the pure,
// shared phone-reverify-core.js (so the onboarding gate AND the profile phone field share ONE copy).
// The core keeps its own PHONE_RECOVERY_SUPPORT_EMAIL (staying import-safe — it must not pull help.js's
// DOM graph into a pure module), so the drift guard here is by VALUE: it must equal help.js's SUPPORT_EMAIL.
// onboarding.js must carry no hardcoded support-email literal of its own. Same source-inspection pattern
// as admin-hub-label-guard.test.mjs.

import assert from "node:assert/strict";
import { test } from "node:test";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { SUPPORT_EMAIL } from "../src/assets/help.js";
import { PHONE_RECOVERY_SUPPORT_EMAIL } from "../src/assets/phone-reverify-core.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ONBOARDING_SRC = readFileSync(join(HERE, "../src/assets/onboarding.js"), "utf8");
const HELP_SRC = readFileSync(join(HERE, "../src/assets/help.js"), "utf8");
const CORE_SRC = readFileSync(join(HERE, "../src/assets/phone-reverify-core.js"), "utf8");

test("help.js is the single source of truth: it EXPORTS SUPPORT_EMAIL", () => {
  // The value itself (the 10xai support inbox), and that it is an *exported* const (so peers can share
  // it) rather than a private one.
  assert.equal(SUPPORT_EMAIL, "hello@10xai.co.uk");
  assert.match(HELP_SRC, /export const SUPPORT_EMAIL\s*=/);
});

test("the shared recovery mailto (phone-reverify-core.js) sources ONE support address — no drift from help.js", () => {
  // Post-TM-1018 the mailto lives in the core and is reused by both the gate and the profile field. Its
  // support address must equal help.js's single source (by value — the core stays import-safe, so it can't
  // import help.js's DOM graph). This is the anti-drift guarantee TM-1019 (d) is really about.
  assert.equal(PHONE_RECOVERY_SUPPORT_EMAIL, SUPPORT_EMAIL);
  // The core builds the mailto from that constant (not a re-typed literal).
  assert.match(CORE_SRC, /mailto:\$\{PHONE_RECOVERY_SUPPORT_EMAIL\}/);
});

test("onboarding.js carries no hardcoded support-email literal of its own", () => {
  // The drift hazard TM-1019 removed: onboarding must not redeclare the address (const or bare literal) —
  // it consumes the pre-built PHONE_RECOVERY_MAILTO from the shared core instead.
  assert.doesNotMatch(ONBOARDING_SRC, /const\s+SUPPORT_EMAIL\s*=/);
  assert.doesNotMatch(ONBOARDING_SRC, /"hello@10xai\.co\.uk"/);
});
