// Boot-screen tagline logic — pure core (TM-381).
//
// A playful quip greets the user on every launch, shown on the lightweight web boot screen (the beat
// between the native-splash handoff and first app paint — see boot-screen.js for the DOM/lifecycle
// half). This module is the PURE, browser-free part: the single configurable tagline list plus the
// random-pick / no-immediate-repeat rule, with NO DOM, `localStorage`, `Math.random` side effects or
// Firebase imports baked in — the RNG and the "previous" value are injected. That keeps it import-safe
// and fully unit-testable under plain `node --test` (the same extraction pattern as
// `tabbar-core.js` / `events-core.js`; see AGENTIC-LESSONS "extract the pure logic to test it").
//
// WHY A WEB BOOT SCREEN AND NOT THE NATIVE SPLASH. Android 12+ renders the launch splash via the
// SYSTEM splash — background colour + icon from fixed theme XML only, with no text or runtime content
// (TM-347). So the quip can't live on the native splash; it lives on the web boot screen, which gives
// one implementation across web, Android WebView and iOS.

/**
 * The single configurable tagline list (TM-381 seed copy). This is the ONE place to add, remove or
 * reword a quip — everything else reads from here. Kept frozen so a caller can't mutate the shared
 * list by accident (a stray push would silently change what every future launch can show). A later
 * ticket can make this prod-config overridable; today it's a static seed.
 */
export const TAGLINES = Object.freeze([
  "You're just my cup of tea",
  "I like you a latte",
  "Where have you bean all my life?",
  "Let's espresso ourselves",
  "Brewing something good…",
  "You mocha me happy",
  "Better latte than never",
  "Chai to remember this moment",
  "Marhaba! The kettle's on.",
  "Steeping up something fun",
]);

/**
 * Pick one tagline at random, avoiding an immediate repeat of the one shown last launch.
 *
 * Uniform over the candidate pool: every tagline that ISN'T `previous` has an equal chance. Avoiding
 * the back-to-back repeat is a best-effort nicety — with a real list of ten it always holds; it only
 * relaxes in the degenerate cases below, where repeating is unavoidable rather than a bug:
 *   • empty list           → `null` (nothing to show; the caller leaves the slot empty).
 *   • single-item list     → that item, even if it equals `previous` (there's no alternative).
 *   • `previous` not in the list (first ever launch, or the list changed) → the whole list is fair game.
 *
 * Pure + deterministic given `rng`: inject a stub in tests to assert the pick and the no-repeat rule
 * across the RNG's whole [0, 1) range without touching `Math.random` or `localStorage`.
 *
 * @param {readonly string[]} taglines the list to pick from (defaults to {@link TAGLINES}).
 * @param {string|null} [previous] the tagline shown on the last launch, to avoid repeating.
 * @param {() => number} [rng=Math.random] a [0, 1) random source (injectable for tests).
 * @returns {string|null} the chosen tagline, or `null` when the list is empty.
 */
export function pickTagline(taglines = TAGLINES, previous = null, rng = Math.random) {
  if (!Array.isArray(taglines) || taglines.length === 0) return null;
  if (taglines.length === 1) return taglines[0];

  // Candidate pool = everything except the previously-shown tagline, so we never repeat back-to-back.
  // If excluding `previous` would leave nothing (e.g. a one-item list, or every entry equals it), fall
  // back to the full list rather than returning null — showing SOMETHING beats showing nothing.
  const pool = taglines.filter((t) => t !== previous);
  const candidates = pool.length > 0 ? pool : taglines;

  // Uniform index into the pool. Clamp defensively: a well-behaved rng() returns [0, 1) so the raw
  // index is already in range, but some sources can return exactly 1.0 — clamping keeps us in-bounds.
  const raw = Math.floor(rng() * candidates.length);
  const index = Math.min(candidates.length - 1, Math.max(0, raw));
  return candidates[index];
}
