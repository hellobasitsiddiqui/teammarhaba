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
