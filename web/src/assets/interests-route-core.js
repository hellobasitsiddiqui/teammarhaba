// Dedicated interests-management ROUTE — pure view-model core (TM-1095).
//
// TM-1095 replaces the in-place picker OVERLAY (the `.tm-modal` opened from the profile hub's "Manage"/
// "＋ add" chip, TM-970) with a dedicated full-screen route (`#/profile/interests`). The route adds three
// things the overlay lacked: a SEARCH field that filters the catalogue, COLLAPSIBLE category sections,
// and a STICKY Save/Cancel bar. It keeps the SAME min/max bounds and the SAME PATCH /me save contract as
// the overlay.
//
// As with interests-core.js / profile-core.js, the DOM-free, framework-free rules live HERE so they can
// be unit-tested in plain Node (`node --test web/tools/*.test.mjs`) — the house "extract the pure logic
// to test it" pattern (docs/agents/conventions/AGENTIC-LESSONS). The DOM renderer (interests-route.js)
// is a thin map over this: it reads `routeViewModel()` and paints the sections, the current-selection
// summary, the search box, and the sticky bar; every interaction (type in search, toggle a chip, expand/
// collapse a section) just recomputes the view-model and repaints.
//
// NONE of these functions touch the DOM, Firebase, or the network. They take plain data shaped like the
// backend payloads — MeResponse.interests (`[{label, category, sourceInterestId}]`) and the PUBLIC
// catalogue rows (`[{label, category, emoji, highlighted, sortWeight}]`, see PublicInterestResponse) —
// and return plain data the renderer maps to elements.
//
// It reuses interests-core.js for the shared primitives (savedInterestLabels de-dup, toggleInterest's
// max-guarded toggle, selectionError's min/max message, interestEmoji) so the route and the retired
// overlay can't drift on the core selection rules.

import {
  DEFAULT_INTEREST_MIN,
  DEFAULT_INTEREST_MAX,
  savedInterestLabels,
  toggleInterest,
  selectionError,
  interestEmoji,
} from "./interests-core.js";

// Re-export the shared selection primitives so the DOM renderer imports everything from ONE module
// (interests-route-core) rather than reaching back into interests-core for the toggle/validate pair.
export { toggleInterest, selectionError, savedInterestLabels, DEFAULT_INTEREST_MIN, DEFAULT_INTEREST_MAX };

// The synthetic group name for the featured/highlighted interests. The catalogue has no "Popular" row —
// it's derived client-side from the `highlighted` flag (PublicInterestResponse.highlighted), floated to
// the TOP of the section list so a first-time user sees the six featured interests before scrolling the
// full alphabet of categories. The label is a constant so the renderer and the tests agree on it.
export const POPULAR_GROUP = "Popular";

/**
 * Normalise a free-text search query for matching: lower-cased + trimmed. A blank/absent query returns
 * "" (the renderer treats that as "no filter", showing the whole catalogue). Kept tiny + pure so the
 * filter predicate below is the single source of truth for what "matches".
 *
 * @param {string|null|undefined} query the raw search box value.
 * @returns {string} the normalised query ("" when blank).
 */
export function normaliseQuery(query) {
  return typeof query === "string" ? query.trim().toLowerCase() : "";
}

/**
 * Does a catalogue row match the (already-normalised) search query? Case-insensitive SUBSTRING match on
 * the label OR the category, so typing "coff" finds "Coffee & cafés" and typing "food" finds every row
 * in the "Food & Drink" category. A blank query matches everything (no filter).
 *
 * @param {{label?: string, category?: string}} row a catalogue row.
 * @param {string} normQuery the normalised query (from normaliseQuery).
 * @returns {boolean}
 */
export function rowMatchesQuery(row, normQuery) {
  if (!normQuery) return true; // no filter → everything matches
  const label = (row && typeof row.label === "string" ? row.label : "").toLowerCase();
  const category = (row && typeof row.category === "string" ? row.category : "").toLowerCase();
  return label.includes(normQuery) || category.includes(normQuery);
}

