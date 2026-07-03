// Admin event create/edit logic (TM-395, epic TM-390) — the pure, browser-free half of the admin
// events console, split out of admin-events.js for the same reason broadcast.js was split out of
// admin.js: it's the part that is unit-testable WITHOUT a browser, the Capacitor runtime, or the
// Firebase SDK. admin-events.js transitively imports the Firebase SDK (via auth.js / storage.js)
// from a gstatic CDN URL the Node test runner can't load, so these rules would be untestable if
// they lived there. Here they're pure functions of their inputs, so `node --test web/tools/*.test.mjs`
// (the CI gate) can assert them.
//
// WHAT LIVES HERE (all pure — no DOM, no fetch):
//   - the field caps, mirrored 1:1 from the backend DTOs (Create/UpdateEventRequest, TM-392) so the
//     browser fails fast with the SAME limits the server enforces;
//   - the "Coffee & X" suggestion-chip list (TM-382) — the single configurable source the form
//     tap-to-prefills the heading from;
//   - validateEventDraft(): the whole create/edit form → per-field errors + a canSave flag, mirroring
//     the API's Bean Validation (required/length/min-max) AND its cross-field rules (visibility window
//     ordered, end after start) PLUS the age-band rule (age_min ≤ age_max, TM-415);
//   - buildEventPayload(): a form draft → the JSON body the admin API accepts (Create/UpdateEventRequest
//     shape), converting each local wall-clock + IANA zone into the UTC instant the API stores and
//     omitting blank optionals;
//   - toFormModel(): an EventResponse → the form's field values for the edit prefill (the inverse — UTC
//     instants rendered back into the event's local wall-clock for the datetime-local inputs);
//   - the UTC ⇄ zoned-wall-clock conversion the two above rest on (zonedToUtcIso / utcIsoToZoned),
//     kept pure via Intl so Node can assert DST correctness;
//   - eventLifecycle(): status + the visibility window + now → the admin list's derived status pill
//     (Cancelled / Finished / Hidden / Visible / Unlisted), so the console shows lifecycle the raw
//     PUBLISHED|CANCELLED status alone can't;
//   - revealSummary() / attendanceCounts() / capacityLabel(): the small display derivations the list
//     and form read (the TM-408 effective reveal window; the going/waitlist counts read defensively so
//     they light up the moment the admin projection carries them; capacity vs "Unlimited").

// --- field caps (mirror Create/UpdateEventRequest, TM-392) ------------------------------------

/** Heading cap — mirrors CreateEventRequest.heading @Size(max = 120). */
export const HEADING_MAX = 120;
/** Description cap — mirrors CreateEventRequest.description @Size(max = 5000). */
export const DESCRIPTION_MAX = 5000;
/** Location-text cap — mirrors CreateEventRequest.locationText @Size(max = 500). */
export const LOCATION_MAX = 500;
/** Map/online URL cap — mirrors CreateEventRequest.mapUrl/onlineUrl @Size(max = 2048). */
export const URL_MAX = 2048;
/** City cap — mirrors CreateEventRequest.city @Size(max = 120) (TM-408). */
export const CITY_MAX = 120;
/** Minimum capacity — mirrors CreateEventRequest.capacity @Min(1); blank = unlimited. */
export const CAPACITY_MIN = 1;
/** Reveal-window bounds — mirror CreateEventRequest.locationRevealHours @Min(1) @Max(8760) (TM-408). */
export const REVEAL_HOURS_MIN = 1;
export const REVEAL_HOURS_MAX = 8760;
/**
 * Age-band bounds (TM-415). The API field isn't live yet (TM-415 is not Done), so these mirror the
 * app's existing age model (profile age is 13..120, TM-162): a band outside that can never match a
 * real attendee. The load-bearing rule is age_min ≤ age_max; the bounds just fail fast. If TM-415
 * lands different bounds, widen these two constants.
 */
export const AGE_MIN_BOUND = 13;
export const AGE_MAX_BOUND = 120;

/**
 * The "Coffee & X" suggestion chips (TM-382) — the single configurable list the create/edit form
 * offers as tap-to-prefill heading suggestions. Editable after a tap (they only seed the field), and
 * the heading is free text, so this is a convenience, never a fixed taxonomy. Add a theme by editing
 * THIS list (the form renders whatever is here).
 */
export const CATEGORY_CHIPS = Object.freeze(["Coffee & Code", "Coffee & Feed", "Coffee & Walk"]);

