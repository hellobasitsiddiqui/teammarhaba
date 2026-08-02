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

import { normalisePreview } from "./chat-linkpreview-core.js";

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
/** Opening-message cap — mirrors Create/UpdateEventRequest.openingMessage @Size(max = 2000) (TM-710). */
export const OPENING_MESSAGE_MAX = 2000;
/** Minimum capacity — mirrors CreateEventRequest.capacity @Min(1); blank = unlimited. */
export const CAPACITY_MIN = 1;
/** Reveal-window bounds — mirror CreateEventRequest.locationRevealHours @Min(1) @Max(8760) (TM-408). */
export const REVEAL_HOURS_MIN = 1;
export const REVEAL_HOURS_MAX = 8760;
/**
 * Booking-cutoff bounds — mirror Create/UpdateEventRequest.bookingCutoffHours @Min(0) @Max(8760) (TM-413,
 * exposed on the form by TM-1157). Unlike the reveal window the MINIMUM is 0: `0` = accept RSVPs right up
 * to the start (no cutoff). Blank = inherit (override → per-city → app default). RSVP/waitlist-join/claim
 * is refused once `now >= startAt − cutoffHours`.
 */
export const BOOKING_CUTOFF_HOURS_MIN = 0;
export const BOOKING_CUTOFF_HOURS_MAX = 8760;
/**
 * The app-default booking cutoff (TM-413): 1 hour before the start. Shown as the placeholder/helper on the
 * form field so an admin who leaves the override BLANK sees what will actually apply. Only the fallback for
 * an EventResponse that carries no resolved `effectiveBookingCutoffHours` yet (create, or a legacy
 * response); a real event always shows its own resolved effective value.
 */
export const BOOKING_CUTOFF_DEFAULT_HOURS = 1;
/**
 * Age-band bounds (TM-415). The API field isn't live yet (TM-415 is not Done), so these mirror the
 * app's existing age model (profile age is 13..120, TM-162): a band outside that can never match a
 * real attendee. The load-bearing rule is age_min ≤ age_max; the bounds just fail fast. If TM-415
 * lands different bounds, widen these two constants.
 */
export const AGE_MIN_BOUND = 13;
export const AGE_MAX_BOUND = 120;

/**
 * The create default age band (TM-1065): 18–99 — attendees are 18–99 (TM-884), so a brand-new event
 * opens pre-filled to the whole adult range rather than blank. These are the numbers seeded into the
 * two custom age inputs on create (which, being 18/99, map back to the "18-99" — a non-preset band, so
 * the control opens on Custom on create). Kept inside [AGE_MIN_BOUND, AGE_MAX_BOUND] so they validate.
 */
export const AGE_DEFAULT_MIN = 18;
export const AGE_DEFAULT_MAX = 99;

/** The Custom sentinel {@link minMaxToAgeBand} returns for any band that isn't one of the presets. */
export const AGE_BAND_CUSTOM = "Custom";

/**
 * The age-band preset chips (TM-1065) — the single configurable source of the tap-to-set age bands the
 * create/edit form offers, in display order. Each is `{ label, min, max }` where `min`/`max` are numbers
 * or null (null = "no bound on that side"). The 13–17 preset is deliberately dropped: attendees are
 * 18–99 (TM-884). A `Custom` chip (not in this list) reveals the two number inputs for any other band.
 *
 * The mapping is bidirectional and must stay 1:1 so {@link minMaxToAgeBand} can reverse-map a saved band
 * back to its preset (and fall back to Custom otherwise). Add/adjust a band by editing THIS list.
 */
export const AGE_BAND_PRESETS = Object.freeze([
  Object.freeze({ label: "18-30", min: 18, max: 30 }),
  Object.freeze({ label: "21-35", min: 21, max: 35 }),
  Object.freeze({ label: "30+", min: 30, max: null }),
  Object.freeze({ label: "All ages", min: null, max: null }),
]);

/**
 * Generic opening-message sample templates (TM-1065) — the 2–3 tap-to-prefill starters shown above the
 * chat opening-message textarea. They only SEED the textarea (the free-text seeding contract, like the
 * TM-382 heading chips): the admin edits freely after a tap and `OPENING_MESSAGE_MAX` still caps it.
 * Deliberately GENERIC (no category-specific copy — that's deferred to TM-219). Add a starter here.
 */
export const OPENING_MESSAGE_TEMPLATES = Object.freeze([
  "Welcome! So glad you're joining us. Introduce yourself when you get a moment 👋",
  "Hi everyone — this is our group chat for the event. Any questions, ask away here.",
  "Looking forward to meeting you all! I'll share any last-minute details in this chat.",
]);

/**
 * Generic event-description starter templates (TM-1113) — the 2–3 tap-to-prefill starters shown above the
 * Description textarea. They mirror {@link OPENING_MESSAGE_TEMPLATES} (TM-1065) exactly: they only SEED the
 * textarea (the free-text seeding contract, like the TM-382 heading chips + the Coffee & X themes) — the
 * admin edits freely after a tap and `DESCRIPTION_MAX` still caps it. Deliberately GENERIC and hardcoded
 * (v1): they echo the existing opening-message + Coffee & X copy so a brand-new event has a sensible
 * starting shape. Category-specific description copy is deferred (the same TM-219 deferral the opening-
 * message templates carry). Add/adjust a starter by editing THIS list; the form renders whatever is here.
 */
export const DESCRIPTION_TEMPLATES = Object.freeze([
  "Join us for a relaxed Coffee & Code session — bring a laptop and whatever you're working on, or just come to chat. All levels welcome.",
  "A friendly get-together over coffee. Come meet the group, say hello, and see what we're about — no agenda, just good company.",
  "We'll gather, grab a drink, and spend a couple of hours together. Details and any last-minute updates will be shared in the group chat.",
]);

/**
 * Map an age-band preset LABEL to its `{ min, max }` as form-field STRINGS (or "" for a null bound), so
 * the caller can drop them straight into the two number inputs (TM-1065). An unknown label (including the
 * Custom sentinel) returns `{ min: "", max: "" }` — Custom carries no fixed numbers, the admin types them.
 * Pure — no DOM. The inverse is {@link minMaxToAgeBand}.
 *
 * @param {string} preset a label from {@link AGE_BAND_PRESETS} (or anything else → blank band).
 * @returns {{min: string, max: string}}
 */
export function ageBandToMinMax(preset) {
  const match = AGE_BAND_PRESETS.find((b) => b.label === cleanText(preset));
  if (!match) return { min: "", max: "" };
  return {
    min: match.min == null ? "" : String(match.min),
    max: match.max == null ? "" : String(match.max),
  };
}

/**
 * Reverse-map a saved `{min, max}` band to the preset LABEL that matches it, or {@link AGE_BAND_CUSTOM}
 * ("Custom") when NO preset matches (TM-1065) — e.g. a saved 25–40, or the 18–99 create default, opens on
 * Custom showing its numbers. Accepts numbers, numeric strings, or null/""/undefined for an absent bound
 * (both absent = the "All ages" preset). A non-integer / out-of-parse value on either side falls back to
 * Custom (it's a real, if unusual, band the admin should still see verbatim). Pure — no DOM.
 *
 * @param {number|string|null|undefined} min
 * @param {number|string|null|undefined} max
 * @returns {string} a preset label from {@link AGE_BAND_PRESETS}, or "Custom".
 */
export function minMaxToAgeBand(min, max) {
  const norm = (v) => {
    if (v == null || cleanText(String(v)) === "") return null;
    // parseIntOrNull only reads strings; accept a raw number too (presets carry numeric min/max).
    const n = parseIntOrNull(String(v));
    return typeof n === "number" ? n : NaN; // NaN = present-but-unparseable → never matches a preset
  };
  const lo = norm(min);
  const hi = norm(max);
  if (Number.isNaN(lo) || Number.isNaN(hi)) return AGE_BAND_CUSTOM;
  const match = AGE_BAND_PRESETS.find((b) => b.min === lo && b.max === hi);
  return match ? match.label : AGE_BAND_CUSTOM;
}

// --- price control (TM-1076) ------------------------------------------------------------------
//
// Every form-created event used to become £5 silently: the form had NO price control, so it omitted
// `pricePence`, and the backend fell back to Event.DEFAULT_PRICE_PENCE = 500 (£5). `pricePence:0` (free)
// was unreachable from the UI. The Price control fixes this — it defaults to Free, and buildEventPayload
// ALWAYS sends `pricePence` (0 for Free) so an event is never silently £5. The backend contract is
// unchanged: Create/UpdateEventRequest already accept `pricePence` (@Min(0), integer pence, 0 = free),
// and EventResponse already exposes it for the edit prefill.

/** The Custom sentinel {@link penceToPriceChip} returns for any amount that isn't one of the presets. */
export const PRICE_CHIP_CUSTOM = "Custom";

/**
 * The price preset chips (TM-1076) — the single configurable source of the tap-to-set prices the form
 * offers, in display order. Each is `{ label, pence }`. **Free is FIRST so it is the create default**
 * (the whole point of the ticket — a brand-new event is Free, not £5). A `Custom` chip (not in this
 * list) reveals a free-text £ amount input for any other price. The mapping must stay 1:1 so
 * {@link penceToPriceChip} can reverse-map a saved price back to its chip. Add/adjust a preset here.
 */
export const PRICE_CHIP_PRESETS = Object.freeze([
  Object.freeze({ label: "Free (£0)", pence: 0 }),
  Object.freeze({ label: "£5", pence: 500 }),
  Object.freeze({ label: "£10", pence: 1000 }),
]);

/** The chip label that is selected by DEFAULT on a brand-new event (TM-1076) — Free. */
export const PRICE_DEFAULT_CHIP = PRICE_CHIP_PRESETS[0].label;

/**
 * Map a price chip LABEL to its pence value (TM-1076). A preset label returns its fixed pence; the
 * Custom sentinel (and anything else) returns null — Custom carries no fixed value, the admin types a
 * £ amount which {@link poundsToPence} converts. Pure — no DOM. The inverse is {@link penceToPriceChip}.
 *
 * @param {string} chip a label from {@link PRICE_CHIP_PRESETS}, or "Custom" / anything unknown.
 * @returns {?number} the preset's pence, or null for Custom / an unknown label.
 */
