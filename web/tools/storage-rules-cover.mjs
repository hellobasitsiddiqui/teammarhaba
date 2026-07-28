// Pure coverage check for Firebase Storage rules (TM-704).
//
// The prod outage was NOT a wrong rule — the committed storage.rules were always correct. It was a
// stale *released* ruleset: CD silently failed to deploy, so the live rules were frozen at the
// TM-184 avatars-only deploy and lacked the event-images/ (TM-392) and venue-images/ (TM-519)
// blocks. Uploads to those paths hit default-deny and every admin image upload failed behind a
// green deploy. Content tests couldn't catch that (they run against the committed file, which is
// fine); only a check that the *ruleset in force* covers the required paths can.
//
// This is that check, kept pure (DOM-free, IO-free) so `node --test` exercises it and the deploy
// workflow can run it against BOTH the committed file (pre-deploy gate) and the released ruleset
// source (post-deploy verification).

/** Top-level Storage paths that MUST have a match block, or an admin image upload silently 403s. */
export const REQUIRED_STORAGE_PATHS = ["avatars", "event-images", "venue-images"];

/**
 * Return the required path prefixes that have no `match /<prefix>/…` block in `rulesText`.
 * Empty array = fully covered; a non-empty array is the exact remediation list.
 *
 * @param {string} rulesText a Storage rules document — the committed storage.rules, or the source of
 *   a released ruleset fetched from the Firebase Rules API.
 * @param {string[]} [required] prefixes to require (defaults to {@link REQUIRED_STORAGE_PATHS}).
 * @returns {string[]} the missing prefixes, preserving the given order.
 */
export function missingStoragePathCoverage(rulesText, required = REQUIRED_STORAGE_PATHS) {
  const text = String(rulesText || "");
  // A path is covered when the ruleset declares a match block for it: `match /event-images/{id}`.
  return required.filter((prefix) => !new RegExp(`match\\s+/${prefix}/`).test(text));
}

/**
 * Extract the body of a top-level Storage `match /<segment>/…` block from a rules document, walking
 * the braces so nested `match`/`function` blocks are captured whole rather than truncated at the
 * first `}`. Tolerates a multi-segment path (`/chat-media/{conversationId}/{imageId}`) — it anchors on
 * the segment header and then finds the FIRST `{` that opens the block body (the one after all the
 * `{var}` path captures), not the path captures themselves.
 *
 * @param {string} rulesText a Storage rules document (the committed storage.rules).
 * @param {string} segment the leading path segment to find, e.g. "chat-media".
 * @returns {string|null} the block body between the outermost braces, or null if no such block.
 */
export function matchBlockBodyFor(rulesText, segment) {
  const text = String(rulesText || "");
  // Locate `match /<segment>/…` then scan forward for the block-opening `{`. Path captures like
  // `{conversationId}` open+close on the same token, so track depth from the match keyword: the block
  // body is the `{` that is NOT immediately closed.
  const header = new RegExp(`match\\s+/${segment}/`);
  const h = header.exec(text);
  if (!h) return null;
  // From the header, find the opening brace of the block body: skip `{seg}` path captures (which are
  // `{...}` pairs sitting on the path) and take the next standalone `{`.
  let i = h.index + h[0].length;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "{") {
      // Is this a path capture like `{imageId}` (closes before the next `/` or `{`) or the block body?
      const close = text.indexOf("}", i);
      const nextSlashOrBrace = text.slice(i + 1).search(/[/{]/);
      const isPathCapture = close !== -1 && (nextSlashOrBrace === -1 || i + 1 + nextSlashOrBrace > close);
      if (!isPathCapture) break; // this `{` opens the block body
      i = close + 1;
      // skip a trailing path separator/whitespace before the next capture or the body brace
      while (i < text.length && /[\s/]/.test(text[i])) i++;
    } else {
      i++;
    }
  }
  if (i >= text.length || text[i] !== "{") return null;
  // Walk from this opening brace to its balanced close.
  let depth = 0;
  const start = i;
  for (let j = start; j < text.length; j++) {
    if (text[j] === "{") depth++;
    else if (text[j] === "}") {
      depth--;
      if (depth === 0) return text.slice(start + 1, j);
    }
  }
  return null; // unbalanced braces — treated as "no usable block"
}

/**
 * True when a match-block body denies ALL direct client read AND write — i.e. every `allow` rule in
 * the block is `allow <ops>: if false;` (or the block declares no `allow` at all, which is also a
 * default-deny). This backs the chat-media property: all access is via a backend-minted signed URL
 * (signed URLs bypass rules), so a public/authenticated caller must never read or write these objects
 * directly. A single `allow …: if true;` (or any non-`false` condition) fails the check.
 *
 * @param {string} blockBody the body returned by {@link matchBlockBodyFor}.
 * @returns {boolean} true iff the block grants no direct read or write access.
 */
export function deniesAllAccess(blockBody) {
  const body = String(blockBody || "");
  // Every `allow <ops>: if <cond>;` rule must have a `false` condition. Collect all allow rules.
  const allowRe = /allow\s+[a-z,\s]+:\s*if\s+([^;]+);/gi;
  let m;
  let sawAllow = false;
  while ((m = allowRe.exec(body)) !== null) {
    sawAllow = true;
    const cond = m[1].replace(/\s+/g, " ").trim();
    if (cond !== "false") return false; // any non-`false` allow means some access is granted
  }
  // No `allow` at all → default-deny (fine). At least one allow, and all were `false` → deny (fine).
  return true;
}
