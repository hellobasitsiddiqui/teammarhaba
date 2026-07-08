// Pure, framework-free logic for the user events UI (TM-396) — no DOM, no fetch, no browser
// globals at module scope, so Node's test runner can import it directly (mirrors the
// verify-banner-state.js / *-state.js split the web app already uses; covered by
// `node --test web/tools/*.test.mjs` on the PR gate).
//
// It encodes everything the events views need but that is worth testing in isolation:
//   • local-time formatting from a UTC instant + IANA tz (DST-correct via Intl), incl. the
//     viewer-vs-event timezone note;
//   • my-state chips + the "N going" badge copy;
//   • the browse listing split into "Happening now" vs "Upcoming" (TM-412), finished excluded;
//   • the reveal-aware location view (TM-408) — approximate/city + countdown before reveal,
//     exact + map/online link after, degrading gracefully when the reveal fields are absent;
//   • the RSVP control model — the single source of truth for the primary/secondary buttons and
//     their honest disabled copy, composing the booking cutoff + one-active-event gates (TM-413)
//     and the age-band gate (TM-415) on top of the base RSVP / waitlist / claim states (TM-393).
//
// DEFENSIVE BY DESIGN. The public events API is still growing: TM-408 (location reveal),
// TM-412 (happening-now), TM-413 (eligibility) and TM-415 (age band) may or may not have merged
// when this ships. So every field those tickets add is read as OPTIONAL and possibly-absent, and
// we always ALSO surface the backend's own 409 message on a rejected command rather than a guess.

// ------------------------------------------------------------------ small utilities

/** First argument that is a finite number, else null. Tolerates strings ("27"), null, undefined. */
function firstNumber(...values) {
  for (const v of values) {
    if (v == null || v === "") continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Parse an ISO instant to epoch-ms, or NaN. Accepts a Date, number, or string. */
function toMs(value) {
  if (value == null) return NaN;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return Date.parse(value);
}

/** The viewer's IANA timezone (browser guess), or null when it can't be resolved. Pure-safe. */
export function viewerTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ time formatting

const DEFAULT_LOCALE = "en-GB";

/**
 * Short "when" label for a card: the UTC instant rendered in the viewer's local time, DST-correct.
 * e.g. "Sat 5 Jul 2026, 18:00". Returns "" for a missing/invalid instant so a card never shows
 * "Invalid Date". `tz`/`locale` default to the viewer's; tests pass them explicitly for determinism.
 */
export function formatWhen(iso, { tz, locale = DEFAULT_LOCALE } = {}) {
  const ms = toMs(iso);
  if (Number.isNaN(ms)) return "";
  try {
    return new Intl.DateTimeFormat(locale, {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: tz || undefined,
    }).format(new Date(ms));
  } catch {
    return "";
  }
}

/** Long date line for the detail header, e.g. "Saturday, 5 July 2026". "" when invalid. */
export function formatDateLong(iso, { tz, locale = DEFAULT_LOCALE } = {}) {
  const ms = toMs(iso);
  if (Number.isNaN(ms)) return "";
  try {
    return new Intl.DateTimeFormat(locale, {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: tz || undefined,
    }).format(new Date(ms));
  } catch {
    return "";
  }
}

/** Time-only in a tz, e.g. "18:00". "" when invalid. */
export function formatTime(iso, { tz, locale = DEFAULT_LOCALE } = {}) {
  const ms = toMs(iso);
  if (Number.isNaN(ms)) return "";
  try {
    return new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: tz || undefined,
    }).format(new Date(ms));
  } catch {
    return "";
  }
}

/** The short timezone label for an instant in a tz, e.g. "GMT+1". "" when unavailable. */
export function tzLabel(iso, { tz, locale = DEFAULT_LOCALE } = {}) {
  const ms = toMs(iso);
  if (Number.isNaN(ms)) return "";
  try {
    const parts = new Intl.DateTimeFormat(locale, {
      timeZone: tz || undefined,
      timeZoneName: "short",
    }).formatToParts(new Date(ms));
    return parts.find((p) => p.type === "timeZoneName")?.value || "";
  } catch {
    return "";
  }
}

/** Do two IANA ids refer to the same zone? Loose compare (case-insensitive, trims). */
function sameZone(a, b) {
  if (!a || !b) return false;
  return String(a).toLowerCase() === String(b).toLowerCase();
}