export function priceChipToPence(chip) {
  const match = PRICE_CHIP_PRESETS.find((p) => p.label === cleanText(chip));
  return match ? match.pence : null;
}

/**
 * Reverse-map a saved `pricePence` to the price chip LABEL that matches it, or {@link PRICE_CHIP_CUSTOM}
 * ("Custom") when NO preset matches (TM-1076) — e.g. a saved 750 (£7.50) opens on Custom showing 7.50.
 * Accepts a number or a numeric string. A null/blank/non-integer/negative value falls back to Custom
 * (an unusual-but-real price the admin should still see verbatim rather than have silently coerced).
 * Pure — no DOM. The inverse is {@link priceChipToPence}.
 *
 * @param {number|string|null|undefined} pence
 * @returns {string} a preset label from {@link PRICE_CHIP_PRESETS}, or "Custom".
 */
export function penceToPriceChip(pence) {
  if (pence == null || cleanText(String(pence)) === "") return PRICE_CHIP_CUSTOM;
  const n = parseIntOrNull(String(pence));
  if (typeof n !== "number" || n < 0) return PRICE_CHIP_CUSTOM; // NaN / negative → Custom
  const match = PRICE_CHIP_PRESETS.find((p) => p.pence === n);
  return match ? match.label : PRICE_CHIP_CUSTOM;
}

/**
 * A pence value → a £ amount STRING for the Custom £ input (TM-1076). Whole pounds render without a
 * decimal (500 → "5"); a fractional amount keeps two places (750 → "7.50"). Returns "" for a
 * null/blank/unparseable value so a Custom input opens empty rather than "NaN". Pure — no DOM.
 *
 * @param {number|string|null|undefined} pence
 * @returns {string} the £ amount (no currency symbol), or "".
 */
export function penceToPounds(pence) {
  if (pence == null || cleanText(String(pence)) === "") return "";
  const n = parseIntOrNull(String(pence));
  if (typeof n !== "number") return "";
  const pounds = n / 100;
  // Whole pounds without a trailing ".00"; otherwise two decimals (a real currency amount).
  return Number.isInteger(pounds) ? String(pounds) : pounds.toFixed(2);
}

/**
 * A £ amount STRING (what the Custom input holds) → integer pence (TM-1076), the @Min(0) integer the API
 * stores. "5" → 500, "7.50" → 750, "0" → 0. Accepts an optional leading "£" and surrounding space. Rounds
 * to the nearest whole pence to absorb float error (7.50 * 100 = 749.9999… → 750). Returns:
 *   - null  for a BLANK amount (the caller decides the default — the Free chip already carries 0),
 *   - NaN   for a non-numeric OR NEGATIVE amount (the caller surfaces the validation error).
 * Pure — no DOM.
 *
 * @param {string} pounds the £ amount the admin typed (may carry a "£" / spaces).
 * @returns {?number} integer pence, or null (blank) / NaN (invalid).
 */
export function poundsToPence(pounds) {
  const raw = cleanText(pounds).replace(/^£/, "").trim();
  if (raw === "") return null;
  // A GBP amount: optional whole part, optional up-to-2-decimal part. Reject anything else (letters,
  // extra dots, more than 2 dp, a leading minus → negative price is never valid).
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return NaN;
  return Math.round(Number(raw) * 100);
}

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
 * Derive-precedence rule (TM-1066) for the venue-pick → event-timezone hook. The event's time zone is
 * DERIVED from the picked venue's `timezone`, EXCEPT once the admin has manually edited the field —
 * a manual value is then never clobbered by a later re-pick. Pure so the precedence is unit-testable
 * without the DOM (admin-events.js can't be imported in Node — a transitive Firebase `https:` import).
 *
 * Returns the zone the field SHOULD hold after a pick, or `null` for "leave the current value alone":
 *   - venue carries no (or a blank/invalid) `timezone` → null (a venue without a zone never blanks it),
 *   - the admin has manually edited the timezone (`userEdited`) → null (their choice wins),
 *   - otherwise → the venue's zone (overwrite; read defensively via `venue?.timezone`).
 *
 * @param {?object} venue the chosen venue (or null for the one-off / blank option).
 * @param {boolean} userEdited whether the admin has hand-edited the timezone since the form opened.
 * @returns {?string} the IANA zone to set, or null to leave the current value unchanged.
 */
export function deriveVenueTimezone(venue, userEdited) {
  if (userEdited) return null;
  const tz = cleanText(venue?.timezone);
  if (tz === "" || !isValidTimeZone(tz)) return null;
  return tz;
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

// --- format (In person / Online) — CLIENT-ONLY, no backend field (TM-1063) --------------------

/**
 * The two event formats the form offers (TM-1063). This is a CLIENT-ONLY view-state distinction — the
 * backend has NO `format` field. An event IS "online" purely by virtue of what it carries: an
 * `onlineUrl` and/or a `locationText` of literally "Online". So we never persist the format; we infer
 * it on edit ({@link formatFromEvent}) and, on save, an Online event auto-fills `locationText="Online"`
 * so the server's `@NotBlank` on the (physical) location line is still satisfied ({@link buildEventPayload}).
 */
export const EVENT_FORMAT_INPERSON = "inperson";
export const EVENT_FORMAT_ONLINE = "online";

/** The wire value written into `locationText` for an Online event so the server `@NotBlank` is met. */
export const ONLINE_LOCATION_TEXT = "Online";

/**
 * Infer an event's format for the edit prefill (TM-1063), CLIENT-SIDE only — the backend carries no
 * format flag. An event is "online" when it has a non-blank `onlineUrl` OR its `locationText` is exactly
 * "Online" (case-insensitive), the two signals the create form leaves behind for an online event.
 * Everything else (a physical location line, no online URL) is "in person" — the default for a brand-new
 * event with no signals either way.
 *
 * @param {object} event an EventResponse (or a draft-shaped object), or nullish on create.
 * @returns {"inperson"|"online"}
 */
export function formatFromEvent(event = {}) {
  const e = event && typeof event === "object" ? event : {};
  const online =
    cleanText(e.onlineUrl) !== "" ||
    cleanText(e.locationText).toLowerCase() === ONLINE_LOCATION_TEXT.toLowerCase();
  return online ? EVENT_FORMAT_ONLINE : EVENT_FORMAT_INPERSON;
}

/** True when `format` is the Online format (tolerant of nullish → false = in person). */
function isOnlineFormat(format) {
  return cleanText(format).toLowerCase() === EVENT_FORMAT_ONLINE;
}

// --- Map URL preview state (TM-1063) ----------------------------------------------------------

/**
 * Classify the outcome of a `GET /api/v1/link-preview?url=…` call for the Map URL preview (TM-1063),
 * PURE so the debounced DOM caller in admin-events.js is a thin wrapper. The distinction the ticket
 * turns on: **"broken" means HTTP-unreachable ONLY, not "no OG data"**. Maps consent / interstitial
 * pages are perfectly valid links that carry no OpenGraph metadata, so a reachable-but-title-less
 * response must NOT be flagged broken — only a URL our own endpoint could not fetch is.
 *
 * The signal comes straight from the backend's contract (LinkPreviewService): a malformed / disallowed
 * / internal-address URL yields a NON-2xx (a 400 the endpoint raised — the URL isn't a fetchable
 * http(s) link), while a genuinely reachable URL (rich OG, empty OG, or even a swallowed transport
 * failure) yields a 200. So:
 *   • `ok === false`             → "broken"   (the endpoint rejected the URL as unfetchable)
 *   • 2xx + a title              → "preview"  (draw the card)
 *   • 2xx + no title             → "empty"    (reachable, no rich preview — NOT broken)
 *   • blank URL / nothing to show → "none"    (draw nothing)
 *
 * @param {string} url the Map URL the admin typed (blank → "none").
 * @param {boolean} ok whether the endpoint responded 2xx (false = non-2xx / network error).
 * @param {?object} raw the endpoint JSON body (or null when the call failed / wasn't 2xx).
 * @returns {{state: "none"|"broken"|"empty"|"preview", preview: ?object}}
 */
export function mapUrlPreviewState(url, ok, raw) {
  if (cleanText(url) === "") return { state: "none", preview: null };
  if (!ok) return { state: "broken", preview: null };
  const preview = normalisePreview(raw, url);
  return preview.hasContent ? { state: "preview", preview } : { state: "empty", preview };
}

// --- scheduling preset chips (TM-1064) --------------------------------------------------------
//
// The pure, zone-aware value helpers behind the create/edit form's "preset chips" — one-tap seeds for
// the four datetime fields + the reveal-hours field. Each returns a value in the SAME shape the field
// takes: the datetime helpers return a `<input type="datetime-local">` wall-clock string
// ("YYYY-MM-DDTHH:mm") IN THE EVENT'S timezone (so it round-trips through zonedToUtcIso losslessly and
// passes validateEventDraft), and the reveal chips are just the raw hour numbers. Kept pure (of the DOM)
// so `node --test` can assert the zone maths on a NON-browser zone and across a DST boundary.
//
// Design notes:
//   - "now"-relative chips (Starts, Visible-from Today/Tomorrow) take an optional `now` so tests are
//     deterministic; production passes the real clock. They render `now` into the event zone, so a chip
//     tapped at 23:50 London-time yields a London wall clock, not the browser's.
//   - Offset chips that build on an existing field (Ends = start + Nh, Visible-until = 1h before start,
//     Visible-from N before start) read the CURRENT startAt wall-clock draft and do the arithmetic via
//     the UTC instant (zonedToUtcIso → shift real ms → utcIsoToZoned) so adding "1 hour" stays a real
//     hour across a spring-forward/fall-back edge. They return "" (a harmless no-op) when start is blank.

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;

/** Coerce a Date | number | ISO string to epoch ms, or NaN if unusable. */
function toEpochMs(now) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === "number") return now;
  return new Date(now).getTime();
}

/**
 * A UTC instant (epoch ms) rendered into `timeZone` as a datetime-local wall-clock string, or "" if the
 * instant/zone is unusable. Thin wrapper over {@link utcIsoToZoned} for the epoch-ms callers below.
 */
function epochMsToZoned(ms, timeZone) {
  if (!Number.isFinite(ms)) return "";
  return utcIsoToZoned(new Date(ms).toISOString(), timeZone);
}

