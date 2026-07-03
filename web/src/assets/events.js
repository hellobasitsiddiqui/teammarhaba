// User-facing Events UI (TM-396) — the #/events browse list and #/events/{id} detail, the TM-377
// journey-3 storyboard made real: browse → detail → RSVP → confirm → "you're on the list", plus the
// waitlist / offer-cascade claim states. A framework-free view module in the profile.js / admin.js
// mould: the router (TM-109) owns route + visibility and calls enterEvents(id) on entry; this module
// builds into #events-view, fetches, and renders.
//
// All decision logic (local-time formatting, listing split, reveal-aware location, the RSVP control
// model with the TM-413 cutoff / one-active-event gates and the TM-415 age gate) lives in the pure,
// unit-tested events-core.js. This module is the thin DOM shell around it, and always surfaces the
// backend's own 409 copy on a rejected command (the server is the real gate).
//
// XSS-safety is inherited from ui.js `el()` (textContent only, no innerHTML seam) — event headings,
// descriptions, locations and attendee names are all untrusted and can never inject markup.

import { listEvents, getEvent, rsvpToEvent, cancelEventRsvp, claimEventSpot, getMe, ApiError } from "./api.js";
import { el, clear, toast, confirmDialog, relativeTime } from "./ui.js";
import { doodle } from "./doodles.js";
import * as core from "./events-core.js";

const $ = (id) => document.getElementById(id);

// Viewer formatting context: the browser's timezone + locale, so instants render in the viewer's
// local time (the AC) and in their number/date format. Both fail soft to sensible defaults.
const VIEWER_TZ = core.viewerTimeZone() || undefined;
const LOCALE = (typeof navigator !== "undefined" && navigator.language) || "en-GB";

// The last listing is cached so the detail's one-active-event derivation can name a GOING event the
// caller holds elsewhere, and for instant back-nav. It's best-effort — a miss just weakens that one
// gate (the backend 409 is the real guard). NB: the caller's /me (age gate) is deliberately NOT
// cached — it's fetched fresh per detail render so that adding an age in #/profile is reflected
// immediately on return, rather than showing a stale "add your age" until a reload.
const state = { cards: [] };
// Monotonic guard so a slow fetch that resolves after the user has navigated away can't paint stale
// content over the new view (mirrors the router's settle-or-fallback discipline).
let renderToken = 0;

/** Fetch /me for the age gate — fresh each call, degrading to null (age "unknown") on any failure. */
async function loadMe() {
  try {
    return await getMe();
  } catch (err) {
    console.warn("[events] GET /me failed (age gate degrades to unknown):", err?.message ?? err);
    return null;
  }
}

// ------------------------------------------------------------------ entry point (router calls this)

/**
 * Router entry (TM-109). `eventId` is the detail id parsed from `#/events/{id}`, or null/undefined
 * for the `#/events` list. Re-invoked on every entry so list↔detail↔another-detail navigation always
 * shows fresh counts/state.
 */
export function enterEvents(eventId) {
  const view = $("events-view");
  if (!view) return;
  if (eventId != null && eventId !== "") renderDetail(view, String(eventId));
  else renderList(view);
}

// ------------------------------------------------------------------ shared chrome

function headerBar(title, { back } = {}) {
  return el("div", { class: "tm-admin-head tm-event-head" }, [
    el("h2", {}, [doodle("calendar", { class: "tm-doodle-header", title }), title]),
    back ? el("a", { class: "tm-btn tm-btn-sm", href: back.href }, back.label) : null,
  ]);
}

function loadingBlock(view, title) {
  clear(view).append(headerBar(title), el("p", { class: "tm-muted", text: "Loading…" }));
}

function errorBlock(view, title, message, onRetry) {
  clear(view).append(
    headerBar(title),
    el("div", { class: "tm-error tm-empty" }, [
      doodle("chat", { class: "tm-doodle-empty", title: message }),
      el("p", { text: message }),
      onRetry ? el("button", { class: "tm-btn", type: "button", onClick: onRetry }, "Retry") : null,
    ]),
  );
}

// ------------------------------------------------------------------ browse list (#/events)

