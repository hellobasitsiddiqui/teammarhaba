// Paper appearance contract (TM-529) — the curated accent palette + the pure helpers to apply and
// validate it. Framework-free and DOM-light (the apply/read functions take the objects they touch),
// so it's unit-testable under `node --test` (web/tools/appearance-core.test.mjs) and shared by both
// the boot script (appearance.js) and the profile settings UI (appearance-settings.js).
//
// The multi-theme family system (clean/doodle/sketch) is retired — Paper is the single theme. The
// only look a user personalises is: (1) the accent swatch, from this FIXED curated palette (NOT a
// free colour picker), and (2) the wavy/sketchy toggle. Both persist server-side per user; this
// module holds the client-side vocabulary they share.

/**
 * The FIXED curated Paper accent palette. Each swatch:
 *   • id       — the stable key persisted server-side (users.theme_accent) + used in the DOM/tests.
 *   • hex      — the accent fill/text colour. Mirrors the `--accent-paper-<id>` token in styles.css
 *                (kept in step by appearance-core.test.mjs), so CSS and JS never drift.
 *   • onAccent — the legible text/icon colour to sit ON that fill (`--on-accent`). Every swatch is a
 *                mid-to-deep tone that stays legible against the off-white Paper surfaces both as a
 *                fill and as link/heading text.
 *   • label    — the human name shown in the picker.
 * Order is the swatch order in the picker; the FIRST swatch is the default for a brand-new user.
 */
export const PAPER_PALETTE = Object.freeze([
  { id: "teal", hex: "#0f9d8c", onAccent: "#ffffff", label: "Teal" },
  { id: "indigo", hex: "#4f46e5", onAccent: "#ffffff", label: "Indigo" },
  { id: "coral", hex: "#d1495b", onAccent: "#ffffff", label: "Coral" },
  { id: "amber", hex: "#b45309", onAccent: "#ffffff", label: "Amber" },
  { id: "plum", hex: "#7c3aed", onAccent: "#ffffff", label: "Plum" },
  { id: "ink", hex: "#2b2b2b", onAccent: "#fafafa", label: "Ink" },
]);

/** The default accent swatch id — the shipped Paper `--accent` (teal, TM-510). First/selected swatch. */
export const DEFAULT_ACCENT_ID = "teal";

/** The default wavy/sketchy state for a brand-new user — ON (the app's character; TM-529 decision). */
export const DEFAULT_SKETCHY = true;

/** All valid swatch ids (the fixed set). Anything outside this is not selectable — Paper stays sole. */
export const ACCENT_IDS = Object.freeze(PAPER_PALETTE.map((s) => s.id));

/** localStorage key holding the no-flash boot HINT (paint guess); the server is the source of truth. */
export const HINT_KEY = "tm-appearance";

/** True iff `id` names a swatch in the curated palette. */
export function isValidAccentId(id) {
  return ACCENT_IDS.includes(id);
}

/** The swatch for `id`, or the default swatch if `id` is unknown. Always returns a real swatch. */
export function accentById(id) {
  return PAPER_PALETTE.find((s) => s.id === id) || PAPER_PALETTE.find((s) => s.id === DEFAULT_ACCENT_ID);
}

/** Reverse lookup: the swatch id whose hex matches `hex` (case-insensitive), or null. */
export function accentIdFromHex(hex) {
  if (typeof hex !== "string") return null;
  const norm = hex.trim().toLowerCase();
  const swatch = PAPER_PALETTE.find((s) => s.hex.toLowerCase() === norm);
  return swatch ? swatch.id : null;
}

/**
 * Coerce a possibly-partial/invalid appearance to a valid one: an unknown/absent accent id falls back
 * to the default swatch, and a non-boolean sketchy flag falls back to the default (ON). Never throws.
 */
export function normalizeAppearance(state) {
  const accentId = isValidAccentId(state?.accentId) ? state.accentId : DEFAULT_ACCENT_ID;
  const sketchy = typeof state?.sketchy === "boolean" ? state.sketchy : DEFAULT_SKETCHY;
  return { accentId, sketchy };
}

/**
 * Apply an appearance to a document: set `[data-sketchy]` on <html> and re-point `--accent` /
 * `--on-accent` inline (the per-user tint that re-tints the whole Paper theme). Tolerant of a missing
 * document (returns the normalized state without touching the DOM). Returns the normalized state.
 */
