// Deploy-config guard (TM-537). Framework-free — Node's built-in test runner, picked up by the CI
// glob `node --test web/tools/*.test.mjs`.
//
// TM-529 retired the multi-theme family system (clean/doodle/sketch) and removed the `theme:` key
// from web/src/assets/config.js — appearance is now PER-USER and server-persisted via `/me`, not a
// build-time lever. But the prod web deploy (`.github/workflows/deploy.yml`) still carried an
// "Inject web theme into config.js" step whose `else` branch `sed`-injected a dead `theme:` key into
// the DEPLOYED config.js on every deploy (a valid-but-ignored key), driven by a live `vars.THEME`
// repo variable that no code reads. TM-537 deletes that step and the `vars.THEME` lever.
//
// This test locks the retirement so a later edit can't silently reintroduce a build-time theme
// injection or the dead operator lever:
//   • config.js (the source that ships as the deployed config, plus apiBaseUrl/buildVersion
//     injections) carries NO `theme:` key, and
//   • deploy.yml no longer has the theme-injection step, references `vars.THEME`, or `sed`-writes a
//     `theme:` key — while the sibling apiBaseUrl + buildVersion injection steps are untouched.
// Together these guarantee the AC: a prod deploy's config.js contains no `theme:` key and no
// reference to `vars.THEME`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = readFileSync(join(HERE, "../src/assets/config.js"), "utf8");
const DEPLOY = readFileSync(join(HERE, "../../.github/workflows/deploy.yml"), "utf8");

test("config.js carries no `theme:` key (TM-529 retirement)", () => {
  // A real key is `theme:` (with a colon); prose mentions of the word `theme` in the file's
  // comments are fine, so we match the key form specifically.
  assert.doesNotMatch(CONFIG, /\btheme\s*:/, "config.js must not define a `theme:` key");
});

test("deploy.yml has no theme-injection step (TM-537 AC)", () => {
  assert.ok(
    !DEPLOY.includes("Inject web theme into config.js"),
    "the `Inject web theme into config.js` step must be removed from deploy.yml",
  );
});

test("deploy.yml no longer references the `vars.THEME` operator lever (TM-537 AC)", () => {
  assert.ok(!DEPLOY.includes("vars.THEME"), "deploy.yml must not reference `vars.THEME`");
  // Belt-and-braces: no residual theme handling of any form (env var, echo, or sed of a theme key).
  assert.doesNotMatch(DEPLOY, /\btheme\b/i, "no `theme` handling should remain anywhere in deploy.yml");
});

test("deploy.yml still injects apiBaseUrl and buildVersion (the real, kept injections)", () => {
  // Guard against an over-broad delete: the two live config.js injections must survive.
  assert.ok(
    DEPLOY.includes("Inject backend API base URL into config.js"),
    "the apiBaseUrl injection step must be kept",
  );
  assert.ok(
    DEPLOY.includes("Inject web build version into config.js"),
    "the buildVersion injection step must be kept",
  );
});