async function renderList(view) {
  const mine = ++renderToken;
  loadingBlock(view, "Events");
  let data;
  try {
    data = await listEvents();
  } catch (err) {
    if (mine !== renderToken) return;
    errorBlock(view, "Events", "Couldn't load events. Please try again.", () => renderList(view));
    console.warn("[events] list load failed:", err?.message ?? err);
    return;
  }
  if (mine !== renderToken) return;

  state.cards = Array.isArray(data?.items) ? data.items : [];
  const { happeningNow, upcoming } = core.listingBuckets(state.cards, Date.now());

  clear(view).append(headerBar("Events"));

  if (!happeningNow.length && !upcoming.length) {
    view.append(
      el("div", { class: "tm-empty", "data-testid": "events-empty" }, [
        doodle("calendar", { class: "tm-doodle-empty", title: "No upcoming events" }),
        el("p", { class: "tm-empty-title", text: "No upcoming events" }),
        el("p", { class: "tm-muted", text: "Check back soon — new meetups land here first." }),
      ]),
    );
    return;
  }

  const list = el("div", { class: "tm-event-list", "data-testid": "events-list" });
  if (happeningNow.length) {
    list.append(
      el("h3", { class: "tm-event-section", "data-testid": "events-happening-now" }, [
        el("span", { class: "tm-event-live-dot", "aria-hidden": "true" }),
        "Happening now",
      ]),
    );
    for (const c of happeningNow) list.append(eventCard(c, { live: true }));
  }
  if (upcoming.length) {
    if (happeningNow.length) list.append(el("h3", { class: "tm-event-section", text: "Upcoming" }));
    for (const c of upcoming) list.append(eventCard(c, { live: false }));
  }
  view.append(list);
}

/** One browse card — a link to the detail answering what / when / where + the two live badges. */
function eventCard(card, { live }) {
  const chip = core.myStateChip(card.myState);
  const when = core.formatWhen(card.startAt, { tz: VIEWER_TZ, locale: LOCALE });
  const rel = relativeTime(card.startAt);
  // The card's location may be withheld pre-reveal (TM-408) — degrade to a neutral line.
  const where = (card.locationText || card.city || "Location shared before the event").trim();

  return el(
    "a",
    {
      class: `tm-event-card${live ? " tm-event-card-live" : ""}`,
      href: `#/events/${encodeURIComponent(card.id)}`,
      "data-testid": "event-card",
      dataset: { eventId: String(card.id) },
    },
    [
      eventThumb(card, "tm-event-thumb"),
      el("div", { class: "tm-event-card-body" }, [
        el("div", { class: "tm-event-card-top" }, [
          live ? el("span", { class: "tm-event-badge-live", text: "Live now" }) : null,
          chip ? el("span", { class: `tm-event-chip ${chip.cls}`, text: chip.label }) : null,
        ]),
        el("h4", { class: "tm-event-card-title", text: card.heading || "Untitled event" }),
        el("p", { class: "tm-event-when" }, [
          el("span", { text: when || "Date to be confirmed" }),
          when ? el("span", { class: "tm-muted tm-event-rel", text: ` · ${rel.text}` }) : null,
        ]),
        el("p", { class: "tm-event-where tm-muted", text: where }),
        el("div", { class: "tm-event-card-badges" }, [
          el("span", { class: "tm-badge tm-event-going", "data-testid": "event-going-count", text: core.goingBadge(card.goingCount) }),
        ]),
      ]),
    ],
  );
}

/** The event image if it's a resolvable absolute URL, else a themed doodle placeholder (TM-215). */
function eventThumb(item, cls) {
  const path = (item?.imagePath || "").trim();
  if (/^https?:\/\//i.test(path)) {
    return el("img", { class: cls, src: path, alt: "", loading: "lazy" });
  }
  // imagePath is a storage path (not yet a served URL) or absent → warm placeholder motif.
  return el("div", { class: `${cls} tm-event-thumb-placeholder`, "aria-hidden": "true" }, [
    doodle("ticket", { title: "" }),
  ]);
}

// ------------------------------------------------------------------ detail (#/events/{id})

async function renderDetail(view, id) {
  const mine = ++renderToken;
  loadingBlock(view, "Event");
  let detail;
  let me = null;
  try {
    // Fetch the detail + a FRESH /me together (age gate); opportunistically warm the listing cache
    // (for the one-active-event derivation) if we don't have it, without letting its failure block.
    const listPromise = state.cards.length ? Promise.resolve(null) : listEvents().catch(() => null);
    const [d, m] = await Promise.all([getEvent(id), loadMe()]);
    detail = d;
    me = m;
    const listData = await listPromise;
    if (listData?.items) state.cards = listData.items;
  } catch (err) {
    if (mine !== renderToken) return;
    if (err instanceof ApiError && err.status === 404) {
      notFoundBlock(view);
      return;
    }
    errorBlock(view, "Event", "Couldn't load this event. Please try again.", () => renderDetail(view, id));
    console.warn("[events] detail load failed:", err?.message ?? err);
    return;
  }
  if (mine !== renderToken) return;

  paintDetail(view, detail, me);
}

