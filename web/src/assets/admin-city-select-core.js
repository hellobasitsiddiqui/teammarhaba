// admin-city-select-core.js — pure city-dropdown option logic for the ADMIN surfaces (TM-1174).
//
// TM-1165 cut the USER-facing city pickers (profile.js / onboarding.js) over to the admin-managed
// catalogue via city-catalogue.js (offeredCityNames / loadCityCatalogue). TM-1174 does the same for
// the two ADMIN surfaces that still read the hardcoded list: the event create/edit City dropdown
// (admin-events.js) and the admin profile-edit City dropdown (admin.js). Both build their <select>
// options from an OFFERED list of city names and must keep a legacy OFF-LIST saved city selectable.
//
// This module holds the DOM-free, catalogue-free pieces of that so they're unit-testable under
// `node --test` — neither admin-events.js nor admin.js is node-importable (both pull api.js → the
// Firebase CDN chain), and city-catalogue.js is itself async/cached. Keeping the option-row shape +
// the off-list test here (pure functions of a passed-in `offeredNames` list) is the testable seam.

/** The blank prompt row shown first in every city dropdown. */
const BLANK_ROW = ["", "Choose a city…"];

/**
 * Whether a saved city is OFF the currently-offered list — i.e. it needs its own injected option to
 * stay selectable (a legacy "Dubai" saved before the catalogue existed, or a value dropped from the
 * catalogue since). Blank is never off-list (it's the "no city" choice). Mirrors the self-edit /
 * events off-list idiom, but relative to the passed-in offered names rather than a hardcoded list.
 *
 * @param {string|null|undefined} saved the target's currently-saved city.
 * @param {ReadonlyArray<string>} offeredNames the offered city names (the catalogue, or the fallback).
 * @returns {boolean} true when `saved` is non-blank and not among `offeredNames`.
 */
export function isOffListCity(saved, offeredNames) {
  const v = saved == null ? "" : String(saved).trim();
  if (v === "") return false;
  return !(offeredNames || []).includes(v);
}

/**
 * Build the `[value, label]` option rows for a city dropdown from the offered names, PLUS the target's
 * already-saved OFF-LIST city (kept selectable so an existing profile/event is never silently
 * overwritten on save — the TM-877 / TM-1063 allowance). The leading blank "Choose a city…" prompt is
 * always first. This is the ONE place the option shape lives, shared by the first (fallback) paint and
 * the repaint after the catalogue resolves, on both admin surfaces.
 *
 * @param {ReadonlyArray<string>} offeredNames the offered city names (catalogue, or the fallback).
 * @param {string|null|undefined} [savedCity] the target's saved city (an off-list one is appended).
 * @returns {Array<[string,string]>} the option rows, blank first, offered next, off-list saved last.
 */
export function cityOptionRows(offeredNames, savedCity = null) {
  const rows = [[...BLANK_ROW], ...(offeredNames || []).map((c) => [c, c])];
  if (isOffListCity(savedCity, offeredNames)) {
    const saved = String(savedCity).trim();
    rows.push([saved, saved]);
  }
  return rows;
}