/**
 * Shift an existing datetime-local wall-clock value (interpreted in `timeZone`) by `deltaMs` REAL
 * milliseconds and render it back into the same zone. Real-ms (not naive string) arithmetic so "+1h"
 * across a DST boundary lands on the correct wall clock (e.g. spring-forward skips the missing hour).
 * Returns "" for a blank/unparseable value or an invalid zone — a safe no-op for the offset chips.
 * @param {string} localValue "YYYY-MM-DDTHH:mm" in `timeZone`
 * @param {number} deltaMs signed millisecond shift
 * @param {string} timeZone IANA id
 * @returns {string}
 */
export function shiftZonedLocal(localValue, deltaMs, timeZone) {
  const iso = zonedToUtcIso(localValue, timeZone);
  if (!iso) return "";
  return epochMsToZoned(new Date(iso).getTime() + deltaMs, timeZone);
}

/**
 * `now` rounded UP to the next 15-minute boundary, rendered as a datetime-local wall-clock in `timeZone`.
 * Rounding is done on the ABSOLUTE instant (before zoning), so it's independent of the zone's offset —
 * every IANA zone in real use is a whole number of minutes off UTC, so a 15-min-aligned instant is also
 * 15-min-aligned on the wall clock. An already-aligned instant is returned unchanged (ceil is a no-op).
 * @param {string} timeZone IANA id
 * @param {Date|number|string} [now]
 * @returns {string} "YYYY-MM-DDTHH:mm" in `timeZone`, or "" if the zone is invalid.
 */
export function startNow(timeZone, now = Date.now()) {
  const t = toEpochMs(now);
  if (!Number.isFinite(t)) return "";
  const quarter = 15 * MS_PER_MINUTE;
  const rounded = Math.ceil(t / quarter) * quarter;
  return epochMsToZoned(rounded, timeZone);
}

/**
 * Start-time preset chips: **Now** (rounds up to the next 15 min), **in 2h**, **in 4h** — each an
 * absolute instant offset from `now`, rendered into the event zone. "Now" is the rounded base; "+2h"/
 * "+4h" add real hours to that rounded base so they stay quarter-aligned and strictly after "Now".
 * @param {string} timeZone IANA id
 * @param {Date|number|string} [now]
 * @returns {{label: string, value: string}[]}
 */
export function startChips(timeZone, now = Date.now()) {
  const base = startNow(timeZone, now);
  const baseIso = zonedToUtcIso(base, timeZone);
  const baseMs = baseIso ? new Date(baseIso).getTime() : NaN;
  return [
    { label: "Now", value: base },
    { label: "In 2h", value: epochMsToZoned(baseMs + 2 * MS_PER_HOUR, timeZone) },
    { label: "In 4h", value: epochMsToZoned(baseMs + 4 * MS_PER_HOUR, timeZone) },
  ];
}

/**
 * End-time preset chips: **+1h / +2h / +4h** relative to the CURRENT start draft (`startLocal`, a
 * wall-clock string in `timeZone`). Real-hour arithmetic so it's DST-correct. When start is blank/
 * unparseable each value is "" — the caller renders those chips disabled and a tap is a no-op (AC:
 * "Ends +2h with a blank start does nothing harmful").
 * @param {string} startLocal the startAt field's current "YYYY-MM-DDTHH:mm" value (may be "")
 * @param {string} timeZone IANA id
 * @returns {{label: string, value: string}[]}
 */
export function endChips(startLocal, timeZone) {
  return [1, 2, 4].map((h) => ({
    label: `+${h}h`,
    value: shiftZonedLocal(startLocal, h * MS_PER_HOUR, timeZone),
  }));
}

/**
 * Add `days` whole calendar days to a datetime-local value, KEEPING the wall-clock time of day (a
 * date-arithmetic shift, not a real-ms one — "1 day before" means the same clock time the day before,
 * even across a DST change). Returns "" for a blank/unparseable value.
 */
function shiftLocalDays(localValue, days) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(cleanText(localValue));
  if (!m) return "";
  const [, y, mo, d, h, mi] = m;
  // Do the day maths in a UTC calendar (no zone — this is pure Gregorian date arithmetic on the wall
  // clock), then re-stamp the same HH:mm. Using Date.UTC handles month/year rollover for us.
  const shifted = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d) + days));
  if (Number.isNaN(shifted.getTime())) return "";
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(shifted)
    .reduce((acc, x) => ((acc[x.type] = x.value), acc), {});
  return `${p.year}-${p.month}-${p.day}T${h}:${mi}`;
}

/** Today's date in `timeZone` at `hhmm` (default 09:00), as a datetime-local value. */
function todayAt(timeZone, now, hhmm = "09:00") {
  const zonedNow = epochMsToZoned(toEpochMs(now), timeZone);
  if (!zonedNow) return "";
  return `${zonedNow.slice(0, 10)}T${hhmm}`;
}

/**
 * "Visible from" preset chips: **Today**, **Tomorrow** (both at 09:00 local, relative to `now`), and
 * **1 day before** / **1 week before** the START (relative to `startLocal`, keeping the start's time of
 * day). The last two are "" (disabled) when start is blank. All rendered in `timeZone`.
 * @param {string} startLocal the startAt field's current value (may be "")
 * @param {string} timeZone IANA id
 * @param {Date|number|string} [now]
 * @returns {{label: string, value: string}[]}
 */
export function visibleFromChips(startLocal, timeZone, now = Date.now()) {
  const today = todayAt(timeZone, now);
  return [
    { label: "Today", value: today },
    { label: "Tomorrow", value: shiftLocalDays(today, 1) },
    { label: "1 day before", value: shiftLocalDays(startLocal, -1) },
    { label: "1 week before", value: shiftLocalDays(startLocal, -7) },
  ];
}

/**
 * "Visible until" preset chips: **1h before start** — a single chip that tracks the CURRENT start draft
 * (real-hour shift, DST-correct). "" (disabled) when start is blank. This is a chip-only convenience, NOT
 * a create default (blank visibility-end is still required from the admin unless they tap it).
 * @param {string} startLocal the startAt field's current value (may be "")
 * @param {string} timeZone IANA id
 * @returns {{label: string, value: string}[]}
 */
export function visibleUntilChips(startLocal, timeZone) {
  return [{ label: "1h before start", value: shiftZonedLocal(startLocal, -1 * MS_PER_HOUR, timeZone) }];
}

/**
 * Location-reveal-hours preset chips: **1h / 24h** — the two common windows, just the raw hour numbers
 * (the field is a bare number, not a datetime). Both are within [REVEAL_HOURS_MIN, REVEAL_HOURS_MAX].
 * @returns {{label: string, value: string}[]}
 */
export function revealHourChips() {
  return [
    { label: "1h", value: "1" },
    { label: "24h", value: "24" },
  ];
}

// --- collapsed-section value summaries (TM-1196) ----------------------------------------------
//
// One-line VALUE summaries for the collapsible form sections (TM-1195): each COLLAPSED section header
// shows a terse " · "-joined line of its current field values so an admin sees what's inside a fold
// without opening it. DERIVED-DISPLAY ONLY — these read the same draft `readDraft()` produces and never
// touch readDraft / validateEventDraft / buildEventPayload / FORM_FIELDS / section membership. Kept pure
// (of the DOM) here so `node --test` can assert the strings — the DOM caller (admin-events.js) just calls
// each section's `setSummary(...)` (buildFormSection, TM-1186) with the result on every field change.
//
// Design: terse and defaults-aware. A field left at its default reads as a sensible word ("public",
// "no cap", "all ages", "reveal default", "Free"), never "undefined" and never a raw blank. Parts join
// with " · "; a whole summary is never empty (there's always at least the visibility / cutoff word).

/** " · "-join the non-blank parts of a summary (drops empty/nullish parts so no stray separators). */
function joinSummary(parts) {
  return parts.filter((p) => typeof p === "string" && p !== "").join(" · ");
}

/**
 * The "Who can join" collapsed-section summary (TM-1196): visibility + capacity + age band, e.g.
 * "public · cap 20 · 18+" or the all-defaults "public · no cap · all ages". PURE — reads the draft's
 * string fields (visibilityStart/visibilityEnd, capacity, ageMin/ageMax) exactly as they sit on the form.
 *
 *   - visibility: "scheduled" when EITHER visibility bound is set (the event's listing is time-boxed),
 *     else "public" (visible whenever — the pre-window default read).
 *   - capacity: "cap N" for a set capacity, else "no cap" (blank = unlimited, {@link capacityLabel}).
 *   - age band: "N+" (min only), "≤N" (max only), "N-M" (both), or "all ages" (neither) — mirrors the
 *     age-band presets' open/closed reads without inventing bounds.
 *
 * @param {object} draft the raw form values (as {@link readDraft}/{@link toFormModel} produce).
 * @returns {string} a one-line " · "-joined summary (never empty).
 */
export function whoCanJoinSummary(draft = {}) {
  const hasWindow = cleanText(draft.visibilityStart) !== "" || cleanText(draft.visibilityEnd) !== "";
  const visibility = hasWindow ? "scheduled" : "public";

  // parseIntOrNull returns NaN for a present-but-non-integer value (and NaN is a `number`), so use
  // Number.isInteger — a mid-edit "abc"/"1x" reads as the sensible default word, never "cap NaN".
  const cap = parseIntOrNull(draft.capacity);
  const capacity = Number.isInteger(cap) ? `cap ${cap}` : "no cap";

  const ageMin = parseIntOrNull(draft.ageMin);
  const ageMax = parseIntOrNull(draft.ageMax);
  const hasMin = Number.isInteger(ageMin);
  const hasMax = Number.isInteger(ageMax);
  let age;
  if (hasMin && hasMax) age = `${ageMin}-${ageMax}`;
  else if (hasMin) age = `${ageMin}+`;
  else if (hasMax) age = `≤${ageMax}`;
  else age = "all ages";

  return joinSummary([visibility, capacity, age]);
}

/**
 * The "Booking rules" collapsed-section summary (TM-1196): booking cutoff + location reveal + price, e.g.
 * "cutoff 1h · reveal 24h · £5" or the all-defaults "cutoff default · reveal default · Free". PURE —
 * reads the draft's string fields (bookingCutoffHours, locationRevealHours, price) as they sit on the form.
 *
 *   - cutoff: "cutoff Nh" for a set override (0 → "cutoff 0h" = up-to-start, a real value), else
 *     "cutoff default" (blank = inherit — mirrors toFormModel's blank-means-inherit contract).
 *   - reveal: "reveal Nh" for a set value, else "reveal default" (blank = the resolved default applies).
 *   - price: "Free" for 0/blank (the create default is Free, TM-1076), else the £ amount ("£5", "£7.50").
 *
 * @param {object} draft the raw form values (as {@link readDraft}/{@link toFormModel} produce).
 * @returns {string} a one-line " · "-joined summary (never empty).
 */
