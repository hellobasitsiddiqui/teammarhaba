import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  matchBlockBody,
  writeRuleCondition,
  requiresAdminClaim,
  requiresImageContentType,
} from "./venue-storage-rules.mjs";

// TM-738 P0 (venues) — pin the two venue-images/ write security-negatives that today live only in
// the emulator e2e (web/e2e/tests/storage-rules.mjs) and so never run in the fast `node --test`
// gate. Pure content checks against the real committed storage.rules — mirrors
// storage-rules-cover.test.mjs. Characterization: the committed rules already enforce both, so
// these PASS; they fail only if a future edit weakens the venue-images write rule.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const rules = readFileSync(join(repoRoot, "storage.rules"), "utf8");

// The write rule the two P0s assert against — extracted once from the committed ruleset.
const venueWriteCondition = writeRuleCondition(matchBlockBody(rules, "venue-images"));

test("the committed storage.rules has a venue-images block with a create/update rule", () => {
  // Guard: if the block or its write rule ever disappears, the two P0 assertions below would be
  // vacuously true — fail loudly instead.
  assert.ok(matchBlockBody(rules, "venue-images"), "expected a match /venue-images/{id} block");
  assert.ok(venueWriteCondition, "expected an `allow create, update: if …;` rule in venue-images");
});

test("venueImageRules_rejectNonImageContentType", () => {
  // A venue photo is world-readable (public raster). The write rule must gate on an image/raster
  // content-type so a non-image upload (application/pdf) — and specifically an active image/svg+xml
  // (stored-XSS on a public-read origin) — is rejected. The committed rule expresses this via the
  // shared isPublicRasterImage() helper, which matches only raster formats and excludes svg+xml.
  assert.ok(
    requiresImageContentType(venueWriteCondition),
    "venue-images write must gate on an image/raster content-type (isPublicRasterImage), " +
      `got condition: ${venueWriteCondition}`,
  );

  // And confirm the helper it relies on really is raster-only: svg+xml must NOT be in the allow-list.
  const helper = /function\s+isPublicRasterImage\s*\(\s*\)\s*\{([^}]*)\}/.exec(rules);
  assert.ok(helper, "expected the isPublicRasterImage() helper in storage.rules");
  assert.doesNotMatch(
    helper[1],
    /svg/i,
    "isPublicRasterImage() must NOT accept svg (active document → stored-XSS on public read)",
  );
});

test("venueImageRules_denyNonAdminWrite", () => {
  // Only an ADMIN (the `role` custom claim RoleService maintains, TM-110) may upload/replace a venue
  // photo. A signed-in non-admin, and an anonymous caller, must be denied — the write rule requires
  // both a non-null auth and the ADMIN claim.
  assert.ok(
    requiresAdminClaim(venueWriteCondition),
    "venue-images write must require request.auth != null AND token.role == 'ADMIN', " +
      `got condition: ${venueWriteCondition}`,
  );

  // Negative control: a rule that only checked auth != null (any signed-in user) would NOT satisfy
  // requiresAdminClaim — proves the assertion is really pinning the ADMIN gate, not just presence.
  assert.equal(requiresAdminClaim("request.auth != null"), false);
});
