// Admin interest create/edit logic (TM-779, epic Interests) — the pure, browser-free half of the admin
// interests console, split out of admin-interests.js for the same reason admin-venues-core.js was split
// out of admin-venues.js: it's the part that is unit-testable WITHOUT a browser, the Capacitor runtime,
// or the Firebase SDK. admin-interests.js transitively imports the Firebase SDK (via auth.js) from a
// gstatic CDN URL the Node test runner can't load, so these rules would be untestable if they lived
// there. Here they're pure functions of their inputs, so `node --test web/tools/*.test.mjs` (the CI
// gate — the "Web asset fingerprinting check") can assert them.
//
// WHAT LIVES HERE (all pure — no DOM, no fetch):
//   - the field caps, mirrored 1:1 from the backend DTOs (Create/UpdateInterestRequest + InterestConfig-
//     Request, TM-774) so the browser fails fast with the SAME limits the server enforces;
//   - CATEGORIES: the seven known interest categories (mirrors InterestCategories.KNOWN — the exact,
//     case-sensitive seed strings), so an admin can only pick a bucket the server will accept;
//   - validateInterestDraft(): the whole create/edit form → per-field errors + a canSave flag, mirroring
//     the API's Bean Validation (@NotBlank/@Size/@Min/@Max) AND its category-known @AssertTrue rule;
//   - buildInterestPayload(): a form draft → the JSON body the admin API accepts (Create/UpdateInterest-
//     Request shape), omitting a blank sortWeight so create uses the highlighted-aware default and a
//     PATCH leaves it unchanged;
//   - toInterestFormModel(): an AdminInterestResponse → the form's field values for the edit prefill;
//   - validateConfigDraft(): the min/max-selection config form → per-field errors + canSave, mirroring
//     InterestConfigRequest exactly (both ≥ 1, max ≥ min) so a bad PUT never reaches the server.

// --- field caps (mirror Create/UpdateInterestRequest + InterestConfigRequest, TM-774) ---------

/** Label cap — mirrors CreateInterestRequest.label @Size(max = 120) / interest_catalogue.label VARCHAR(120). */
export const LABEL_MAX = 120;
/** Category cap — mirrors CreateInterestRequest.category @Size(max = 80) / category VARCHAR(80). */
export const CATEGORY_MAX = 80;
/** Emoji cap — mirrors CreateInterestRequest.emoji @Size(max = 16) (generous for multi-codepoint
 *  glyphs like flags/ZWJ sequences). Blank = no emoji (server stores null). (TM-805) */
export const EMOJI_MAX = 16;
/** Sort-weight bounds — mirror CreateInterestRequest.sortWeight @Min(0) @Max(1000); blank = default. */
export const SORT_WEIGHT_MIN = 0;
export const SORT_WEIGHT_MAX = 1000;
/** Minimum selection bound — mirrors InterestConfigRequest @Min(1) on BOTH minSelections and maxSelections. */
export const CONFIG_MIN = 1;

/**
 * The seven known interest categories — the exact, CASE-SENSITIVE seed strings, mirroring
 * InterestCategories.KNOWN (V45 seed / TM-774). An admin creating or editing an interest must pick one
 * of these verbatim; the backend's @AssertTrue isCategoryKnown rejects anything else (a differently-cased
 * "food & drink" would fragment a bucket, so the match is exact). This is the single source of truth on
 * the client — the select is built from it and validation checks membership against it. Order here is the
 * seed order (irrelevant to validation, which is a membership test only).
 */
export const CATEGORIES = Object.freeze([
  "Outdoors & Nature",
  "Sport & Fitness",
  "Food & Drink",
  "Arts & Creative",
  "Games & Tech",
  "Music & Nightlife",
  "Social & Wellbeing",
]);

/** A trimmed string, or "" for anything that isn't a non-blank string (mirrors admin-venues-core cleanText). */
function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** Parse an integer field's raw string: an integer Number, or null for blank; NaN for non-integer input. */
function parseIntOrNull(raw) {
  const value = cleanText(raw);
  if (value === "") return null;
  if (!/^-?\d+$/.test(value)) return NaN; // present but not a whole number — caller surfaces the error
  return Number(value);
}

// --- validation (mirrors the API's Bean Validation + the category-known rule) ------------------

/**
 * Validate a create/edit draft against the SAME rules the admin API enforces (Create/UpdateInterest-
 * Request, TM-774) so the browser fails fast with the server's limits and only ever POSTs something it
 * will accept. Returns a per-field error map ("" = valid) plus `canSave` (no field in error).
 *
 * The rules mirror the DTOs:
 *   - label: required (@NotBlank on create); ≤ LABEL_MAX (@Size). On EDIT the label isn't required to be
 *     PRESENT, but a present-but-blank label is rejected (mirrors UpdateInterestRequest.isLabelUsable) —
 *     so with requireForCreate=false a blank label still errors (you can't clear a label to nothing).
 *   - category: required, and EXACTLY one of CATEGORIES (case-sensitive — mirrors @AssertTrue
 *     isCategoryKnown); ≤ CATEGORY_MAX is implied by membership so it's covered by the known-set check.
 *   - sortWeight: optional integer in [0, 1000] (@Min/@Max); blank = omit (the service applies the
 *     highlighted-aware default). NaN → "whole number"; out of range → the bounds message.
 *   - highlighted: a boolean checkbox — never invalid.
 *
 * @param {object} draft the raw form values (label/category/sortWeight strings; highlighted a boolean).
 * @param {{requireForCreate?: boolean}} [opts] when true (create), a present-or-absent label must be present.
 * @returns {{errors: Record<string,string>, canSave: boolean}}
 */
