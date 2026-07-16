// Onboarding interests PICK STEP — pure logic core (TM-776 / I4).
//
// The onboarding interests step (a category-grouped picker with a "Popular" section on top, a hard
// min-1 gate and a max from config) keeps its DOM-free, framework-free rules HERE so they can be
// unit-tested in plain Node (`node --test`), the same extraction pattern as profile-core.js /
// events-core.js (see docs/agents/conventions/AGENTIC-LESSONS "extract the pure logic to test it").
// The DOM half lives in onboarding.js; the markup styling lives in styles.css.
//
// NONE of these functions touch the DOM, Firebase, or the network. They take the catalogue rows
// (from GET /api/v1/interests/catalogue), the selection config (from GET /api/v1/interests/config),
// a set/array of currently-selected labels, and a `/me`-shaped object, and return plain data the
// renderer maps to elements. The client validation here is a fail-fast UX MIRROR of the server rules
// (UserService.replaceInterests: hard min-1, max from config, pluralised messages) — the server stays
// the source of truth, so a stale-catalogue race is still caught by the PATCH /me 400.

// The synthetic top-group name. NOT a real catalogue category (InterestCategories.KNOWN never contains
// it) — it is a derived bucket that gathers every highlighted row so the featured/popular interests
// float to the top of the picker, exactly as the catalogue's `sort_weight DESC` intends.
export const POPULAR_LABEL = "Popular";

/**
 * Compare two catalogue rows the way the picker orders them: higher `sortWeight` first, then label
 * ascending (case-insensitive, locale-aware) — the same `ORDER BY sort_weight DESC, label` the
 * backend's catalogue read uses (InterestCatalogueRepository.findAllByOrderBySortWeightDescLabelAsc).
 * Keeps grouping deterministic even when the server already sorted, so a re-sort here is a no-op.
 */
function bySortWeightThenLabel(a, b) {
  const wa = Number(a?.sortWeight ?? 0);
  const wb = Number(b?.sortWeight ?? 0);
  if (wb !== wa) return wb - wa; // higher weight first
  return String(a?.label ?? "").localeCompare(String(b?.label ?? ""));
}

/**
 * Group the flat catalogue into the ordered sections the picker renders.
 *
 * Returns an ORDERED array of `{ category, items }` groups:
 *   1. A synthetic `Popular` group first — ALL highlighted rows (sorted sortWeight DESC, then label).
 *      Omitted entirely when the catalogue has zero highlighted rows (never render an empty section).
 *   2. Then each real category, in the order categories first appear in the (already sort-ordered)
 *      catalogue, each with its rows sorted the same way.
 *
 * A highlighted row appears in BOTH the Popular group AND its home category — dedupe is by LABEL in
 * the selection state (toggling a chip in either place stays in sync because selection is keyed by
 * label, not by which section it was toggled in), so it is intentionally NOT de-duplicated here.
 *
 * @param {Array<{label:string, category:string, highlighted?:boolean, sortWeight?:number}>} items
 * @returns {Array<{category: string, items: Array<object>}>} ordered groups (empty array for empty input)
 */
export function groupCatalogue(items) {
  const rows = Array.isArray(items) ? items.filter((r) => r && typeof r.label === "string") : [];
  if (rows.length === 0) return [];

  const groups = [];

  // 1. Popular = every highlighted row, sorted. Only emitted when there is at least one.
  const highlighted = rows.filter((r) => r.highlighted === true).slice().sort(bySortWeightThenLabel);
  if (highlighted.length > 0) {
    groups.push({ category: POPULAR_LABEL, items: highlighted });
  }

  // 2. Real categories, in first-appearance order, each internally sorted. A Map preserves insertion
  // order, so iterating `rows` once records the category order the (pre-sorted) catalogue presents.
  const byCategory = new Map();
  for (const row of rows) {
    const category = String(row.category ?? "");
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category).push(row);
  }
  for (const [category, catRows] of byCategory) {
    groups.push({ category, items: catRows.slice().sort(bySortWeightThenLabel) });
  }

  return groups;
}