function notFoundBlock(view) {
  clear(view).append(
    headerBar("Event", { back: { href: "#/events", label: "← Events" } }),
    el("div", { class: "tm-empty", "data-testid": "event-not-found" }, [
      doodle("calendar", { class: "tm-doodle-empty", title: "Event unavailable" }),
      el("p", { class: "tm-empty-title", text: "This event isn't available anymore" }),
      el("p", { class: "tm-muted", text: "It may have finished, been cancelled, or isn't public yet." }),
      el("a", { class: "tm-btn", href: "#/events" }, "Back to events"),
    ]),
  );
}

function paintDetail(view, detail, me) {
  const now = Date.now();
  const when = core.describeWhen(detail.startAt, detail.endAt, detail.timezone, { viewerTz: VIEWER_TZ, locale: LOCALE });
  const bandLabel = core.ageBandLabel(detail);

  clear(view).append(
    el("article", { class: "tm-event-detail", "data-testid": "event-detail", dataset: { eventId: String(detail.id) } }, [
      headerBar("Event", { back: { href: "#/events", label: "← Events" } }),
      eventThumb(detail, "tm-event-hero"),
      el("h3", { class: "tm-event-title", text: detail.heading || "Untitled event" }),

      // When — viewer-local, with an event-local line when the zones differ.
      el("section", { class: "tm-event-when-block", "data-testid": "event-when" }, [
        el("p", { class: "tm-event-when-date", text: when.date || "Date to be confirmed" }),
        when.time ? el("p", { class: "tm-event-when-time" }, [`${when.time}`, when.tz ? el("span", { class: "tm-muted", text: ` ${when.tz}` }) : null]) : null,
        when.showEventLocal
          ? el("p", { class: "tm-muted tm-event-when-local", text: `Event local time: ${when.eventLocalTime} ${when.eventLocalTz} (${when.eventTz})` })
          : null,
      ]),

      // Age band (TM-415) — shown whenever the event has one, independent of eligibility.
      bandLabel ? el("p", { class: "tm-badge tm-event-ageband", "data-testid": "event-age-band", text: bandLabel }) : null,

      // Location — reveal-aware (TM-408).
      locationSection(detail, now),

      // Body.
      detail.description ? el("section", { class: "tm-event-description", text: detail.description }) : null,

      // Attendees + counts.
      attendeesSection(detail),

      // The action area — RSVP / waitlist / claim / cancel, driven entirely by the tested model.
      actionSection(view, detail, now, me),
    ]),
  );
}

function locationSection(detail, now) {
  const loc = core.locationView(detail, now);
  const children = [
    el("h4", { class: "tm-event-subhead", text: "Where" }),
    el("p", { class: "tm-event-location-primary" }, [
      doodle("pin", { class: "tm-event-pin", title: "" }),
      el("span", { text: loc.primary }),
      loc.approximate ? el("span", { class: "tm-muted", text: " (approximate)" }) : null,
    ]),
  ];
  if (loc.note) children.push(el("p", { class: "tm-muted tm-event-reveal-note", text: loc.note }));
  if (loc.mapUrl) {
    children.push(el("a", { class: "tm-btn tm-btn-sm", href: loc.mapUrl, target: "_blank", rel: "noopener", "data-testid": "event-map-link" }, "Open map"));
  }
  if (loc.onlineUrl) {
    children.push(el("a", { class: "tm-btn tm-btn-sm", href: loc.onlineUrl, target: "_blank", rel: "noopener", "data-testid": "event-online-link" }, "Join online"));
  }
  return el("section", { class: "tm-event-location", "data-testid": "event-location" }, children);
}

function attendeesSection(detail) {
  const going = core.goingBadge(detail.goingCount);
  const attendees = Array.isArray(detail.attendees) ? detail.attendees : [];
  const overflow = Math.max(0, (Number(detail.goingCount) || 0) - attendees.length);
  const waitBadge = core.waitlistBadge(detail.waitlistedCount);

  const strip = el("div", { class: "tm-event-avatars", "aria-hidden": "true" });
  for (const a of attendees) {
    strip.append(el("span", { class: "tm-event-avatar", title: a.displayName || "Member", text: core.initials(a.displayName) }));
  }
  if (overflow > 0) strip.append(el("span", { class: "tm-event-avatar tm-event-avatar-more", text: `+${overflow}` }));

  return el("section", { class: "tm-event-attendees" }, [
    el("div", { class: "tm-event-counts" }, [
      el("span", { class: "tm-badge tm-event-going", "data-testid": "event-going-count", text: going }),
      waitBadge ? el("span", { class: "tm-badge tm-event-waitlist", "data-testid": "event-waitlist-count", text: waitBadge }) : null,
    ]),
    attendees.length ? strip : el("p", { class: "tm-muted", text: "No one's going yet — you could be the first." }),
  ]);
}