/** A trimmed string, or "" for anything that isn't a non-blank string (mirrors broadcast.js cleanText). */
function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** Parse an integer field's raw string: an integer Number, or null for blank/non-integer input. */
function parseIntOrNull(raw) {
  const value = cleanText(raw);
  if (value === "") return null;
  if (!/^-?\d+$/.test(value)) return NaN; // present but not a whole number — caller surfaces the error
  return Number(value);
}

// --- IANA timezone helpers --------------------------------------------------------------------

/**
 * Whether `tz` is a real IANA timezone id — mirrors the API's `ZoneId.getAvailableZoneIds()` check
 * (Create/UpdateEventRequest.isTimezoneValid) but on the client via Intl, so a bad id fails fast in
 * the browser instead of round-tripping a doomed request. Pure: try to build a formatter for it.
 * @param {string} tz
 * @returns {boolean}
 */
export function isValidTimeZone(tz) {
  const value = cleanText(tz);
  if (value === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** The browser/runtime's best-guess IANA zone (for a new event's default), or "" if unknowable. */
export function guessTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

/**
 * How many milliseconds `timeZone` is ahead of UTC at the instant `date` — computed by formatting the
 * instant AS the zone's wall clock and reading it back as if it were UTC. The gap is the offset. This
 * is what makes the wall-clock ⇄ UTC conversions DST-correct without a tz database on the client.
 */
function zoneOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .formatToParts(date)
    .reduce((acc, p) => ((acc[p.type] = p.value), acc), {});
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - date.getTime();
}

/**
 * A local wall-clock value from a `<input type="datetime-local">` ("YYYY-MM-DDTHH:mm", seconds
 * optional) INTERPRETED IN `timeZone` → the UTC instant ISO string the API stores (the backend keeps
 * everything as UTC + the IANA id and never converts, TM-391). Two-pass so a value on a DST boundary
 * lands on the right instant. Returns null for an unparseable value or an invalid zone.
 *
 * e.g. ("2026-07-10T18:30", "Europe/London") → "2026-07-10T17:30:00.000Z"  (BST, +1)
 *      ("2026-01-10T18:30", "Europe/London") → "2026-01-10T18:30:00.000Z"  (GMT, +0)
 *
 * @param {string} localValue
 * @param {string} timeZone IANA id
 * @returns {?string} UTC ISO 8601, or null.
 */
export function zonedToUtcIso(localValue, timeZone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(cleanText(localValue));
  if (!m || !isValidTimeZone(timeZone)) return null;
  const [, y, mo, d, h, mi, s] = m;
  const asUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), s ? Number(s) : 0);
  // Offset depends on the instant; approximate with the offset at the wall-clock-as-UTC point, correct
  // once, then re-check (a spring-forward/fall-back edge shifts the offset between the two).
  const offset1 = zoneOffsetMs(new Date(asUtc), timeZone);
  let utc = asUtc - offset1;
  const offset2 = zoneOffsetMs(new Date(utc), timeZone);
  if (offset2 !== offset1) utc = asUtc - offset2;
  return new Date(utc).toISOString();
}

/**
 * The inverse: a UTC instant ISO string → the wall-clock value for a `<input type="datetime-local">`
 * ("YYYY-MM-DDTHH:mm") IN `timeZone`, so the edit form shows the event's LOCAL time (TM-391). Returns
 * "" for an unparseable instant or an invalid zone.
 * @param {string} iso UTC ISO 8601
 * @param {string} timeZone IANA id
 * @returns {string}
 */
export function utcIsoToZoned(iso, timeZone) {
  // No instant → blank field. Guard BEFORE `new Date()`: `new Date(null)` is the Unix epoch (its
  // getTime() is 0, NOT NaN), so a null `endAt` (a legit open-ended event) would otherwise render as
  // "1970-01-01…" and poison the edit form — the End field then fails "end after start" and blocks
  // Save on an event that never had an end time (TM-429). `undefined`/`""` already fall out as NaN,
  // but we return early for all three so intent is explicit.
  if (iso == null || iso === "") return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime()) || !isValidTimeZone(timeZone)) return "";
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
    .formatToParts(date)
    .reduce((acc, x) => ((acc[x.type] = x.value), acc), {});
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

// --- validation (mirrors the API's Bean Validation + cross-field rules) ------------------------

