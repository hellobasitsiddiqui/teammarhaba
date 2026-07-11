// Admin user-detail Subscription panel flag-gate regression guard (TM-624 fix, backfilled by TM-629).
// Framework-free — Node's built-in test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// THE BUG (review finding, frontend-ci MEDIUM): TM-620 added a "Subscription" heading +
// loadSubscription(user) to openDetail() in admin.js with NO config.flags.membership check — unlike
// every other membership surface in the epic. With the flag OFF (the shipped state), every admin
// user-detail modal on the LIVE site showed a Subscription section ("No subscription — pay-per-event
// account.") and fired GET /api/v1/admin/users/{id}/subscription on every open — breaking the epic's
// stated invariant that ALL membership UI ships inert behind the OFF flag, and leaking the feature's
// existence (plus an extra request per modal) into production ahead of launch.
//
// THE FIX (TM-624): admin.js gained a local membershipEnabled() reading the SAME single flag
// (config.flags.membership) the other membership screens gate on; both the Subscription section AND
// the loadSubscription() fetch are behind it.
//
// admin.js can't be imported under `node --test` (it statically imports api.js/auth.js → the Firebase
// CDN), so — like events-map-link-a11y.test.mjs — this is a source-level guard pinning both halves of
// the gate: the SECTION (no leaked UI) and the FETCH (no leaked request).

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "../src/assets/admin.js"), "utf8");

test("admin.js defines membershipEnabled() off the single config.flags.membership flag (TM-624)", () => {
  const fn = SRC.match(/function\s+membershipEnabled\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(fn, "admin.js must carry its own membershipEnabled() (it cannot import the membership modules)");
  assert.match(
    fn[1],
    /cfg\.flags\s*&&\s*cfg\.flags\.membership/,
    "…reading the SAME config.flags.membership flag every other membership surface gates on",
  );
});

test("the Subscription section of the user-detail modal is spread in ONLY when the flag is ON (TM-624)", () => {
  // The gate: `...(membershipEnabled() ? [ <Subscription heading + placeholder> ] : [])`. Pin the
  // heading INSIDE the conditional arm so moving it back out (the regression) fails this test.
  assert.match(
    SRC,
    /\.\.\.\(membershipEnabled\(\)\s*\?\s*\[\s*\n?\s*el\("h3",\s*\{[^}]*text:\s*"Subscription"\s*\}\),[\s\S]*?\]\s*:\s*\[\]\),/,
    "the Subscription heading + placeholder must sit inside a membershipEnabled() ? […] : [] spread — " +
      "with the flag OFF the live admin modal must show NO Subscription section",
  );
});

test("the per-open GET …/users/{id}/subscription fetch is behind the same flag (TM-624)", () => {
  assert.match(
    SRC,
    /if\s*\(membershipEnabled\(\)\)\s*loadSubscription\(user\);/,
    "loadSubscription(user) must only run when the flag is ON — no leaked admin subscription request per modal open",
  );
  // And no OTHER call site sneaks the fetch back in unguarded (the declaration itself doesn't count).
  const calls = [...SRC.matchAll(/(?<!function\s)loadSubscription\(user\);/g)];
  assert.equal(calls.length, 1, "exactly one loadSubscription(user) call site (the guarded one)");
});