// ------------------------------------------------------------------ the action area

function actionSection(view, detail, now, me) {
  const model = core.rsvpControlModel({ detail, me, cards: state.cards, nowMs: now });
  const wrap = el("section", { class: "tm-event-actions", "data-testid": "event-actions" });

  // My-state chip (✓ Going / Waitlisted) sits above the button.
  if (model.chip) {
    wrap.append(el("p", { class: `tm-event-chip tm-event-mystate ${model.chip.cls}`, "data-testid": "event-mystate", text: model.chip.label }));
  }

  if (model.primary) wrap.append(actionButton(view, detail, model.primary, "event-primary-action"));
  if (model.secondary) wrap.append(actionButton(view, detail, model.secondary, "event-secondary-action"));

  // The reminder / context note (enabled state) or, for a disabled button, the honest reason (+ link).
  if (model.primary?.disabled && model.primary.reason) {
    const reason = el("p", { class: "tm-event-reason tm-muted", "data-testid": "event-action-reason", text: model.primary.reason });
    if (model.primary.link) {
      reason.append(" ");
      reason.append(el("a", { href: model.primary.link.href, class: "tm-event-reason-link" }, model.primary.link.label));
    }
    wrap.append(reason);
  } else if (model.remindNote) {
    wrap.append(el("p", { class: "tm-event-remind tm-muted", "data-testid": "event-remind-note", text: model.remindNote }));
  }

  return wrap;
}

/** Build one action button from a control-model spec and wire its command. */
function actionButton(view, detail, spec, testid) {
  const cls = [
    "tm-btn",
    spec.prominent ? "tm-btn-primary" : "",
    spec.danger ? "tm-btn-danger" : "",
  ].filter(Boolean).join(" ");
  return el("button", {
    class: cls || "tm-btn",
    type: "button",
    disabled: Boolean(spec.disabled),
    "data-testid": testid,
    dataset: { kind: spec.kind },
    "aria-describedby": spec.disabled ? "event-action-reason" : null,
    onClick: () => runCommand(view, detail, spec),
  }, spec.label);
}

/** Dispatch a control action → the API, then re-render the detail with fresh counts/state. */
async function runCommand(view, detail, spec) {
  if (spec.disabled) return;
  const id = detail.id;

  // RSVP that lands GOING gets the confirm dialog ("we'll remind you the day before").
  if (spec.confirm) {
    const ok = await confirmDialog({
      title: spec.confirm.title,
      message: spec.confirm.message,
      confirmLabel: spec.confirm.confirmLabel || "Confirm",
    });
    if (!ok) return;
  }
  // Leaving (cancel RSVP / leave the waitlist) confirms too, so it's not a one-tap mistake.
  if (spec.kind === "leave") {
    const ok = await confirmDialog({
      title: detail.myState === "GOING" ? "Cancel your RSVP?" : "Leave the waiting list?",
      message: detail.myState === "GOING" ? "You'll give up your spot for this event." : "You'll lose your place in the queue.",
      confirmLabel: detail.myState === "GOING" ? "Cancel RSVP" : "Leave",
      danger: true,
    });
    if (!ok) return;
  }

  try {
    if (spec.kind === "rsvp" || spec.kind === "waitlist") {
      const result = await rsvpToEvent(id);
      toast(result.state === "GOING" ? "You're going 🎉 — we'll remind you the day before." : "You're on the waiting list — we'll let you know if a spot opens.", { type: "success" });
    } else if (spec.kind === "claim") {
      const result = await claimEventSpot(id);
      toast(result.state === "GOING" ? "You're in! 🎉 See you there." : "Updated.", { type: "success" });
    } else if (spec.kind === "leave") {
      await cancelEventRsvp(id);
      toast("Your RSVP has been removed.", { type: "info" });
    }
  } catch (err) {
    // Surface the backend's specific 409 copy (booking cutoff / one-active-event / age band / lost
    // claim race) rather than a generic error. A 401 will already have redirected via apiFetch.
    toast(core.commandErrorMessage(err), { type: "error" });
  } finally {
    // Always re-fetch — even on error the server state may have moved (e.g. a lost claim race means
    // the spot's gone and we're still waitlisted), so the UI must reflect the truth.
    renderDetail(view, id);
  }
}

// Bridge for the router (which imports this) + ad-hoc use.
if (typeof window !== "undefined") {
  window.tmEvents = { enterEvents };
}