export function bookingRulesSummary(draft = {}) {
  // Number.isInteger (not `typeof === "number"`) so a present-but-non-integer NaN reads as the default
  // word, never "cutoff NaNh". `0` IS an integer → a real "cutoff 0h" override (accept up to start).
  const cutoff = parseIntOrNull(draft.bookingCutoffHours);
  const cutoffPart = Number.isInteger(cutoff) ? `cutoff ${cutoff}h` : "cutoff default";

  const reveal = parseIntOrNull(draft.locationRevealHours);
  const revealPart = Number.isInteger(reveal) ? `reveal ${reveal}h` : "reveal default";

  // Price → the £ amount, or Free for 0 / blank / unparseable. penceToPounds gives the display amount;
  // poundsToPence normalises the £-string the form carries back to pence so "0"/""/"5" all read right.
  const pence = poundsToPence(draft.price);
  const pricePart =
    typeof pence === "number" && pence > 0 ? `£${penceToPounds(String(pence))}` : "Free";

  return joinSummary([cutoffPart, revealPart, pricePart]);
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
  // Format-conditional (TM-1063) — CLIENT-ONLY view state. Online → the Online URL is the required
  // field and `locationText` is auto-filled "Online" on the wire (so it's NOT demanded here); In person
  // → today's rules (Location required, Online URL optional). The server never sees a `format` field —
  // it only ever sees a satisfied `locationText` (physical text, or "Online").
  const online = isOnlineFormat(draft.format);
  if (online) {
    req("onlineUrl", "Online URL");
  } else {
    req("locationText", "Location");
  }
  // Length caps (mirror @Size) — checked whether or not the field is required.
  if (!errors.heading) maxLen("heading", HEADING_MAX);
  if (!errors.description) maxLen("description", DESCRIPTION_MAX);
  if (!errors.locationText) maxLen("locationText", LOCATION_MAX);
  maxLen("mapUrl", URL_MAX);
  maxLen("onlineUrl", URL_MAX);
  maxLen("city", CITY_MAX);
  // Opening message (TM-710): optional (blank = none); only the length cap applies.
  maxLen("openingMessage", OPENING_MESSAGE_MAX);

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

  // Booking cutoff: optional, integer within [0, 8760] when present (mirrors @Min(0)/@Max, TM-413 exposed
  // by TM-1157). Blank = inherit; 0 = accept RSVPs right up to the start (a valid value, unlike reveal).
  const cutoff = parseIntOrNull(draft.bookingCutoffHours);
  if (Number.isNaN(cutoff)) errors.bookingCutoffHours = "Enter a whole number of hours.";
  else if (cutoff !== null && (cutoff < BOOKING_CUTOFF_HOURS_MIN || cutoff > BOOKING_CUTOFF_HOURS_MAX)) {
    errors.bookingCutoffHours = `Must be between ${BOOKING_CUTOFF_HOURS_MIN} and ${BOOKING_CUTOFF_HOURS_MAX} hours.`;
  }

  // Price (TM-1076): a £ amount → integer pence, @Min(0). Free carries "0"; the presets seed a valid
  // amount; only a Custom hand-typed value can be invalid. poundsToPence returns NaN for a negative or
  // non-numeric amount (a blank Custom is treated as "0"/Free by buildEventPayload, so blank ≠ error).
  const pence = poundsToPence(draft.price);
  if (Number.isNaN(pence)) errors.price = "Enter a price like 5 or 7.50 (0 for free), no negatives.";

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
  // Format-conditional wire shaping (TM-1063), CLIENT-ONLY. For an Online event the physical trio
  // (mapUrl / city / venueId) is not part of the form, and `locationText` is auto-filled "Online" so
  // the server's @NotBlank on the location line is satisfied without a physical address. For In person
  // it's the existing behaviour verbatim. NOTE (TM-734): switching In person→Online on EDIT cannot
  // CLEAR a stale server-side mapUrl over PATCH — buildEventPayload omits blanks and the server reads
  // absent as "leave unchanged" — so a preexisting map URL persists on the wire; the submit handler
  // surfaces the existing TM-734 "can't be cleared here yet" warning rather than pretending it cleared.
  const online = isOnlineFormat(draft.format);
  if (online) {
    const loc = cleanText(draft.locationText);
    body.locationText = loc === "" ? ONLINE_LOCATION_TEXT : loc;
    putText("onlineUrl");
    // mapUrl / city / venueId deliberately NOT written for an Online event.
  } else {
    putText("locationText");
    putText("mapUrl");
    putText("onlineUrl");
    putText("city");
  }
  // Opening message (TM-710): optional group-chat opening message; blank = omitted (no change on PATCH,
  // absent on create). Auto-posted once as an announcement when the event's chat first opens.
  putText("openingMessage");
  // Venue reference (TM-519): the id of a saved venue picked from the library, or omitted for a
  // one-off free-text location. Sent as an integer id; the server validates it exists + is active.
  // Skipped for an Online event (TM-1063) — no physical venue applies.
  if (!online) putInt("venueId");
  if (tz !== "") body.timezone = tz;
  putInstant("startAt");
  putInstant("endAt");
  putInstant("visibilityStart");
  putInstant("visibilityEnd");
  putInt("capacity");
  putInt("locationRevealHours");
  // Booking cutoff (TM-413, exposed by TM-1157): the per-event RSVP-stop override in hours. Blank →
  // parseIntOrNull returns null → putInt OMITS it, so an untouched/blanked cutoff means "inherit" on the
  // wire (NOT `0`). An explicit `0` IS a real value (accept up to start) and is sent verbatim by putInt.
  putInt("bookingCutoffHours");
  // Forward-compatible age band (TM-415) — ignored by the server until that ticket persists them.
  putInt("ageMin");
  putInt("ageMax");
  // Price (TM-1076): ALWAYS send `pricePence` — the whole point of the ticket. An omitted price makes the
  // backend fall back to DEFAULT_PRICE_PENCE = 500 (£5), so a form-created event was silently £5. We send
  // an explicit integer pence (0 for Free) so an event is NEVER silently £5. A blank/invalid £ amount
  // resolves to 0 (Free) rather than being omitted — validation blocks a genuinely invalid Custom amount
  // before submit, so this fallback only ever applies to blank (= Free).
  const pence = poundsToPence(draft.price);
  body.pricePence = typeof pence === "number" && pence >= 0 ? pence : 0;
  return body;
}

/**
 * The optional fields a PATCH can carry — the ones {@link buildEventPayload} OMITS when blank. The
 * backend's PATCH convention (UpdateEventRequest, TM-392) reads a null/absent field as "leave
 * unchanged", so an omitted-because-blank optional is indistinguishable from "untouched": clearing
 * it back to empty is silently a no-op on the wire. This list is what {@link clearedOptionalFields}
 * checks so the submit handler can WARN the admin instead of toasting a false "saved" (TM-734).
 *
 * `timezone`, the required datetimes, and the required text (heading/description/locationText) are
 * deliberately excluded — none is ever cleared to blank (validation blocks it), so they can't
 * silently no-op.
 */
export const CLEARABLE_OPTIONAL_FIELDS = [
  "mapUrl",
  "onlineUrl",
  "city",
  "openingMessage",
  "venueId",
  "endAt",
  "visibilityEnd",
  "capacity",
  "locationRevealHours",
  "bookingCutoffHours",
  "ageMin",
  "ageMax",
];

/**
 * On EDIT, the optional fields the admin has blanked that the PATCH cannot express — i.e. the event
 * carried a value, the draft now leaves it empty, yet {@link buildEventPayload} omits it (so the
 * server keeps the old value). Returns the list of affected field keys (empty on create, or when
 * nothing was actually cleared). The caller uses a non-empty result to warn the admin rather than
 * report a success that didn't happen (TM-734).
 *
 * @param {object} original the EventResponse being edited (omit/empty on create).
 * @param {object} draft the raw form values being submitted.
 * @returns {string[]} the keys of previously-set optionals now blanked but not transmittable.
 */
export function clearedOptionalFields(original, draft = {}) {
  if (!original || typeof original !== "object") return [];
  const before = toFormModel(original);
  const body = buildEventPayload(draft);
  return CLEARABLE_OPTIONAL_FIELDS.filter(
    (key) => cleanText(before[key]) !== "" && !(key in body),
  );
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
    openingMessage: str(event.openingMessage),
    venueId: event.venueId == null ? "" : String(event.venueId),
    timezone: tz,
    startAt: utcIsoToZoned(event.startAt, tz),
    endAt: utcIsoToZoned(event.endAt, tz),
    visibilityStart: utcIsoToZoned(event.visibilityStart, tz),
    visibilityEnd: utcIsoToZoned(event.visibilityEnd, tz),
    capacity: event.capacity == null ? "" : String(event.capacity),
    locationRevealHours: event.locationRevealHours == null ? "" : String(event.locationRevealHours),
    // Booking cutoff (TM-413, exposed by TM-1157): prefill the RAW per-event OVERRIDE (`bookingCutoffHours`),
    // NOT the resolved `effectiveBookingCutoffHours`. An INHERITING event (override == null) must show BLANK
    // — not `0` and not the effective 1 — so re-saving an untouched form keeps it inheriting. `0` is a real
    // override (accept up to start) and comes back as "0". The effective value drives the placeholder only.
    bookingCutoffHours: event.bookingCutoffHours == null ? "" : String(event.bookingCutoffHours),
    ageMin: event.ageMin == null ? "" : String(event.ageMin),
    ageMax: event.ageMax == null ? "" : String(event.ageMax),
    // Price (TM-1076): the saved `pricePence` rendered back into the form's £ amount (0 → "0" = Free). The
    // price control reverse-maps this to a chip (or Custom) via penceToPriceChip. A null/absent price (a
    // legacy response that never carried it) comes back "" — the control then opens on Free by default.
    price: event.pricePence == null ? "" : penceToPounds(event.pricePence),
    imagePath: str(event.imagePath),
    // CLIENT-ONLY format (TM-1063), inferred from the event's own signals (onlineUrl / "Online"
    // locationText) — the backend carries no format field. Seeds the form's In person/Online selector.
    format: formatFromEvent(event),
  };
}