/**
 * Everything the detail's "when" block needs. The instant is absolute (UTC); we render it in the
 * viewer's local time (the AC: "converted from event tz to the viewer's"). When the event's own
 * timezone differs from the viewer's, we also expose an event-local line so a cross-timezone viewer
 * isn't caught out ("Event local time: 13:00 GMT-4").
 *
 * @returns {{date, time, tz, hasEnd, showEventLocal, eventLocalTime, eventLocalTz, eventTz}}
 */
export function describeWhen(startAt, endAt, eventTz, { viewerTz, locale = DEFAULT_LOCALE } = {}) {
  const vtz = viewerTz || viewerTimeZone() || undefined;
  const startMs = toMs(startAt);
  if (Number.isNaN(startMs)) {
    return { date: "", time: "", tz: "", hasEnd: false, showEventLocal: false };
  }
  const date = formatDateLong(startAt, { tz: vtz, locale });
  const startTime = formatTime(startAt, { tz: vtz, locale });
  const endMs = toMs(endAt);
  const hasEnd = !Number.isNaN(endMs);
  let time = startTime;
  if (hasEnd) {
    const endTime = formatTime(endAt, { tz: vtz, locale });
    // Same local calendar day? then "18:00 – 20:00"; else include the end date.
    const sameDay = formatDateLong(startAt, { tz: vtz, locale }) === formatDateLong(endAt, { tz: vtz, locale });
    time = sameDay ? `${startTime} – ${endTime}` : `${startTime} → ${formatWhen(endAt, { tz: vtz, locale })}`;
  }
  const showEventLocal = Boolean(eventTz) && !sameZone(eventTz, vtz);
  return {
    date,
    time,
    tz: tzLabel(startAt, { tz: vtz, locale }),
    hasEnd,
    showEventLocal,
    eventLocalTime: showEventLocal ? formatTime(startAt, { tz: eventTz, locale }) : "",
    eventLocalTz: showEventLocal ? tzLabel(startAt, { tz: eventTz, locale }) : "",
    eventTz: eventTz || "",
  };
}

/**
 * A compact relative countdown for a positive duration in ms — "in 12 min", "in 3 h", "in 2 days".
 * Non-positive → "now". Used for the location-reveal and (optionally) start countdowns.
 */
