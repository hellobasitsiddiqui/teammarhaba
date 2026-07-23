// TM-1019 (d) — the support contact email must have ONE definition. help.js owns and EXPORTS
// SUPPORT_EMAIL; onboarding.js's phone-collision recovery mailto (TM-987) must IMPORT that single
// constant, not carry its own hardcoded copy that can silently drift out of step with the help page.
//
// FAIL-BEFORE / PASS-AFTER: before TM-1019, onboarding.js declared its own
// `const SUPPORT_EMAIL = "hello@10xai.co.uk"` — the "onboarding must not redeclare its own literal"
// assertion below would have failed. After the fix onboarding imports it from help.js, so the two can
// never diverge. Uses the same source-text-inspection pattern as admin-hub-label-guard.test.mjs.

import assert from "node:assert/strict";
import { test } from "node:test";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { SUPPORT_EMAIL } from "../src/assets/help.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ONBOARDING_SRC = readFileSync(join(HERE, "../src/assets/onboarding.js"), "utf8");
const HELP_SRC = readFileSync(join(HERE, "../src/assets/help.js"), "utf8");

test("help.js is the single source of truth: it EXPORTS SUPPORT_EMAIL", () => {
  // The value itself (the 10xai support inbox), and that it is an *exported* const (so peers can share
  // it) rather than a private one.
  assert.equal(SUPPORT_EMAIL, "hello@10xai.co.uk");
  assert.match(HELP_SRC, /export const SUPPORT_EMAIL\s*=/);
});

test("onboarding.js SHARES help.js's SUPPORT_EMAIL instead of hardcoding its own copy", () => {
  // It must import the constant from help.js …
  assert.match(ONBOARDING_SRC, /import\s*\{\s*SUPPORT_EMAIL\s*\}\s*from\s*["']\.\/help\.js["']/);
  // … and must NOT redeclare its own literal (the drift hazard this ticket removed). This is the exact
  // assertion that fails on the pre-TM-1019 `const SUPPORT_EMAIL = "hello@10xai.co.uk"` in onboarding.js.
  assert.doesNotMatch(ONBOARDING_SRC, /const\s+SUPPORT_EMAIL\s*=/);
  // The recovery mailto still uses the (now imported) constant.
  assert.match(ONBOARDING_SRC, /mailto:\$\{SUPPORT_EMAIL\}/);
});
