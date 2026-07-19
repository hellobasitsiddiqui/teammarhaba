// Pure, DOM-free loading mask for the admin console stats bars (TM-756, flash-of-zero — the
// TM-663 bug class) — extracted so the fix has a real behavioural seam under `node --test`
// (admin-stats-loading.test.mjs): the DOM halves (admin.js / admin-events.js / admin-venues.js /
// admin-interests.js) cannot be imported there (api.js → Firebase CDN chain), so the rule lives
// here, import-free, like its *-core.js siblings (admin-page-walk-core.js et al).
//
// THE BUG: every console's load*() sets state.loading = true and calls render() BEFORE its page
// walk resolves, and renderStats() computed concrete counts straight from the still-empty state —
// so a populated system flashed "Total 0 / Admins 0 / …" as if that were real data, then jumped to
// the real numbers. The TABLE sibling was already gated on state.loading ("Loading users…"); the
// stats path was not — that asymmetry is the whole bug.
//
// THE RULE: while loading, every card keeps its label but shows the em-dash "—" placeholder in
// place of its value (the repo's established not-a-value mark — e.g. the interests console's
// non-featured cell), so the stats grid keeps its exact markup shape — no layout jump, and the
// product tour's ".tm-stats" target (tour-highlights.js) still matches. Once loading clears, the
// cards pass through UNTOUCHED, keeping the loaded-numbers path byte-identical to before TM-756.

/** The while-loading stand-in for every stat value — deliberately not a number. */
export const STAT_LOADING_PLACEHOLDER = "—";

/**
 * Apply the loading mask to a stats-card list.
 *
 * @param {Array<[string, string|number]>} cards [label, value] pairs in display order
 * @param {boolean} loading the console's state.loading flag (true while the page walk is in flight)
 * @returns {Array<[string, string|number]>} the SAME array when not loading (pass-through, no copy);
 *          while loading, a NEW array with every value replaced by the placeholder — the input is
 *          never mutated, so the real values are still there for the post-fetch render.
 */
export function statsCards(cards, loading) {
  if (!loading) return cards;
  return cards.map(([label]) => [label, STAT_LOADING_PLACEHOLDER]);
}