export function countdownText(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "under a minute";
  if (mins < 60) return `in ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `in ${hours} h`;
  const days = Math.round(hours / 24);
  return `in ${days} days`;
}

// ------------------------------------------------------------------ state chips + badges

/**
 * The caller's my-state chip for a card/detail. NONE (or anything unknown) → null (no chip).
 * @param {"NONE"|"GOING"|"WAITLISTED"|string} myState
 */
export function myStateChip(myState) {
  if (myState === "GOING") return { state: "GOING", label: "✓ Going", cls: "tm-event-chip-going" };
  if (myState === "WAITLISTED") return { state: "WAITLISTED", label: "Waitlisted", cls: "tm-event-chip-waitlisted" };
  return null;
}

/** The "N going" badge copy — warm empty-copy at zero. */
export function goingBadge(goingCount) {
  const n = firstNumber(goingCount) ?? 0;
  if (n <= 0) return "Be the first to go";
  return `${n} going`;
}

/** "N on the waitlist" copy for the detail when a waitlist exists; "" when empty. */
export function waitlistBadge(waitlistedCount) {
  const n = firstNumber(waitlistedCount) ?? 0;
  if (n <= 0) return "";
  return n === 1 ? "1 on the waitlist" : `${n} on the waitlist`;
}

/** Up to two uppercase initials from a display name; "?" when unknown (soft-deleted / null). */
export function initials(displayName) {
  const name = (displayName || "").trim();
  if (!name) return "?";
  const parts = name.split(/\s+/).filter(Boolean);
  const chars = parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0];
  return chars.toUpperCase();
}

// ------------------------------------------------------------------ listing states (TM-412)

/** Status string off an item, upper-cased, or "". */
function statusOf(item) {
  return String(item?.status || "").toUpperCase();
}

/**
 * Is this event live right now? Prefers the API's own signal (TM-412: `isHappeningNow` / `status`)
 * and derives from the instants only as a fallback (defensive: those fields may not exist yet).
 * An open-ended event that has started and is still in the listing is treated as live.
 */
export function isHappeningNow(item, nowMs = Date.now()) {
  if (typeof item?.isHappeningNow === "boolean") return item.isHappeningNow;
  const status = statusOf(item);
  if (status === "HAPPENING_NOW" || status === "LIVE" || status === "ONGOING" || status === "IN_PROGRESS") return true;
  if (status === "UPCOMING" || status === "SCHEDULED" || status === "PUBLISHED") return false;
  const start = toMs(item?.startAt);
  if (Number.isNaN(start) || nowMs < start) return false; // not started (or unknown) → not live
  const end = toMs(item?.endAt);
  if (!Number.isNaN(end)) return nowMs < end; // started and not yet ended
  return true; // started, open-ended, still listed → treat as live
}

/**
 * Has this event finished? The API already excludes finished events from the listing, so this is a
 * pure client-side backstop (never trust it to be exhaustive). Open-ended events are never
 * client-side "finished".
 */
export function isFinished(item, nowMs = Date.now()) {
  const status = statusOf(item);
  if (status === "FINISHED" || status === "ENDED" || status === "PAST" || status === "CANCELLED") return true;
  const end = toMs(item?.endAt);
  if (!Number.isNaN(end)) return nowMs >= end;
  return false;
}

/**
 * Split the visible listing into the two surfaced states, preserving the API's soonest-first order
 * within each: `happeningNow` (surfaced section) and `upcoming`. Finished events are dropped
 * defensively (the API already excludes them), so there is no third bucket — finished → gone.
 */
export function listingBuckets(cards, nowMs = Date.now()) {
  const list = Array.isArray(cards) ? cards : [];
  const visible = list.filter((c) => !isFinished(c, nowMs));
  return {
    happeningNow: visible.filter((c) => isHappeningNow(c, nowMs)),
    upcoming: visible.filter((c) => !isHappeningNow(c, nowMs)),
  };
}

// ------------------------------------------------------------------ location reveal (TM-408)

/**
 * The reveal-aware location model for the detail. The public API withholds the EXACT location
 * (`locationText` / `mapUrl` / `onlineUrl`) until the reveal boundary and exposes `city`,
 * `locationRevealed`, `locationRevealsAt` (TM-408). All of those are treated as OPTIONAL: on an API
 * that predates TM-408 the reveal fields are simply absent and we fall through to "revealed" with
 * whatever location we were given.
 *
 *  • `locationRevealed === false` → pre-reveal: show the approximate `city` (or a neutral
 *    placeholder), a "revealed …" note, and a countdown when `locationRevealsAt` is known. No exact
 *    text / links (they're withheld).
 *  • otherwise → show the exact `locationText` (+ map/online links when present); if even that is
 *    missing, degrade to the placeholder rather than a blank.
 */
export function locationView(detail, nowMs = Date.now()) {
  const city = (detail?.city || "").trim();
  const locationText = (detail?.locationText || "").trim();
  const mapUrl = detail?.mapUrl || null;
  const onlineUrl = detail?.onlineUrl || null;
  const revealsAtMs = toMs(detail?.locationRevealsAt);
  const hasRevealsAt = !Number.isNaN(revealsAtMs);
  const PLACEHOLDER = "Location shared ~24h before the event";

  if (detail?.locationRevealed === false) {
    return {
      revealed: false,
      approximate: true,
      primary: city || PLACEHOLDER,
      note: hasRevealsAt
        ? `Exact location revealed ${countdownText(revealsAtMs - nowMs)}`
        : "Exact location revealed 24h before the event",
      countdownMs: hasRevealsAt ? Math.max(0, revealsAtMs - nowMs) : null,
      mapUrl: null,
      onlineUrl: null,
    };
  }

  return {
    revealed: true,
    approximate: !locationText && Boolean(city),
    primary: locationText || city || PLACEHOLDER,
    note: null,
    countdownMs: null,
    mapUrl,
    onlineUrl,
  };
}

// ------------------------------------------------------------------ eligibility gates

/** Normalize the event's age band from any of the plausible field shapes; null when there is none. */
export function ageBand(item) {
  const band = item?.ageBand;
  const min = firstNumber(item?.ageMin, item?.minAge, band?.min);
  const max = firstNumber(item?.ageMax, item?.maxAge, band?.max);
  if (min == null && max == null) return null;
  return { min, max };
}

/** Human label for the age band, e.g. "Ages 25–30" / "Ages 25+" / "Ages up to 30". null when none. */
export function ageBandLabel(item) {
  const band = ageBand(item);
  if (!band) return null;
  if (band.min != null && band.max != null) return `Ages ${band.min}–${band.max}`;
  if (band.min != null) return `Ages ${band.min}+`;
  return `Ages up to ${band.max}`;
}

/**
 * Age-band eligibility (TM-415, ±2 years hard rule). `me.age` may be unset (null/blank) — that is a
 * distinct, fixable state ("add your age") from being outside the band.
 * @returns {{hasBand, status:"ok"|"unset"|"outside", band, tolerance, age}}
 */
export function ageEligibility(item, me, { tolerance = 2 } = {}) {
  const band = ageBand(item);
  if (!band) return { hasBand: false, status: "ok", band: null, tolerance, age: firstNumber(me?.age) };
  const age = firstNumber(me?.age);
  if (age == null) return { hasBand: true, status: "unset", band, tolerance, age: null };
  const lo = band.min == null ? -Infinity : band.min - tolerance;
  const hi = band.max == null ? Infinity : band.max + tolerance;
  const ok = age >= lo && age <= hi;
  return { hasBand: true, status: ok ? "ok" : "outside", band, tolerance, age };
}

/**
 * The booking window (TM-413): an event stops accepting attendance changes within `cutoffMinutes`
 * (default 60, configurable) of its start, and of course once it has started. Prefers an explicit
 * `bookingClosesAt` from the API if present; otherwise derives it as start − cutoff.
 * @returns {{started, closed, cutoffAtMs, startMs}}
 */
export function bookingWindow(item, nowMs = Date.now(), { cutoffMinutes = 60 } = {}) {
  const startMs = toMs(item?.startAt);
  if (Number.isNaN(startMs)) return { started: false, closed: false, cutoffAtMs: null, startMs: null };
  const explicit = toMs(item?.bookingClosesAt);
  const cutoffAtMs = Number.isNaN(explicit) ? startMs - cutoffMinutes * 60000 : explicit;
  return { started: nowMs >= startMs, closed: nowMs >= cutoffAtMs, cutoffAtMs, startMs };
}

/** Would a fresh RSVP land GOING (a free spot and no waitlist) rather than WAITLISTED? */
export function wouldLandGoing(detail) {
  const cap = firstNumber(detail?.capacity); // null → unlimited
  const going = firstNumber(detail?.goingCount) ?? 0;
  const waitlisted = firstNumber(detail?.waitlistedCount) ?? 0;
  const hasFreeSpot = cap == null || going < cap;
  return hasFreeSpot && waitlisted === 0;
}

/**
 * The "one active event at a time" conflict (TM-413): does the caller already hold a GOING spot on a
 * DIFFERENT, unfinished event? Prefers an explicit hint from the API (`activeGoingEvent` /
 * `blockingEvent`) and otherwise derives it best-effort from the loaded listing (any other card
 * whose `myState` is GOING). This gate only blocks an RSVP that would land GOING — waitlisting a
 * second event is always allowed — so the caller applies it accordingly.
 * @returns {{blocked, event: {id, heading}|null}}
 */
export function activeGoingConflict(detail, cards, nowMs = Date.now()) {
  const explicit = detail?.activeGoingEvent || detail?.blockingEvent || detail?.activeEvent;
  if (explicit && explicit.id != null && explicit.id !== detail?.id) {
    return { blocked: true, event: { id: explicit.id, heading: explicit.heading || explicit.name || "another event" } };
  }
  const others = (Array.isArray(cards) ? cards : []).filter(
    (c) => c && c.id !== detail?.id && c.myState === "GOING" && !isFinished(c, nowMs),
  );
  if (others.length) return { blocked: true, event: { id: others[0].id, heading: others[0].heading || "another event" } };
  return { blocked: false, event: null };
}

// ------------------------------------------------------------------ the RSVP control model

/** Honest copy for why booking is shut. */
function closedReason(bw) {
  return bw.started
    ? "This event has started, so attendance can no longer be changed."
    : "Booking closed — this event starts in under an hour.";
}

/**
 * THE control model for the detail's action area — the single place that decides the primary (and
 * optional secondary) button, whether it's disabled, and the honest copy for why. It composes, in
 * priority order, the base TM-393 states (NONE / GOING / WAITLISTED / claimable) with the TM-413
 * gates (booking cutoff, one-active-event) and the TM-415 age gate. The caller renders it verbatim
 * and ALSO surfaces the backend's own 409 on a rejected command (the server is the real gate).
 *
 * Button `kind`s: `rsvp` (join → GOING), `waitlist` (join → WAITLISTED), `claim` (take an open
 * spot), `leave` (un-RSVP / leave the waitlist), `none` (nothing actionable). A disabled button
 * carries `reason` (copy) and optional `link` ({href,label}) — e.g. the "add your age" → #/profile.
 *
 * @returns {{chip, primary, secondary, ageBandLabel, remindNote, full}}
 */
export function rsvpControlModel({ detail, me, cards = [], nowMs = Date.now(), cutoffMinutes = 60, tolerance = 2 } = {}) {
  const chip = myStateChip(detail?.myState);
  const bw = bookingWindow(detail, nowMs, { cutoffMinutes });
  const band = ageBandLabel(detail);
  const model = { chip, primary: null, secondary: null, ageBandLabel: band, remindNote: null, full: !wouldLandGoing(detail) };

  const claimable = detail?.spotAvailableToClaim === true && detail?.myState === "WAITLISTED";

  // 1) A live claim offer wins the primary slot — it's the whole point of the offer cascade and the
  //    push deep-link landing state. Disabled (with honest copy) only if booking has since shut.
  if (claimable) {
    model.primary = bw.closed
      ? { key: "claim", kind: "claim", label: "A spot opened — claim it", disabled: true, reason: closedReason(bw) }
      : { key: "claim", kind: "claim", label: "A spot opened — claim it", disabled: false, prominent: true };
    // Still allow leaving the waitlist while booking is open.
    model.secondary = leaveButton("WAITLISTED", bw);
    return model;
  }

  // 2) Already GOING → the primary action is to cancel; keep the ✓ Going chip.
  if (detail?.myState === "GOING") {
    model.primary = { key: "leave", kind: "leave", label: "Cancel RSVP", danger: true, ...disabledIfClosed(bw) };
    return model;
  }

  // 3) On the waitlist (no live offer) → primary action is to leave the waitlist.
  if (detail?.myState === "WAITLISTED") {
    model.primary = { key: "leave", kind: "leave", label: "Leave the waiting list", ...disabledIfClosed(bw) };
    return model;
  }

  // 4) NONE → considering joining. Decide RSVP vs waitlist, then apply the gates in priority order.
  const landsGoing = wouldLandGoing(detail);
  const joinKind = landsGoing ? "rsvp" : "waitlist";
  const joinLabel = landsGoing ? "RSVP — I'm going" : "Join the waiting list";
  const base = { key: "join", kind: joinKind, label: joinLabel };

  // 4a) time gates apply to everyone.
  if (bw.started || bw.closed) {
    model.primary = { ...base, disabled: true, reason: closedReason(bw) };
    return model;
  }
  // 4b) age gate (TM-415): unset age is fixable and links to the profile; outside-band is a hard no.
  const age = ageEligibility(detail, me, { tolerance });
  if (age.status === "unset") {
    model.primary = {
      ...base,
      disabled: true,
      reason: "Add your age to your profile to RSVP",
      link: { href: "#/profile", label: "Add your age" },
    };
    return model;
  }
  if (age.status === "outside") {
    model.primary = { ...base, disabled: true, reason: `This event is for ${band || "a different age group"}.` };
    return model;
  }
  // 4c) one-active-event gate (TM-413) — only blocks a would-be GOING RSVP; a second WAITLIST is fine.
  if (landsGoing) {
    const conflict = activeGoingConflict(detail, cards, nowMs);
    if (conflict.blocked) {
      model.primary = {
        ...base,
        disabled: true,
        reason: `You're going to ${conflict.event.heading} until it ends.`,
      };
      return model;
    }
  } else {
    // Joining a waitlist while already going elsewhere is allowed — say so, so it isn't surprising.
    const conflict = activeGoingConflict(detail, cards, nowMs);
    if (conflict.blocked) {
      model.remindNote = `You're going to ${conflict.event.heading} — you can still join this waiting list.`;
    }
  }

  // 4d) enabled. RSVP gets the confirm dialog + reminder note; joining a waitlist is a direct action.
  model.primary = {
    ...base,
    disabled: false,
    prominent: true,
    confirm: landsGoing
      ? { title: "RSVP to this event?", message: "We'll remind you the day before.", confirmLabel: "I'm going" }
      : null,
  };
  if (landsGoing) model.remindNote = "We'll remind you the day before.";
  else if (!model.remindNote) model.remindNote = "This event is full — you'll join the waiting list.";
  return model;
}

