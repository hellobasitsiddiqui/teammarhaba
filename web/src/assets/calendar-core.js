// Pure, framework-free generators for the events "Add to calendar" control (TM-398) — no DOM, no
// fetch, and no browser globals at module scope, so Node's test runner imports it directly (mirrors
// events-core.js; covered by `node --test web/tools/*.test.mjs` on the PR gate). ONE web
// implementation, so the same output is used on web, mobile-web, the Android WebView and iOS.
//
// Three destinations from one event detail:
//   • Apple/iOS + generic → a downloadable .ics (RFC 5545 VCALENDAR/VEVENT). Times are
//     UTC-normalised (a trailing `Z`), so DST is intrinsic: an absolute instant needs no VTIMEZONE
//     and a summer 17:00Z vs a winter 18:00Z both resolve to the right wall-clock in any calendar app.
//   • Google Calendar → the `render?action=TEMPLATE` URL.
//   • Outlook → the `deeplink/compose` URL (consumer host by default).
//
// Reveal-aware (TM-408): the location is taken from events-core.locationView(), so the EXACT venue is
// never written into a calendar entry before it is revealed — only the approximate city (or nothing)
// leaves the app pre-reveal, matching exactly what the detail page itself shows.

import { locationView } from "./events-core.js";

const DEFAULT_DURATION_MS = 2 * 60 * 60 * 1000; // 2h fallback when an event has no explicit end.
const PRODID = "-//TeamMarhaba//Events//EN";

// ------------------------------------------------------------------ time helpers