// --- clone / duplicate an event with a time offset (TM-1061) ----------------------------------
//
// Clone/Duplicate (TM-1061, absorbing TM-796) turns ANY source event — past, current, or cancelled —
// into a NEW pre-filled CREATE draft the admin reviews/edits then Saves (nothing is persisted until
// Save; the clone goes through the ordinary create POST). The pure half lives here so the offset
// arithmetic + the past-start warning are unit-testable without a browser (admin-events.js can't be
// imported in Node — a transitive Firebase `https:` import). The DOM half (admin-events.js) prefills
// the form from {@link buildCloneDraft}'s model, seeds the source image as the create form's pending
// upload (so it re-uploads to a DISTINCT `event-images/{newId}` object), and renders the warning.
//
// LOCKED decisions this encodes (TM-1061):
//   - Offset presets ONLY (+7 days / +7 hours) — no free-form offset field (deferred follow-up). The
//     chosen offset shifts startAt/endAt/visibilityStart/visibilityEnd TOGETHER so the whole interval
//     lands later, preserving the gaps between them.
//   - Opening message → BLANK on clone (avoid carrying stale text).
//   - Everything else is copied from the source (heading, description, location, timezone, capacity,
//     price, age band, format signals, …) via {@link toFormModel} — the same model the edit prefill uses.
//   - A shifted start that still lands in the past is ALLOWED but WARNED (non-blocking) so the admin
//     fixes it before Save — no auto-bump, no silent bad data.

const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * The clone time-offset presets (TM-1061) — the ONLY offsets round 1 offers (a custom offset is a
 * deferred follow-up, so there is deliberately NO free-form field). Each is `{ label, ms }`; the chosen
 * offset shifts all four datetime fields by the same REAL millisecond delta. Add/adjust a preset here.
 */
export const CLONE_OFFSET_PRESETS = Object.freeze([
  Object.freeze({ label: "+7 days", ms: 7 * MS_PER_DAY }),
  Object.freeze({ label: "+7 hours", ms: 7 * MS_PER_HOUR }),
]);

/** The four datetime fields a clone offset shifts together (in the event's own timezone). */
const CLONE_SHIFTED_DATETIME_FIELDS = Object.freeze([
  "startAt",
  "endAt",
  "visibilityStart",
  "visibilityEnd",
]);

/**
 * Shift a draft's four datetime fields (startAt/endAt/visibilityStart/visibilityEnd) LATER by `offsetMs`
 * real milliseconds, in the draft's own `timezone` (TM-1061). Uses {@link shiftZonedLocal} per field so a
 * "+7 hours"/"+7 days" shift stays a real span across a DST boundary (the same real-ms arithmetic the
 * scheduling chips use). A blank field stays blank (an open-ended event with no endAt is not invented),
 * and the four move by the SAME delta so the interval between them is preserved. Every other field is
 * copied through untouched. Pure — no DOM. Returns a NEW draft object (the input is not mutated).
 *
 * @param {object} draft a form-model draft (as from {@link toFormModel}) — must carry `timezone`.
 * @param {number} offsetMs the signed millisecond shift (the presets are positive → later).
 * @returns {object} a new draft with the four datetimes shifted, everything else copied.
 */
export function shiftDraftTimes(draft = {}, offsetMs = 0) {
  const tz = cleanText(draft.timezone);
  const shifted = { ...draft };
  const delta = Number(offsetMs);
  if (!Number.isFinite(delta) || delta === 0) return shifted;
  for (const key of CLONE_SHIFTED_DATETIME_FIELDS) {
    const local = cleanText(draft[key]);
    if (local === "") continue; // blank stays blank (never invent an open-ended event's endAt)
    shifted[key] = shiftZonedLocal(local, delta, tz);
  }
  return shifted;
}

/**
 * Build the pre-filled CREATE draft for a clone/duplicate of `event`, with the chosen `offsetMs` applied
 * (TM-1061). Starts from {@link toFormModel} (the SAME model the edit prefill uses, so every field is
 * copied identically), shifts the four datetime fields later by the offset ({@link shiftDraftTimes}), and
 * BLANKS the opening message (the locked decision — stale opening text must not carry over). The source
 * `imagePath` is preserved on the returned draft so the DOM layer can fetch that image and re-upload it as
 * a NEW storage object (a distinct `event-images/{newId}`), never a shared reference. Works for a past,
 * current, OR cancelled source — the clone is a fresh unsaved draft, so the source's status is irrelevant
 * (a cancelled source clones to a normal new event, not a cancelled one). Pure — no DOM.
 *
 * @param {object} event the source EventResponse to clone.
 * @param {number} [offsetMs] the chosen offset (0 = no shift; the presets pass a positive value).
 * @returns {object} the create-form draft (form-model shape) to prefill the clone form from.
 */
export function buildCloneDraft(event = {}, offsetMs = 0) {
  const base = toFormModel(event);
  const shifted = shiftDraftTimes(base, offsetMs);
  // Opening message → BLANK on clone (LOCKED, TM-1061) — never carry stale opening text.
  shifted.openingMessage = "";
  return shifted;
}

/**
 * The non-blocking past-start warning for a clone draft (TM-1061), or "" when the start is present and in
 * the future. A clone whose shifted `startAt` still lands in the past (e.g. +7h on an old event) is ALLOWED
 * — Save isn't blocked — but the admin must SEE that they're about to create an event in the past so they
 * fix the time first (no auto-bump, no silent bad data). This is a distinct VALIDITY NOTE, separate from
 * the required-field errors {@link validateEventDraft} returns (which DO block Save). Compares the draft's
 * local wall-clock `startAt` (interpreted in its timezone) against `now` on the real instant, so it's
 * DST-correct and zone-correct. Returns "" for a blank/unparseable start (that's a required-field error's
 * job, not this warning's). Pure — no DOM.
 *
 * @param {object} draft the form-model draft (must carry `startAt` + `timezone`).
 * @param {Date|number|string} [now] the current instant (defaults to Date.now(); injectable for tests).
 * @returns {string} the warning copy, or "" when the start is in the future / absent / unparseable.
 */
export function pastStartWarning(draft = {}, now = Date.now()) {
  const iso = zonedToUtcIso(draft.startAt, cleanText(draft.timezone));
  if (!iso) return ""; // blank/unparseable start → not this warning's concern (required-field error)
  const startMs = new Date(iso).getTime();
  const nowMs = toEpochMs(now);
  if (!Number.isFinite(startMs) || !Number.isFinite(nowMs)) return "";
  if (startMs >= nowMs) return "";
  return "This event's start time is in the past. Pick a later start (or a bigger offset) before saving,"
    + " or it'll be created already finished.";
}

// --- dirty-guard on exit + Clear/Reset (TM-1101) ----------------------------------------------

/**
 * The form field keys a dirty-check compares (TM-1101) — the values the form actually reads back on save
 * (`readDraft` in admin-events.js) that a {@link toFormModel} baseline can express. `imagePath` is
 * deliberately EXCLUDED: the image control carries its own separate "pending file" state (a picked File is
 * never in the text draft), so image dirtiness is tracked by the DOM layer, not this string compare. All
 * other keys are plain strings on both sides, so equality after {@link cleanText} normalisation is a sound
 * "differs from baseline" test.
 */
export const DIRTY_COMPARE_FIELDS = Object.freeze([
  "heading",
  "description",
  "locationText",
  "mapUrl",
  "onlineUrl",
  "city",
  "openingMessage",
  "venueId",
  "timezone",
  "startAt",
  "endAt",
  "visibilityStart",
  "visibilityEnd",
  "capacity",
  "locationRevealHours",
  "bookingCutoffHours",
  "ageMin",
  "ageMax",
  "price",
  "format",
]);

/**
 * A blank create-form model (TM-1101) — the field values a brand-new event form opens with, so the
 * "Clear all" button on CREATE can reset every field to empty. Every {@link DIRTY_COMPARE_FIELDS} key is
 * "" EXCEPT `format`, which defaults to {@link EVENT_FORMAT_INPERSON} (the create default — a blank format
 * isn't a valid view state). `timezone` is intentionally "" here: the caller re-seeds the browser-guessed
 * zone after a reset the same way {@link buildEventForm}'s create path does (a guessed zone isn't part of
 * the "cleared" baseline — it's a convenience default the form layer applies).
 *
 * @returns {object} the draft a freshly-cleared create form holds.
 */
export function blankFormModel() {
  const model = {};
  for (const key of DIRTY_COMPARE_FIELDS) model[key] = "";
  model.format = EVENT_FORMAT_INPERSON;
  return model;
}

/**
 * Whether the form's CURRENT values differ from its initial baseline (TM-1101) — the dirty check that
 * gates the confirm-on-exit. `draft` is the live `readDraft()` shape; `baseline` is the model the form
 * opened with ({@link toFormModel} of the edited event, or {@link blankFormModel} on create). Compares
 * only {@link DIRTY_COMPARE_FIELDS}, each after {@link cleanText} normalisation, so incidental whitespace
 * or a missing-vs-"" key never reads as dirty. Pure — no DOM — so the exit-gate decision is unit-testable
 * without a browser (admin-events.js can't be imported in Node). Image dirtiness is tracked separately by
 * the DOM layer (a picked File isn't in the text draft); the caller ORs it in.
 *
 * @param {object} draft the current form values (readDraft()).
 * @param {object} baseline the values the form opened with (toFormModel / blankFormModel).
 * @returns {boolean} true when any compared field differs from the baseline.
 */
export function isDirtyDraft(draft = {}, baseline = {}) {
  for (const key of DIRTY_COMPARE_FIELDS) {
    if (cleanText(draft[key]) !== cleanText(baseline[key])) return true;
  }
  return false;
}

// --- display derivations (the list + form read these) -----------------------------------------

