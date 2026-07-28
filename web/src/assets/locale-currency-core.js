// Language + currency preference PLACEHOLDER contract (TM-1124) — the option catalogues + the pure
// localStorage helpers behind the two profile "Preferences" dropdowns.
//
// ⚠ DELIBERATELY INERT. There is NO i18n layer (locale is a bare User field, TM-1104) and payments are
// GBP-only (currency does not exist server-side). These two pickers are VISUAL-ONLY placeholders so the
// Preferences area shows where language/currency choice WILL live — selecting one has NO functional
// effect: no translation, no conversion, and (the load-bearing guarantee) NO backend/API call. The only
// side effect is a write to localStorage, so the pick survives a reload and doesn't look broken. Real
// wiring is the deferred TM-1104 work; keep this module free of any api.js / fetch dependency so the
// placeholder can never accidentally start talking to the server.
//
// Framework-free and DOM-light (pure data + Storage helpers), so it's unit-testable under `node --test`
// (web/tools/locale-currency-core.test.mjs) and shared by the settings UI (locale-currency-settings.js).

/**
 * The language options offered by the placeholder picker. Each entry:
 *   • id    — the stable key persisted in localStorage + used in the DOM/tests (a BCP-47-ish tag).
 *   • label — the human name shown in the dropdown, written in its own script (an endonym) so the
 *             list reads correctly regardless of the (non-existent) app locale.
 * Order is the dropdown order; the FIRST entry is the default when nothing is stored. English leads
 * because the whole app UI is English-only today (no i18n) — this is purely a stored preference.
 */
export const LANGUAGE_OPTIONS = Object.freeze([
  { id: "en", label: "English" },
  { id: "ar", label: "العربية" },
  { id: "fr", label: "Français" },
  { id: "ur", label: "اردو" },
]);

/**
 * The currency options offered by the placeholder picker. Each entry:
 *   • id    — the ISO-4217 code persisted in localStorage + used in the DOM/tests.
 *   • label — "CODE — Name" shown in the dropdown.
 * GBP leads because the app charges in GBP only today (no conversion exists) — this is purely a stored
 * preference that changes nothing about what a user is actually billed.
 */
export const CURRENCY_OPTIONS = Object.freeze([
  { id: "GBP", label: "GBP — British Pound" },
  { id: "USD", label: "USD — US Dollar" },
  { id: "EUR", label: "EUR — Euro" },
  { id: "SAR", label: "SAR — Saudi Riyal" },
]);

/** The default language id — the first option (English). Used when localStorage has nothing (valid). */
export const DEFAULT_LANGUAGE_ID = LANGUAGE_OPTIONS[0].id;

/** The default currency id — the first option (GBP), matching the app's GBP-only billing. */
export const DEFAULT_CURRENCY_ID = CURRENCY_OPTIONS[0].id;

/** localStorage keys for the two placeholder preferences. Namespaced under `tm.` like the tour state. */
export const LANGUAGE_KEY = "tm.pref.language";
export const CURRENCY_KEY = "tm.pref.currency";

/** All valid language ids (the fixed set). Anything outside it is not a selectable preference. */
export const LANGUAGE_IDS = Object.freeze(LANGUAGE_OPTIONS.map((o) => o.id));

/** All valid currency ids (the fixed set). */
export const CURRENCY_IDS = Object.freeze(CURRENCY_OPTIONS.map((o) => o.id));

/** True iff `id` names one of the offered languages. */
export function isValidLanguageId(id) {
  return LANGUAGE_IDS.includes(id);
}

/** True iff `id` names one of the offered currencies. */
export function isValidCurrencyId(id) {
  return CURRENCY_IDS.includes(id);
}

/**
 * Read a stored preference, coercing an absent/invalid/locked value to `fallback`. Best-effort: any
 * storage access error (private mode, quota, disabled) yields the fallback rather than throwing — so a
 * broken Storage never breaks the profile render. `isValid` guards against a stale/tampered value.
 */
export function readPref(storage, key, isValid, fallback) {
  try {
    const raw = storage && storage.getItem(key);
    return isValid(raw) ? raw : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Write a preference to localStorage IFF it's a valid id (never persists junk). Best-effort: returns
 * false if the id is invalid or storage is locked/full, true on a successful write. This is the ONLY
 * side effect either picker has — no network, by design (TM-1124).
 */
export function writePref(storage, key, id, isValid) {
  if (!isValid(id)) return false;
  try {
    storage.setItem(key, id);
    return true;
  } catch {
    return false;
  }
}

/** The stored (or default) language id. */
export function readLanguage(storage) {
  return readPref(storage, LANGUAGE_KEY, isValidLanguageId, DEFAULT_LANGUAGE_ID);
}

/** The stored (or default) currency id. */
export function readCurrency(storage) {
  return readPref(storage, CURRENCY_KEY, isValidCurrencyId, DEFAULT_CURRENCY_ID);
}

/** Persist the chosen language id (validated). Returns whether it was written. */
export function writeLanguage(storage, id) {
  return writePref(storage, LANGUAGE_KEY, id, isValidLanguageId);
}

/** Persist the chosen currency id (validated). Returns whether it was written. */
export function writeCurrency(storage, id) {
  return writePref(storage, CURRENCY_KEY, id, isValidCurrencyId);
}