/**
 * Validate a create/edit draft against the SAME rules the admin API enforces (Create/UpdateEventRequest,
 * TM-392) so the browser fails fast with the server's limits and only ever POSTs something it will
 * accept. Returns a per-field error map ("" = valid) plus `canSave` (no field in error). The required
 * set matches CreateEventRequest's `@NotBlank`/`@NotNull` fields; the cross-field checks mirror its
 * `@AssertTrue`s (visibility window ordered, end after start) and add the TM-415 age-band rule
 * (age_min ≤ age_max). Datetime ordering is compared on the raw wall-clock strings — both sides are the
 * SAME zone + `YYYY-MM-DDTHH:mm` format, which sorts chronologically — so it needs no zone maths and the
 * server re-checks the instants authoritatively anyway.
 *
 * @param {object} draft the raw form values (all strings; see the FIELD ids in admin-events.js).
 * @param {{requireForCreate?: boolean}} [opts] when true (create), required fields must be present;
 *   for an edit prefilled from the API they always are, but the same rules apply.
 * @returns {{errors: Record<string,string>, canSave: boolean}}
 */
export function validateEventDraft(draft = {}, { requireForCreate = true } = {}) {
  const errors = {};
  const req = (key, label) => {
    if (requireForCreate && cleanText(draft[key]) === "") errors[key] = `${label} is required.`;
  };
  const maxLen = (key, max) => {
    if (cleanText(draft[key]).length > max) errors[key] = `Must be ${max} characters or fewer.`;
  };

  // Required text (mirrors @NotBlank).
  req("heading", "Heading");
  req("description", "Description");
  req("locationText", "Location");
  // Length caps (mirror @Size) — checked whether or not the field is required.
  if (!errors.heading) maxLen("heading", HEADING_MAX);
  if (!errors.description) maxLen("description", DESCRIPTION_MAX);
  if (!errors.locationText) maxLen("locationText", LOCATION_MAX);
  maxLen("mapUrl", URL_MAX);
  maxLen("onlineUrl", URL_MAX);
  maxLen("city", CITY_MAX);

  // Timezone: required + a real IANA id (mirrors @NotBlank + isTimezoneValid).
  const tz = cleanText(draft.timezone);
  if (requireForCreate && tz === "") errors.timezone = "Time zone is required.";
  else if (tz !== "" && !isValidTimeZone(tz)) errors.timezone = "Enter a valid IANA time zone, e.g. Europe/London.";

  // Required datetimes (mirror @NotNull). visibility window + start.
  req("startAt", "Start");
  req("visibilityStart", "Visibility start");
  req("visibilityEnd", "Visibility end");

  // Cross-field ordering (mirror @AssertTrue) — string compare on same-zone wall-clock values.
  const vs = cleanText(draft.visibilityStart);
  const ve = cleanText(draft.visibilityEnd);
  if (!errors.visibilityStart && !errors.visibilityEnd && vs !== "" && ve !== "" && vs >= ve) {
    errors.visibilityEnd = "Visibility end must be after visibility start.";
  }
  const sa = cleanText(draft.startAt);
  const ea = cleanText(draft.endAt);
  if (!errors.startAt && ea !== "" && sa !== "" && ea <= sa) {
    errors.endAt = "End must be after the start.";
  }

  // Capacity: optional, integer ≥ 1 when present (mirrors @Min(1); blank = unlimited).
  const cap = parseIntOrNull(draft.capacity);
  if (Number.isNaN(cap)) errors.capacity = "Enter a whole number.";
  else if (cap !== null && cap < CAPACITY_MIN) errors.capacity = `Must be ${CAPACITY_MIN} or more.`;

  // Location-reveal hours: optional, integer within [1, 8760] when present (mirrors @Min/@Max, TM-408).
  const reveal = parseIntOrNull(draft.locationRevealHours);
  if (Number.isNaN(reveal)) errors.locationRevealHours = "Enter a whole number of hours.";
  else if (reveal !== null && (reveal < REVEAL_HOURS_MIN || reveal > REVEAL_HOURS_MAX)) {
    errors.locationRevealHours = `Must be between ${REVEAL_HOURS_MIN} and ${REVEAL_HOURS_MAX} hours.`;
  }

  // Age band (TM-415): both optional (blank = all ages). Each an integer in [13, 120] when present,
  // and — the load-bearing rule — age_min ≤ age_max when BOTH are set.
  const ageMin = parseIntOrNull(draft.ageMin);
  const ageMax = parseIntOrNull(draft.ageMax);
  const ageBoundMsg = `Must be between ${AGE_MIN_BOUND} and ${AGE_MAX_BOUND}.`;
  if (Number.isNaN(ageMin)) errors.ageMin = "Enter a whole number.";
  else if (ageMin !== null && (ageMin < AGE_MIN_BOUND || ageMin > AGE_MAX_BOUND)) errors.ageMin = ageBoundMsg;
  if (Number.isNaN(ageMax)) errors.ageMax = "Enter a whole number.";
  else if (ageMax !== null && (ageMax < AGE_MIN_BOUND || ageMax > AGE_MAX_BOUND)) errors.ageMax = ageBoundMsg;
  if (
    !errors.ageMin &&
    !errors.ageMax &&
    typeof ageMin === "number" &&
    typeof ageMax === "number" &&
    ageMin > ageMax
  ) {
    errors.ageMax = "Maximum age must be at least the minimum age.";
  }

  return { errors, canSave: Object.keys(errors).length === 0 };
}