/** Parse a Date | number | ISO string to epoch-ms, or NaN. */
function toMs(value) {
  if (value == null) return NaN;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return Date.parse(value);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * iCalendar UTC timestamp for an instant: `YYYYMMDDTHHMMSSZ` (RFC 5545 §3.3.5 UTC form). Because the
 * input is an absolute instant, the emitted value is DST-correct by construction. Returns "" if the
 * input is missing / unparseable (so a caller never emits `DTSTART:InvalidZ`).
 */
export function toIcsUtc(value) {
  const ms = toMs(value);
  if (Number.isNaN(ms)) return "";
  const d = new Date(ms);
  return (
    String(d.getUTCFullYear()).padStart(4, "0") +
    pad2(d.getUTCMonth() + 1) +
    pad2(d.getUTCDate()) +
    "T" +
    pad2(d.getUTCHours()) +
    pad2(d.getUTCMinutes()) +
    pad2(d.getUTCSeconds()) +
    "Z"
  );
}

/** ISO-8601 UTC without milliseconds: `YYYY-MM-DDTHH:MM:SSZ` (the Outlook deeplink form). "" if invalid. */
export function toIsoUtc(value) {
  const ms = toMs(value);
  if (Number.isNaN(ms)) return "";
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ------------------------------------------------------------------ iCalendar text encoding

/**
 * Escape a TEXT value per RFC 5545 §3.3.11: backslash, semicolon and comma are backslash-escaped and
 * any CR/LF newline becomes a literal `\n`. (Colon / equals need no escaping inside a value.)
 */
export function icsEscape(text) {
  return String(text ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

function utf8Bytes(str) {
  return new TextEncoder().encode(str);
}

/**
 * Fold one content line to ≤ `limit` octets, continuing with CRLF + a single leading space
 * (RFC 5545 §3.1). Folding is octet-aware (UTF-8) and never splits a multi-byte character. Lines that
 * already fit are returned unchanged.
 */
export function foldLine(line, limit = 75) {
  const bytes = utf8Bytes(line);
  if (bytes.length <= limit) return line;
  const decoder = new TextDecoder();
  const out = [];
  let start = 0;
  let first = true;
  while (start < bytes.length) {
    // Continuation lines carry one leading space, so they get one fewer content octet.
    const budget = first ? limit : limit - 1;
    let end = Math.min(start + budget, bytes.length);
    // Never cut inside a UTF-8 sequence: back off while the next byte is a continuation byte (10xxxxxx).
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    out.push((first ? "" : " ") + decoder.decode(bytes.slice(start, end)));
    start = end;
    first = false;
  }
  return out.join("\r\n");
}

// ------------------------------------------------------------------ the calendar-event descriptor

/**
 * Build a neutral, reveal-safe calendar descriptor from an event detail. The location comes from
 * events-core.locationView(), so the exact venue is withheld until reveal (TM-408): pre-reveal only
 * the approximate city (or nothing) is used, never the precise address / map / online link.
 *
 * @param {object} detail  event detail (heading, description, startAt, endAt, timezone, city, …)
 * @param {number} [nowMs] clock for the reveal check (defaults to Date.now())
 * @param {{url?: string}} [opts] optional public URL of the event, appended to the description
 * @returns {{id:string, title:string, start:number|null, end:number|null, location:string,
 *            description:string, url:string}}
 */
export function calendarEventFromDetail(detail, nowMs = Date.now(), { url } = {}) {
  const d = detail || {};
  const startMs = toMs(d.startAt);
  const start = Number.isNaN(startMs) ? null : startMs;
  const endRaw = toMs(d.endAt);
  const end =
    !Number.isNaN(endRaw) && start != null && endRaw > start
      ? endRaw
      : start != null
        ? start + DEFAULT_DURATION_MS
        : null;

  const loc = locationView(d, nowMs);
  // Never leak an unrevealed exact venue: an "approximate" view (pre-reveal, or city-only) yields at
  // most the city; only a REVEALED exact location becomes the calendar location.
  const location = loc.approximate ? String(d.city || "").trim() : String(loc.primary || "").trim();

  // Compose the description: the blurb, a pre-reveal location note, the online-join line (revealed
  // only) and a link back — each only when present.
  const parts = [];
  if (d.description) parts.push(String(d.description).trim());
  if (loc.revealed === false && loc.note) parts.push(loc.note);
  if (loc.revealed !== false && loc.onlineUrl) parts.push(`Join online: ${loc.onlineUrl}`);
  if (url) parts.push(String(url).trim());

  return {
    id: d.id != null ? String(d.id) : "",
    title: String(d.heading || "Event").trim() || "Event",
    start,
    end,
    location,
    description: parts.join("\n\n"),
    url: url ? String(url).trim() : "",
  };
}

// ------------------------------------------------------------------ .ics (Apple/iOS + generic)

/**
 * The .ics document for a descriptor — a single-VEVENT VCALENDAR with UTC-normalised times. `uid` /
 * `dtstamp` are injectable for deterministic tests; by default a STABLE uid is derived from the event
 * id (so re-adding updates the same entry rather than duplicating) and DTSTAMP is "now". Returns ""
 * when the descriptor has no valid start (nothing to add).
 */
export function buildIcs(calEvent, { uid, dtstamp, nowMs = Date.now() } = {}) {
  const ev = calEvent || {};
  if (ev.start == null) return "";
  const dtStart = toIcsUtc(ev.start);
  const dtEnd = toIcsUtc(ev.end != null ? ev.end : ev.start + DEFAULT_DURATION_MS);
  const stamp = dtstamp || toIcsUtc(nowMs);
  const theUid = uid || `tm-event-${ev.id || dtStart}@teammarhaba.web.app`;

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${theUid}`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    `SUMMARY:${icsEscape(ev.title)}`,
  ];
  if (ev.description) lines.push(`DESCRIPTION:${icsEscape(ev.description)}`);
  if (ev.location) lines.push(`LOCATION:${icsEscape(ev.location)}`);
  if (ev.url) lines.push(`URL:${icsEscape(ev.url)}`);
  lines.push("END:VEVENT", "END:VCALENDAR");

  return lines.map((l) => foldLine(l)).join("\r\n") + "\r\n";
}

/** A safe download filename for the .ics, slugged from the title: `teammarhaba-<slug>.ics`. */
export function icsFilename(calEvent) {
  const slug =
    String(calEvent?.title || "event")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "event";
  return `teammarhaba-${slug}.ics`;
}

// ------------------------------------------------------------------ Google + Outlook template URLs

/** Google Calendar "add event" template URL for a descriptor. "" when there is no valid start. */
export function googleCalendarUrl(calEvent) {
  const ev = calEvent || {};
  if (ev.start == null) return "";
  const start = toIcsUtc(ev.start);
  const end = toIcsUtc(ev.end != null ? ev.end : ev.start + DEFAULT_DURATION_MS);
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: ev.title || "Event",
    dates: `${start}/${end}`,
  });
  if (ev.description) params.set("details", ev.description);
  if (ev.location) params.set("location", ev.location);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/**
 * Outlook "add event" deeplink. Defaults to the consumer host (outlook.live.com); pass
 * `{ host: "office" }` for the work/school host (outlook.office.com). "" when there is no valid start.
 */
export function outlookCalendarUrl(calEvent, { host = "live" } = {}) {
  const ev = calEvent || {};
  if (ev.start == null) return "";
  const base =
    host === "office"
      ? "https://outlook.office.com/calendar/0/deeplink/compose"
      : "https://outlook.live.com/calendar/0/deeplink/compose";
  const params = new URLSearchParams({
    path: "/calendar/action/compose",
    rru: "addevent",
    subject: ev.title || "Event",
    startdt: toIsoUtc(ev.start),
    enddt: toIsoUtc(ev.end != null ? ev.end : ev.start + DEFAULT_DURATION_MS),
    allday: "false",
  });
  if (ev.description) params.set("body", ev.description);
  if (ev.location) params.set("location", ev.location);
  return `${base}?${params.toString()}`;
}

// ------------------------------------------------------------------ visibility gate + UI model

/** Is this event cancelled? (Both spellings.) Cancelled events hide the Add-to-calendar control (AC). */
export function isCancelled(detail) {
  const s = String(detail?.status || "").toUpperCase();
  return s === "CANCELLED" || s === "CANCELED";
}

/**
 * Should the "Add to calendar" control be shown? Hidden for cancelled events (AC) and for anything
 * without a usable start instant (nothing to add).
 */
export function shouldShowAddToCalendar(detail) {
  if (!detail || isCancelled(detail)) return false;
  return !Number.isNaN(toMs(detail.startAt));
}

/**
 * Everything the detail view needs to render the options in one call — the descriptor plus the
 * ready-to-use .ics text, Google URL and Outlook URL. Reveal- and cancellation-aware; returns
 * `{ show: false }` when the control must be hidden entirely.
 *
 * `icsDownloadable` says whether the client-side .ics *download* affordance is viable in this
 * environment. The download is a blob + download-anchor click (events.js `downloadIcs`); the Android
 * System WebView / iOS WKWebView shells ignore anchor-`download`/`blob:` (no DownloadListener /
 * WKDownloadDelegate is wired) and `a.click()` doesn't throw, so offering the button there is a SILENT
 * no-op with zero feedback (TM-422). Pass `{ webView: true }` — the caller reads auth-env
 * `isWebViewEnv()` — to withhold the button and rely on the real-https Google/Outlook links instead.
 * The .ics text and both URLs are unchanged either way: identical output on web, mobile-web and both
 * native shells (TM-398); only the download affordance is gated.
 *
 * @param {object} detail  event detail
 * @param {number} [nowMs] clock for the reveal / visibility checks
 * @param {{url?:string, webView?:boolean}} [opts] public event URL; `webView` withholds the .ics download
 * @returns {{show:boolean, event?:object, ics?:string, icsFilename?:string, googleUrl?:string,
 *            outlookUrl?:string, icsDownloadable?:boolean}}
 */
export function addToCalendarModel(detail, nowMs = Date.now(), { url, webView = false } = {}) {
  if (!shouldShowAddToCalendar(detail)) return { show: false };
  const event = calendarEventFromDetail(detail, nowMs, { url });
  return {
    show: true,
    event,
    ics: buildIcs(event, { nowMs }),
    icsFilename: icsFilename(event),
    googleUrl: googleCalendarUrl(event),
    outlookUrl: outlookCalendarUrl(event),
    icsDownloadable: !webView,
  };
}
