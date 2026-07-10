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

import { listEvents, getEvent, getEventEntitlement, rsvpToEvent, cancelEventRsvp, claimEventSpot, getMe, listMyConversations, ApiError } from "./api.js";
import { el, clear, toast, confirmDialog } from "./ui.js";
import { doodle } from "./doodles.js";
import { isWebViewEnv } from "./auth-env.js";
import { platformFor } from "./push-env.js";
import * as core from "./events-core.js";
import * as cal from "./calendar-core.js";

const $ = (id) => document.getElementById(id);

// ── Inline SVG icons (TM-513) ─────────────────────────────────────────────────────────────────
// The paper wireframes ink a clock / pin beside the meta lines and a chevron in the hero back button.
// These are ALWAYS-VISIBLE structural icons — unlike the doodle asset pack (assets/doodles.js), which
// styles.css hides in clean Paper (shown only when the sketchy toggle is on) — so the wireframe's
// icons always render. Built via a tiny namespaced factory (createElement can't make SVG),
// attribute-only like ui.js `el()` / doodles.js — no innerHTML seam, all shapes are static.
const SVG_NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, String(v));
  for (const c of children) if (c) node.append(c);
  return node;
}
const ICON_SHAPES = {
  clock: () => [svgEl("circle", { cx: 12, cy: 12, r: 8.5 }), svgEl("path", { d: "M12 7.5V12l3 2" })],
  pin: () => [svgEl("path", { d: "M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11z" }), svgEl("circle", { cx: 12, cy: 10, r: 2.4 })],
  back: () => [svgEl("path", { d: "M15 5l-7 7 7 7" })],
};
/** A small decorative line-icon (clock / pin / back), inked with `currentColor` so it follows theme. */
function icon(name, size = 18) {
  return svgEl(
    "svg",
    {
      class: "tm-event-icon",
      viewBox: "0 0 24 24",
      width: size,
      height: size,
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 1.8,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
      focusable: "false",
    },
    (ICON_SHAPES[name] || (() => []))(),
  );
}

// Viewer formatting context: the browser's timezone + locale, so instants render in the viewer's
// local time (the AC) and in their number/date format. Both fail soft to sensible defaults.
const VIEWER_TZ = core.viewerTimeZone() || undefined;
const LOCALE = (typeof navigator !== "undefined" && navigator.language) || "en-GB";

// The last listing is cached so the detail's one-active-event derivation can name a GOING event the
// caller holds elsewhere, and for instant back-nav. It's best-effort — a miss just weakens that one
// gate (the backend 409 is the real guard). NB: the caller's /me (age gate) is deliberately NOT
// cached — it's fetched fresh per detail render so that adding an age in #/profile is reflected
// immediately on return, rather than showing a stale "add your age" until a reload.
// `filter` is the active browse chip (TM-513) — persisted across list re-paints so switching a chip
// doesn't refetch, and reset to "all" whenever it's no longer one of the offered (data-backed) chips.
const state = { cards: [], filter: "all" };
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
  paintList(view);
}

/**
 * The friendly "no events" empty state (the wireframe's calendar doodle + warm copy). Shared by the two
 * paths that have genuinely nothing to browse — zero cards, or an unfiltered listing that bucketed out to
 * nothing (TM-535) — so both surface the same `events-empty` testid the golden-path + events specs look
 * for, rather than a dead-end filter note.
 */
function eventsEmptyState() {
  return el("div", { class: "tm-empty", "data-testid": "events-empty" }, [
    doodle("calendar", { class: "tm-doodle-empty", title: "No upcoming events" }),
    el("p", { class: "tm-empty-title", text: "No upcoming events" }),
    el("p", { class: "tm-muted", text: "Check back soon — new meetups land here first." }),
  ]);
}

/**
 * Paint the browse list from the cached `state.cards` at the current `state.filter` (TM-513) — the
 * wireframe's `Events` header, the filter-chip row, then the cards grouped into Happening now /
 * Upcoming. Split from `renderList` so a chip tap re-paints without a refetch.
 */