// --- payload building (draft → the API body) --------------------------------------------------

/**
 * Turn a validated draft into the JSON body the admin API accepts (Create/UpdateEventRequest shape,
 * TM-392): required text/timezone verbatim, each datetime converted from its local wall-clock + the
 * chosen IANA zone into the UTC instant the API stores, and blank optionals OMITTED (so an untouched
 * optional means "no change" on PATCH, and an unset one is simply absent on create). `imagePath` is
 * NOT set here — the image rides a follow-up PATCH once the event id exists (the id doesn't exist
 * before creation), the house avatar pattern (TM-166).
 *
 * The age-band fields go out as `ageMin`/`ageMax` (camelCase, the API's wire convention). TM-415 owns
 * persisting them; until it lands the server ignores unknown fields (Spring's default), so sending
 * them is a forward-compatible no-op, not a break — and the day TM-415 merges they start persisting
 * with zero client change. Same for anything else the API doesn't read yet.
 *
 * @param {object} draft the raw form values.
 * @returns {object} the request body (only the fields the draft actually carries).
 */
export function buildEventPayload(draft = {}) {
  const tz = cleanText(draft.timezone);
  const body = {};
  const putText = (key, srcKey = key) => {
    const v = cleanText(draft[srcKey]);
    if (v !== "") body[key] = v;
  };
  const putInstant = (key) => {
    const iso = zonedToUtcIso(draft[key], tz);
    if (iso) body[key] = iso;
  };
  const putInt = (key, srcKey = key) => {
    const n = parseIntOrNull(draft[srcKey]);
    if (typeof n === "number") body[key] = n;
  };

  putText("heading");
  putText("description");
  putText("locationText");
  putText("mapUrl");
  putText("onlineUrl");
  putText("city");
  if (tz !== "") body.timezone = tz;
  putInstant("startAt");
  putInstant("endAt");
  putInstant("visibilityStart");
  putInstant("visibilityEnd");
  putInt("capacity");
  putInt("locationRevealHours");
  // Forward-compatible age band (TM-415) — ignored by the server until that ticket persists them.
  putInt("ageMin");
  putInt("ageMax");
  return body;
}

/**
 * The inverse of the form: an EventResponse (TM-392) → the form field values for the edit prefill,
 * rendering each UTC instant back into the event's LOCAL wall-clock (in its own timezone) for the
 * datetime-local inputs. Blank/absent optionals come back as "". Age band is read defensively
 * (`ageMin`/`ageMax` if the projection carries them yet — TM-415).
 *
 * @param {object} event an EventResponse.
 * @returns {object} the draft the form fills its inputs from.
 */
export function toFormModel(event = {}) {
  const tz = cleanText(event.timezone);
  const str = (v) => (v == null ? "" : String(v));
  return {
    heading: str(event.heading),
    description: str(event.description),
    locationText: str(event.locationText),
    mapUrl: str(event.mapUrl),
    onlineUrl: str(event.onlineUrl),
    city: str(event.city),
    timezone: tz,
    startAt: utcIsoToZoned(event.startAt, tz),
    endAt: utcIsoToZoned(event.endAt, tz),
    visibilityStart: utcIsoToZoned(event.visibilityStart, tz),
    visibilityEnd: utcIsoToZoned(event.visibilityEnd, tz),
    capacity: event.capacity == null ? "" : String(event.capacity),
    locationRevealHours: event.locationRevealHours == null ? "" : String(event.locationRevealHours),
    ageMin: event.ageMin == null ? "" : String(event.ageMin),
    ageMax: event.ageMax == null ? "" : String(event.ageMax),
    imagePath: str(event.imagePath),
  };
}

