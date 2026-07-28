// Notification audience-targeting chips — the pure, browser-free filter half (TM-1098, epic TM-358).
//
// The notification compose (admin-notifications.js) picks recipients from a loaded eligible-user list.
// Before this, the only way to narrow that list was hand-picking + a text search. TM-1098 adds
// multi-select FILTER CHIPS over the Core 4 attributes — City, Age group, Gender (Male/Female) and
// "Active in last 24h" — that narrow the SELECTABLE set client-side, over the already-loaded list.
// Hand-pick + select-all then operate on the filtered set; the send still posts the resolved explicit
// userId list (no backend audience fan-out — that stays the TM-373-vision follow-up).
//
// WHY A PURE CORE (the broadcast.js / admin-messages-core.js split): admin-notifications.js transitively
// imports the Firebase SDK (via api.js → auth.js) from a gstatic CDN URL the Node test runner can't
// load, so any logic that lives there is untestable under `node --test`. Everything here is a pure
// function of its inputs (a user row + the selected chip filter) — no DOM, no fetch, no Firebase — so
// the CI gate (`node --test web/tools/*.test.mjs`) can assert the filter behaviour directly.
//
// The chip data (which cities are on offer, whether any Active-24h account exists) is DERIVED from the
// loaded users, so a chip only ever offers a value that can actually match — no dead chips.

// --- age groups -------------------------------------------------------------------------------
//
// The onboarding age band is 18–99 (TM-884). We bucket it into a small, human set of groups so the
// chip is pick-one-of-a-few rather than a numeric range picker. Buckets are half-open [min, max]
// INCLUSIVE on both ends (contiguous, non-overlapping): 18-24, 25-34, 35-44, 45-54, 55+. An account
// with no age (null / non-number) matches NO age group — the filter can only NARROW to a known age.

/**
 * The age-group buckets offered as chips, in display order. `max: null` = open-ended (the "55+" tail).
 * Ids are stable tokens the UI keys chips by; `label` is the human chip text.
 * @type {ReadonlyArray<{id: string, label: string, min: number, max: number|null}>}
 */
export const AGE_GROUPS = Object.freeze([
  Object.freeze({ id: "18-24", label: "18–24", min: 18, max: 24 }),
  Object.freeze({ id: "25-34", label: "25–34", min: 25, max: 34 }),
  Object.freeze({ id: "35-44", label: "35–44", min: 35, max: 44 }),
  Object.freeze({ id: "45-54", label: "45–54", min: 45, max: 54 }),
  Object.freeze({ id: "55+", label: "55+", min: 55, max: null }),
]);

/**
 * Which {@link AGE_GROUPS} bucket a user's age falls in, or "" for an account with no usable age.
 * Age must be a finite number within a bucket's inclusive [min, max] (max null = no upper bound).
 * @param {{age?: unknown}} [user]
 * @returns {string} the matching group id, or "" when the age is missing / out of every bucket.
 */
export function ageGroupOf(user = {}) {
  const age = Number(user?.age);
  if (!Number.isFinite(age)) return "";
  for (const g of AGE_GROUPS) {
    if (age >= g.min && (g.max == null || age <= g.max)) return g.id;
  }
  return "";
}

// --- gender -----------------------------------------------------------------------------------
//
// The MVP chip set is Male / Female only (the refinement's "Male/Female"). PREFER_NOT_TO_SAY and a
// null/unknown gender simply don't match either gender chip — the filter narrows to a stated M/F, it
// never claims an unknown account is one or the other.

/**
 * The gender chips offered, in display order. `value` is the backend {@code Gender} enum name the user
 * row carries; `label` is the human chip text.
 * @type {ReadonlyArray<{id: string, label: string, value: string}>}
 */
export const GENDER_CHIPS = Object.freeze([
  Object.freeze({ id: "FEMALE", label: "Female", value: "FEMALE" }),
  Object.freeze({ id: "MALE", label: "Male", value: "MALE" }),
]);

/** The stated gender of a user as the backend enum name ("FEMALE"/"MALE"/"PREFER_NOT_TO_SAY"), or "". */
export function genderOf(user = {}) {
  return typeof user?.gender === "string" ? user.gender : "";
}

// --- active-in-last-24h -----------------------------------------------------------------------

/** The Active-24h window, in milliseconds — a user is "active" if seen within this of `now`. */
export const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Whether the user was active within {@link ACTIVE_WINDOW_MS} of `now` (TM-1098). Reads
 * `lastActiveAt` (an ISO string or epoch ms) — bumped on GET /me, so it tracks recent activity. An
 * account with no / unparseable `lastActiveAt`, or a timestamp in the future, is NOT active (the
 * filter can only narrow to a genuinely-recent account). `now` is injected (ms since epoch) so the
 * predicate stays pure and testable — the caller passes Date.now().
 *
 * @param {{lastActiveAt?: unknown}} user
 * @param {number} now epoch milliseconds "now" (Date.now() at the call site).
 * @returns {boolean}
 */