/** Shared: a disabled-when-closed patch for a button. */
function disabledIfClosed(bw) {
  return bw.closed ? { disabled: true, reason: closedReason(bw) } : { disabled: false };
}

/** Shared: the "leave" secondary for a claimable/waitlisted caller. */
function leaveButton(state, bw) {
  const label = state === "GOING" ? "Cancel RSVP" : "Leave the waiting list";
  return { key: "leave", kind: "leave", label, ...disabledIfClosed(bw) };
}

// ------------------------------------------------------------------ error copy

/**
 * The message to show when a command is rejected. We ALWAYS prefer the backend's own copy (an
 * ApiError.message carries the RFC-7807 `detail` — the specific, honest 409 text the API returns,
 * e.g. "That spot has already been taken — you are still on the waitlist."), falling back to
 * `fallback` only when there is none.
 */
export function commandErrorMessage(err, fallback = "Something went wrong. Please try again.") {
  const msg = err && typeof err.message === "string" ? err.message.trim() : "";
  return msg || fallback;
}

// ------------------------------------------------------------------ wireframe affordances (TM-513)
//
// Pure helpers backing the TM-513 visual refresh of the browse list + detail to the approved paper
// wireframes (design-kit/pages/paper-events-list, paper-event-detail). They only shape COPY/STATE
// off the same EventCard/EventDetail projection the tested model above reads — no new command paths,
// so the RSVP/waitlist/claim behaviour (and its e2e coverage) is unchanged. Kept here (pure) so the
// wireframe's pill / CTA / summary / chip states are unit-testable without a DOM.

