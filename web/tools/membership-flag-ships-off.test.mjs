// Membership-flag config guard (TM-725). Framework-free — Node's built-in test runner, picked up by
// the CI glob `node --test web/tools/*.test.mjs`.
//
// The committed web membership flag (`flags.membership` in web/src/assets/config.js) MUST ship OFF:
// every gate comment and every reader (membership-tier.js / events.js / membership-receipts.js /
// membership-subscribe.js / router.js) documents it as "shipped OFF" inert dead code. TM-725 fixed a
// drift where the committed value was `true` while the comments claimed OFF, and added a real,
// opt-in deploy-time injection seam (mirroring the apiBaseUrl / buildVersion / ops seams).
//
// This test locks committed state == documented state so a later edit can't silently re-ship the
// flag ON, and locks the injection seam so go-live stays a deploy toggle rather than a source edit.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = readFileSync(join(HERE, "../src/assets/config.js"), "utf8");
const DEPLOY = readFileSync(join(HERE, "../../.github/workflows/deploy.yml"), "utf8");

test("config.js ships membership flag OFF (committed default matches the comments)", () => {
  // Assert on the CODE only — strip line comments so the seam's `membership: true` doc arrow can't
  // false-positive the negative check below.
  const code = CONFIG.split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  assert.match(code, /\bmembership\s*:\s*false\b/, "config.js must ship `membership: false`");
  assert.doesNotMatch(code, /\bmembership\s*:\s*true\b/, "config.js must not ship `membership: true`");
});

test("deploy.yml carries the opt-in membership injection seam", () => {
  assert.ok(
    DEPLOY.includes("Inject web membership flag into config.js"),
    "the membership-flag injection step must exist in deploy.yml",
  );
  // Opt-in only: the flag flips ON exclusively when the explicit repo variable is "true".
  assert.ok(
    DEPLOY.includes("WEB_MEMBERSHIP_FLAG"),
    "the injection must be gated on the explicit WEB_MEMBERSHIP_FLAG repo variable",
  );
  assert.ok(
    DEPLOY.includes('s#membership: false#membership: true#'),
    "the seam must sed `membership: false` -> `membership: true` (matches the committed token)",
  );
});