function paintList(view) {
  const now = Date.now();
  const filters = core.eventFilters(state.cards, now);
  // The active chip might no longer be offered (data changed under it) → fall back to All.
  if (!filters.some((f) => f.key === state.filter)) state.filter = "all";

  clear(view).append(headerBar("Events"));

  // The core decides which of the three list states this is (see events-core `browseListModel`).
  const { kind, happeningNow, upcoming } = core.browseListModel(state.cards, state.filter, now);

  // Nothing to show for the UNFILTERED listing — no cards at all, or everything bucketed out (e.g. every
  // event has finished; `listingBuckets` drops finished events defensively). There are no chips to offer,
  // so this is the friendly empty state, NEVER the dead-end "No events match this filter" note (TM-535).
  // Uses the same `events-empty` testid the golden-path + events specs look for.
  if (kind === "empty") {
    view.append(eventsEmptyState());
    return;
  }

  // The filter-chip row — only when there's more than "All" to offer (i.e. some status filter matches).
  if (filters.length > 1) view.append(filterChips(view, filters));

  const list = el("div", { class: "tm-event-list", "data-testid": "events-list" });
  if (kind === "filter-empty") {
    // A non-empty listing filtered down to nothing under a real, non-"all" filter (edge: e.g. the only
    // GOING event has since ended). Keep the `events-list` container present (so the browse surface still
    // reads as rendered) with a muted note; the chip row above is the Show-all escape hatch.
    list.append(el("p", { class: "tm-muted tm-event-filter-empty", text: "No events match this filter." }));
  }
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

/**
 * The browse filter-chip row (the wireframe's pill chips). Data-backed status filters (see
 * events-core `eventFilters`) — the event model has no category field yet, so these are All / Going /
 * Waitlisted / Happening now rather than categories. // reconcile with TM-511 component library (chip)
 * + a real category field when either lands.
 */
function filterChips(view, filters) {
  const row = el("div", { class: "tm-event-chips", role: "tablist", "aria-label": "Filter events" });
  for (const f of filters) {
    const on = f.key === state.filter;
    row.append(
      el(
        "button",
        {
          type: "button",
          class: `tm-event-chip-filter${on ? " is-on" : ""}`,
          role: "tab",
          "aria-selected": on ? "true" : "false",
          dataset: { filter: f.key },
          onClick: () => {
            if (state.filter === f.key) return;
            state.filter = f.key;
            paintList(view);
          },
        },
        f.label,
      ),
    );
  }
  return row;
}

/**
 * One browse card (the wireframe's `paper-events-list` card): title, a `date · time · where` meta
 * line, and a row of the going/full pill + a state affordance styled like the wireframe's button. The
 * whole card is a LINK to the detail (where the real RSVP command runs), so the CTA is a non-interactive
 * label — tapping anywhere on the card, including it, opens the detail.
 */
function eventCard(card, { live }) {
  const when = core.formatWhen(card.startAt, { tz: VIEWER_TZ, locale: LOCALE });
  // The card's location may be withheld pre-reveal (TM-408) — degrade to a neutral line.
  const where = (card.locationText || card.city || "Location shared before the event").trim();
  const meta = [when || "Date to be confirmed", where].filter(Boolean).join(" · ");
  const pill = core.listCountPill(card);
  const cta = core.listCtaState(card);

  return el(
    "a",
    {
      class: `tm-event-card${live ? " tm-event-card-live" : ""}`,
      href: `#/events/${encodeURIComponent(card.id)}`,
      "data-testid": "event-card",
      dataset: { eventId: String(card.id) },
    },
    [
      // The wireframe's category `.tag` slot has no backing field yet — used only to surface the
      // data-backed "Happening now" state for a live event (else omitted). // reconcile with TM-511
      // (tag component) + a category field.
      live ? el("span", { class: "tm-event-tag tm-event-tag-live", text: "Happening now" }) : null,
      el("h3", { class: "tm-event-card-title", text: card.heading || "Untitled event" }),
      el("p", { class: "tm-event-meta", text: meta }),
      el("div", { class: "tm-event-card-row" }, [
        el("span", {
          class: `tm-event-pill${pill.full ? " tm-event-pill-full" : ""}`,
          "data-testid": "event-going-count",
          text: pill.label,
        }),
        // A state LABEL styled like the wireframe button (not itself interactive — the card link owns
        // the tap). // reconcile with TM-511 component library (button).
        el("span", { class: `tm-event-cta tm-event-cta-${cta.variant}`, "aria-hidden": "true", text: cta.label }),
      ]),
    ],
  );
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

  // TM-450: resolve this event's group-chat thread so the detail can offer an "Open chat" deep-link.
  // Fetched ONLY for members (a GOING attendee or an admin) — a non-member can't have a thread, so a
  // browse-by non-member pays no extra request and still gets the correct disabled-with-hint entry.
  // Best-effort: a failure just degrades to the "chat isn't ready yet" hint rather than blocking the
  // detail. Re-guard after the await so a slow response can't paint over a newer navigation.
  let conversations = [];
  if (core.isEventChatMember(detail, me)) {
    const conv = await listMyConversations().catch((err) => {
      console.warn("[events] conversations load failed (chat entry degrades):", err?.message ?? err);
      return null;
    });
    if (mine !== renderToken) return;
    conversations = conv?.items ?? [];
  }

  paintDetail(view, detail, me, conversations);
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

function paintDetail(view, detail, me, conversations = []) {
  const now = Date.now();
  const when = core.describeWhen(detail.startAt, detail.endAt, detail.timezone, { viewerTz: VIEWER_TZ, locale: LOCALE });
  const bandLabel = core.ageBandLabel(detail);
  const live = core.isHappeningNow(detail, now);

  clear(view).append(
    el("article", { class: "tm-event-detail", "data-testid": "event-detail", dataset: { eventId: String(detail.id) } }, [
      // Hero (the wireframe's boxed image with the back button top-left + a state tag top-right).
      detailHero(detail, { live }),
      el("h1", { class: "tm-event-title", text: detail.heading || "Untitled event" }),

      // When — clock icon + viewer-local date/time (event-local line when zones differ).
      whenSection(when),

      // Where — pin icon + reveal-aware location (TM-408).
      locationSection(detail, now),

      // Age band (TM-415) — shown whenever the event has one, independent of eligibility.
      bandLabel ? el("p", { class: "tm-badge tm-event-ageband", "data-testid": "event-age-band", text: bandLabel }) : null,

      // Body.
      detail.description ? el("section", { class: "tm-event-description", text: detail.description }) : null,

      // Attendees + counts + the wireframe's "N going · M spots" summary.
      attendeesSection(detail),

      // Map tile (the wireframe's "Map — tap to open in Maps") — reveal-aware.
      mapSection(detail, now),

      // Add to calendar (TM-398) — reveal-aware (never leaks the exact venue pre-reveal); hidden for
      // cancelled events. Returns null when there's nothing to add. Not in the wireframe, but a shipped
      // affordance kept below the body, above the sticky CTA.
      calendarSection(detail, now),

      // The action CTA — RSVP / waitlist / claim / cancel, driven entirely by the tested model.
      actionSection(view, detail, now, me),

      // "Open chat" entry (TM-450) — deep-links a member (GOING attendee or admin) into this event's
      // group-chat thread; disabled with a hint for non-members / when the thread isn't ready. Sits
      // just below the RSVP CTA so becoming eligible and jumping into the chat are adjacent.
      chatEntrySection(detail, me, conversations),
    ]),
  );
}

/**
 * The detail hero (the wireframe's boxed banner). A bordered box carrying the event image (when it's a
 * resolvable http(s) URL) with the circular back button overlaid top-left and, for a live event, a
 * "Happening now" tag top-right. With no image it's the plain bordered box the wireframe shows (the
 * doodle placeholder is intentionally dropped — it's `display:none` in clean Paper anyway).
 */
function detailHero(detail, { live }) {
  const path = (detail?.imagePath || "").trim();
  const kids = [];
  if (/^https?:\/\//i.test(path)) kids.push(el("img", { class: "tm-event-hero-img", src: path, alt: "", loading: "lazy" }));
  kids.push(
    el("a", { class: "tm-event-hero-back", href: "#/events", "aria-label": "Back to events" }, [icon("back", 18)]),
  );
  if (live) kids.push(el("span", { class: "tm-event-hero-tag", text: "Happening now" }));
  return el("div", { class: "tm-event-hero", "data-testid": "event-hero" }, kids);
}

/** The "when" block — a clock-iconed meta row of viewer-local date · time, plus an event-local line
 *  when the zones differ (TM-396). Keeps the `event-when` testid the e2e suite reads. */
function whenSection(when) {
  const line = [when.date || "Date to be confirmed"];
  if (when.time) line.push(` · ${when.time}`);
  if (when.tz) line.push(el("span", { class: "tm-muted", text: ` ${when.tz}` }));
  const kids = [metaRow(icon("clock"), line)];
  if (when.showEventLocal) {
    kids.push(
      el("p", {
        class: "tm-muted tm-event-when-local",
        text: `Event local time: ${when.eventLocalTime} ${when.eventLocalTz} (${when.eventTzCity})`,
      }),
    );
  }
  return el("section", { class: "tm-event-when-block", "data-testid": "event-when" }, kids);
}

/** A meta line: a leading line-icon + a text span (the wireframe's icon+text `.meta` rows). */
function metaRow(iconEl, textParts) {
  return el("p", { class: "tm-event-meta-row" }, [iconEl, el("span", {}, textParts)]);
}

function locationSection(detail, now) {
  const loc = core.locationView(detail, now);
  const line = [loc.primary];
  if (loc.approximate) line.push(el("span", { class: "tm-muted", text: " (approximate)" }));
  const children = [metaRow(icon("pin"), line)];
  if (loc.note) children.push(el("p", { class: "tm-muted tm-event-reveal", text: loc.note }));
  if (loc.onlineUrl) {
    children.push(
      el("a", { class: "tm-btn tm-btn-sm", href: loc.onlineUrl, target: "_blank", rel: "noopener", "data-testid": "event-online-link" }, "Join online"),
    );
  }
  return el("section", { class: "tm-event-location", "data-testid": "event-location" }, children);
}

/**
 * The map tile / "Open in Maps — Directions" affordance (TM-487, building on the wireframe's
 * "Map — tap to open in Maps"). Once the location is revealed and there is somewhere to point — the
 * curated venue `mapUrl`, else a query built from the exact location text — it becomes a real,
 * PLATFORM-CORRECT directions link: Apple Maps on iOS, a `geo:` intent on Android, Google Maps on the
 * web (all resolved by the pure, unit-tested `directionsModel`). It opens EXTERNALLY — `target="_blank"`
 * hands off to the system maps app / browser in the Capacitor shell rather than loading inside the
 * WebView (same external-open path the calendar links use). While the venue is still hidden it stays
 * the non-interactive "revealed later" placeholder; revealed-but-nowhere-to-go renders nothing.
 */
function mapSection(detail, now) {
  const model = core.directionsModel(detail, platformFor(), now);
  if (model.show) {
    return el(
      "a",
      {
        class: "tm-event-map tm-event-map-link",
        href: model.href,
        target: "_blank",
        rel: "noopener",
        "data-testid": "event-map-link",
        // No aria-label (TM-568): the visible text ("Open in Maps — Directions") is descriptive on its
        // own, so we let it BE the accessible name. A wordier aria-label that didn't contain the visible
        // words broke WCAG 2.5.3 Label in Name (Level A) — a speech-input user saying "Open in Maps"
        // couldn't activate the link. The pin icon is aria-hidden, so the name is exactly the span text.
      },
      [icon("pin"), el("span", { class: "tm-event-map-label", text: `${model.label} — Directions` })],
    );
  }
  if (core.locationView(detail, now).revealed === false) {
    return el("div", { class: "tm-event-map", "aria-hidden": "true" }, "Map opens once the venue is revealed");
  }
  return null;
}

// ------------------------------------------------------------------ add to calendar (TM-398)

/**
 * The "Add to calendar" disclosure. All of the decision logic (reveal-safe location, .ics text, the
 * Google / Outlook URLs, and the cancelled-hides-control gate) lives in the pure, unit-tested
 * calendar-core.js; this is the thin DOM shell. Returns null (renders nothing) when the model says
 * the control must be hidden — cancelled events, or anything without a start (the AC).
 *
 * A native <details> disclosure keeps it accessible and framework-free. The .ics is a JS blob
 * download (a generated file, not a navigation), so it's a <button>; Google and Outlook are real
 * outbound links.
 */
function calendarSection(detail, now) {
  // A deep-link back to this event, only for a real http(s) origin (never a capacitor:// scheme).
  const origin =
    typeof window !== "undefined" && /^https?:/.test(window.location?.origin || "") ? window.location.origin : "";
  const url = origin ? `${origin}/#/events/${encodeURIComponent(detail.id)}` : "";
  // `webView` gates the .ics option. Inside the Android/iOS native shell the blob + download-anchor
  // .ics is a SILENT no-op: the shell honours neither anchor-`download` nor `blob:` and `a.click()`
  // doesn't throw, so downloadIcs's catch→toast never fires and the tap does nothing (TM-422).
  // isWebViewEnv() reads the shell's signal (window.TEAMMARHABA_WEBVIEW / the JS bridge); it's false on
  // any normal page load, so web/mobile-web are unaffected. Mirrors the WebView hides in login.js
  // (TM-275) and app-badges.js (TM-330).
  const model = cal.addToCalendarModel(detail, now, { url, webView: isWebViewEnv() });
  if (!model.show) return null;

  // Google / Outlook are real https links opened externally, so they work everywhere — including the
  // WebView, where the .ics download can't. When the .ics button is withheld the user still has both of
  // these (never left with nothing); on web / mobile-web all three show.
  const options = [];
  if (model.icsDownloadable) {
    options.push(
      el(
        "button",
        {
          class: "tm-btn tm-btn-sm",
          type: "button",
          "data-testid": "calendar-ics",
          onClick: () => downloadIcs(model.icsFilename, model.ics),
        },
        [doodle("calendar", { class: "tm-event-cal-opt-icon", title: "" }), "Apple / iCal (.ics)"],
      ),
    );
  }
  options.push(
    el(
      "a",
      { class: "tm-btn tm-btn-sm", href: model.googleUrl, target: "_blank", rel: "noopener", "data-testid": "calendar-google" },
      "Google Calendar",
    ),
    el(
      "a",
      { class: "tm-btn tm-btn-sm", href: model.outlookUrl, target: "_blank", rel: "noopener", "data-testid": "calendar-outlook" },
      "Outlook",
    ),
  );

  const menu = el("div", { class: "tm-event-calendar-menu", role: "group", "aria-label": "Add to calendar" }, options);

  return el("details", { class: "tm-event-calendar", "data-testid": "event-add-to-calendar" }, [
    el("summary", { class: "tm-event-calendar-toggle" }, [
      doodle("calendar", { class: "tm-event-cal-icon", title: "" }),
      el("span", { text: "Add to calendar" }),
    ]),
    menu,
  ]);
}

/**
 * Trigger a client-side .ics download — a generated file, no server round-trip, via the standard blob +
 * download-anchor path. Only ever wired on web / mobile-web: the native Android/iOS WebView shell
 * honours neither anchor-`download` nor `blob:` and fails SILENTLY there (TM-422), so calendarSection
 * withholds this button in that env (`model.icsDownloadable`) and offers the Google/Outlook links
 * instead. Best-effort regardless: any failure degrades to a toast rather than a broken control.
 */
function downloadIcs(filename, icsText) {
  try {
    const blob = new Blob([icsText], { type: "text/calendar;charset=utf-8" });
    const objectUrl = URL.createObjectURL(blob);
    const a = el("a", { href: objectUrl, download: filename, rel: "noopener" });
    document.body.append(a);
    a.click();
    a.remove();
    // Revoke once the download has been handed off (a short delay is enough across browsers).
    setTimeout(() => URL.revokeObjectURL(objectUrl), 4000);
  } catch (err) {
    console.warn("[events] .ics download failed:", err?.message ?? err);
    toast("Couldn't prepare the calendar file. Please try again.", { type: "error" });
  }
}

function attendeesSection(detail) {
  const summary = core.attendanceSummary(detail); // { going: "8 going", spots: "12 spots" | "" }
  const attendees = Array.isArray(detail.attendees) ? detail.attendees : [];
  const overflow = Math.max(0, (Number(detail.goingCount) || 0) - attendees.length);
  const waitBadge = core.waitlistBadge(detail.waitlistedCount);

  const strip = el("div", { class: "tm-event-avatars", "aria-hidden": "true" });
  for (const a of attendees) {
    strip.append(el("span", { class: "tm-event-avatar", title: a.displayName || "Member", text: core.initials(a.displayName) }));
  }
  if (overflow > 0) strip.append(el("span", { class: "tm-event-avatar tm-event-avatar-more", text: `+${overflow}` }));

  // The wireframe's attendees row: the avatar strip beside "8 going · 12 spots". The going badge keeps
  // its `event-going-count` testid/copy; "· M spots" is appended when capacity is finite; the waitlist
  // badge follows when there's a queue.
  const countLine = el("p", { class: "tm-event-att-summary" }, [
    el("span", { class: "tm-badge tm-event-going", "data-testid": "event-going-count", text: summary.going }),
    summary.spots ? el("span", { class: "tm-muted tm-event-spots", text: ` · ${summary.spots}` }) : null,
    waitBadge ? el("span", { class: "tm-badge tm-event-waitlist", "data-testid": "event-waitlist-count", text: waitBadge }) : null,
  ]);

  return el("section", { class: "tm-event-attendees" }, [
    el("div", { class: "tm-event-att-head" }, [attendees.length ? strip : null, countLine]),
    attendees.length ? null : el("p", { class: "tm-muted", text: "No one's going yet — you could be the first." }),
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

/**
 * The "Open chat" entry (TM-450) — deep-links a member into this event's group-chat thread. The whole
 * decision (who sees it enabled, whether the thread exists, the disabled-hint copy) lives in the tested
 * core (`eventChatEntryModel`); this only renders the model. An ENABLED entry is an <a> — it navigates
 * to `#/chat/{conversationId}`, it isn't a command — so a plain tap/click (and cmd-click) works like any
 * link; the ineligible / not-ready states render a disabled <button> plus a muted hint, mirroring the
 * detail's existing disabled-action pattern (`aria-describedby` → the reason). Deliberately no chat.js
 * edits: this is the entry point, not the thread UI.
 */
function chatEntrySection(detail, me, conversations) {
  const model = core.eventChatEntryModel({ detail, me, conversations });
  const wrap = el("section", { class: "tm-event-chat-entry", "data-testid": "event-chat-entry" });

  if (model.enabled) {
    wrap.append(
      el("a", {
        class: "tm-btn tm-btn-primary tm-event-chat-open",
        href: model.href,
        "data-testid": "event-chat-open",
        dataset: { conversationId: String(model.conversationId) },
        text: model.label,
      }),
    );
    return wrap;
  }

  // Disabled: a non-member, or a member whose thread isn't provisioned yet. A disabled button plus the
  // honest reason so it's clear why chat isn't open and (for non-members) how to get in.
  wrap.append(
    el("button", {
      class: "tm-btn tm-event-chat-open",
      type: "button",
      disabled: true,
      "data-testid": "event-chat-open",
      "aria-describedby": "event-chat-entry-reason",
      text: model.label,
    }),
    el("p", {
      class: "tm-event-reason tm-muted",
      id: "event-chat-entry-reason",
      "data-testid": "event-chat-entry-reason",
      text: model.reason,
    }),
  );
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

// ------------------------------------------------------------------ paid per-event checkout (TM-624)

/**
 * Is the membership feature flag ON? Reads `window.TEAMMARHABA_CONFIG.flags.membership` (owned by
 * TM-480, shipped OFF). While it's off the paid-checkout detour below is entirely inert and the RSVP
 * flow behaves exactly as before — the same single flag every other membership surface gates on.
 */
function membershipEnabled() {
  const cfg = (typeof window !== "undefined" && window.TEAMMARHABA_CONFIG) || {};
  return Boolean(cfg.flags && cfg.flags.membership);
}

/**
 * Before a join that would land the caller GOING, decide whether it must detour through the paid
 * membership checkout (TM-624). Resolves the AUTHORITATIVE per-event entitlement (GET
 * /events/{id}/entitlement, TM-476) and — only for a PAY decision — opens the membership-checkout
 * screen (`window.tmMembershipCheckout.open`, which creates the order + mounts the Revolut card widget)
 * instead of the direct free RSVP. Returns true when the checkout has taken over (the caller must NOT
 * then run the free RSVP), false to fall through to the normal RSVP.
 *
 * Fail-safe: a failed/absent entitlement lookup returns false (fall through to the direct RSVP; the
 * backend stays the real gate). The one case we DON'T silently free-join is a confirmed PAY with the
 * checkout seam missing — that would let a paid event through for free — so we surface an error and
 * abort the join instead. Only ever called with the flag ON.
 * @param {object} detail the EventDetail being RSVP'd.
 * @returns {Promise<boolean>} true iff the checkout screen handled it (skip the direct RSVP).
 */
async function routePaidCheckout(detail) {
  let entitlement;
  try {
    entitlement = await getEventEntitlement(detail.id);
  } catch (err) {
    // Couldn't price the event — fall back to the normal RSVP path; the backend is the real gate.
    console.warn("[events] entitlement load failed; falling back to direct RSVP:", err?.message ?? err);
    return false;
  }
  if (!core.requiresPaidCheckout(entitlement)) return false; // FREE / INCLUDED / UPGRADE → normal RSVP

  // PAY: this event costs the caller money — route through the checkout screen rather than free-RSVPing.
  const checkout = typeof window !== "undefined" ? window.tmMembershipCheckout : null;
  if (!checkout || typeof checkout.open !== "function") {
    // The checkout module isn't available — do NOT quietly join a paid event for free. Surface it and
    // abort the join (returning true skips the direct RSVP below).
    toast("Checkout isn't available right now. Please try again.", { type: "error" });
    return true;
  }
  await checkout.open(detail);
  return true;
}

/** Dispatch a control action → the API, then re-render the detail with fresh counts/state. */
async function runCommand(view, detail, spec) {
  if (spec.disabled) return;
  const id = detail.id;

  // Paid per-event checkout (TM-624): a fresh RSVP that would land the caller GOING must run through the
  // membership checkout when the event is a PAY event for them (per GET /events/{id}/entitlement) —
  // otherwise the RSVP button joins paid/premium events for free. Only the join→GOING `rsvp` kind is
  // gated: joining a WAITLIST is not attendance (no charge until a spot is actually claimed), and leave/
  // claim are handled by the backend. Inert while the flag is OFF, so behaviour is unchanged there.
  if (spec.kind === "rsvp" && membershipEnabled()) {
    const handledByCheckout = await routePaidCheckout(detail);
    if (handledByCheckout) return; // checkout screen owns the order + payment (or aborted on error)
  }

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
