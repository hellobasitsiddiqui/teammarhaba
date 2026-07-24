// Profile Interests card — pure logic core (TM-778, epic Interests).
//
// The Profile hub's Interests card (profile.js) lets a signed-in user VIEW their saved interests and
// ADD/REMOVE them within the configured min/max bounds, persisted via PATCH /api/v1/me (the TM-775
// user-selection API). As with profile-core / events-core / chat-core, the DOM-free, framework-free
// rules live HERE so they can be unit-tested in plain Node (`node --test web/tools/*.test.mjs`) — the
// house "extract the pure logic to test it" pattern (docs/agents/conventions/AGENTIC-LESSONS). The DOM
// half lives in profile.js; the chip styling lives in styles.css (.tm-pf-chip / -on / -add).
//
// NONE of these functions touch the DOM, Firebase, or the network. They take plain data shaped like the
// backend payloads — MeResponse.interests (`[{label, category, sourceInterestId}]`, see
// web/src/api-docs/openapi.json) and the catalogue rows (`[{label, category, ...}]`) — and return plain
// data the renderer maps to elements.

// The interests min/max-selection bounds default (matches the V45 seed: interests.min_selections = 1,
// interests.max_selections = 3, and the MeInterestsIntegrationTest expectations). The card fetches the
// live config when it can (GET /api/v1/interests/config), but the backend PATCH /me is always the
// authoritative gate — so a missing/unreadable config simply falls back to these sane defaults rather
// than blocking the card. min is never below 1 (an empty set is rejected server-side); max never below
// min.
export const DEFAULT_INTEREST_MIN = 1;
export const DEFAULT_INTEREST_MAX = 3;

/**
 * The display emoji for a catalogue row (TM-805). Reads the nullable `emoji` field the public/admin
 * catalogue projections now carry (V46 back-fills a glyph for every seed interest), trims it, and
 * returns "" for anything absent/blank/non-string. Callers render the leading glyph ONLY when this is
 * non-empty, so a row without an emoji degrades gracefully to a label-only chip. DOM-free + pure so the
 * chip-render logic stays unit-testable in plain Node.
 *
 * @param {{emoji?: string}|null|undefined} row a catalogue row (or anything).
 * @returns {string} the trimmed emoji glyph, or "" when there is none.
 */
export function interestEmoji(row) {
  const raw = row && typeof row.emoji === "string" ? row.emoji.trim() : "";
  return raw;
}

/**
 * Build a label→emoji lookup from the offered catalogue (TM-805). The profile Interests-card VIEW chips
 * render from the saved MeResponse.interests (which carry NO emoji — see InterestResponse), so the card
 * resolves each saved label's glyph against the separately-fetched catalogue. A null/absent catalogue
 * yields an empty map, so the card degrades to label-only chips rather than breaking.
 *
 * @param {Array<{label?: string, emoji?: string}>|null|undefined} catalogue the offered catalogue rows.
 * @returns {Map<string, string>} label → non-empty emoji glyph (labels without a glyph are omitted).
 */
export function emojiByLabel(catalogue) {
  const map = new Map();
  if (!Array.isArray(catalogue)) return map;
  for (const row of catalogue) {
    const label = row && typeof row.label === "string" ? row.label.trim() : "";
    const emoji = interestEmoji(row);
    if (label && emoji) map.set(label, emoji);
  }
  return map;
}

/**
 * Normalise a raw interests-config payload (or null) into a clean {min, max} pair, clamped to the
 * invariants the backend enforces (min ≥ 1, max ≥ min). A null/absent/garbage config → the defaults, so
 * the card renders even when the config endpoint is unreachable (a transient failure on the public
 * config route — the ADD picker still works off these bounds and the server is the real gate).
 *
 * @param {{minSelections?: number, maxSelections?: number}|null|undefined} config the raw config payload.
 * @returns {{min: number, max: number}}
 */
export function normaliseInterestConfig(config) {
  const c = config || {};
  let min = Number.isInteger(c.minSelections) && c.minSelections >= 1 ? c.minSelections : DEFAULT_INTEREST_MIN;
  let max = Number.isInteger(c.maxSelections) && c.maxSelections >= 1 ? c.maxSelections : DEFAULT_INTEREST_MAX;
  // Enforce the max ≥ min invariant defensively (a malformed config could invert them).
  if (max < min) max = min;
  return { min, max };
}

/**
 * The saved interests as an ordered list of labels, de-duplicated and blank-stripped. Accepts the
 * MeResponse.interests array (`[{label, ...}]`) OR a plain array of label strings, so callers can pass
 * either the raw payload or an already-extracted list.
 *
 * @param {Array<{label?: string}|string>|null|undefined} interests
 * @returns {string[]} the saved labels in order, unique, non-blank.
 */