/**
 * The admin list's derived status pill. The API's raw status is only PUBLISHED|CANCELLED, but the
 * console lists the FULL inventory — including events whose visibility window hasn't opened yet and
 * ones already over — so it derives the lifecycle the admin actually cares about from status + the
 * window + now. `tone` maps to a badge variant (ok/off/muted/info) in admin-events.js.
 *
 *   CANCELLED                          → Cancelled (off)
 *   finished (see below)               → Finished  (muted)
 *   now ≥ startAt (started, not over)  → Happening (ok)     — the event is live right now (TM-1096)
 *   now < visibilityStart              → Hidden    (info)   — scheduled, not yet public
 *   now > visibilityEnd                → Unlisted  (muted)  — past its listing window, not yet started
 *   otherwise                          → Visible   (ok)     — publicly listed right now
 *
 * "Happening" (TM-1096) sits between Finished and Hidden: an event that has STARTED (now ≥ startAt) but
 * is NOT finished is live, distinct from an upcoming-but-visible event. It's checked after Finished (so
 * an over event never reads Happening) and before the window buckets (so a live event never reads
 * Visible/Unlisted just because of where `now` sits relative to its listing window). The started test
 * mirrors {@link isPastEvent}'s startAt handling: at exactly startAt it's already Happening; at exactly
 * endAt the Finished branch has already claimed it.
 *
 * The "finished" verdict prefers the admin projection's authoritative {@code past} boolean (the
 * server's {@code EventPhasePolicy.isFinished}); only when it's absent (a legacy response) does it
 * fall back to the instants. Crucially, that fallback finishes an event only once {@code now ≥ endAt}
 * — an OPEN-ENDED event (no {@code endAt}) is NOT client-side-finished at its start (TM-727): the
 * server runs such an event for an assumed default duration, and the member UI
 * ({@code events-core.isFinished}) likewise never client-side-finishes an open-ended event, so this
 * keeps the admin pill in lock-step with both rather than flipping to "Finished" the instant it begins.
 *
 * @param {object} event an EventResponse.
 * @param {Date|number|string} [now]
 * @returns {{label: string, tone: "ok"|"off"|"muted"|"info"}}
 */
export function eventLifecycle(event = {}, now = Date.now()) {
  if (String(event.status).toUpperCase() === "CANCELLED") return { label: "Cancelled", tone: "off" };
  const t = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const visStart = new Date(event.visibilityStart).getTime();
  const visEnd = new Date(event.visibilityEnd).getTime();
  // Finished: trust the server's `past` flag when present; else fall back to endAt ONLY (a null endAt =
  // open-ended = not client-side finished, matching the member UI + server assumed-duration rule).
  const finished =
    typeof event.past === "boolean"
      ? event.past
      : event.endAt != null && Number.isFinite(new Date(event.endAt).getTime()) && t >= new Date(event.endAt).getTime();
  if (finished) return { label: "Finished", tone: "muted" };
  // Happening (TM-1096): started (now ≥ startAt) and not finished ⇒ live right now. `>=` so exactly at
  // startAt reads Happening; the Finished branch above already claimed anything at/after its end.
  const startAt = new Date(event.startAt).getTime();
  if (Number.isFinite(startAt) && t >= startAt) return { label: "Happening", tone: "ok" };
  if (Number.isFinite(visStart) && t < visStart) return { label: "Hidden", tone: "info" };
  if (Number.isFinite(visEnd) && t > visEnd) return { label: "Unlisted", tone: "muted" };
  return { label: "Visible", tone: "ok" };
}

/**
 * Has this event already ENDED (TM-518)? The authoritative signal is the admin projection's own
 * {@code past} boolean (EventResponse.past, the server's EventPhasePolicy.isFinished verdict), so this
 * prefers it whenever it's a boolean — that keeps the console's "Past events" grouping and its
 * hidden/disabled edit + cancel controls in lock-step with the server-side edit/cancel reject, so the
 * two can never disagree. It falls back to deriving from the instants (ended once now ≥ endAt, or ≥
 * startAt for an open-ended event with no endAt) only for a response that predates the flag — a plain
 * backstop, never the primary path. Never throws.
 *
 * @param {object} event an EventResponse.
 * @param {Date|number|string} [now]
 * @returns {boolean}
 */
export function isPastEvent(event = {}, now = Date.now()) {
  if (typeof event.past === "boolean") return event.past;
  const t = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const startMs = new Date(event.startAt).getTime();
  const endMs = event.endAt ? new Date(event.endAt).getTime() : startMs;
  return Number.isFinite(endMs) && Number.isFinite(t) && t >= endMs;
}

/**
 * Partition an already-sorted event list into active vs past (TM-518), PRESERVING the incoming order
 * within each group — the admin list renders active rows first, then the "Past events" section at the
 * bottom, so it stably concatenates {@code [...upcoming, ...past]} and drops a divider at the seam.
 * A stable partition (not a re-sort) so the admin's chosen column sort still holds inside each group.
 *
 * @param {object[]} events EventResponses, already in the admin's chosen sort order.
 * @param {Date|number|string} [now]
 * @returns {{upcoming: object[], past: object[]}}
 */
export function partitionEventsByPast(events = [], now = Date.now()) {
  const list = Array.isArray(events) ? events : [];
  const upcoming = [];
  const past = [];
  for (const e of list) (isPastEvent(e, now) ? past : upcoming).push(e);
  return { upcoming, past };
}

/**
 * Whether an event matches the admin list's status filter (TM-965). The filter values are the DERIVED
 * lifecycle labels {@link eventLifecycle} emits (Visible / Hidden / Finished / Cancelled / Unlisted),
 * plus the sentinel "ALL" which matches everything. Pure so it can be unit-tested without the DOM —
 * the admin-events.js filter is a thin wrapper over this. Crucially it covers "Unlisted": before TM-965
 * the console had no Unlisted option, so an unlisted event (past its visibility window but not yet
 * started) matched no non-ALL filter and silently vanished from every filtered view.
 *
 * @param {object} event an EventResponse.
 * @param {string} filter one of the STATUS_FILTERS values (a lifecycle label, or "ALL").
 * @param {Date|number|string} [now]
 * @returns {boolean}
 */
export function matchesStatusFilter(event, filter, now = Date.now()) {
  if (!filter || filter === "ALL") return true;
  return eventLifecycle(event, now).label === filter;
}

/**
 * The admin list's lifecycle filter chips (TM-1096). Each chip is one lifecycle bucket the admin thinks
 * in: its `key` is the {@link eventLifecycle} label it matches, and `label` is the chip's copy. The
 * dropdown this replaced only offered a single label; chips are multi-select, so the console keeps a
 * Set of selected keys instead of one string.
 *
 * TM-1110 relabel: the admin's real "upcoming" events are PUBLISHED + not-yet-started — those carry the
 * "Visible" lifecycle label, so the **Visible** bucket is the "Upcoming" chip. The **Hidden** lifecycle
 * (published but not yet inside its public visibility window = not visible to anyone yet) gets the honest
 * "Scheduled" chip. (Before TM-1110 the "Upcoming" chip was wired to Hidden, which is ~always empty, so
 * it mislabelled the truly-upcoming events under a chip literally reading "Visible".)
 *
 * Order = the natural lifecycle reading order (live → upcoming → gone): Happening now · Upcoming
 * (Visible) · Scheduled (Hidden) · Unlisted · Finished · Cancelled.
 */
export const LIFECYCLE_FILTERS = [
  ["Happening", "Happening now"],
  ["Visible", "Upcoming"],
  ["Hidden", "Scheduled"],
  ["Unlisted", "Unlisted"],
  ["Finished", "Finished"],
  ["Cancelled", "Cancelled"],
];

/**
 * Whether an event matches the admin list's lifecycle-chip selection (TM-1096). `selected` is the Set
 * (or array) of chosen lifecycle labels; an event matches when its derived {@link eventLifecycle} label
 * is in the set. An EMPTY (or missing) selection matches EVERYTHING — clearing the chips shows all, and
 * a no-chips-selected state is never an empty table. Pure, so the admin-events.js chip row is a thin
 * wrapper over it and the filter core is unit-testable without the DOM.
 *
 * @param {object} event an EventResponse.
 * @param {Set<string>|string[]|null|undefined} selected the chosen lifecycle labels (empty = all).
 * @param {Date|number|string} [now]
 * @returns {boolean}
 */
export function matchesLifecycleFilter(event, selected, now = Date.now()) {
  const set = selected instanceof Set ? selected : new Set(Array.isArray(selected) ? selected : []);
  if (set.size === 0) return true; // empty selection ⇒ show all
  return set.has(eventLifecycle(event, now).label);
}

/** "Unlimited" when capacity is null/absent, otherwise the number as a string (blank = unlimited). */
export function capacityLabel(capacity) {
  return capacity == null || capacity === "" ? "Unlimited" : String(capacity);
}

/**
 * Derive the admin roster's capacity state (TM-592) — the browser-side MIRROR of the backend's
 * {@code CapacityAdjustResult.of}, so the console can render the over-capacity warning without a
 * round-trip and stays in lock-step with what the server returns. Every derived figure clamps at
 * {@code >= 0}: {@code freeSpots} is never negative even while the event sits over cap.
 *
 * <p>Per the owner decision, lowering capacity below the current GOING count is ALLOWED — no confirmed
 * attendee is auto-evicted — so a positive {@code overCapacityBy} is a normal, non-error state the admin
 * is simply warned about.
 *
 * @param {?number} capacity the (proposed) capacity; null/""/undefined = unlimited (no ceiling)
 * @param {number}  going    the current committed (GOING) count
 * @returns {{capacity: ?number, going: number, freeSpots: ?number, overCapacityBy: number, isOverCapacity: boolean}}
 */
export function overCapacityState(capacity, going) {
  const g = Number.isFinite(Number(going)) ? Math.max(0, Number(going)) : 0;
  const unlimited = capacity == null || capacity === "";
  const cap = unlimited ? null : Number(capacity);
  if (unlimited || !Number.isFinite(cap)) {
    return { capacity: null, going: g, freeSpots: null, overCapacityBy: 0, isOverCapacity: false };
  }
  const freeSpots = Math.max(0, cap - g); // clamp >= 0 — never negative even when over cap
  const overCapacityBy = Math.max(0, g - cap);
  return { capacity: cap, going: g, freeSpots, overCapacityBy, isOverCapacity: overCapacityBy > 0 };
}

