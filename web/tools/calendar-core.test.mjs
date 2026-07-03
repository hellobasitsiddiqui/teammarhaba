// Tests for the pure "Add to calendar" generators (TM-398). Framework-free — Node's built-in test
// runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// calendar-core.js has zero DOM/fetch deps, so the whole behaviour is asserted here: UTC time
// normalisation (incl. the DST edge the AC calls out), RFC 5545 TEXT escaping + octet-aware line
// folding, the reveal-aware descriptor (TM-408 — the exact venue must never reach a calendar entry
// pre-reveal), the .ics document, the Google + Outlook URLs, and the cancelled-hides-control gate.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  toIcsUtc,
  toIsoUtc,
  icsEscape,
  foldLine,
  calendarEventFromDetail,
  buildIcs,
  icsFilename,
  googleCalendarUrl,
  outlookCalendarUrl,
  isCancelled,
  shouldShowAddToCalendar,
  addToCalendarModel,
} from "../src/assets/calendar-core.js";

const HOUR = 3600000;

// A revealed, timed event fixture (the common case).
function revealedEvent(over = {}) {
  return {
    id: 42,
    heading: "Sunday Picnic",
    description: "Bring a blanket.",
    startAt: "2026-07-05T17:00:00Z",
    endAt: "2026-07-05T19:00:00Z",
    timezone: "Europe/London",
    city: "Camden",
    locationText: "Regent's Park, Camden",
    locationRevealed: true,
    status: "PUBLISHED",
    ...over,
  };
}

// ------------------------------------------------------------------ UTC time normalisation (+ DST)

test("toIcsUtc: normalises an instant to YYYYMMDDTHHMMSSZ, DST-correct by construction", () => {
  // 18:00 London in SUMMER is 17:00Z; the .ics is UTC-normalised, so DST is intrinsic.
  assert.equal(toIcsUtc("2026-07-05T17:00:00Z"), "20260705T170000Z");
  // 18:00 London in WINTER is 18:00Z — the same wall-clock, a different UTC value, purely because of DST.
  assert.equal(toIcsUtc("2026-01-05T18:00:00Z"), "20260105T180000Z");
  // Accepts a Date and an epoch number too, identically.
  assert.equal(toIcsUtc(new Date("2026-07-05T17:00:00Z")), "20260705T170000Z");
  assert.equal(toIcsUtc(Date.parse("2026-07-05T17:00:00Z")), "20260705T170000Z");
});

test("toIcsUtc / toIsoUtc: invalid or missing → empty string (never 'InvalidZ')", () => {
  assert.equal(toIcsUtc(null), "");
  assert.equal(toIcsUtc("not-a-date"), "");
  assert.equal(toIsoUtc(undefined), "");
});

test("toIsoUtc: ISO-8601 UTC without milliseconds (the Outlook deeplink form)", () => {
  assert.equal(toIsoUtc("2026-07-05T17:00:00Z"), "2026-07-05T17:00:00Z");
  assert.equal(toIsoUtc("2026-07-05T17:00:00.123Z"), "2026-07-05T17:00:00Z");
});

// ------------------------------------------------------------------ RFC 5545 escaping + folding

test("icsEscape: backslash, semicolon, comma and newlines per RFC 5545 §3.3.11", () => {
  assert.equal(icsEscape("a,b;c"), "a\\,b\\;c");
  assert.equal(icsEscape("back\\slash"), "back\\\\slash");
  assert.equal(icsEscape("line1\nline2"), "line1\\nline2");
  assert.equal(icsEscape("win\r\nnl"), "win\\nnl");
  assert.equal(icsEscape(null), "");
  // Colon is left alone inside a value.
  assert.equal(icsEscape("Join online: https://x.test/a"), "Join online: https://x.test/a");
});

test("foldLine: lines within 75 octets are unchanged", () => {
  const short = "SUMMARY:Sunday Picnic";
  assert.equal(foldLine(short), short);
});

