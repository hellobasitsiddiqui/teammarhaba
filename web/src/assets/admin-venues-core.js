// Admin venue create/edit logic (TM-519, epic TM-390) — the pure, browser-free half of the admin
// venues console, split out of admin-venues.js for the same reason event-form.js was split out of
// admin-events.js: it's the part that is unit-testable WITHOUT a browser, the Capacitor runtime, or
// the Firebase SDK. admin-venues.js transitively imports the Firebase SDK (via auth.js / storage.js)
// from a gstatic CDN URL the Node test runner can't load, so these rules would be untestable if they
// lived there. Here they're pure functions of their inputs, so `node --test web/tools/*.test.mjs`
// (the CI gate) can assert them.
//
// WHAT LIVES HERE (all pure — no DOM, no fetch):
//   - the field caps, mirrored 1:1 from the backend DTOs (Create/UpdateVenueRequest, TM-519) so the
//     browser fails fast with the SAME limits the server enforces;
//   - the indoor/outdoor option list (mirrors the IndoorOutdoor enum);
//   - validateVenueDraft(): the whole create/edit form → per-field errors + a canSave flag, mirroring
//     the API's Bean Validation (required/length/min) AND its cross-field rule (a coordinate pair must
//     be complete — both lat+lng or neither);
//   - buildVenuePayload(): a form draft → the JSON body the admin API accepts (Create/UpdateVenueRequest
//     shape), omitting blank optionals;
//   - toVenueFormModel(): a VenueResponse → the form's field values for the edit prefill.

// --- field caps (mirror Create/UpdateVenueRequest, TM-519) ------------------------------------

/** Name cap — mirrors CreateVenueRequest.name @Size(max = 160). */
export const NAME_MAX = 160;
/** Address cap — mirrors CreateVenueRequest.addressLine @Size(max = 500). */
export const ADDRESS_MAX = 500;
/** City cap — mirrors CreateVenueRequest.city @Size(max = 120). */
export const CITY_MAX = 120;
/** Map URL cap — mirrors CreateVenueRequest.mapUrl @Size(max = 2048). */
export const URL_MAX = 2048;
/** Notes cap — mirrors CreateVenueRequest.notes @Size(max = 5000). */
export const NOTES_MAX = 5000;
/** Accessibility / parking cap — mirrors CreateVenueRequest.accessibility/parking @Size(max = 1000). */
export const DETAIL_MAX = 1000;
/** Minimum capacity — mirrors CreateVenueRequest.capacity @Min(1); blank = unspecified. */
export const CAPACITY_MIN = 1;
/** Latitude bounds — mirror CreateVenueRequest.latitude @DecimalMin/@DecimalMax(-90..90). */
export const LAT_MIN = -90;
export const LAT_MAX = 90;
/** Longitude bounds — mirror CreateVenueRequest.longitude @DecimalMin/@DecimalMax(-180..180). */
export const LNG_MIN = -180;
export const LNG_MAX = 180;

/** The indoor/outdoor options (mirrors the backend IndoorOutdoor enum); "" = unspecified. */
export const INDOOR_OUTDOOR_OPTIONS = Object.freeze(["", "INDOOR", "OUTDOOR", "MIXED"]);

/** A trimmed string, or "" for anything that isn't a non-blank string (mirrors event-form.js cleanText). */
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

// --- validation (mirrors the API's Bean Validation + cross-field rule) ------------------------

/**
 * Validate a create/edit draft against the SAME rules the admin API enforces (Create/UpdateVenueRequest,
 * TM-519) so the browser fails fast with the server's limits and only ever POSTs something it will
 * accept. Returns a per-field error map ("" = valid) plus `canSave` (no field in error). The required
 * set matches CreateVenueRequest's `@NotBlank` fields (name, addressLine); the cross-field check mirrors
 * its `@AssertTrue` (a coordinate pair must be complete — both latitude+longitude or neither).
 *
 * @param {object} draft the raw form values (all strings).
 * @param {{requireForCreate?: boolean}} [opts] when true (create), required fields must be present.
 * @returns {{errors: Record<string,string>, canSave: boolean}}
 */
