// Admin city create/edit logic (TM-1166, epic wave-admin-events-city) — the pure, browser-free half
// of the admin cities console, split out of admin-cities.js for the same reason admin-venues-core.js
// was split out of admin-venues.js: it's the part that is unit-testable WITHOUT a browser, the
// Capacitor runtime, or the Firebase SDK. admin-cities.js transitively imports the Firebase SDK (via
// auth.js / storage.js) from a gstatic CDN URL the Node test runner can't load, so these rules would
// be untestable if they lived there. Here they're pure functions of their inputs, so
// `node --test web/tools/*.test.mjs` (the CI gate) can assert them.
//
// WHAT LIVES HERE (all pure — no DOM, no fetch):
//   - the field caps, mirrored 1:1 from the backend DTOs (Create/UpdateCityRequest, TM-1089/TM-1166)
//     so the browser fails fast with the SAME limits the server enforces;
//   - validateCityDraft(): the whole create/edit form → per-field errors + a canSave flag, mirroring
//     the API's Bean Validation (@NotBlank name/country, @Size caps, @Min/@Max on geo + sortWeight)
//     AND the coordinate-pair completeness rule (both geoLat+geoLng or neither) the console enforces;
//   - buildCityPayload(): a form draft → the JSON body the admin API accepts (Create/UpdateCity-
//     Request shape), omitting a blank sortWeight (create → default 0; PATCH → leave unchanged) and
//     blank optional text so a create doesn't send empties. imagePath/iconImagePath are NOT set here —
//     they ride a follow-up PATCH once the city id exists (the house avatar/upload pattern, TM-166);
//   - toCityFormModel(): an AdminCityResponse → the form's field values for the edit prefill;
//   - cityImageRef(): classify a stored image path (url vs Storage object path) for rendering.

// --- field caps (mirror Create/UpdateCityRequest, TM-1089/TM-1166) ----------------------------

/** Name cap — mirrors CreateCityRequest.name @Size(max = 120) / city_catalogue.name VARCHAR(120). */
export const NAME_MAX = 120;
/** Country cap — mirrors CreateCityRequest.country @Size(max = 80) / country VARCHAR(80). */
export const COUNTRY_MAX = 80;
/** Icon-emoji cap — mirrors CreateCityRequest.iconEmoji @Size(max = 16) (generous for flag/ZWJ glyphs). */
export const ICON_EMOJI_MAX = 16;
/** Image-path caps — mirror image_path / icon_image_path VARCHAR(500) (the upload writes these, TM-1166). */
export const IMAGE_PATH_MAX = 500;
/** Sort-weight bounds — mirror CreateCityRequest.sortWeight @Min(0) @Max(1000); blank = default. */
export const SORT_WEIGHT_MIN = 0;
export const SORT_WEIGHT_MAX = 1000;
/** Latitude bounds — mirror CreateCityRequest.geoLat @DecimalMin/@DecimalMax(-90..90). */
export const LAT_MIN = -90;
export const LAT_MAX = 90;
/** Longitude bounds — mirror CreateCityRequest.geoLng @DecimalMin/@DecimalMax(-180..180). */
export const LNG_MIN = -180;
export const LNG_MAX = 180;

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

/** Parse a decimal field's raw string: a finite Number, or null for blank; NaN for non-numeric input. */
function parseFloatOrNull(raw) {
  const value = cleanText(raw);
  if (value === "") return null;
  if (!/^-?\d+(\.\d+)?$/.test(value)) return NaN; // present but not a decimal — caller surfaces the error
  return Number(value);
}

// --- validation (mirrors the API's Bean Validation + the coordinate-pair rule) ----------------