/**
 * Group the (active) catalogue into sections for the route, honouring a search filter and the collapse
 * state, with each option flagged selected/disabled exactly as the overlay's catalogueGroups did.
 *
 * Sections (in order): a synthetic "Popular" group of the highlighted rows FIRST, then the real
 * categories in first-seen catalogue order (the backend already sorts highlights-first then
 * alphabetically, so first-seen ≈ the intended order). A row that is highlighted appears in BOTH the
 * Popular group and its own category — the same interest reachable two ways, mirroring how a store shows
 * a "Featured" shelf plus the aisle. Toggling either instance toggles the same label (the renderer keys
 * chips by label, not by section).
 *
 * Filtering: only rows matching the query are kept; a section with no matching rows is dropped entirely
 * (so an empty "Music & Nightlife" header never shows while searching "coffee"). Retired rows
 * (active === false) and blank labels are skipped defensively, matching catalogueGroups.
 *
 * Collapse: each section carries `collapsed` from the passed `collapsed` set (a Set/array of section
 * names the user has folded). While a search query is active, sections are FORCE-EXPANDED (collapsed:
 * false) regardless of the stored state — hiding matches behind a collapsed header would make the search
 * feel broken. The stored collapse state is untouched; it simply doesn't apply during a search.
 *
 * @param {Array<{label?: string, category?: string, emoji?: string, highlighted?: boolean, active?: boolean}>|null|undefined} catalogue
 * @param {string[]} selectedLabels the pending selection (labels).
 * @param {{
 *   max?: number,
 *   query?: string,
 *   collapsed?: Set<string>|string[]|null,
 * }} [opts]
 * @returns {{
 *   sections: {name: string, popular: boolean, collapsed: boolean, options: {label: string, selected: boolean, disabled: boolean, emoji: string}[]}[],
 *   matchCount: number,
 *   atMax: boolean,
 *   filtering: boolean,
 * }}
 */
export function groupedSections(catalogue, selectedLabels, { max = DEFAULT_INTEREST_MAX, query = "", collapsed = null } = {}) {
  const selected = new Set(savedInterestLabels(selectedLabels));
  const atMax = selected.size >= max;
  const normQuery = normaliseQuery(query);
  const filtering = normQuery !== "";
  const foldedSet = collapsed instanceof Set ? collapsed : new Set(Array.isArray(collapsed) ? collapsed : []);
  const rows = Array.isArray(catalogue) ? catalogue : [];

  // Build an option view-model for a row (shared by the Popular group + the per-category groups).
  const toOption = (row) => {
    const label = typeof row.label === "string" ? row.label.trim() : "";
    const isSelected = selected.has(label);
    return {
      label,
      selected: isSelected,
      // Disabled only at the cap AND not already selected — you can always DEselect to make room. The
      // same predicate catalogueGroups uses for the overlay, so the two surfaces gate identically.
      disabled: atMax && !isSelected,
      emoji: interestEmoji(row),
    };
  };

  // Collect the category groups in first-seen order, and the highlighted rows for the synthetic Popular
  // group, in ONE pass. Skip retired rows + blank labels.
  const order = [];
  const byCategory = new Map();
  const popularOpts = [];
  let matchCount = 0;
  for (const row of rows) {
    if (!row || row.active === false) continue;
    const label = typeof row.label === "string" ? row.label.trim() : "";
    if (!label) continue;
    if (!rowMatchesQuery(row, normQuery)) continue; // filtered out — counts toward no section
    matchCount += 1;
    const category = (typeof row.category === "string" && row.category.trim()) || "Other";
    if (!byCategory.has(category)) {
      byCategory.set(category, []);
      order.push(category);
    }
    const opt = toOption(row);
    byCategory.get(category).push(opt);
    if (row.highlighted) popularOpts.push(opt);
  }

  const sections = [];
  // Popular FIRST when it has any matches. It's collapsible like any section (default expanded), but a
  // section header only appears when it has options — so it silently vanishes when a search excludes
  // every highlighted row.
  if (popularOpts.length > 0) {
    sections.push({
      name: POPULAR_GROUP,
      popular: true,
      collapsed: filtering ? false : foldedSet.has(POPULAR_GROUP),
      options: popularOpts,
    });
  }
  for (const category of order) {
    sections.push({
      name: category,
      popular: false,
      collapsed: filtering ? false : foldedSet.has(category),
      options: byCategory.get(category),
    });
  }
  return { sections, matchCount, atMax, filtering };
}