/**
 * The effective selection bounds, mirroring the server (InterestSelectionConfig, seeded min 1 / max 3).
 *
 * `min` is FLOORED to 1 — the hard-min-1 invariant: even if config (or a lie) says 0, a user must pick
 * at least one interest to finish the onboarding step. `max` falls back to 3 and is clamped to be `>=`
 * the effective min so a nonsensical config (max < min) can never produce an unsatisfiable gate.
 *
 * @param {?{minSelections?: number, maxSelections?: number}} config
 * @returns {{min: number, max: number}}
 */
export function selectionBounds(config) {
  const rawMin = Number(config?.minSelections);
  const rawMax = Number(config?.maxSelections);
  // Hard min-1: never below 1, even if config is missing/0/negative/NaN.
  const min = Number.isFinite(rawMin) && rawMin >= 1 ? Math.floor(rawMin) : 1;
  const maxCandidate = Number.isFinite(rawMax) && rawMax >= 1 ? Math.floor(rawMax) : 3;
  const max = Math.max(maxCandidate, min); // clamp max >= min
  return { min, max };
}

/** Pluralise "interest" the way the backend copy does: singular for n===1, else "interests". */
function pluralInterest(n) {
  return n === 1 ? "interest" : "interests";
}

/**
 * Validate a selection against the bounds — a fail-fast UX mirror of the server. Returns
 * `{ ok, message }`: on failure the message matches the backend copy
 * ("Select at least N interest(s)" / "Select at most N interest(s)") including pluralisation, so
 * client and server never contradict each other.
 *
 * @param {Iterable<string>|Array<string>} selectedLabels the currently-picked labels
 * @param {{min:number, max:number}} bounds from {@link selectionBounds}
 * @returns {{ok: boolean, message: string}}
 */
export function validateSelection(selectedLabels, bounds) {
  const count = countUnique(selectedLabels);
  const { min, max } = bounds;
  if (count < min) {
    return { ok: false, message: `Select at least ${min} ${pluralInterest(min)}.` };
  }
  if (count > max) {
    return { ok: false, message: `Select at most ${max} ${pluralInterest(max)}.` };
  }
  return { ok: true, message: "" };
}

/**
 * Whether the current selection satisfies the bounds (the Finish CTA's enabled predicate).
 * @param {Iterable<string>|Array<string>} selectedLabels
 * @param {{min:number, max:number}} bounds
 * @returns {boolean}
 */
export function canFinish(selectedLabels, bounds) {
  const count = countUnique(selectedLabels);
  return count >= bounds.min && count <= bounds.max;
}

/**
 * Build the PATCH /api/v1/me `interests` payload — a plain array of label strings (NOT objects; the
 * backend UpdateMeRequest.interests is a `List<String>` of labels). De-dupes repeated labels and
 * preserves first-pick order, so the request carries exactly the distinct labels the user chose.
 *
 * @param {Iterable<string>|Array<string>} selectedLabels
 * @returns {string[]} distinct label strings, in pick order
 */
export function toInterestsPayload(selectedLabels) {
  const seen = new Set();
  const out = [];
  for (const label of selectedLabels ?? []) {
    if (typeof label !== "string") continue;
    if (seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out;
}

/**
 * The labels to pre-select for a returning, half-onboarded user — mapped from the saved snapshots on
 * a `/me` response (MeResponse.interests is `[{label, category, sourceInterestId}]`). Absent/empty →
 * `[]`. Only the label is used (selection is keyed by label everywhere in this step).
 *
 * @param {?{interests?: Array<{label?: string}>}} me a `/me`-shaped object
 * @returns {string[]} the saved interest labels
 */
export function selectedLabelsFromMe(me) {
  const list = me?.interests;
  if (!Array.isArray(list)) return [];
  return list.map((i) => i?.label).filter((l) => typeof l === "string");
}

/** Count the DISTINCT labels in an iterable (a Set is passed through by size). */
function countUnique(selectedLabels) {
  if (selectedLabels instanceof Set) return selectedLabels.size;
  const seen = new Set();
  for (const label of selectedLabels ?? []) {
    if (typeof label === "string") seen.add(label);
  }
  return seen.size;
}