export function validateVenueDraft(draft = {}, { requireForCreate = true } = {}) {
  const errors = {};
  const req = (key, label) => {
    if (requireForCreate && cleanText(draft[key]) === "") errors[key] = `${label} is required.`;
  };
  const maxLen = (key, max) => {
    if (cleanText(draft[key]).length > max) errors[key] = `Must be ${max} characters or fewer.`;
  };

  // Required text (mirrors @NotBlank).
  req("name", "Name");
  req("addressLine", "Address");
  // Length caps (mirror @Size) — checked whether or not the field is required.
  if (!errors.name) maxLen("name", NAME_MAX);
  if (!errors.addressLine) maxLen("addressLine", ADDRESS_MAX);
  maxLen("city", CITY_MAX);
  maxLen("mapUrl", URL_MAX);
  maxLen("notes", NOTES_MAX);
  maxLen("accessibility", DETAIL_MAX);
  maxLen("parking", DETAIL_MAX);

  // Capacity: optional, integer ≥ 1 when present (mirrors @Min(1); blank = unspecified).
  const cap = parseIntOrNull(draft.capacity);
  if (Number.isNaN(cap)) errors.capacity = "Enter a whole number.";
  else if (cap !== null && cap < CAPACITY_MIN) errors.capacity = `Must be ${CAPACITY_MIN} or more.`;

  // Coordinates: optional decimals in range; and — the load-bearing rule — both or neither.
  const lat = parseFloatOrNull(draft.latitude);
  const lng = parseFloatOrNull(draft.longitude);
  if (Number.isNaN(lat)) errors.latitude = "Enter a number, e.g. 51.5074.";
  else if (lat !== null && (lat < LAT_MIN || lat > LAT_MAX)) errors.latitude = `Must be between ${LAT_MIN} and ${LAT_MAX}.`;
  if (Number.isNaN(lng)) errors.longitude = "Enter a number, e.g. -0.1278.";
  else if (lng !== null && (lng < LNG_MIN || lng > LNG_MAX)) {
    errors.longitude = `Must be between ${LNG_MIN} and ${LNG_MAX}.`;
  }
  if (!errors.latitude && !errors.longitude && (lat === null) !== (lng === null)) {
    // Half a coordinate can't place a point — flag whichever edge is missing.
    if (lat === null) errors.latitude = "Add a latitude to go with the longitude (or clear both).";
    else errors.longitude = "Add a longitude to go with the latitude (or clear both).";
  }

  // Indoor/outdoor: blank or one of the known enum values.
  const io = cleanText(draft.indoorOutdoor);
  if (io !== "" && !INDOOR_OUTDOOR_OPTIONS.includes(io)) errors.indoorOutdoor = "Choose indoor, outdoor, or mixed.";

  return { errors, canSave: Object.keys(errors).length === 0 };
}

// --- payload building (draft → the API body) --------------------------------------------------

/**
 * Turn a validated draft into the JSON body the admin API accepts (Create/UpdateVenueRequest shape,
 * TM-519): required text verbatim and blank optionals OMITTED (so an untouched optional means "no
 * change" on PATCH, and an unset one is simply absent on create). `photoPath` is NOT set here — the
 * photo rides a follow-up PATCH once the venue id exists (the id doesn't exist before creation), the
 * house avatar pattern (TM-166).
 *
 * @param {object} draft the raw form values.
 * @returns {object} the request body (only the fields the draft actually carries).
 */
export function buildVenuePayload(draft = {}) {
  const body = {};
  const putText = (key) => {
    const v = cleanText(draft[key]);
    if (v !== "") body[key] = v;
  };
  const putInt = (key) => {
    const n = parseIntOrNull(draft[key]);
    if (typeof n === "number" && !Number.isNaN(n)) body[key] = n;
  };
  const putFloat = (key) => {
    const n = parseFloatOrNull(draft[key]);
    if (typeof n === "number" && !Number.isNaN(n)) body[key] = n;
  };

  putText("name");
  putText("addressLine");
  putText("city");
  putText("mapUrl");
  putText("notes");
  putText("accessibility");
  putText("parking");
  putText("indoorOutdoor");
  putInt("capacity");
  putFloat("latitude");
  putFloat("longitude");
  return body;
}