/**
 * The current-selection summary shown at the top of the route (and driving the sticky bar's enabled
 * state): the chosen labels (each removable — the route has no min-lock on the summary chips because the
 * Save is the gate, and the server + selectionError() enforce the min), the count, the min/max, and the
 * count/limit line copy. Distinct from interestChipsModel (the hub card): here EVERY chip is removable
 * (this is the editor; you can drop below min transiently and Save simply stays disabled until you're
 * back in range), and there's no "add" entry chip (the sections below ARE the add surface).
 *
 * @param {string[]} selectedLabels the pending selection.
 * @param {{min?: number, max?: number}} [bounds]
 * @returns {{
 *   chips: {label: string}[],
 *   count: number,
 *   min: number,
 *   max: number,
 *   atMin: boolean,
 *   atMax: boolean,
 *   empty: boolean,
 *   countLine: string,
 * }}
 */
export function selectionSummary(selectedLabels, { min = DEFAULT_INTEREST_MIN, max = DEFAULT_INTEREST_MAX } = {}) {
  const labels = savedInterestLabels(selectedLabels);
  const count = labels.length;
  return {
    chips: labels.map((label) => ({ label })),
    count,
    min,
    max,
    atMin: count <= min,
    atMax: count >= max,
    empty: count === 0,
    countLine: `${count} of ${max} selected`,
  };
}

/**
 * The sticky Save/Cancel bar's state. Save is enabled only when the pending selection is valid against
 * min/max (selectionError === "") AND the selection actually DIFFERS from the originally-saved set — so
 * an untouched editor can't fire a no-op PATCH, and an obviously-invalid set (below min / above max) is
 * pre-blocked with the server's own message copy before a round-trip. Cancel is always enabled (it
 * discards and leaves).
 *
 * @param {string[]} selectedLabels the pending selection.
 * @param {string[]} originalLabels the set the route opened with (the saved interests).
 * @param {{min?: number, max?: number}} [bounds]
 * @returns {{
 *   canSave: boolean,
 *   dirty: boolean,
 *   error: string,
 * }}
 */
export function saveBarModel(selectedLabels, originalLabels, { min = DEFAULT_INTEREST_MIN, max = DEFAULT_INTEREST_MAX } = {}) {
  const selected = savedInterestLabels(selectedLabels);
  const original = savedInterestLabels(originalLabels);
  const error = selectionError(selected, { min, max });
  const dirty = !sameLabelSet(selected, original);
  return {
    // Save only when the set is valid AND changed — a valid-but-unchanged editor has nothing to persist.
    canSave: error === "" && dirty,
    dirty,
    error,
  };
}

/**
 * Set-equality of two label lists (order-independent, both already de-duped by savedInterestLabels).
 * Powers the dirty check + the leave-guard (a route with unsaved changes can warn before discarding).
 *
 * @param {string[]} a
 * @param {string[]} b
 * @returns {boolean} true when a and b contain exactly the same labels.
 */
export function sameLabelSet(a, b) {
  const sa = new Set(savedInterestLabels(a));
  const sb = new Set(savedInterestLabels(b));
  if (sa.size !== sb.size) return false;
  for (const label of sa) if (!sb.has(label)) return false;
  return true;
}

/**
 * Toggle a section's collapsed state in a folded-set, returning a NEW Set (does not mutate the input).
 * The renderer keeps the folded section names in a Set and persists it per-uid; this is the single pure
 * transition so expand/collapse can't diverge from what groupedSections reads.
 *
 * @param {Set<string>|string[]|null|undefined} collapsed the current folded set.
 * @param {string} sectionName the section being toggled.
 * @returns {Set<string>} the new folded set.
 */
export function toggleSection(collapsed, sectionName) {
  const next = new Set(collapsed instanceof Set ? collapsed : Array.isArray(collapsed) ? collapsed : []);
  const name = String(sectionName ?? "").trim();
  if (!name) return next;
  if (next.has(name)) next.delete(name);
  else next.add(name);
  return next;
}

/**
 * The empty-results copy for the search box when a query matches nothing (matchCount === 0 while
 * filtering). Names the query so the user sees exactly what they typed. A blank query never reaches here
 * (that's "no filter", not "no results").
 *
 * @param {string} query the raw (un-normalised) query the user typed.
 * @returns {string}
 */
export function noResultsMessage(query) {
  const shown = typeof query === "string" ? query.trim() : "";
  return shown ? `No interests match “${shown}”.` : "No interests match your search.";
}