export function validateInterestDraft(draft = {}, { requireForCreate = true } = {}) {
  const errors = {};
  const label = cleanText(draft.label);
  const category = cleanText(draft.category);

  // Label: required on create; on edit, present-but-blank is rejected but absent is fine. In this form
  // the label input is always present, so the practical rule is: a blank label errors when creating, and
  // ALWAYS errors when the field carried something the admin cleared. We treat a blank label as an error
  // on create (required) and on edit (can't clear a label) — matching @NotBlank + isLabelUsable.
  if (label === "") {
    if (requireForCreate) errors.label = "Label is required.";
    else errors.label = "Label can't be blank.";
  } else if (label.length > LABEL_MAX) {
    errors.label = `Must be ${LABEL_MAX} characters or fewer.`;
  }

  // Category: required and exactly one of the known buckets (case-sensitive membership).
  if (category === "") {
    errors.category = "Category is required.";
  } else if (!CATEGORIES.includes(category)) {
    errors.category = "Choose one of the listed categories.";
  }

  // Sort weight: optional integer in [0, 1000]; blank = unspecified (server default applies).
  const weight = parseIntOrNull(draft.sortWeight);
  if (Number.isNaN(weight)) errors.sortWeight = "Enter a whole number.";
  else if (weight !== null && (weight < SORT_WEIGHT_MIN || weight > SORT_WEIGHT_MAX)) {
    errors.sortWeight = `Must be between ${SORT_WEIGHT_MIN} and ${SORT_WEIGHT_MAX}.`;
  }

  // Emoji (TM-805): optional; the only rule is the length cap (mirrors @Size(max = 16)). Blank is fine
  // (no glyph). We don't validate that it's "really an emoji" — the admin is trusted, and the picker
  // renders any short glyph verbatim.
  const emoji = cleanText(draft.emoji);
  if (emoji.length > EMOJI_MAX) {
    errors.emoji = `Must be ${EMOJI_MAX} characters or fewer.`;
  }

  return { errors, canSave: Object.keys(errors).length === 0 };
}

// --- payload building (draft → the API body) --------------------------------------------------

/**
 * Turn a validated draft into the JSON body the admin API accepts (Create/UpdateInterestRequest shape,
 * TM-774): `label` and `category` verbatim (trimmed), `highlighted` always as a boolean, and `sortWeight`
 * ONLY when a valid integer is present. Omitting a blank sortWeight is load-bearing: on create the server
 * applies its highlighted-aware default (100 when featured, else 0), and on PATCH a null/absent field is
 * "leave unchanged" — so a blank weight never clobbers the stored value.
 *
 * @param {object} draft the raw form values.
 * @returns {object} the request body.
 */
export function buildInterestPayload(draft = {}) {
  const body = {
    label: cleanText(draft.label),
    category: cleanText(draft.category),
    highlighted: Boolean(draft.highlighted),
  };
  const weight = parseIntOrNull(draft.sortWeight);
  if (typeof weight === "number" && !Number.isNaN(weight)) body.sortWeight = weight;
  // Emoji (TM-805): always send the (trimmed) value — "" tells the server to clear/leave-blank it, a
  // non-empty glyph sets it. The backend normalises a blank to null, so a cleared field reads as "no
  // emoji" (mirrors how the picker renders a null/blank emoji as no glyph).
  body.emoji = cleanText(draft.emoji);
  return body;
}

/**
 * The inverse of the form: an AdminInterestResponse (TM-774) → the form field values for the edit prefill.
 * `highlighted` comes back a boolean (for the checkbox); `sortWeight` is stringified for the number input
 * (it's an `int` on the response so always present — but "" if somehow null).
 *
 * @param {object} interest an AdminInterestResponse.
 * @returns {{label: string, category: string, highlighted: boolean, sortWeight: string}}
 */
export function toInterestFormModel(interest = {}) {
  const str = (v) => (v == null ? "" : String(v));
  return {
    label: str(interest.label),
    category: str(interest.category),
    emoji: str(interest.emoji), // TM-805 — pre-fill the emoji field for the edit form ("" when none)
    highlighted: Boolean(interest.highlighted),
    sortWeight: interest.sortWeight == null ? "" : String(interest.sortWeight),
  };
}

// --- config (min/max selection bounds) validation ---------------------------------------------