/**
 * Is the event at (or over) capacity for a fresh joiner? Unlimited capacity (no `capacity`) is never
 * full. Mirrors `wouldLandGoing`'s capacity check but ignores the waitlist (a full event with a free
 * spot to CLAIM is still "full" for a brand-new RSVP).
 */
export function isFull(item) {
  const cap = firstNumber(item?.capacity);
  if (cap == null) return false;
  const going = firstNumber(item?.goingCount) ?? 0;
  return going >= cap;
}

/**
 * The left-hand pill on a browse card (the wireframe's `12 going` / `Full · waitlist N`). The EventCard
 * projection carries no waitlist count (only the detail does), so a full event the viewer isn't already
 * GOING to surfaces the bare `Full` — the "N going" count otherwise.
 * @returns {{label: string, full: boolean}}
 */
export function listCountPill(item) {
  if (isFull(item) && item?.myState !== "GOING") return { label: "Full", full: true };
  return { label: goingBadge(item?.goingCount), full: false };
}

/**
 * The right-hand action affordance on a browse card. The list is a BROWSE surface — the real
 * RSVP/waitlist/claim commands (with their confirm dialogs + the tested `rsvpControlModel`) live on the
 * DETAIL — so this is a state LABEL styled like the wireframe's button; tapping the card opens the
 * detail to act. Mirrors the wireframe states: `Going ✓` (done) · `Waitlisted` (done) · `Waitlist`
 * (ghost, when full) · `RSVP` (primary).
 * @returns {{label: string, variant: "primary"|"done"|"ghost"}}
 */