/**
 * Validate a create/edit draft against the SAME rules the admin API enforces (Create/UpdateCityRequest,
 * TM-1089/TM-1166) so the browser fails fast with the server's limits and only ever POSTs something it
 * will accept. Returns a per-field error map ("" = valid) plus `canSave` (no field in error).
 *
 * The rules mirror the DTOs:
 *   - name/country: required on create (@NotBlank); present-but-blank rejected on edit (mirrors
 *     UpdateCityRequest.isNameUsable/isCountryUsable — you can't clear a name/country to nothing);
 *     ≤ NAME_MAX / COUNTRY_MAX (@Size);
 *   - iconEmoji: optional; only the length cap (≤ ICON_EMOJI_MAX). Blank = no glyph;
 *   - geoLat/geoLng: optional decimals in real WGS-84 ranges (@DecimalMin/@DecimalMax). The console
 *     additionally requires a coordinate PAIR to be complete (both or neither) — half a coordinate
 *     can't place a point (the same UX guard as venues);
 *   - sortWeight: optional integer in [0, 1000] (@Min/@Max); blank = omit (server default 0).
 *
 * @param {object} draft the raw form values (all strings).
 * @param {{requireForCreate?: boolean}} [opts] when true (create), name/country must be present.
 * @returns {{errors: Record<string,string>, canSave: boolean}}
 */
export function validateCityDraft(draft = {}, { requireForCreate = true } = {}) {
  const errors = {};
  const name = cleanText(draft.name);
  const country = cleanText(draft.country);

  // Name: required on create; on edit a present-but-blank name is rejected (can't clear it). In this
  // form the input is always present, so a blank name errors on create (required) and on edit (@AssertTrue
  // isNameUsable). Matches @NotBlank + isNameUsable.
  if (name === "") {
    errors.name = requireForCreate ? "Name is required." : "Name can't be blank.";
  } else if (name.length > NAME_MAX) {
    errors.name = `Must be ${NAME_MAX} characters or fewer.`;
  }

  // Country: same shape as name (@NotBlank + isCountryUsable).
  if (country === "") {
    errors.country = requireForCreate ? "Country is required." : "Country can't be blank.";
  } else if (country.length > COUNTRY_MAX) {
    errors.country = `Must be ${COUNTRY_MAX} characters or fewer.`;
  }

  // Icon emoji: optional; the only rule is the length cap (mirrors @Size(max = 16)). Blank = no glyph.
  const iconEmoji = cleanText(draft.iconEmoji);
  if (iconEmoji.length > ICON_EMOJI_MAX) {
    errors.iconEmoji = `Must be ${ICON_EMOJI_MAX} characters or fewer.`;
  }

  // Coordinates: optional decimals in range; and — the load-bearing UX rule — both or neither.
  const lat = parseFloatOrNull(draft.geoLat);
  const lng = parseFloatOrNull(draft.geoLng);
  if (Number.isNaN(lat)) errors.geoLat = "Enter a number, e.g. 51.5074.";
  else if (lat !== null && (lat < LAT_MIN || lat > LAT_MAX)) errors.geoLat = `Must be between ${LAT_MIN} and ${LAT_MAX}.`;
  if (Number.isNaN(lng)) errors.geoLng = "Enter a number, e.g. -0.1278.";
  else if (lng !== null && (lng < LNG_MIN || lng > LNG_MAX)) {
    errors.geoLng = `Must be between ${LNG_MIN} and ${LNG_MAX}.`;
  }
  if (!errors.geoLat && !errors.geoLng && (lat === null) !== (lng === null)) {
    if (lat === null) errors.geoLat = "Add a latitude to go with the longitude (or clear both).";
    else errors.geoLng = "Add a longitude to go with the latitude (or clear both).";
  }

  // Sort weight: optional integer in [0, 1000]; blank = unspecified (server default 0).
  const weight = parseIntOrNull(draft.sortWeight);
  if (Number.isNaN(weight)) errors.sortWeight = "Enter a whole number.";
  else if (weight !== null && (weight < SORT_WEIGHT_MIN || weight > SORT_WEIGHT_MAX)) {
    errors.sortWeight = `Must be between ${SORT_WEIGHT_MIN} and ${SORT_WEIGHT_MAX}.`;
  }

  return { errors, canSave: Object.keys(errors).length === 0 };
}