export function isActiveWithin24h(user, now) {
  const nowMs = Number(now);
  if (!Number.isFinite(nowMs)) return false;
  const raw = user?.lastActiveAt;
  if (raw == null) return false;
  const t = typeof raw === "number" ? raw : Date.parse(String(raw));
  if (!Number.isFinite(t)) return false;
  const delta = nowMs - t;
  // In [0, window]: not in the future (delta ≥ 0), within the window (delta ≤ ACTIVE_WINDOW_MS).
  return delta >= 0 && delta <= ACTIVE_WINDOW_MS;
}

// --- the combined filter ----------------------------------------------------------------------
//
// A `filter` is the admin's chip selection: which cities, which age-group ids, which genders are
// picked, and whether the Active-24h chip is on. Selection is MULTI-select WITHIN a category (OR) and
// combined ACROSS categories (AND) — "London OR Milton Keynes" AND "25–34 OR 35–44" AND "Female" AND
// active-24h. An EMPTY category imposes no constraint (all values pass that dimension), so the
// no-chips-selected filter passes everyone — the chips only ever NARROW the loaded set.

/** The empty (no-op) filter — every category unselected, so it matches every user. */
export function emptyAudienceFilter() {
  return { cities: [], ageGroups: [], genders: [], activeWithin24h: false };
}

/**
 * Whether any chip is selected at all (any category non-empty, or the Active-24h toggle on). The UI
 * uses this to show a "clear filters" affordance / an "N chips" hint only when filtering is active.
 * @param {ReturnType<typeof emptyAudienceFilter>} [filter]
 * @returns {boolean}
 */
export function hasActiveFilter(filter = {}) {
  return (
    toArray(filter.cities).length > 0 ||
    toArray(filter.ageGroups).length > 0 ||
    toArray(filter.genders).length > 0 ||
    filter.activeWithin24h === true
  );
}

/**
 * Does this user pass the chip filter? Multi-select OR within each category, AND across categories; an
 * empty category is unconstrained. `now` (epoch ms) is only consulted when the Active-24h chip is on.
 *
 * - City: `user.city` is one of the selected cities (exact match, as stored — the admin city list).
 * - Age group: the user's {@link ageGroupOf} is one of the selected group ids (no age ⇒ fails a
 *   non-empty age filter).
 * - Gender: the user's {@link genderOf} is one of the selected genders (unknown/prefer-not ⇒ fails a
 *   non-empty gender filter).
 * - Active-24h: when on, {@link isActiveWithin24h} must hold.
 *
 * @param {object} user a loaded eligible-user row (city / age / gender / lastActiveAt).
 * @param {ReturnType<typeof emptyAudienceFilter>} filter the admin's chip selection.
 * @param {number} now epoch milliseconds (only used when the Active-24h chip is on).
 * @returns {boolean}
 */
export function matchesAudienceFilter(user, filter = {}, now = 0) {
  if (!user) return false;
  const cities = toArray(filter.cities);
  if (cities.length && !cities.includes(user.city)) return false;

  const ageGroups = toArray(filter.ageGroups);
  if (ageGroups.length && !ageGroups.includes(ageGroupOf(user))) return false;

  const genders = toArray(filter.genders);
  if (genders.length && !genders.includes(genderOf(user))) return false;

  if (filter.activeWithin24h === true && !isActiveWithin24h(user, now)) return false;

  return true;
}

/**
 * Apply the chip filter across a list of users (the ordered, already-loaded eligible set), returning
 * only the matches — the SELECTABLE recipient set the roster / select-all then operate over. Order is
 * preserved; a non-array input yields []. `now` is passed straight through to the Active-24h predicate.
 *
 * @param {object[]} users the loaded users to narrow.
 * @param {ReturnType<typeof emptyAudienceFilter>} filter the admin's chip selection.
 * @param {number} now epoch milliseconds (only used when the Active-24h chip is on).
 * @returns {object[]} the users that pass the filter, in input order.
 */
export function applyAudienceFilter(users, filter = {}, now = 0) {
  if (!Array.isArray(users)) return [];
  // Fast path: no chips selected ⇒ no narrowing, return the list as-is (a fresh array, so callers can
  // sort/slice it without mutating the source).
  if (!hasActiveFilter(filter)) return [...users];
  return users.filter((u) => matchesAudienceFilter(u, filter, now));
}

/**
 * The distinct, sorted set of cities present across the loaded users — the City chips to OFFER, so a
 * chip only ever exists for a city that at least one loaded account is in (no dead chips). Blank /
 * non-string cities are dropped. Sorted for a stable, predictable chip order.
 *
 * @param {object[]} users the loaded users.
 * @returns {string[]} distinct non-blank cities, sorted ascending.
 */
export function citiesOf(users) {
  if (!Array.isArray(users)) return [];
  const seen = new Set();
  for (const u of users) {
    const city = typeof u?.city === "string" ? u.city.trim() : "";
    if (city) seen.add(city);
  }
  return [...seen].sort();
}

/** Coerce a maybe-array chip selection to an array (defensive against undefined / a stray scalar). */
function toArray(value) {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}