export function listCtaState(item) {
  if (item?.myState === "GOING") return { label: "Going ✓", variant: "done" };
  if (item?.myState === "WAITLISTED") return { label: "Waitlisted", variant: "done" };
  if (isFull(item)) return { label: "Waitlist", variant: "ghost" };
  return { label: "RSVP", variant: "primary" };
}

/**
 * The detail attendees summary — the wireframe's `8 going · 12 spots`. Always leads with the same
 * `goingBadge` copy the `event-going-count` badge already shows (so its tested text is unchanged);
 * `spots` is populated only when the event has a finite capacity ("" for unlimited/unknown).
 * @returns {{going: string, spots: string}}
 */
export function attendanceSummary(detail) {
  const cap = firstNumber(detail?.capacity);
  return { going: goingBadge(detail?.goingCount), spots: cap == null ? "" : `${cap} spots` };
}

/**
 * The browse filter chips (the wireframe's `All · Dog walks · Coffee · Sport · Nearby` row). The event
 * model has NO category field yet (see the EventCard projection: no `type`/`category`), so rather than
 * fabricate categories we surface DATA-BACKED status filters: `All`, plus `Going` / `Waitlisted` /
 * `Happening now` — each shown ONLY when ≥1 card matches, so the row never offers an empty filter.
 * (Reconcile with real categories + the shared chip component when a category field / TM-511 lands.)
 * @returns {{key: string, label: string}[]}  always begins with { key: "all", label: "All" }
 */