// --- payload building (draft → the API body) --------------------------------------------------

/**
 * Turn a validated draft into the JSON body the admin API accepts (Create/UpdateCityRequest shape,
 * TM-1089/TM-1166): required text verbatim, blank optionals OMITTED (so on create an unset optional is
 * simply absent, and on PATCH an untouched optional means "no change"). `iconEmoji` is ALWAYS sent
 * (trimmed) — "" tells the server to clear it, a non-empty glyph sets it (the backend normalises blank
 * to null). `imagePath`/`iconImagePath` are NOT set here — the images ride a follow-up PATCH once the
 * city id exists (the id doesn't exist before creation), the house avatar/upload pattern (TM-166).
 *
 * @param {object} draft the raw form values.
 * @returns {object} the request body.
 */
export function buildCityPayload(draft = {}) {
  const body = {
    name: cleanText(draft.name),
    country: cleanText(draft.country),
  };
  // Icon emoji: always send the (trimmed) value so a cleared field reads as "no emoji" on the server.
  body.iconEmoji = cleanText(draft.iconEmoji);

  const lat = parseFloatOrNull(draft.geoLat);
  if (typeof lat === "number" && !Number.isNaN(lat)) body.geoLat = lat;
  const lng = parseFloatOrNull(draft.geoLng);
  if (typeof lng === "number" && !Number.isNaN(lng)) body.geoLng = lng;

  const weight = parseIntOrNull(draft.sortWeight);
  if (typeof weight === "number" && !Number.isNaN(weight)) body.sortWeight = weight;
  return body;
}

/**
 * The inverse of the form: an AdminCityResponse (TM-1089/TM-1166) → the form field values for the edit
 * prefill. Blank/absent optionals come back as ""; sortWeight is stringified for the number input (it's
 * an `int` on the response so always present). The image paths ride along so the form can seed its
 * existing-image previews.
 *
 * @param {object} city an AdminCityResponse.
 * @returns {object} the draft the form fills its inputs from.
 */
export function toCityFormModel(city = {}) {
  const str = (v) => (v == null ? "" : String(v));
  return {
    name: str(city.name),
    country: str(city.country),
    iconEmoji: str(city.iconEmoji),
    geoLat: city.geoLat == null ? "" : String(city.geoLat),
    geoLng: city.geoLng == null ? "" : String(city.geoLng),
    sortWeight: city.sortWeight == null ? "" : String(city.sortWeight),
    imagePath: str(city.imagePath),
    iconImagePath: str(city.iconImagePath),
  };
}

/**
 * A compact one-line summary for a city list row / picker option: "Name — Country" (or just the name
 * when there's no country). Kept pure so any surface renders cities identically (mirrors
 * venueSummaryLabel).
 *
 * @param {object} city an AdminCityResponse.
 * @returns {string}
 */
export function citySummaryLabel(city = {}) {
  const name = cleanText(city.name) || "Untitled city";
  const country = cleanText(city.country);
  return country ? `${name} — ${country}` : name;
}

/**
 * Classify a city's stored image path (imagePath or iconImagePath) for rendering — the twin of
 * venueImageRef in admin-venues-core.js (TM-711). The field holds EITHER a full http(s) URL (legacy /
 * externally hosted) OR a Firebase Storage object path — which is what `uploadCityImage` /
 * `uploadCityIconImage` actually persist (e.g. `city-icon-images/7`). Returns:
 *   - `null`                    → no image; render the placeholder.
 *   - `{ kind: "url",  value }` → use directly as the `<img>` src.
 *   - `{ kind: "path", value }` → resolve to a download URL before rendering (view calls downloadUrlForPath).
 * Pure + synchronous so it's unit-testable; the async path resolution lives in the view (admin-cities.js).
 *
 * @param {string|null|undefined} imagePath
 * @returns {{kind:"url"|"path", value:string}|null}
 */
export function cityImageRef(imagePath) {
  const path = (imagePath || "").trim();
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return { kind: "url", value: path };
  return { kind: "path", value: path };
}