export function applyAppearance(doc, state) {
  const normalized = normalizeAppearance(state);
  const root = doc && doc.documentElement;
  if (root) {
    root.setAttribute("data-sketchy", normalized.sketchy ? "on" : "off");
    const swatch = accentById(normalized.accentId);
    root.style.setProperty("--accent", swatch.hex);
    root.style.setProperty("--on-accent", swatch.onAccent);
  }
  return normalized;
}

/**
 * Read the boot hint from a Storage-like object. Returns a normalized `{accentId, sketchy}` or null
 * when there's no (valid) hint. Best-effort: any access/parse error yields null (defaults then win).
 */
export function readHint(storage) {
  try {
    const raw = storage && storage.getItem(HINT_KEY);
    if (!raw) return null;
    return normalizeAppearance(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Write the boot hint (the fast, no-flash paint guess appearance.js reads on the next cold start).
 * Stores the normalized state PLUS the resolved hex/onAccent so the classic boot script needs no
 * palette. The server (GET /api/v1/me) remains the source of truth — this is only a paint hint.
 * Best-effort: returns false if storage is locked/full rather than throwing.
 */
export function writeHint(storage, state) {
  const normalized = normalizeAppearance(state);
  const swatch = accentById(normalized.accentId);
  const payload = {
    accentId: normalized.accentId,
    sketchy: normalized.sketchy,
    hex: swatch.hex,
    onAccent: swatch.onAccent,
  };
  try {
    storage.setItem(HINT_KEY, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

/** Clear the boot hint (e.g. on sign-out, so a shared device doesn't leak the last user's accent). */
export function clearHint(storage) {
  try {
    storage.removeItem(HINT_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sequence appearance PATCHes so quick successive changes can't leave the server and the UI
 * disagreeing (TM-720). The user can flip the accent / toggle faster than a PATCH round-trips, so
 * two writes can be in flight at once and their responses can arrive out of order. Two failure modes
 * this closes:
 *   • A FAILED OLDER request must not clobber a NEWER successful change — reverting the UI to the
 *     older request's "previous" state would undo the newer pick the user is looking at.
 *   • The UI must end on the state of the LAST request the user made, matched by the server (last
 *     write wins by REQUEST ORDER — the order they were dispatched, which is the order the user
 *     intended, regardless of which network response lands first).
 *
 * Mechanism (a monotonic generation counter, mirroring notification-bell-core's createBadgeSync):
 *   • Each `run()` takes the next generation and is the "latest" until another `run()` supersedes it.
 *   • On SUCCESS: nothing to do — the optimistic UI already shows this change; a superseded success
 *     is simply ignored (a newer run owns the UI).
 *   • On FAILURE: revert ONLY if this run is still the latest. A stale failure (a newer change has
 *     since been dispatched) is swallowed — its `revert` would fight the newer, still-pending or
 *     succeeded change. This gives last-write-wins by request order without cancelling HTTP.
 *
 * Pure: no DOM/fetch. The caller injects the async `patch` (updateMe) and a `revert(previous)` that
 * restores the working state + UI; failures are reported via the returned outcome + optional onError.
 *
 * @param {{
 *   patch: (body: object) => Promise<any>,             // the PATCH (updateMe)
 *   revert: (previous: object) => void,                // restore UI/state to `previous`
 *   onError?: (err: any, superseded: boolean) => void, // best-effort; toast only when not superseded
 * }} deps
 * @returns {{ run: (body: object, previous: object) => Promise<{ok: boolean, superseded?: boolean}> }}
 */
export function createAppearancePersister({ patch, revert, onError } = {}) {
  let generation = 0; // monotonic; the highest value is the "latest" write the user made

  async function run(body, previous) {
    const mine = ++generation; // this run is now the latest until another run() bumps it
    try {
      await patch(body);
      return { ok: true };
    } catch (err) {
      const superseded = mine !== generation;
      // Only the LATEST request may revert — a stale failure must not undo a newer change.
      if (!superseded) revert(previous);
      if (onError) onError(err, superseded);
      return { ok: false, superseded };
    }
  }

  return { run };
}