test("foldLine: long lines fold at 75 octets with CRLF + leading space, and round-trip", () => {
  const line = "DESCRIPTION:" + "x".repeat(200);
  const folded = foldLine(line);
  const physical = folded.split("\r\n");
  assert.ok(physical.length > 1, "a 212-char line must fold");
  // Every physical line is at most 75 octets (continuation space included).
  for (const p of physical) {
    assert.ok(Buffer.byteLength(p, "utf8") <= 75, `"${p}" (${Buffer.byteLength(p, "utf8")}b) exceeds 75`);
  }
  // Continuation lines each start with exactly one space; unfolding restores the original.
  const unfolded = physical.map((p, i) => (i === 0 ? p : p.replace(/^ /, ""))).join("");
  assert.equal(unfolded, line);
});

test("foldLine: never splits a multi-byte UTF-8 character (no U+FFFD)", () => {
  // Emoji (4 bytes each) packed so a naive byte-slice at 75 would land mid-character.
  const line = "SUMMARY:" + "😀".repeat(40);
  const folded = foldLine(line);
  assert.ok(!folded.includes("�"), "folding must not produce a replacement character");
  const unfolded = folded.split("\r\n").map((p, i) => (i === 0 ? p : p.replace(/^ /, ""))).join("");
  assert.equal(unfolded, line);
  for (const p of folded.split("\r\n")) {
    assert.ok(Buffer.byteLength(p, "utf8") <= 75);
  }
});

// ------------------------------------------------------------------ descriptor + reveal-safety

test("calendarEventFromDetail: title / times, and a 2h default end when there is none", () => {
  const ev = calendarEventFromDetail(revealedEvent({ endAt: null }));
  assert.equal(ev.title, "Sunday Picnic");
  assert.equal(ev.start, Date.parse("2026-07-05T17:00:00Z"));
  assert.equal(ev.end, Date.parse("2026-07-05T17:00:00Z") + 2 * HOUR, "no end → start + 2h");
});

test("calendarEventFromDetail: a non-positive/backwards end falls back to +2h", () => {
  const ev = calendarEventFromDetail(revealedEvent({ endAt: "2026-07-05T16:00:00Z" }));
  assert.equal(ev.end, ev.start + 2 * HOUR);
});

test("calendarEventFromDetail: missing heading → 'Event'; missing start → null", () => {
  assert.equal(calendarEventFromDetail({ startAt: "2026-07-05T17:00:00Z" }).title, "Event");
  assert.equal(calendarEventFromDetail({ heading: "x" }).start, null);
});

test("calendarEventFromDetail: REVEALED event uses the exact location", () => {
  const ev = calendarEventFromDetail(revealedEvent());
  assert.equal(ev.location, "Regent's Park, Camden");
});

test("calendarEventFromDetail (TM-408): pre-reveal NEVER leaks the exact venue — only the city", () => {
  const detail = revealedEvent({
    locationRevealed: false,
    city: "Camden, London",
    locationText: "12 Secret Lane, NW1 4RY",
    mapUrl: "https://maps.example/secret",
    locationRevealsAt: new Date(Date.now() + 24 * HOUR).toISOString(),
  });
  const ev = calendarEventFromDetail(detail, Date.now());
  assert.equal(ev.location, "Camden, London", "pre-reveal location is the approximate city");
  assert.ok(!ev.location.includes("Secret Lane"));
  // The exact address / map link must not have leaked into the description either.
  assert.ok(!ev.description.includes("Secret Lane"));
  assert.ok(!ev.description.includes("maps.example"));
});