/**
 * The optional venue fields a PATCH can carry — the ones {@link buildVenuePayload} OMITS when blank.
 * Same PATCH convention as events (UpdateVenueRequest, TM-519): a null/absent field is "leave
 * unchanged", so a blanked optional is indistinguishable from an untouched one and clearing it back
 * to empty silently no-ops. This list is what {@link clearedOptionalVenueFields} checks so the submit
 * handler can WARN rather than toast a false "saved" (TM-734). `name`/`addressLine` are excluded —
 * required, so validation blocks blanking them.
 */
export const CLEARABLE_OPTIONAL_VENUE_FIELDS = [
  "city",
  "mapUrl",
  "notes",
  "accessibility",
  "parking",
  "indoorOutdoor",
  "capacity",
  "latitude",
  "longitude",
];

/**
 * On EDIT, the optional venue fields the admin has blanked that the PATCH cannot express — the venue
 * carried a value, the draft leaves it empty, yet {@link buildVenuePayload} omits it (so the server
 * keeps the old value). Returns the affected field keys (empty on create, or when nothing was
 * actually cleared) so the caller can warn instead of reporting a save that didn't happen (TM-734).
 *
 * @param {object} original the VenueResponse being edited (omit/empty on create).
 * @param {object} draft the raw form values being submitted.
 * @returns {string[]} the keys of previously-set optionals now blanked but not transmittable.
 */
export function clearedOptionalVenueFields(original, draft = {}) {
  if (!original || typeof original !== "object") return [];
  const before = toVenueFormModel(original);
  const body = buildVenuePayload(draft);
  return CLEARABLE_OPTIONAL_VENUE_FIELDS.filter(
    (key) => cleanText(before[key]) !== "" && !(key in body),
  );
}

/**
 * The inverse of the form: a VenueResponse (TM-519) → the form field values for the edit prefill.
 * Blank/absent optionals come back as "".
 *
 * @param {object} venue a VenueResponse.
 * @returns {object} the draft the form fills its inputs from.
 */
export function toVenueFormModel(venue = {}) {
  const str = (v) => (v == null ? "" : String(v));
  return {
    name: str(venue.name),
    addressLine: str(venue.addressLine),
    city: str(venue.city),
    latitude: venue.latitude == null ? "" : String(venue.latitude),
    longitude: venue.longitude == null ? "" : String(venue.longitude),
    mapUrl: str(venue.mapUrl),
    notes: str(venue.notes),
    capacity: venue.capacity == null ? "" : String(venue.capacity),
    accessibility: str(venue.accessibility),
    parking: str(venue.parking),
    indoorOutdoor: str(venue.indoorOutdoor),
    photoPath: str(venue.photoPath),
  };
}

/**
 * A compact one-line address summary for the venue picker option / list row: "Name — City" (or just
 * "Name" when there's no city). Kept pure so the picker and list render venues identically.
 *
 * @param {object} venue a VenueResponse.
 * @returns {string}
 */
export function venueSummaryLabel(venue = {}) {
  const name = cleanText(venue.name) || "Untitled venue";
  const city = cleanText(venue.city);
  return city ? `${name} — ${city}` : name;
}

/**
 * Classify a venue's stored `photoPath` for rendering (TM-711) — the twin of `eventImageRef` in
 * events-core.js (TM-708). The field holds EITHER a full http(s) URL (legacy / externally hosted) OR a
 * Firebase Storage object path — which is what `uploadVenueImage` actually persists (e.g.
 * `venue-images/7`). The photo was stored but rendered NOWHERE, so uploaded venue photos silently never
 * showed. Returns:
 *   - `null`                    → no photo; render the placeholder box.
 *   - `{ kind: "url",  value }` → use directly as the `<img>` src.
 *   - `{ kind: "path", value }` → resolve to a download URL before rendering (view calls
 *                                 downloadUrlForPath).
 * Pure + synchronous so it's unit-testable; the async path resolution lives in the view (admin-venues.js).
 * @param {string|null|undefined} photoPath
 * @returns {{kind:"url"|"path", value:string}|null}
 */
export function venueImageRef(photoPath) {
  const path = (photoPath || "").trim();
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return { kind: "url", value: path };
  return { kind: "path", value: path };
}