// --- display derivations (the list + form read these) -----------------------------------------

/**
 * The admin list's derived status pill. The API's raw status is only PUBLISHED|CANCELLED, but the
 * console lists the FULL inventory — including events whose visibility window hasn't opened yet and
 * ones already over — so it derives the lifecycle the admin actually cares about from status + the
 * window + now. `tone` maps to a badge variant (ok/off/muted/info) in admin-events.js.
 *
 *   CANCELLED                          → Cancelled (off)
 *   over (now ≥ endAt, else ≥ startAt) → Finished  (muted)
 *   now < visibilityStart              → Hidden    (info)   — scheduled, not yet public
 *   now > visibilityEnd                → Unlisted  (muted)  — past its listing window, not yet started
 *   otherwise                          → Visible   (ok)     — publicly listed right now
 *
 * @param {object} event an EventResponse.
 * @param {Date|number|string} [now]
 * @returns {{label: string, tone: "ok"|"off"|"muted"|"info"}}
 */
export function eventLifecycle(event = {}, now = Date.now()) {
  if (String(event.status).toUpperCase() === "CANCELLED") return { label: "Cancelled", tone: "off" };
  const t = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const startMs = new Date(event.startAt).getTime();
  const endMs = event.endAt ? new Date(event.endAt).getTime() : startMs;
  const visStart = new Date(event.visibilityStart).getTime();
  const visEnd = new Date(event.visibilityEnd).getTime();
  if (Number.isFinite(endMs) && t >= endMs) return { label: "Finished", tone: "muted" };
  if (Number.isFinite(visStart) && t < visStart) return { label: "Hidden", tone: "info" };
  if (Number.isFinite(visEnd) && t > visEnd) return { label: "Unlisted", tone: "muted" };
  return { label: "Visible", tone: "ok" };
}

/** "Unlimited" when capacity is null/absent, otherwise the number as a string (blank = unlimited). */
export function capacityLabel(capacity) {
  return capacity == null || capacity === "" ? "Unlimited" : String(capacity);
}

/**
 * Read going/waitlist counts off an EventResponse DEFENSIVELY. The admin projection (TM-392) does not
 * carry attendance counts yet, so this returns nulls today and the list renders "—". It reads a small
 * set of likely field names so the counts light up automatically the moment the projection (or a
 * TM-413 follow-up) exposes them — no UI change needed. Never throws.
 *
 * @param {object} event
 * @returns {{going: ?number, waitlist: ?number}}
 */
export function attendanceCounts(event = {}) {
  const num = (...candidates) => {
    for (const c of candidates) {
      const n = Number(c);
      if (c != null && Number.isFinite(n)) return n;
    }
    return null;
  };
  return {
    going: num(event.goingCount, event.going, event.attendingCount, event.attending),
    waitlist: num(event.waitlistCount, event.waitlisted, event.waitlist),
  };
}

/**
 * A one-line summary of when the exact location is revealed (TM-408), read off the EventResponse's
 * resolved reveal fields: `effectiveLocationRevealHours` (what actually applies after the
 * override→city→app fallback) and whether `locationRevealHours` (the per-event override) is set. Says
 * where the effective value came from so the admin understands a blank override still has an effect.
 * Returns "" when the response carries no resolved value.
 *
 * @param {object} event an EventResponse.
 * @returns {string}
 */
export function revealSummary(event = {}) {
  const hours = Number(event.effectiveLocationRevealHours);
  if (!Number.isFinite(hours)) return "";
  const source = event.locationRevealHours == null ? "the city / app default" : "this event's override";
  return `Exact location is revealed ${hours} ${hours === 1 ? "hour" : "hours"} before the start (from ${source}).`;
}

/**
 * Render an event's start instant into a compact, human date-time string IN THE EVENT'S OWN timezone
 * for the admin list (the backend stores UTC + the IANA id and never converts, TM-391). Falls back to
 * UTC for an unknown zone and "—" for an unparseable instant. Locale-fixed (en-GB, 24h) so the column
 * reads consistently regardless of the admin's browser locale.
 *
 * @param {string} iso UTC ISO 8601 instant.
 * @param {string} timeZone IANA id the instant pairs with.
 * @returns {string}
 */
export function formatEventWhen(iso, timeZone) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: isValidTimeZone(timeZone) ? timeZone : "UTC",
      weekday: "short",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  } catch {
    return "—";
  }
}