/**
 * Validate the interests min/max-selection config draft against InterestConfigRequest EXACTLY (TM-774):
 * both bounds are required, each an integer ≥ CONFIG_MIN (@NotNull @Min(1)), and max ≥ min (the cross-field
 * @AssertTrue isRangeOrdered). This is what stops a bad PUT before it hits the 400 — the PUT is a full
 * replacement, so both fields are always sent and the ordering rule is only checkable with both present.
 *
 * @param {{minSelections: any, maxSelections: any}} draft the raw config form values.
 * @returns {{errors: {minSelections?: string, maxSelections?: string}, canSave: boolean}}
 */
export function validateConfigDraft({ minSelections, maxSelections } = {}) {
  const errors = {};
  const min = parseIntOrNull(minSelections);
  const max = parseIntOrNull(maxSelections);

  if (min === null) errors.minSelections = "Enter a minimum.";
  else if (Number.isNaN(min)) errors.minSelections = "Enter a whole number.";
  else if (min < CONFIG_MIN) errors.minSelections = `Must be ${CONFIG_MIN} or more.`;

  if (max === null) errors.maxSelections = "Enter a maximum.";
  else if (Number.isNaN(max)) errors.maxSelections = "Enter a whole number.";
  else if (max < CONFIG_MIN) errors.maxSelections = `Must be ${CONFIG_MIN} or more.`;

  // Cross-field: max ≥ min — only checked when both are valid integers (else the per-field errors stand).
  if (!errors.minSelections && !errors.maxSelections && max < min) {
    errors.maxSelections = "Maximum must be at least the minimum.";
  }

  return { errors, canSave: Object.keys(errors).length === 0 };
}

// --- display helpers --------------------------------------------------------------------------

/**
 * A compact one-line summary for an interest picker option / list row: "Label — Category" (or just the
 * label when there's no category). Kept pure so any surface renders interests identically (mirrors
 * venueSummaryLabel).
 *
 * @param {object} interest an AdminInterestResponse.
 * @returns {string}
 */
export function interestSummaryLabel(interest = {}) {
  const label = cleanText(interest.label) || "Untitled interest";
  const category = cleanText(interest.category);
  return category ? `${label} — ${category}` : label;
}

// --- selection analytics: "Selected by" column (TM-832) ---------------------------------------

/**
 * Index a selection-stats response (GET /api/v1/admin/interests/stats, TM-832) by label, so a catalogue
 * row can look up its tally in O(1). The response shape is `{ activeUsers, stats: [{ label, selectorCount,
 * percent }] }`; a label nobody selected is simply absent. Tolerant of a null/garbage response (→ empty
 * Map) so a failed stats fetch degrades to "0 (0%)" on every row rather than throwing.
 *
 * @param {object} statsResponse the stats endpoint body (or null/undefined on a failed fetch).
 * @returns {Map<string, {selectorCount: number, percent: number}>} label → tally.
 */
export function indexSelectionStats(statsResponse) {
  const byLabel = new Map();
  const stats = statsResponse && Array.isArray(statsResponse.stats) ? statsResponse.stats : [];
  for (const s of stats) {
    if (!s || typeof s.label !== "string") continue;
    byLabel.set(s.label, {
      selectorCount: Number(s.selectorCount) || 0,
      percent: Number(s.percent) || 0,
    });
  }
  return byLabel;
}

/**
 * The "Selected by" cell text for one catalogue row, joined to the stats index by LABEL (TM-832):
 * "<count> (<pct>%)", e.g. "42 (7%)". A label with no stat entry — nobody has selected it (yet) — renders
 * as "0 (0%)" rather than blank, so an unselected interest reads as an explicit zero. Pure and framework-
 * free so it's unit-testable and every surface formats identically.
 *
 * @param {object} interest an AdminInterestResponse (its `label` is the join key).
 * @param {Map<string, {selectorCount: number, percent: number}>} statsByLabel from {@link indexSelectionStats}.
 * @returns {string} the formatted "<count> (<pct>%)" cell.
 */
export function selectedByLabel(interest, statsByLabel) {
  const label = interest && typeof interest.label === "string" ? interest.label : "";
  const stat = statsByLabel instanceof Map ? statsByLabel.get(label) : undefined;
  const count = stat ? Number(stat.selectorCount) || 0 : 0;
  const percent = stat ? Number(stat.percent) || 0 : 0;
  return `${count} (${percent}%)`;
}

/**
 * The numeric selector count for a catalogue row (its stat's count, or 0 when unselected) — the sort key
 * behind the optional sort-by-popularity on the "Selected by" column (TM-832). Kept separate from the
 * display formatter so the sort compares numbers, not the "N (P%)" string.
 *
 * @param {object} interest an AdminInterestResponse.
 * @param {Map<string, {selectorCount: number, percent: number}>} statsByLabel from {@link indexSelectionStats}.
 * @returns {number} the selector count (0 when there is no stat for the label).
 */
export function selectorCountOf(interest, statsByLabel) {
  const label = interest && typeof interest.label === "string" ? interest.label : "";
  const stat = statsByLabel instanceof Map ? statsByLabel.get(label) : undefined;
  return stat ? Number(stat.selectorCount) || 0 : 0;
}