test("calendarEventFromDetail: description composes blurb + online-join (revealed) + url", () => {
  const detail = revealedEvent({ onlineUrl: "https://meet.example/abc" });
  const ev = calendarEventFromDetail(detail, Date.now(), { url: "https://teammarhaba.web.app/#/events/42" });
  assert.match(ev.description, /Bring a blanket\./);
  assert.match(ev.description, /Join online: https:\/\/meet\.example\/abc/);
  assert.match(ev.description, /teammarhaba\.web\.app\/#\/events\/42/);
});

test("calendarEventFromDetail: predates TM-408 (no reveal fields) → treated as revealed", () => {
  const ev = calendarEventFromDetail({
    id: 1,
    heading: "Old Event",
    startAt: "2026-07-05T17:00:00Z",
    locationText: "Somewhere Hall",
  });
  assert.equal(ev.location, "Somewhere Hall");
});

// ------------------------------------------------------------------ .ics document

test("buildIcs: a valid single-VEVENT VCALENDAR with UTC times and an escaped summary", () => {
  const ev = calendarEventFromDetail(revealedEvent({ heading: "Picnic, with cake; fun" }));
  const ics = buildIcs(ev, { uid: "fixed-uid@teammarhaba.web.app", dtstamp: "20260601T000000Z" });
  const lines = ics.split("\r\n");
  assert.equal(lines[0], "BEGIN:VCALENDAR");
  assert.ok(ics.includes("VERSION:2.0"));
  assert.ok(ics.includes("PRODID:-//TeamMarhaba//Events//EN"));
  assert.ok(ics.includes("BEGIN:VEVENT"));
  assert.ok(ics.includes("UID:fixed-uid@teammarhaba.web.app"));
  assert.ok(ics.includes("DTSTAMP:20260601T000000Z"));
  assert.ok(ics.includes("DTSTART:20260705T170000Z"));
  assert.ok(ics.includes("DTEND:20260705T190000Z"));
  assert.ok(ics.includes("SUMMARY:Picnic\\, with cake\\; fun"), "commas + semicolons escaped in SUMMARY");
  assert.equal(lines[lines.length - 2], "END:VCALENDAR");
  assert.equal(ics.slice(-2), "\r\n", "document ends with CRLF");
});

test("buildIcs: DST edge — the same 18:00-London event yields different UTC DTSTART by season", () => {
  const summer = buildIcs(calendarEventFromDetail(revealedEvent({ startAt: "2026-07-05T17:00:00Z", endAt: null })));
  const winter = buildIcs(calendarEventFromDetail(revealedEvent({ startAt: "2026-01-05T18:00:00Z", endAt: null })));
  assert.ok(summer.includes("DTSTART:20260705T170000Z"));
  assert.ok(winter.includes("DTSTART:20260105T180000Z"));
});

test("buildIcs: stable UID derives from the event id when none is injected", () => {
  const ics = buildIcs(calendarEventFromDetail(revealedEvent({ id: 99 })));
  assert.ok(ics.includes("UID:tm-event-99@teammarhaba.web.app"));
});

test("buildIcs: no valid start → empty document (nothing to add)", () => {
  assert.equal(buildIcs(calendarEventFromDetail({ heading: "no time" })), "");
  assert.equal(buildIcs(null), "");
});

test("icsFilename: slugged from the title, always .ics", () => {
  assert.equal(icsFilename({ title: "Sunday Picnic!" }), "teammarhaba-sunday-picnic.ics");
  assert.equal(icsFilename({ title: "   " }), "teammarhaba-event.ics");
});

// ------------------------------------------------------------------ Google + Outlook URLs

test("googleCalendarUrl: TEMPLATE action, UTC date range, encoded title/details/location", () => {
  const url = googleCalendarUrl(calendarEventFromDetail(revealedEvent()));
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, "https://calendar.google.com/calendar/render");
  assert.equal(u.searchParams.get("action"), "TEMPLATE");
  assert.equal(u.searchParams.get("text"), "Sunday Picnic");
  assert.equal(u.searchParams.get("dates"), "20260705T170000Z/20260705T190000Z");
  assert.equal(u.searchParams.get("location"), "Regent's Park, Camden");
  assert.equal(u.searchParams.get("details"), "Bring a blanket.");
});

test("googleCalendarUrl (TM-408): pre-reveal location is the city, not the exact venue", () => {
  const detail = revealedEvent({ locationRevealed: false, city: "Camden", locationText: "12 Secret Lane" });
  const url = googleCalendarUrl(calendarEventFromDetail(detail, Date.now()));
  assert.equal(new URL(url).searchParams.get("location"), "Camden");
  assert.ok(!url.includes("Secret"));
});

test("googleCalendarUrl: no valid start → empty", () => {
  assert.equal(googleCalendarUrl(calendarEventFromDetail({ heading: "x" })), "");
});

test("outlookCalendarUrl: consumer host by default, compose params, ISO-UTC start/end", () => {
  const url = outlookCalendarUrl(calendarEventFromDetail(revealedEvent()));
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, "https://outlook.live.com/calendar/0/deeplink/compose");
  assert.equal(u.searchParams.get("rru"), "addevent");
  assert.equal(u.searchParams.get("subject"), "Sunday Picnic");
  assert.equal(u.searchParams.get("startdt"), "2026-07-05T17:00:00Z");
  assert.equal(u.searchParams.get("enddt"), "2026-07-05T19:00:00Z");
  assert.equal(u.searchParams.get("allday"), "false");
  assert.equal(u.searchParams.get("location"), "Regent's Park, Camden");
});