export function savedInterestLabels(interests) {
  if (!Array.isArray(interests)) return [];
  const seen = new Set();
  const out = [];
  for (const it of interests) {
    const label = typeof it === "string" ? it : (it && typeof it.label === "string" ? it.label : "");
    const trimmed = label.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

/**
 * The chip view-model for the Interests card: one chip per saved interest (each removable) plus whether
 * the "add" affordance should show. Drives the renderer directly — the DOM half just maps each entry to
 * a chip element and reads the flags.
 *
 * Each chip also carries its display `emoji` (TM-805), resolved by label against the offered catalogue
 * (passed via the optional `catalogue` bound — the saved MeResponse.interests carry no emoji, so the
 * glyph is looked up separately). A saved interest with no catalogue match (or no catalogue supplied)
 * gets `emoji: ""` and the renderer shows a label-only chip.
 *
 * @param {Array<{label?: string}|string>|null|undefined} interests the saved interests (MeResponse shape).
 * @param {{min?: number, max?: number, catalogue?: Array<object>}} [bounds] the selection bounds (from
 *   normaliseInterestConfig) plus, optionally, the offered catalogue rows for emoji resolution.
 * @returns {{
 *   chips: {label: string, removable: boolean, emoji: string}[],
 *   empty: boolean,
 *   count: number,
 *   canAdd: boolean,
 *   entry: {show: boolean, label: string, action: "add"|"manage"},
 *   atMin: boolean,
 *   atMax: boolean,
 *   hint: string
 * }}
 */
export function interestChipsModel(interests, { min = DEFAULT_INTEREST_MIN, max = DEFAULT_INTEREST_MAX, catalogue } = {}) {
  const labels = savedInterestLabels(interests);
  const count = labels.length;
  const atMin = count <= min;
  const atMax = count >= max;
  // A chip is removable unless removing it would drop below the minimum (the backend rejects a set
  // below min with a 400, so we don't offer a remove that can only fail). At/above the minimum, every
  // chip is removable.
  const removable = !atMin;
  // Resolve each saved label's glyph from the offered catalogue (TM-805); "" when there's no match.
  const emojis = emojiByLabel(catalogue);
  const chips = labels.map((label) => ({ label, removable, emoji: emojis.get(label) || "" }));
  return {
    chips,
    empty: count === 0,
    count,
    // The add affordance shows whenever there's room for more (below max). Retained for callers that
    // still read the old flag — the state-adaptive `entry` below supersedes it for the render.
    canAdd: !atMax,
    // TM-970: the ONE persistent entry point into the in-place picker. Its label adapts to state so
    // there's never a dead-end at the cap (see addChipModel).
    entry: addChipModel(count, max),
    atMin,
    atMax,
    hint: interestsHint(count, min, max),
  };
}

// TM-970: the fullwidth plus prefix on the below-max "add" chip (kept as the shipped glyph). The at-max
// chip drops it — "Manage" is a mode switch, not an add.
export const ADD_CHIP_LABEL = "＋ add";
export const MANAGE_CHIP_LABEL = "Manage";

/**
 * The single, PERSISTENT entry-point chip into the in-place interests picker/manage view (TM-970),
 * decided purely so it's unit-testable. Below the max it reads "＋ add" (open the picker to add more);
 * AT the max it relabels to "Manage" — the SAME affordance routing to the SAME picker — so a user who's
 * filled all their slots can still open it to remove/swap an interest. Hiding it at the cap (the old
 * behaviour) left no way to reach the picker without first removing a chip: a dead-end.
 *
 * The chip is only hidden when the max itself is 0 (a degenerate config where no interest can ever be
 * held) — otherwise there is always something to add OR to manage.
 *
 * @param {number} count the number of saved interests.
 * @param {number} max the configured maximum selections.
 * @returns {{show: boolean, label: string, action: "add"|"manage"}}
 */
export function addChipModel(count, max) {
  if (max <= 0) return { show: false, label: "", action: "add" };
  const atMax = count >= max;
  return atMax
    ? { show: true, label: MANAGE_CHIP_LABEL, action: "manage" }
    : { show: true, label: ADD_CHIP_LABEL, action: "add" };
}

/** The card's helper line — honest guidance on the min/max, replacing the old "coming soon" copy. */
export function interestsHint(count, min, max) {
  if (count === 0) {
    return min > 0
      ? `Add at least ${min} interest${min === 1 ? "" : "s"} so people find you.`
      : "Add interests so people find you.";
  }
  if (count > max) {
    // Over the ceiling (e.g. a since-lowered max): don't claim they've "added the maximum".
    return `You're over the maximum of ${max}.`;
  }
  if (count === max) {
    return `You've added the maximum of ${max}.`;
  }
  return `Add up to ${max - count} more.`;
}

/**
 * The catalogue picker view-model: the active catalogue grouped by category (in catalogue order), each
 * option flagged with whether it's already selected and whether picking it is disabled (because the max
 * is already reached and it isn't currently selected). Retired/inactive rows are excluded. This is what
 * the ADD picker renders — a grouped list of toggle chips.
 *
 * @param {Array<{label?: string, category?: string, active?: boolean}>|null|undefined} catalogue the
 *   active catalogue rows (GET /api/v1/interests/catalogue).
 * @param {string[]} selectedLabels the labels currently selected (the pending picker selection).
 * @param {{max?: number}} [bounds]
 * Each option also carries its display `emoji` (TM-805, read straight off the catalogue row), so the
 * ADD picker chips can render the leading glyph — "" when the row has none.
 *
 * @returns {{
 *   groups: {category: string, options: {label: string, selected: boolean, disabled: boolean, emoji: string}[]}[],
 *   selectedCount: number,
 *   atMax: boolean
 * }}
 */
export function catalogueGroups(catalogue, selectedLabels, { max = DEFAULT_INTEREST_MAX } = {}) {
  const selected = new Set(savedInterestLabels(selectedLabels));
  const atMax = selected.size >= max;
  const rows = Array.isArray(catalogue) ? catalogue : [];
  // Group by category, preserving first-seen category order + within-category catalogue order (the
  // backend already sorts highlights-first then alphabetically). Skip retired rows (active === false)
  // and blank labels defensively.
  const order = [];
  const byCategory = new Map();
  for (const row of rows) {
    if (!row || row.active === false) continue;
    const label = typeof row.label === "string" ? row.label.trim() : "";
    if (!label) continue;
    const category = (typeof row.category === "string" && row.category.trim()) || "Other";
    if (!byCategory.has(category)) {
      byCategory.set(category, []);
      order.push(category);
    }
    const isSelected = selected.has(label);
    byCategory.get(category).push({
      label,
      selected: isSelected,
      // Disabled only when at the cap AND not already selected (you can always DEselect to make room).
      disabled: atMax && !isSelected,
      emoji: interestEmoji(row), // leading glyph for the picker chip (TM-805); "" when none.
    });
  }
  const groups = order.map((category) => ({ category, options: byCategory.get(category) }));
  return { groups, selectedCount: selected.size, atMax };
}

/**
 * Toggle one label in a pending selection set, respecting the max. Returns the NEW selection array (does
 * not mutate the input). Removing is always allowed; adding is refused (returns the set unchanged) when
 * it would exceed the max — the picker disables at-cap options, and this is the belt-and-braces guard so
 * a stale click can never build an over-max set.
 *
 * @param {string[]} selected the current pending selection (labels).
 * @param {string} label the label being toggled.
 * @param {{max?: number}} [bounds]
 * @returns {string[]} the new selection (order preserved; the toggled label appended when added).
 */
export function toggleInterest(selected, label, { max = DEFAULT_INTEREST_MAX } = {}) {
  const list = savedInterestLabels(selected);
  const trimmed = String(label ?? "").trim();
  if (!trimmed) return list;
  if (list.includes(trimmed)) {
    return list.filter((l) => l !== trimmed);
  }
  if (list.length >= max) return list; // at the cap — adding is a no-op (the option is disabled anyway)
  return [...list, trimmed];
}

/**
 * Validate a pending selection against the bounds before it's saved. Returns a user-facing error string,
 * or "" when the selection is savable. The backend PATCH /me is the authoritative gate (it re-checks
 * min/max + catalogue membership and returns a 400 the card surfaces), but this lets the picker's Save
 * button pre-block an obviously-invalid set with a clear message instead of a round-trip 400.
 *
 * @param {string[]} selected the pending selection (labels).
 * @param {{min?: number, max?: number}} [bounds]
 * @returns {string} an error message, or "" if valid.
 */
export function selectionError(selected, { min = DEFAULT_INTEREST_MIN, max = DEFAULT_INTEREST_MAX } = {}) {
  const count = savedInterestLabels(selected).length;
  if (count < min) return `Choose at least ${min} interest${min === 1 ? "" : "s"}.`;
  if (count > max) return `Choose at most ${max} interest${max === 1 ? "" : "s"}.`;
  return "";
}
