// Pure content assertions for the venue-images/ block of storage.rules (TM-738 P0, venues).
//
// Context: storage-rules-cover.mjs only checks that a `match /venue-images/…` block *exists* (the
// TM-704 stale-ruleset outage was a missing block, not a wrong rule). That leaves the venue-images
// security-negatives — "not an ADMIN can't write" and "a non-image content-type is rejected" —
// asserted ONLY by the emulator e2e (web/e2e/tests/storage-rules.mjs), which needs a running Storage
// emulator and so never runs in the fast `node --test` gate. Venue photos are world-readable
// (public raster), so both gates are real security properties: an admin-only write claim keeps
// arbitrary users from planting images, and the raster-only content-type keeps an active SVG
// (stored-XSS vector) off a public-read origin.
//
// These helpers parse the committed storage.rules text and expose the venue-images write rule's
// conditions so a pure, IO-free, DOM-free unit test can pin those two behaviours against the
// real committed ruleset — mirroring storage-rules-cover.mjs (helper + sibling *.test.mjs).
//
// This is a CHARACTERIZATION check: the committed rules already enforce both properties (see
// storage.rules `match /venue-images/{venueId}` → create,update guarded on
// `request.auth.token.role == 'ADMIN'` and `isPublicRasterImage()`). The test asserts that
// existing behaviour and must PASS; it fails only if a future edit weakens the venue-images write
// rule (e.g. drops the ADMIN claim or the image-type check).

/**
 * Extract the body of a top-level Storage `match /<segment>/{var} { … }` block from a rules
 * document. Brace-balanced so nested `match`/`function` blocks inside are captured whole rather
 * than truncated at the first `}`.
 *
 * @param {string} rulesText a Storage rules document (the committed storage.rules).
 * @param {string} segment the path segment to find, e.g. "venue-images".
 * @returns {string|null} the block body between the outermost braces, or null if no such block.
 */
export function matchBlockBody(rulesText, segment) {
  const text = String(rulesText || "");
  // Find `match /<segment>/{anything}` then the opening brace that follows it.
  const header = new RegExp(`match\\s+/${segment}/\\{[^}]*\\}\\s*\\{`);
  const m = header.exec(text);
  if (!m) return null;
  // Walk from the opening brace, counting depth, to find the matching close.
  let depth = 0;
  const start = m.index + m[0].length - 1; // index of the opening `{`
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start + 1, i);
    }
  }
  return null; // unbalanced braces — treated as "no usable block"
}

/**
 * Pull the condition of the `allow create, update: if <cond>;` rule out of a match-block body.
 * Only the write rule (create/update — the one that carries the resource/auth checks) is returned;
 * the separate read and delete rules are ignored.
 *
 * @param {string} blockBody the body returned by {@link matchBlockBody}.
 * @returns {string|null} the condition text (whitespace-collapsed), or null if no create/update rule.
 */
export function writeRuleCondition(blockBody) {
  const body = String(blockBody || "");
  // `allow create, update:` (order/spacing tolerant) up to the terminating semicolon.
  const rule = /allow\s+create\s*,\s*update\s*:\s*if\s+([^;]+);/.exec(body);
  if (!rule) return null;
  return rule[1].replace(/\s+/g, " ").trim();
}

/**
 * True when a write-rule condition gates the upload on the ADMIN custom claim — i.e. a non-admin
 * (or anonymous) caller cannot write. This is the `denyNonAdminWrite` property.
 *
 * @param {string} condition a condition from {@link writeRuleCondition}.
 */
export function requiresAdminClaim(condition) {
  const c = String(condition || "");
  // The rule authority: `request.auth.token.role == 'ADMIN'` (single or double quotes tolerated).
  return /request\.auth\.token\.role\s*==\s*['"]ADMIN['"]/.test(c)
    && /request\.auth\s*!=\s*null/.test(c);
}

/**
 * True when a write-rule condition gates the upload on an image/raster content-type — i.e. a
 * non-image upload (e.g. application/pdf, image/svg+xml) is rejected. This is the
 * `rejectNonImageContentType` property. The committed rules express this via the shared
 * `isPublicRasterImage()` helper (which matches only png|jpeg|jpg|gif|webp|avif|heic|heif and
 * deliberately excludes svg+xml), so accept either the helper call or a direct contentType match.
 *
 * @param {string} condition a condition from {@link writeRuleCondition}.
 */
export function requiresImageContentType(condition) {
  const c = String(condition || "");
  return /isPublicRasterImage\s*\(\s*\)/.test(c)
    || /request\.resource\.contentType\.matches\s*\(/.test(c);
}