test("outlookCalendarUrl: { host: 'office' } switches to the work/school host", () => {
  const url = outlookCalendarUrl(calendarEventFromDetail(revealedEvent()), { host: "office" });
  assert.ok(url.startsWith("https://outlook.office.com/calendar/0/deeplink/compose"));
});

// ------------------------------------------------------------------ visibility gate + UI model

test("isCancelled / shouldShowAddToCalendar: cancelled (either spelling) hides the control", () => {
  assert.equal(isCancelled({ status: "CANCELLED" }), true);
  assert.equal(isCancelled({ status: "canceled" }), true);
  assert.equal(isCancelled({ status: "PUBLISHED" }), false);
  assert.equal(shouldShowAddToCalendar(revealedEvent({ status: "CANCELLED" })), false);
  assert.equal(shouldShowAddToCalendar(revealedEvent()), true);
  assert.equal(shouldShowAddToCalendar({ heading: "no start" }), false, "no start instant → hidden");
});

test("addToCalendarModel: hidden for cancelled; otherwise carries ics + both URLs", () => {
  assert.deepEqual(addToCalendarModel(revealedEvent({ status: "CANCELLED" })), { show: false });

  const m = addToCalendarModel(revealedEvent(), Date.now(), { url: "https://teammarhaba.web.app/#/events/42" });
  assert.equal(m.show, true);
  assert.ok(m.ics.includes("BEGIN:VCALENDAR"));
  assert.equal(m.icsFilename, "teammarhaba-sunday-picnic.ics");
  assert.ok(m.googleUrl.startsWith("https://calendar.google.com/"));
  assert.ok(m.outlookUrl.startsWith("https://outlook.live.com/"));
});

test("addToCalendarModel: on web / mobile-web the .ics download is offered (icsDownloadable defaults true)", () => {
  // No `webView` option = a normal browser: the blob + download-anchor .ics works, so the button stays.
  assert.equal(addToCalendarModel(revealedEvent()).icsDownloadable, true);
  assert.equal(addToCalendarModel(revealedEvent(), Date.now(), { webView: false }).icsDownloadable, true);
});

test("addToCalendarModel (TM-422): inside the native WebView the .ics download is withheld, links survive", () => {
  // On the Android System WebView / iOS WKWebView shell the blob + download-anchor .ics is a SILENT
  // no-op (no DownloadListener / WKDownloadDelegate; a.click() doesn't throw → zero feedback). The
  // shell reads isWebViewEnv() and passes webView:true so the button is dropped rather than dead.
  const m = addToCalendarModel(revealedEvent(), Date.now(), { webView: true });
  assert.equal(m.show, true, "the control still shows — only the .ics option is gated");
  assert.equal(m.icsDownloadable, false, "the silently-failing .ics option must not be offered in a WebView");
  // The working paths remain fully present, so the user is never left with nothing: Google/Outlook are
  // real https navigations opened externally.
  assert.ok(m.googleUrl.startsWith("https://calendar.google.com/"));
  assert.ok(m.outlookUrl.startsWith("https://outlook.live.com/"));
  // The calendar payload itself is identical everywhere (TM-398) — only the download affordance is
  // gated, never the generated .ics text / filename.
  assert.ok(m.ics.includes("BEGIN:VCALENDAR"));
  assert.equal(m.icsFilename, "teammarhaba-sunday-picnic.ics");
});

test("addToCalendarModel (TM-408): pre-reveal exact venue never appears in ANY output", () => {
  const detail = revealedEvent({
    locationRevealed: false,
    city: "Camden",
    locationText: "12 Secret Lane, NW1 4RY",
    mapUrl: "https://maps.example/secret",
  });
  const m = addToCalendarModel(detail, Date.now());
  for (const out of [m.ics, m.googleUrl, m.outlookUrl]) {
    assert.ok(!out.includes("Secret"), "exact address must not leak");
    assert.ok(!out.includes("maps.example"), "map link must not leak");
  }
});