export function eventFilters(cards, nowMs = Date.now()) {
  const list = Array.isArray(cards) ? cards : [];
  const chips = [{ key: "all", label: "All" }];
  if (list.some((c) => c?.myState === "GOING")) chips.push({ key: "going", label: "Going" });
  if (list.some((c) => c?.myState === "WAITLISTED")) chips.push({ key: "waitlisted", label: "Waitlisted" });
  if (list.some((c) => isHappeningNow(c, nowMs))) chips.push({ key: "live", label: "Happening now" });
  return chips;
}

/** Apply a browse filter key to the card list. Unknown / "all" → the list unchanged. */
export function filterCards(cards, key, nowMs = Date.now()) {
  const list = Array.isArray(cards) ? cards : [];
  switch (key) {
    case "going":
      return list.filter((c) => c?.myState === "GOING");
    case "waitlisted":
      return list.filter((c) => c?.myState === "WAITLISTED");
    case "live":
      return list.filter((c) => isHappeningNow(c, nowMs));
    default:
      return list;
  }
}

/**
 * The browse-list render model for a set of cards at a given filter (TM-535). paintList (the DOM shell)
 * has to tell apart THREE "how do I render this list?" outcomes, and getting them apart is exactly the
 * decision that regressed in TM-513 — so it lives here in the unit-tested core, not the view:
 *
 *   • kind "empty"        — nothing to show for the UNFILTERED listing: either no cards at all, or every
 *                           card bucketed out (e.g. all finished — `listingBuckets` drops finished events
 *                           defensively even though the API already excludes them). A genuine "no events"
 *                           state, so the view renders the friendly events-empty block. With only the
 *                           `All` chip on offer there are no chips to show, so a filter note here would be
 *                           a dead end with no escape — the TM-535 bug.
 *   • kind "filter-empty" — a real, non-"all" filter matched nothing (edge: the only GOING event has since
 *                           ended). The chip row still offers a way back to All, so the view renders the
 *                           muted "No events match this filter" note inside the list container.
 *   • kind "list"         — there are cards to render; `happeningNow` / `upcoming` carry the split.
 *
 * @returns {{ kind: "empty"|"filter-empty"|"list", happeningNow: object[], upcoming: object[] }}
 */
export function browseListModel(cards, filter = "all", nowMs = Date.now()) {
  const list = Array.isArray(cards) ? cards : [];
  // Truly zero cards is always the empty state, whatever the (stale) filter key — matches the original
  // `!state.cards.length` guard.
  if (!list.length) return { kind: "empty", happeningNow: [], upcoming: [] };

  const { happeningNow, upcoming } = listingBuckets(filterCards(list, filter, nowMs), nowMs);
  if (happeningNow.length || upcoming.length) return { kind: "list", happeningNow, upcoming };

  // Nothing survived bucketing. Under the unfiltered "all" view that's a genuine empty state (e.g. every
  // event finished); only an actual status filter that matched nothing is the filter-empty note.
  const filtered = filter != null && filter !== "all";
  return { kind: filtered ? "filter-empty" : "empty", happeningNow, upcoming };
}