/**
 * The admin-facing over-capacity warning line (TM-592), or "" when the event is at/under cap or
 * unlimited. Reads a {@link overCapacityState} shape (or a server {@code CapacityAdjustResponse}, which
 * carries the same fields). Honest about the decided behaviour: attendees are NOT removed; the event
 * sits over cap and no new GOING joins land until attendance drops under the limit.
 *
 * @param {{overCapacityBy?: number, capacity?: ?number}} state
 * @returns {string}
 */
export function overCapacityWarning(state = {}) {
  const over = Number(state.overCapacityBy) || 0;
  if (over <= 0) return "";
  const who = over === 1 ? "1 attendee is" : `${over} attendees are`;
  const cap = state.capacity == null ? "the new limit" : `the new limit of ${state.capacity}`;
  return `${who} over ${cap}. No one is removed — the event stays over capacity and no new "going" joins`
    + " land until attendance drops back under the limit.";
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
 * The EFFECTIVE booking-cutoff hours to show as the form field's placeholder/helper (TM-1157) — what
 * actually applies when the per-event override is left BLANK. Prefers the EventResponse's resolved
 * `effectiveBookingCutoffHours` (server = override → per-city → app default), falling back to
 * {@link BOOKING_CUTOFF_DEFAULT_HOURS} (1) on create or when the response doesn't carry a resolved value.
 * Read defensively so a bad/absent value can never render `NaN` in the placeholder. Pure.
 *
 * @param {object} [event] an EventResponse (omit/empty on create).
 * @returns {number} the effective cutoff hours (≥ 0), defaulting to the app default (1).
 */
export function effectiveBookingCutoffHours(event = {}) {
  const hours = Number(event && event.effectiveBookingCutoffHours);
  return Number.isFinite(hours) && hours >= 0 ? hours : BOOKING_CUTOFF_DEFAULT_HOURS;
}

/**
 * A one-line summary of when this event stops accepting RSVPs (TM-413, exposed by TM-1157), read off the
 * EventResponse's resolved cutoff fields: `effectiveBookingCutoffHours` (what actually applies after the
 * override → city → app-default resolution) and whether `bookingCutoffHours` (the per-event override) is
 * set. Says where the effective value came from so the admin understands a blank override still has an
 * effect. `0` reads as "right up to the start". Returns "" when the response carries no resolved value.
 *
 * @param {object} event an EventResponse.
 * @returns {string}
 */
export function bookingCutoffSummary(event = {}) {
  const hours = Number(event.effectiveBookingCutoffHours);
  if (!Number.isFinite(hours)) return "";
  const source = event.bookingCutoffHours == null ? "the city / app default" : "this event's override";
  if (hours === 0) return `RSVPs are accepted right up to the start (from ${source}).`;
  return `RSVPs stop ${hours} ${hours === 1 ? "hour" : "hours"} before the start (from ${source}).`;
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

// --- recurrence: the "Repeat" picker → CreateSeriesRequest (TM-796, recurring events v1 TRIM) ------
//
// The pure half of the create-form's Repeat control (admin-events.js is the DOM half). When Repeat is ON
// the form becomes a RECURRING SERIES: the normal event fields become the template, the first occurrence's
// startAt/endAt/visibility become the series ANCHOR (firstStartAt/firstEndAt/firstVisibilityStart/
// firstVisibilityEnd), and a small recurrence rule (frequency + interval + weekday + end condition) rides
// alongside. On submit we POST a `CreateSeriesRequest` (backend/…/api/CreateSeriesRequest.java, TM-795) to
// POST /api/v1/admin/events/series instead of the single-create POST.
//
// v1 THIN CUT (matches the backend engine + DTO exactly):
//   - frequency ∈ {DAILY, WEEKLY} ONLY — no MONTHLY (the enum has just these two; an unknown cadence is a
//     clean 400). WEEKLY pins to a SINGLE weekday (no multi-weekday).
//   - interval ≥ 1 (@Min(1)).
//   - end = EXACTLY ONE of untilDate (a local calendar date "YYYY-MM-DD") or afterN (an integer ≥ 1) —
//     both or neither is a 400 (RecurrenceRule's invariant).
//   - byWeekday required for WEEKLY, omitted for DAILY, and (WEEKLY) must equal the weekday firstStartAt
//     falls on in the chosen timezone — else the engine refuses to realign and the API 400s.
//   - firstStartAt must be in the future; the first-occurrence window must bracket the start.
//
// buildSeriesPayload + validateSeriesDraft mirror those edges so the admin gets INLINE errors before the
// request is sent (the API re-checks authoritatively). Kept pure (of the DOM) so `node --test` asserts them.

/** The two recurrence frequencies v1 supports (TM-796) — the backend SeriesFrequency enum's whole set. */
export const SERIES_FREQ_DAILY = "DAILY";
export const SERIES_FREQ_WEEKLY = "WEEKLY";

/** The recurrence frequencies offered by the Repeat picker, `[value, label]`, in display order. */
export const SERIES_FREQUENCIES = Object.freeze([
  Object.freeze([SERIES_FREQ_DAILY, "Daily"]),
  Object.freeze([SERIES_FREQ_WEEKLY, "Weekly"]),
]);

/** The two end-condition modes the picker offers (exactly one is active). */
export const SERIES_END_UNTIL = "until";
export const SERIES_END_AFTER = "after";

/**
 * The ISO weekdays (Monday-first), each `{ value, label }` where `value` is the UPPERCASE `DayOfWeek`
 * name the API binds (`"MONDAY"`…`"SUNDAY"`, TM-795 wire format) and `label` is the display copy. The
 * weekday <select> the WEEKLY picker shows is built from this; `weekdayOfLocal` maps a start date onto
 * the matching `value` so the field defaults to the start's own weekday. Frozen — the single source.
 */
export const SERIES_WEEKDAYS = Object.freeze([
  Object.freeze({ value: "MONDAY", label: "Monday" }),
  Object.freeze({ value: "TUESDAY", label: "Tuesday" }),
  Object.freeze({ value: "WEDNESDAY", label: "Wednesday" }),
  Object.freeze({ value: "THURSDAY", label: "Thursday" }),
  Object.freeze({ value: "FRIDAY", label: "Friday" }),
  Object.freeze({ value: "SATURDAY", label: "Saturday" }),
  Object.freeze({ value: "SUNDAY", label: "Sunday" }),
]);

/** The set of valid `DayOfWeek` wire values, for fast membership checks. */
const SERIES_WEEKDAY_VALUES = new Set(SERIES_WEEKDAYS.map((d) => d.value));

/** Default recurrence interval — every 1 day/week (@Min(1)). */
export const SERIES_INTERVAL_MIN = 1;

/**
 * The UPPERCASE `DayOfWeek` name a `<input type="datetime-local">` wall-clock value falls on (TM-796) —
 * used to DEFAULT the WEEKLY picker's weekday to the chosen start date's own weekday, and to cross-check
 * that a hand-picked weekday still matches the start (the API's `isByWeekdayMatchingFirstStart` edge).
 * The value is a bare calendar date in the event's own zone ("YYYY-MM-DDThh:mm" holds that date directly),
 * so the weekday is a pure Gregorian calendar fact — computed via a UTC `Date` to avoid the host zone
 * shifting the day. Returns "" for a blank/unparseable value. Pure — no DOM.
 *
 * @param {string} localValue the startAt field's "YYYY-MM-DDTHH:mm" value (in the event's timezone).
 * @returns {string} a `SERIES_WEEKDAYS` value ("MONDAY"…"SUNDAY"), or "" when the date is absent/bad.
 */
export function weekdayOfLocal(localValue) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}/.exec(cleanText(localValue));
  if (!m) return "";
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (Number.isNaN(date.getTime())) return "";
  // getUTCDay(): 0 = Sunday … 6 = Saturday. Map onto the Monday-first SERIES_WEEKDAYS order.
  const MON_FIRST = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
  return MON_FIRST[date.getUTCDay()] || "";
}

/** The local calendar DATE ("YYYY-MM-DD") of a datetime-local value, or "" — the untilDate wire shape. */
function localDateOf(localValue) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}/.exec(cleanText(localValue));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

/**
 * Validate a RECURRING create draft against the SAME edges the series API enforces (CreateSeriesRequest,
 * TM-795) so the admin gets inline recurrence errors before the POST. This layers the recurrence rule on
 * top of the ordinary event validation: call {@link validateEventDraft} for the template/anchor fields
 * (heading/description/location/timezone/instants/window ordering/…) AND this for the recurrence knobs.
 * Returns a per-field error map (keyed by the recurrence field ids: `frequency`, `interval`, `byWeekday`,
 * `endMode`, `untilDate`, `afterN`) plus `canSave` (no recurrence field in error). The rules mirror the
 * DTO's `@AssertTrue`/`@Min` cross-field checks:
 *   - interval an integer ≥ 1;
 *   - EXACTLY ONE end condition — the active `endMode` supplies untilDate XOR afterN, and that value must
 *     be present + valid (a future-ish date / an integer ≥ 1);
 *   - WEEKLY requires a byWeekday that MATCHES the start's weekday (DAILY forbids one — the DOM only shows
 *     the weekday field for WEEKLY, but we still reject a stray DAILY weekday for parity).
 * The instant/future-start/window checks stay in {@link validateEventDraft}; this only owns the rule.
 *
 * @param {object} draft the raw recurrence + start values (all strings): `frequency`, `interval`,
 *   `byWeekday`, `endMode` ("until"|"after"), `untilDate`, `afterN`, `startAt` (to cross-check weekday +
 *   the future-start rule), and `timezone` (to resolve startAt's absolute instant for the future check).
 * @param {object} [opts]
 * @param {Date|number|string} [opts.now] the clock the future-start check compares against (default
 *   `Date.now()`; injectable so tests are deterministic — mirrors the scheduling-chip helpers).
 * @returns {{errors: Record<string,string>, canSave: boolean}}
 */
