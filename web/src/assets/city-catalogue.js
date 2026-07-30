// Offered-city resolver for the profile / onboarding city picker (TM-1165).
//
// The picker + client-side validation used to read a hardcoded list (CITY_OPTIONS / ALLOWED_CITIES).
// This module retires that: it fetches the ADMIN-MANAGED catalogue once (GET /api/v1/cities/catalogue,
// via api.js getCityCatalogue) and exposes the offered city NAMES to the render code. So an
// admin-added city becomes selectable + valid with NO code deploy. The fetch is cached (one shared
// promise) so the several consumers (profile.js, onboarding.js) don't each hit the endpoint.
//
// FAIL-SAFE: the field must never break offline. Until the catalogue resolves — and forever after if
// the fetch fails or returns nothing — offeredCityNames() returns the hard fallback (CITY_FALLBACK =
// the four seeded cities). cityOptionsFrom (profile-core.js) is the pure mapping this wraps; keeping
// the fetch/caching here and the mapping there keeps the mapping trivially unit-testable.

import { getCityCatalogue } from "./api.js";
import { CITY_FALLBACK, cityOptionsFrom } from "./profile-core.js";

/** The resolved offered names once the fetch has succeeded, or null while unresolved/failed. */
let resolvedNames = null;

/** The in-flight (or settled) fetch promise, so we only ever fetch once per page load. */
let inflight = null;

/**
 * The offered city names to show/validate against, RIGHT NOW (synchronous). Returns the resolved
 * catalogue names once {@link loadCityCatalogue} has succeeded; otherwise the hard {@link CITY_FALLBACK}
 * (the field never breaks offline). Callers that want the freshest list should await
 * {@link loadCityCatalogue} first, then read this on repaint.
 *
 * @returns {string[]} the offered city names (a fresh array).
 */
export function offeredCityNames() {
  return resolvedNames ? [...resolvedNames] : [...CITY_FALLBACK];
}

/**
 * Fetch + cache the active city catalogue, resolving to the offered city names. Idempotent: the
 * network call happens at most once per page load (subsequent calls return the same settled promise).
 * A failed/empty fetch resolves to the fallback (never rejects) so a caller can always `await` it and
 * repaint without a try/catch — the picker stays usable offline.
 *
 * @returns {Promise<string[]>} the offered city names (catalogue, or the fallback on failure/empty).
 */
export function loadCityCatalogue() {
  if (inflight) return inflight;
  inflight = getCityCatalogue()
    .then((rows) => {
      resolvedNames = cityOptionsFrom(rows);
      return [...resolvedNames];
    })
    .catch((err) => {
      // Non-fatal: keep resolvedNames null so offeredCityNames() serves the fallback.
      console.warn("[city-catalogue] catalogue fetch failed — using the fallback list:", err?.message ?? err);
      return [...CITY_FALLBACK];
    });
  return inflight;
}

/** Test-only reset of the module cache so a spec can re-exercise the fetch path. */
export function __resetCityCatalogueForTest() {
  resolvedNames = null;
  inflight = null;
}