export function validateSeriesDraft(draft = {}, { now = Date.now() } = {}) {
  const errors = {};
  const frequency = cleanText(draft.frequency).toUpperCase();

  // Frequency — DAILY or WEEKLY only.
  if (frequency !== SERIES_FREQ_DAILY && frequency !== SERIES_FREQ_WEEKLY) {
    errors.frequency = "Choose Daily or Weekly.";
  }

  // Interval — integer ≥ 1.
  const interval = parseIntOrNull(draft.interval);
  if (Number.isNaN(interval)) errors.interval = "Enter a whole number.";
  else if (interval === null || interval < SERIES_INTERVAL_MIN) errors.interval = `Must be ${SERIES_INTERVAL_MIN} or more.`;

  // Weekday — required for WEEKLY, must match the start's weekday; forbidden for DAILY.
  const weekday = cleanText(draft.byWeekday).toUpperCase();
  if (frequency === SERIES_FREQ_WEEKLY) {
    if (weekday === "") {
      errors.byWeekday = "Pick a weekday.";
    } else if (!SERIES_WEEKDAY_VALUES.has(weekday)) {
      errors.byWeekday = "Pick a valid weekday.";
    } else {
      const startWeekday = weekdayOfLocal(draft.startAt);
      if (startWeekday !== "" && startWeekday !== weekday) {
        errors.byWeekday = "The weekday must match the start date's day.";
      }
    }
  } else if (frequency === SERIES_FREQ_DAILY && weekday !== "") {
    // The DOM hides the weekday for Daily, but reject a stray value for parity with the API edge.
    errors.byWeekday = "A weekday only applies to a weekly series.";
  }

  // End condition — EXACTLY ONE of untilDate / afterN, chosen by endMode, present + valid.
  const endMode = cleanText(draft.endMode);
  if (endMode === SERIES_END_UNTIL) {
    const until = localDateOf(draft.untilDate) || cleanText(draft.untilDate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) errors.untilDate = "Pick an end date.";
  } else if (endMode === SERIES_END_AFTER) {
    const afterN = parseIntOrNull(draft.afterN);
    if (Number.isNaN(afterN)) errors.afterN = "Enter a whole number.";
    else if (afterN === null || afterN < 1) errors.afterN = "Must be 1 or more occurrences.";
  } else {
    errors.endMode = "Choose how the series ends.";
  }

  // Future start (TM-1183 item 8): the series anchor `firstStartAt` must be in the FUTURE — the server
  // 400s a past anchor (CreateSeriesRequest.isFirstStartInFuture). We mirror it client-side so the admin
  // sees it inline before the POST rather than as a raw server 400. The startAt is a wall-clock in the
  // event's own zone → resolve it to an absolute instant via zonedToUtcIso and compare to `now`. Only
  // checked when a start + a real zone are present (validateEventDraft owns the "start required" edge);
  // an unparseable start/zone just skips this rule (that field's own error already blocks Save).
  const startInstant = zonedToUtcIso(draft.startAt, cleanText(draft.timezone));
  if (startInstant && Date.parse(startInstant) <= toEpochMs(now)) {
    errors.startAt = "The first occurrence must start in the future.";
  }

  return { errors, canSave: Object.keys(errors).length === 0 };
}

/**
 * The event-payload keys the series DTO (`CreateSeriesRequest`, TM-795) does NOT read — the "non-template"
 * fields. {@link buildEventPayload} emits these for a single event, but the series template has NO column
 * for them, so an occurrence materialised by the series engine would carry NONE of them (worst case: an
 * Online series whose occurrences have `onlineUrl=null` — no join link). We STRIP them from the series body
 * EXPLICITLY (TM-1184) rather than relying on Jackson to silently drop unknown fields. The create form also
 * hides/disables these when Repeat is ON (and prevents the Online+Repeat combo), but stripping here is the
 * load-bearing guarantee that they never ride the series wire regardless of what the form sent.
 */
export const SERIES_NON_TEMPLATE_KEYS = Object.freeze(["onlineUrl", "mapUrl", "openingMessage", "ageMin", "ageMax"]);

/**
 * Turn a validated RECURRING draft into the `CreateSeriesRequest` body (TM-795) the series API accepts —
 * the recurrence rule + the first-occurrence anchor + the template snapshot, all in ONE object. It REUSES
 * {@link buildEventPayload} for the template + instant fields (so the template stays 1:1 with the single-
 * create body — heading/description/location/timezone/capacity/reveal/cutoff/price/venue and the UTC
 * instants), then RE-KEYS the four instant fields onto the DTO's `first*` anchor names and appends the
 * recurrence rule. The end condition is EXACTLY ONE of untilDate / afterN (per `endMode`); the other is
 * omitted. `byWeekday` is sent (uppercase `DayOfWeek` name) only for WEEKLY. The non-template keys the
 * series DTO doesn't read ({@link SERIES_NON_TEMPLATE_KEYS}) are STRIPPED explicitly. Pure — no DOM, no fetch.
 *
 * Wire shape (CreateSeriesRequest):
 *   frequency, interval, [byWeekday], (untilDate XOR afterN), timezone,
 *   firstStartAt, [firstEndAt], firstVisibilityStart, firstVisibilityEnd,
 *   + the template fields (heading, description, locationText, city?, venueId?, capacity?, imagePath?,
 *     locationRevealHours?, bookingCutoffHours?, cancellationWindowHours?, pricePence?, premium?).
 *
 * @param {object} draft the raw form values (template + start/window + recurrence knobs).
 * @returns {object} the CreateSeriesRequest body.
 */
export function buildSeriesPayload(draft = {}) {
  // The template + instants come from the ordinary event payload, so the template is identical to a single
  // create. We then move the event's absolute instants onto the series anchor's `first*` field names.
  const base = buildEventPayload(draft);
  const body = {};

  // Recurrence rule.
  const frequency = cleanText(draft.frequency).toUpperCase();
  body.frequency = frequency === SERIES_FREQ_WEEKLY ? SERIES_FREQ_WEEKLY : SERIES_FREQ_DAILY;
  const interval = parseIntOrNull(draft.interval);
  body.interval = typeof interval === "number" && interval >= SERIES_INTERVAL_MIN ? interval : SERIES_INTERVAL_MIN;
  if (body.frequency === SERIES_FREQ_WEEKLY) {
    const weekday = cleanText(draft.byWeekday).toUpperCase();
    if (SERIES_WEEKDAY_VALUES.has(weekday)) body.byWeekday = weekday;
  }
  // End condition — EXACTLY ONE (the other is deliberately absent, the DTO's XOR invariant).
  const endMode = cleanText(draft.endMode);
  if (endMode === SERIES_END_AFTER) {
    const afterN = parseIntOrNull(draft.afterN);
    if (typeof afterN === "number" && afterN >= 1) body.afterN = afterN;
  } else {
    const until = localDateOf(draft.untilDate) || cleanText(draft.untilDate);
    if (/^\d{4}-\d{2}-\d{2}$/.test(until)) body.untilDate = until;
  }

  // Timezone (verbatim from the base payload).
  if (base.timezone != null) body.timezone = base.timezone;

  // First-occurrence anchor — the event's own instants re-keyed onto the DTO's `first*` names.
  if (base.startAt != null) body.firstStartAt = base.startAt;
  if (base.endAt != null) body.firstEndAt = base.endAt;
  if (base.visibilityStart != null) body.firstVisibilityStart = base.visibilityStart;
  if (base.visibilityEnd != null) body.firstVisibilityEnd = base.visibilityEnd;

  // Template snapshot — every field the base payload carried that IS a series-template column (heading,
  // description, locationText, city, venueId, capacity, locationRevealHours, bookingCutoffHours, pricePence).
  // We SKIP two groups: the instant/timezone fields (ANCHOR_KEYS — re-keyed onto first*/timezone above) AND
  // the non-template keys the series DTO has no column for (SERIES_NON_TEMPLATE_KEYS — onlineUrl/mapUrl/
  // openingMessage/ageMin/ageMax). Stripping the latter EXPLICITLY (TM-1184) is what stops an Online series
  // from materialising occurrences with no join link; we do NOT lean on the server dropping unknown fields.
  const SKIP_KEYS = new Set(["timezone", "startAt", "endAt", "visibilityStart", "visibilityEnd", ...SERIES_NON_TEMPLATE_KEYS]);
  for (const [key, value] of Object.entries(base)) {
    if (!SKIP_KEYS.has(key)) body[key] = value;
  }

  return body;
}

// --- Start→End duration preservation (TM-1208) --------------------------------------------------
//
// When the admin moves the event Start, the End should slide with it to keep the event's length —
// otherwise pushing Start later strands End before Start (an invalid event the admin must hand-fix).
// This is the standard calendar-app behaviour. Pure + display-only: it only proposes a new End string
// from the datetime-local wall-clock values; it never touches readDraft / validate / payload.
//
// Values are `<input type="datetime-local">` strings ("YYYY-MM-DDTHH:mm", no zone). We parse both
// endpoints via Date.UTC (treating the wall clock AS UTC) so the delta is pure wall-clock minutes —
// DST-agnostic, and independent of the runtime's local timezone. Preserving the WALL-CLOCK length is
// what an admin expects (18:30–20:30 is "2 hours" regardless of any real zone/DST).

/** Parse a datetime-local "YYYY-MM-DDTHH:mm[:ss]" as a wall-clock epoch (via Date.UTC). null if unparseable. */
function parseLocalWallClock(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(value || ""));
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
}

/** Format a wall-clock epoch (from Date.UTC) back to a datetime-local "YYYY-MM-DDTHH:mm" string. */
function formatLocalWallClock(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/**
 * Given the PREVIOUS Start, the NEW Start, and the CURRENT End (all datetime-local strings), return the
 * End shifted by the same delta as Start so the event's wall-clock length is preserved — or `null` when
 * there's nothing to do:
 *   - End is blank / unparseable (End is optional — never invent one),
 *   - either Start is blank / unparseable (no delta to apply),
 *   - Start didn't actually move,
 *   - the current End is not strictly after the previous Start (no positive duration to preserve — leave
 *     an already-invalid or zero-length End alone rather than shifting it further).
 * @param {string} prevStart  the Start value BEFORE this change ("YYYY-MM-DDTHH:mm")
 * @param {string} newStart   the Start value AFTER this change
 * @param {string} currentEnd the End value right now
 * @returns {string|null} the new End string, or null for "leave End as-is"
 */
export function shiftEndPreservingDuration(prevStart, newStart, currentEnd) {
  const ps = parseLocalWallClock(prevStart);
  const ns = parseLocalWallClock(newStart);
  const ce = parseLocalWallClock(currentEnd);
  if (ps === null || ns === null || ce === null) return null;
  if (ns === ps) return null; // Start didn't move
  const durationMs = ce - ps;
  if (durationMs <= 0) return null; // no positive duration to preserve
  return formatLocalWallClock(ns + durationMs);
}
