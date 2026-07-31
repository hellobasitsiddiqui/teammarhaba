// Admin events console (TM-395, epic TM-390) — ADMIN-only. The admin surface for the events MVP:
// lists the FULL event inventory (cancelled + not-yet-visible + finished included), and creates,
// edits and cancels events against the admin API (TM-392). Mounts into #admin-events-view; the
// router (TM-109) gates the ADMIN-only #/admin/events route, exactly as it gates #/admin.
//
// This file is the DOM/mount half; the pure, browser-free logic (validation mirroring the API DTOs,
// UTC ⇄ local-wall-clock conversion, the payload builder, the display derivations) lives in
// event-form.js so `node --test` can assert it without a browser or the Firebase SDK — the same split
// admin.js ↔ broadcast.js uses. The create/edit form is its OWN full-page admin route (TM-426):
// #/admin/events/new and #/admin/events/{id}/edit render into #admin-event-form-view, so the form
// scrolls with the page (no height cap) and the submit button is always reachable — the modal it
// replaced overflowed short viewports and hid the submit button (TM-421). The list and the form are
// separate views, so a background list refresh can't disturb an in-progress draft either.
//
// Backend contract consumed (TM-392, ADMIN-gated):
//   GET    /api/v1/admin/events            — paged full inventory (PageResponse<EventResponse>)
//   GET    /api/v1/admin/events/{id}       — one event
//   POST   /api/v1/admin/events            — create (201)
//   PATCH  /api/v1/admin/events/{id}       — partial edit (null = leave unchanged)
//   POST   /api/v1/admin/events/{id}/cancel — cancel (kept as CANCELLED; idempotent)
// Event images ride the house avatar pattern (TM-166): the image is uploaded to Storage at
// `event-images/{id}` AFTER the id exists, then its path is persisted with a follow-up PATCH.

import { apiFetch, ApiError } from "./api.js";
import { walkPages } from "./admin-page-walk-core.js";
import { clear, confirmDialog, el, ensureZoneOption, fillTimeZoneOptions, guessTimeZone, modal, relativeTime, stackableTable, toast } from "./ui.js";
import { doodle } from "./doodles.js";
import { isStorageConfigured, uploadEventImage, validateEventImageFile, MAX_EVENT_IMAGE_BYTES, downloadUrlForPath } from "./storage.js";
import { eventImageRef } from "./events-core.js";
import {
  HEADING_MAX,
  DESCRIPTION_MAX,
  LOCATION_MAX,
  URL_MAX,
  CITY_MAX,
  OPENING_MESSAGE_MAX,
  REVEAL_HOURS_MIN,
  REVEAL_HOURS_MAX,
  BOOKING_CUTOFF_HOURS_MIN,
  BOOKING_CUTOFF_HOURS_MAX,
  AGE_MIN_BOUND,
  AGE_MAX_BOUND,
  CATEGORY_CHIPS,
  isValidTimeZone,
  deriveVenueTimezone,
  validateEventDraft,
  buildEventPayload,
  clearedOptionalFields,
  toFormModel,
  eventLifecycle,
  capacityLabel,
  LIFECYCLE_FILTERS,
  matchesLifecycleFilter,
  attendanceCounts,
  overCapacityState,
  overCapacityWarning,
  revealSummary,
  bookingCutoffSummary,
  effectiveBookingCutoffHours,
  formatEventWhen,
  isPastEvent,
  partitionEventsByPast,
  EVENT_FORMAT_INPERSON,
  EVENT_FORMAT_ONLINE,
  formatFromEvent,
  mapUrlPreviewState,
  startChips,
  endChips,
  visibleFromChips,
  visibleUntilChips,
  revealHourChips,
  AGE_DEFAULT_MIN,
  AGE_DEFAULT_MAX,
  AGE_BAND_CUSTOM,
  AGE_BAND_PRESETS,
  OPENING_MESSAGE_TEMPLATES,
  DESCRIPTION_TEMPLATES,
  blankFormModel,
  isDirtyDraft,
  ageBandToMinMax,
  minMaxToAgeBand,
  PRICE_CHIP_CUSTOM,
  PRICE_CHIP_PRESETS,
  PRICE_DEFAULT_CHIP,
  priceChipToPence,
  penceToPriceChip,
  penceToPounds,
  CLONE_OFFSET_PRESETS,
  buildCloneDraft,
  pastStartWarning,
  SERIES_FREQ_DAILY,
  SERIES_FREQ_WEEKLY,
  SERIES_FREQUENCIES,
  SERIES_WEEKDAYS,
  SERIES_END_UNTIL,
  SERIES_END_AFTER,
  SERIES_INTERVAL_MIN,
  weekdayOfLocal,
  validateSeriesDraft,
  buildSeriesPayload,
} from "./event-form.js";
import { ADMIN_EVENTS_ROUTE, adminEventNewHash, adminEventEditHash, adminEventRosterHash } from "./admin-event-route.js";
import {
  ROSTER_FILTER_CHIPS,
  defaultChipSelection,
  rosterStateBadge,
  mergeRosterRows,
  filterRosterRows,
} from "./roster-core.js";
import { venueSummaryLabel } from "./admin-venues-core.js";
import { CITY_OPTIONS, cityChoiceError } from "./profile-core.js";
// TM-1174: the City dropdown reads the ADMIN-MANAGED catalogue (offeredCityNames), not the hardcoded
// CITY_OPTIONS. loadCityCatalogue primes it once on form mount; the static CITY_OPTIONS options on the
// city FORM_FIELDS entry stay as the offline FALLBACK so the first paint is never empty. cityOptionRows
// / isOffListCity are the pure option-row + off-list helpers (unit-tested in admin-city-select-core.test.mjs).
import { loadCityCatalogue, offeredCityNames } from "./city-catalogue.js";
import { cityOptionRows, isOffListCity } from "./admin-city-select-core.js";
import { adminVenueNewHash } from "./admin-venues-route.js";
import { clampPage } from "./admin-paging-core.js";
import { statsCards } from "./admin-stats-core.js";

const FETCH_SIZE = 100; // page size PER REQUEST of the full-inventory walk — matches the server max page size (TM-115)
const MAX_FETCH_PAGES = 50; // runaway guard on the walk (× FETCH_SIZE = 5,000 events)
const PAGE_SIZES = [10, 25, 50];

// The default lifecycle-chip selection (TM-1096): the console lands showing only what's LIVE — an
// admin's most common "what do I need to look at right now" view. Empty selection ⇒ show all; the
// available buckets live on LIFECYCLE_FILTERS (event-form.js). Cloned per mount so the shared default
// array never mutates.
const DEFAULT_LIFECYCLE_FILTER = ["Happening"];

const COLUMNS = [
  { key: "heading", label: "Event", sortable: true },
  { key: "startAt", label: "Start", sortable: true },
  { key: "status", label: "Status", sortable: true },
  { key: "attendance", label: "Going / Waitlist", sortable: false },
  { key: "capacity", label: "Capacity", sortable: false },
];

const state = {
  events: [],
  totalEvents: 0,
  fetchComplete: true,
  fetchPartial: false, // a page failed mid-walk — `events` is a prefix of the true inventory (TM-727)
  fetchTruncated: false, // the runaway guard tripped before the last page — `events` is a prefix (TM-727)
  loading: false,
  error: null,
  search: "",
  // TM-1096: multi-select lifecycle filter (was a single-select status dropdown). A Set of the selected
  // lifecycle labels; empty ⇒ show all. Defaults to { Happening } so the list lands on live events.
  lifecycleFilter: new Set(DEFAULT_LIFECYCLE_FILTER),
  sortKey: "startAt",
  sortDir: "desc",
  page: 0,
  pageSize: 25,
  // TM-1115 roster PAGE (was TM-592's inline expando — retired; ONE render path now). The Roster button
  // navigates to #/admin/events/{id}/roster; the page mounts into #admin-event-roster-view. These hold
  // the event being shown, the last-loaded roster payload (entries + pastEntries, TM-1114), its load/error
  // status, and the include/exclude chip selection (a Set of enabled roster-state keys — waitlist on,
  // evicted/cancelled off by default). Chip toggling filters the already-fetched set with NO refetch.
  rosterEventId: null, // the id of the event whose roster page is currently mounted (null = none)
  rosterEvent: null, // the resolved EventResponse for the page header / capacity default
  roster: null, // the { eventId, capacity, going, waitlist, entries, pastEntries } payload
  rosterLoading: false,
  rosterError: null,
  rosterChips: defaultChipSelection(), // enabled include/exclude chip state keys (client-side filter)
};

let shell = null; // { head, stats, toolbar, table, pager } persistent containers

// ---- data ---------------------------------------------------------------------------------

/**
 * One authenticated call to the admin events API. Goes through apiFetch (Bearer + 401 refresh/retry/
 * redirect, TM-108) — never a hand-rolled fetch. A non-2xx is parsed as RFC-7807 and thrown as the
 * shared {@link ApiError}, carrying `.status` and (for a 400) the per-field `errors` so the form can
 * paint them next to the offending inputs. A 204 resolves to null.
 */
async function eventApi(path, { method = "GET", body } = {}) {
  const res = await apiFetch(path, {
    method,
    headers: body
      ? { "Content-Type": "application/json", Accept: "application/json" }
      : { Accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 403) throw new ApiError(403, "You need an admin role to manage events.");
  if (!res.ok) {
    const problem = await res.json().catch(() => ({}));
    const fieldErrors = Array.isArray(problem.errors) ? problem.errors : [];
    throw new ApiError(res.status, problem.detail || problem.title || `Request failed (${res.status})`, fieldErrors);
  }
  return res.status === 204 ? null : res.json();
}

/**
 * Load the WHOLE event inventory by walking the paged endpoint (TM-392) — small scale (an admin plans
 * tens of events), so we hold them in memory and search/filter/sort/paginate in the browser, mirroring
 * the admin users console (admin.js). Newest-scheduled first from the server; the client sort can
 * re-order. A page failing mid-walk keeps what loaded and flags the fetch partial (TM-727); only a
 * failure with nothing loaded errors the table. Hitting the runaway guard flags the fetch truncated.
 */
export async function loadEvents() {
  // TM-751 re-entry guard: a second Refresh while a load is already running would start a whole second
  // concurrent page walk (walkPages walks EVERY page), doubling request volume and racing two result
  // sets into state.events. Bail if one's in flight — mirrors the guarded loadUsers() in admin.js.
  if (state.loading) return;
  state.loading = true;
  state.error = null;
  render();
  // The walk is a pure, DOM-free helper (admin-page-walk-core.js) so its keep-partial / surface-
  // truncation contract is unit-tested; here we just fetch each page and reflect the result into state.
  const result = await walkPages(
    (page) => eventApi(`/api/v1/admin/events?page=${page}&size=${FETCH_SIZE}&sort=startAt,desc`),
    { pageSize: FETCH_SIZE, maxPages: MAX_FETCH_PAGES },
  );
  if (result.error) {
    // Nothing loaded — surface the failure and clear the table.
    state.error = result.error instanceof ApiError ? result.error.message : "Could not load events.";
    state.events = [];
    state.totalEvents = 0;
    state.fetchComplete = true;
    state.fetchPartial = false;
    state.fetchTruncated = false;
  } else {
    state.error = null;
    state.events = result.items; // whatever loaded — kept even when a later page failed (partial)
    state.totalEvents = result.total;
    state.fetchComplete = result.complete;
    state.fetchPartial = result.partial;
    state.fetchTruncated = result.truncated;
  }
  state.loading = false;
  state.page = 0;
  render();
}

// ---- derived view -------------------------------------------------------------------------

function filteredEvents(now) {
  const q = state.search.trim().toLowerCase();
  return state.events.filter((e) => {
    // TM-1096: match against the DERIVED lifecycle label via the pure multi-select predicate — an event
    // shows if its lifecycle bucket is in the selected chip set (empty set ⇒ all).
    if (!matchesLifecycleFilter(e, state.lifecycleFilter, now)) return false;
    if (q) {
      const haystack = [e.heading, e.locationText, e.city].filter(Boolean).join(" ").toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

function sortEvents(list, now) {
  const { sortKey, sortDir } = state;
  const dir = sortDir === "desc" ? -1 : 1;
  const keyOf = (e) => {
    if (sortKey === "startAt") return new Date(e.startAt).getTime() || 0;
    if (sortKey === "status") return eventLifecycle(e, now).label;
    return String(e[sortKey] ?? "").toLowerCase();
  };
  return [...list].sort((a, b) => {
    const av = keyOf(a);
    const bv = keyOf(b);
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });
}

// ---- rendering ----------------------------------------------------------------------------

/** Map a badge tone (ok / off / info / …) to its `.tm-badge-*` class — the ONE place the mapping lives,
 *  shared by the status pill (lifecycle tone) and the roster 4-state badges (TM-1115). */
function badgeClassForTone(tone) {
  return tone === "ok" ? "tm-badge-ok" : tone === "off" ? "tm-badge-off" : tone === "info" ? "tm-badge-info" : "tm-badge-unknown";
}

/** The derived status pill for a row — colour follows the lifecycle tone (event-form.js). */
function statusPill(event, now) {
  const { label, tone } = eventLifecycle(event, now);
  return el("span", { class: `tm-badge ${badgeClassForTone(tone)}`, text: label });
}

function renderStats(now) {
  const total = Math.max(state.totalEvents, state.events.length);
  // TM-1096: a live event now reads "Happening" once it has started (was all "Visible"), so the live
  // stat counts BOTH live buckets — Happening (started, running) + Visible (listed, not yet started) —
  // to stay the "publicly live right now" figure it was before the Happening split.
  const live = state.events.filter((e) => {
    const label = eventLifecycle(e, now).label;
    return label === "Happening" || label === "Visible";
  }).length;
  const cancelled = state.events.filter((e) => String(e.status).toUpperCase() === "CANCELLED").length;
  // TM-756: loadEvents() renders BEFORE the page walk resolves, so these counts derive from EMPTY
  // state — the mask (admin-stats-core.js) shows "—" per card while loading instead of a false
  // "Total 0", mirroring the table's state.loading gate below; loaded cards pass through untouched.
  const cards = statsCards([
    ["Total", total],
    ["Live now", live],
    ["Cancelled", cancelled],
  ], state.loading);
  clear(shell.stats).append(
    ...cards.map(([label, value]) =>
      el("div", { class: "tm-stat" }, [
        el("span", { class: "tm-stat-value", text: String(value) }),
        el("span", { class: "tm-stat-label", text: label }),
      ]),
    ),
  );
}

function renderTable() {
  clear(shell.table);
  if (state.loading) {
    shell.table.append(el("p", { class: "tm-muted", text: "Loading events…" }));
    return;
  }
  if (state.error) {
    shell.table.append(
      el("div", { class: "tm-error" }, [
        el("p", { text: state.error }),
        el("button", { class: "tm-btn", type: "button", onClick: loadEvents }, "Retry"),
      ]),
    );
    return;
  }

  const now = Date.now();
  // Past events (TM-518) always sink to the BOTTOM as their own "Past events" section, regardless of
  // the admin's chosen column sort — a stable partition preserves that sort inside each group.
  const sorted = sortEvents(filteredEvents(now), now);
  const { upcoming, past } = partitionEventsByPast(sorted, now);
  const rows = [...upcoming, ...past];
  const pastStart = upcoming.length; // index in `rows` where the past section begins
  if (!rows.length) {
    const notice = fetchIncompleteNotice();
    if (notice) shell.table.append(notice);
    const filtered = state.events.length > 0;
    const message = filtered ? "No events match your filters." : "No events yet. Create your first one.";
    shell.table.append(
      el("div", { class: "tm-empty", id: "admin-events-empty" }, [
        doodle("calendar", { class: "tm-doodle-empty" }),
        el("p", { class: "tm-muted", text: message }),
      ]),
    );
    renderPager(0);
    return;
  }

  // TM-721: clamp a stale page index BEFORE slicing (see admin-paging-core.js). Cancelling/deleting the
  // last event on a page shrinks `rows` below the page start; without this we'd paint a blank table while
  // the pager (which clamps too late) reads "Page 1 of 1".
  state.page = clampPage(state.page, rows.length, state.pageSize);
  const start = state.page * state.pageSize;
  const pageRows = rows.slice(start, start + state.pageSize);

  const head = el("tr", {}, [
    ...COLUMNS.map((c) => {
      const active = state.sortKey === c.key;
      const arrow = active ? (state.sortDir === "asc" ? " ▲" : " ▼") : "";
      return el(
        "th",
        {
          class: c.sortable ? "tm-sortable" : null,
          scope: "col",
          "aria-sort": active ? (state.sortDir === "asc" ? "ascending" : "descending") : null,
          onClick: c.sortable ? () => toggleSort(c.key) : null,
        },
        `${c.label}${arrow}`,
      );
    }),
    el("th", { scope: "col", text: "Actions" }),
  ]);

  // Build the page's rows, dropping a full-width "Past events" divider before the first past row that
  // lands on this page (TM-518) — so the section header appears exactly once, at the seam.
  const bodyRows = [];
  pageRows.forEach((event, i) => {
    const globalIndex = start + i;
    if (past.length && globalIndex === pastStart) bodyRows.push(pastSectionRow());
    bodyRows.push(eventRow(event, now));
    // TM-1115: the inline roster expando is RETIRED — the Roster button now navigates to the roster page
    // (#/admin/events/{id}/roster). No full-width panel row is appended here anymore (one render path).
  });
  const body = el("tbody", {}, bodyRows);

  const notice = fetchIncompleteNotice();
  if (notice) shell.table.append(notice);
  shell.table.append(stackableTable(el("thead", {}, head), body));
  renderPager(rows.length);
}

/**
 * A non-blocking notice when the inventory walk did NOT load the whole set (TM-727) — a page failed
 * mid-walk (partial) or the runaway guard tripped before the last page (truncated). Without this the
 * table silently shows a prefix as if it were complete. Returns null on a full, clean load.
 */
function fetchIncompleteNotice() {
  if (state.fetchTruncated) {
    return el("div", { class: "tm-notice", "data-testid": "admin-events-truncated" }, [
      el("p", {
        text:
          `Showing the first ${state.events.length} events — there are more than this console loads at once. ` +
          "Use search to narrow down.",
      }),
    ]);
  }
  if (state.fetchPartial) {
    return el("div", { class: "tm-notice", "data-testid": "admin-events-partial" }, [
      el("p", { text: "Some events couldn’t be loaded, so this list may be incomplete." }),
      el("button", { class: "tm-btn tm-btn-sm", type: "button", onClick: loadEvents }, "Retry"),
    ]);
  }
  return null;
}

/** One event row. A past event (TM-518) reads as muted and read-only (see rowActions). */
function eventRow(event, now) {
  const counts = attendanceCounts(event);
  const attendance = `${counts.going == null ? "—" : counts.going} / ${counts.waitlist == null ? "—" : counts.waitlist}`;
  const past = isPastEvent(event, now);
  return el("tr", { class: past ? "tm-event-row-past" : null, dataset: { eventId: String(event.id) } }, [
    // TM-935: data-label on every body td drives the CSS stacked-card layout at ≤30rem (the label is
    // painted via td::before once the header row is hidden). The trailing Actions cell carries no label.
    el("td", { "data-label": "Event" }, [
      el("span", { class: "tm-event-heading", text: event.heading || "—" }),
      event.onlineUrl ? el("span", { class: "tm-badge tm-badge-unknown tm-event-tag", text: "Online" }) : null,
    ]),
    el("td", { "data-label": "Start", class: "tm-muted", text: formatEventWhen(event.startAt, event.timezone) }),
    el("td", { "data-label": "Status" }, [statusPill(event, now)]),
    el("td", { "data-label": "Going / Waitlist", class: "tm-muted", text: attendance }),
    el("td", { "data-label": "Capacity", class: "tm-muted", text: capacityLabel(event.capacity) }),
    el("td", { class: "tm-actions" }, rowActions(event, now)),
  ]);
}

/** The full-width "Past events" divider row that heads the read-only past section (TM-518). */
function pastSectionRow() {
  return el("tr", { class: "tm-event-past-divider", "data-testid": "admin-events-past" }, [
    el("td", { colspan: String(COLUMNS.length + 1), class: "tm-muted" }, "Past events — read-only"),
  ]);
}

function rowActions(event, now = Date.now()) {
  // Clone/Duplicate (TM-1061, absorbing TM-796): available on EVERY row — past, current, AND cancelled.
  // A clone is a brand-new unsaved draft (nothing about the source's lifecycle carries over), so unlike
  // Edit/Cancel it's never disabled by the source being past or cancelled. It opens the offset-preset
  // picker, then a pre-filled create draft.
  const clone = el(
    "button",
    {
      class: "tm-btn tm-btn-sm",
      type: "button",
      "aria-label": `Clone ${event.heading}`,
      onClick: () => startCloneEvent(event),
    },
    "Clone",
  );
  // A past event is READ-ONLY (TM-518): both Edit and Cancel are unavailable (the server rejects them
  // too, with a 409). Render a single DISABLED "Edit" so the control is visibly present-but-inert, and
  // no Cancel — a finished event has nothing left to call off. Kept in lock-step with the server-side
  // reject via the same `past` flag the projection carries. Clone is still offered (TM-1061) — cloning a
  // past event forward is a primary use case.
  if (isPastEvent(event, now)) {
    return [
      el(
        "button",
        {
          class: "tm-btn tm-btn-sm",
          type: "button",
          disabled: true,
          "aria-label": `Edit ${event.heading} (ended — read-only)`,
          title: "This event has ended and can no longer be edited or cancelled.",
        },
        "Edit",
      ),
      clone,
    ];
  }
  const edit = el(
    "button",
    {
      class: "tm-btn tm-btn-sm",
      type: "button",
      "aria-label": `Edit ${event.heading}`,
      // Navigate to the full-page edit route (TM-426) rather than opening a modal.
      onClick: () => { window.location.hash = adminEventEditHash(event.id); },
    },
    "Edit",
  );
  const cancelled = String(event.status).toUpperCase() === "CANCELLED";
  if (cancelled) {
    // A cancelled event keeps its history (cancel ≠ delete) — nothing left to cancel, so Edit + Clone
    // (TM-1061: a cancelled event is a valid clone source — re-run it as a fresh event).
    return [edit, clone];
  }
  // Roster + capacity control (TM-592, moved onto its own page TM-1115): NAVIGATES to the full-page
  // roster (#/admin/events/{id}/roster) — the attendee list (4-state badges, evict), a force-add form and
  // a first-class capacity adjust that surfaces the over-cap warning. The inline expando is retired.
  const roster = el(
    "button",
    {
      class: "tm-btn tm-btn-sm",
      type: "button",
      "aria-label": `Manage roster for ${event.heading}`,
      onClick: () => { window.location.hash = adminEventRosterHash(event.id); },
    },
    "Roster",
  );
  return [
    roster,
    edit,
    clone,
    el(
      "button",
      { class: "tm-btn tm-btn-sm tm-btn-danger", type: "button", "aria-label": `Cancel ${event.heading}`, onClick: () => cancelEvent(event) },
      "Cancel",
    ),
  ];
}

function renderPager(totalRows) {
  clear(shell.pager);
  const pageCount = Math.max(1, Math.ceil(totalRows / state.pageSize));
  if (state.page >= pageCount) state.page = pageCount - 1;
  const from = totalRows === 0 ? 0 : state.page * state.pageSize + 1;
  const to = Math.min(totalRows, (state.page + 1) * state.pageSize);

  shell.pager.append(
    el("span", { class: "tm-muted", text: `${from}–${to} of ${totalRows}` }),
    el("div", { class: "tm-pager-controls" }, [
      el(
        "button",
        { class: "tm-btn tm-btn-sm", type: "button", disabled: state.page <= 0, onClick: () => { state.page--; renderTable(); } },
        "Prev",
      ),
      el("span", { class: "tm-muted", text: `Page ${state.page + 1} of ${pageCount}` }),
      el(
        "button",
        {
          class: "tm-btn tm-btn-sm",
          type: "button",
          disabled: state.page >= pageCount - 1,
          onClick: () => { state.page++; renderTable(); },
        },
        "Next",
      ),
    ]),
  );
}

function toggleSort(key) {
  if (state.sortKey === key) {
    state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
  } else {
    state.sortKey = key;
    state.sortDir = key === "startAt" ? "desc" : "asc";
  }
  state.page = 0;
  renderTable();
}

function render() {
  if (!shell) return;
  renderStats(Date.now());
  renderTable();
}

// ---- actions ------------------------------------------------------------------------------

/** Cancel an event behind a danger confirm ("attendees will be notified"). Cancel keeps the record. */
async function cancelEvent(event) {
  const ok = await confirmDialog({
    title: "Cancel this event?",
    message: `“${event.heading}” will be called off and attendees will be notified. The event stays in the list as cancelled — this isn't a delete.`,
    confirmLabel: "Cancel event",
    cancelLabel: "Keep event",
    danger: true,
  });
  if (!ok) return;
  try {
    const updated = await eventApi(`/api/v1/admin/events/${event.id}/cancel`, { method: "POST" });
    const idx = state.events.findIndex((e) => e.id === event.id);
    if (idx >= 0 && updated) state.events[idx] = updated;
    render();
    toast("Event cancelled. Attendees will be notified.", { type: "success" });
  } catch (err) {
    toast(err instanceof ApiError ? err.message : "Couldn't cancel the event.", { type: "error" });
  }
}

// ---- clone / duplicate an event with a time offset (TM-1061) -------------------------------
//
// The DOM half of Clone (the pure buildCloneDraft / pastStartWarning live in event-form.js). A row's
// Clone action opens an offset-preset picker; on a pick it builds the pre-filled create draft, stashes
// it, and navigates to the create route — where enterAdminEventForm mounts the form in CLONE mode from
// the stash. Nothing is persisted until the admin reviews the draft and Saves (the ordinary create POST).

/**
 * The clone draft handed to the next create-form mount (TM-1061). A one-shot baton: startCloneEvent sets
 * it before navigating to `#/admin/events/new`; enterAdminEventForm reads-and-clears it so a plain "New
 * event" (or a refresh) never accidentally re-opens a stale clone. Holds the source event (for context)
 * + the pure clone draft (source fields copied, times shifted, opening message blanked).
 */
let pendingClone = null;

/** Take (and clear) the pending clone draft, or null if the create route was reached any other way. */
function takePendingClone() {
  const c = pendingClone;
  pendingClone = null;
  return c;
}

/**
 * Offset-preset picker for a clone (TM-1061) — LOCKED to the two presets (+7 days / +7 hours); there is
 * deliberately NO free-form offset field (a custom offset is a deferred follow-up). Built on the shared
 * `modal` primitive (ui.js) so it inherits the backdrop/Esc/focus-trap semantics. The admin must
 * EXPLICITLY pick a preset — nothing is auto-applied. Resolves to the chosen offset ms, or null if the
 * admin dismissed the picker (Esc / close / backdrop) without choosing.
 *
 * @param {object} event the source event (its heading titles the picker).
 * @returns {Promise<?number>} the chosen offset in ms, or null on dismiss.
 */
function pickCloneOffset(event) {
  return new Promise((resolve) => {
    let picked = null; // the chosen offset, captured before close; onClose resolves it (or null on dismiss)
    let ref = null;
    const choose = (ms) => { picked = ms; ref?.close(); };
    const buttons = CLONE_OFFSET_PRESETS.map((preset) =>
      el(
        "button",
        {
          class: "tm-btn tm-btn-primary tm-clone-offset-btn",
          type: "button",
          dataset: { offset: preset.label },
          onClick: () => choose(preset.ms),
        },
        preset.label,
      ),
    );
    const body = [
      el("p", {
        class: "tm-muted",
        text: "Duplicate this event into a new draft with its times shifted later. Pick how far to shift — you can review and edit everything before saving.",
      }),
      el("div", { class: "tm-clone-offset-choices", role: "group", "aria-label": "Clone time offset" }, buttons),
    ];
    // The picker resolves the chosen offset on a pick, or null on ANY dismiss (Esc / close / backdrop) via
    // modal()'s onClose — the admin must EXPLICITLY pick a preset; nothing is auto-applied.
    ref = modal(`Clone “${event.heading || "event"}”`, body, { onClose: () => resolve(picked) });
  });
}

/**
 * Start a clone (TM-1061): pick the offset preset, build the pre-filled create draft (pure buildCloneDraft
 * — source fields copied, the four datetimes shifted, opening message blanked), stash it, and navigate to
 * the create route. The create-form mount picks the stash up in clone mode. Available for a past, current,
 * OR cancelled source (the clone is a fresh unsaved event; the source lifecycle is irrelevant).
 */
async function startCloneEvent(event) {
  const offsetMs = await pickCloneOffset(event);
  if (offsetMs == null) return; // dismissed without choosing — nothing happens
  pendingClone = { source: event, draft: buildCloneDraft(event, offsetMs) };
  window.location.hash = adminEventNewHash();
}

// ---- roster PAGE (TM-1115, lifting the TM-592 controls onto #/admin/events/{id}/roster) ---
//
// The inline expando (openRosterId / toggleRoster / rosterPanelRow) is RETIRED — ONE render path now.
// The list's Roster button navigates to #/admin/events/{id}/roster; the router mounts the page via
// enterAdminEventRoster(id). The page hosts: a "← Events" back header, a summary line, the capacity
// control, the force-add form, the 4-state include/exclude chip row, and the merged attendee list
// (live entries + pastEntries from TM-1114, 4-state badges, evict).

/** Module guard so a slow roster fetch that resolves AFTER the admin navigated away can't paint stale. */
let rosterToken = 0;

/**
 * Router entry (TM-1115) for the full-page roster. Renders from the list row already in memory when we
 * have it (the common path — the admin clicked "Roster"); otherwise fetches the event by id so the route
 * also works on a direct deep-link / refresh. Resets the chip selection to the default (waitlist on) on
 * each fresh entry, then loads the roster payload.
 */
export async function enterAdminEventRoster(id) {
  const view = document.getElementById("admin-event-roster-view");
  if (!view) return;
  const mine = ++rosterToken;

  state.rosterEventId = id;
  state.roster = null;
  state.rosterError = null;
  state.rosterChips = defaultChipSelection(); // fresh default per entry (waitlist on, evicted/cancelled off)

  const cached = state.events.find((e) => String(e.id) === String(id));
  if (cached) {
    state.rosterEvent = cached;
    state.rosterLoading = true;
    renderRosterPage(view);
    await reloadRoster(id);
    return;
  }

  // Not in memory (deep-link / refresh straight onto the roster URL): fetch the event first so the header
  // + capacity default render, then load the roster.
  state.rosterEvent = null;
  state.rosterLoading = true;
  renderRosterPage(view);
  try {
    const event = await eventApi(`/api/v1/admin/events/${encodeURIComponent(id)}`);
    if (mine !== rosterToken) return; // navigated away while the fetch was in flight
    state.rosterEvent = event || null;
  } catch {
    if (mine !== rosterToken) return;
    // A failed event fetch is non-fatal — the roster load below surfaces the real error; the header just
    // falls back to a generic title.
  }
  if (mine !== rosterToken) return;
  renderRosterPage(view);
  await reloadRoster(id);
}

/** (Re)load the current roster page's roster payload into state and repaint the page. */
async function reloadRoster(eventId) {
  if (String(state.rosterEventId) !== String(eventId)) return; // navigated away / switched while we were away
  const view = document.getElementById("admin-event-roster-view");
  state.rosterLoading = true;
  state.rosterError = null;
  if (view) renderRosterPage(view);
  try {
    const roster = await eventApi(`/api/v1/admin/events/${encodeURIComponent(eventId)}/roster`);
    if (String(state.rosterEventId) !== String(eventId)) return;
    state.roster = roster;
  } catch (err) {
    if (String(state.rosterEventId) !== String(eventId)) return;
    state.rosterError = err instanceof ApiError ? err.message : "Couldn't load the roster.";
  } finally {
    state.rosterLoading = false;
    if (view) renderRosterPage(view);
  }
}

/** Render the whole roster page into its view: back header, then the panel body (loading/error/content). */
function renderRosterPage(view) {
  const event = state.rosterEvent || { id: state.rosterEventId, heading: "event", capacity: null };
  const back = el("a", { class: "tm-btn tm-btn-sm", id: "admin-event-roster-back", href: ADMIN_EVENTS_ROUTE }, "← Events");
  const header = el("div", { class: "tm-admin-head tm-event-form-head" }, [
    el("h2", {}, [doodle("calendar", { class: "tm-doodle-header" }), `Roster · ${event.heading || "event"}`]),
    back,
  ]);
  clear(view).append(header, rosterPanel(event));
}

/** The roster panel body: summary, capacity control + over-cap warning, force-add form, chips + list. */
function rosterPanel(event) {
  const panel = el("div", { class: "tm-roster-panel", "data-testid": "admin-event-roster-panel" });

  if (state.rosterLoading && !state.roster) {
    panel.append(el("p", { class: "tm-muted", text: "Loading roster…" }));
    return panel;
  }
  if (state.rosterError && !state.roster) {
    panel.append(
      el("div", { class: "tm-error" }, [
        el("p", { text: state.rosterError }),
        el("button", { class: "tm-btn tm-btn-sm", type: "button", onClick: () => reloadRoster(event.id) }, "Retry"),
      ]),
    );
    return panel;
  }
  const roster = state.roster || { capacity: event.capacity, going: 0, waitlist: 0, entries: [], pastEntries: [] };
  panel.append(
    el("div", { class: "tm-roster-head" }, [
      el("strong", { text: `Roster · ${event.heading || "event"}` }),
      el("span", {
        class: "tm-muted",
        text: `${roster.going} going / ${roster.waitlist} waitlist · capacity ${capacityLabel(roster.capacity)}`,
      }),
    ]),
    capacityControl(event, roster),
    forceAddForm(event),
    rosterFilterChipRow(),
    attendeeList(event, roster),
  );
  return panel;
}

/**
 * The include/exclude filter chips (TM-1115) — one `aria-pressed` toggle per non-Going roster state
 * (Waitlist / Evicted / Cancelled; Going is always shown, so it's not a chip). Toggling a chip flips its
 * state key in `state.rosterChips` and repaints the attendee list from the ALREADY-FETCHED set — NO
 * refetch. Defaults come from defaultChipSelection() (waitlist on, evicted/cancelled off). Built on the
 * shared `.tm-chip` CSS; `aria-pressed="true"` lights a chip up.
 */
function rosterFilterChipRow() {
  const row = el("div", {
    class: "tm-chips tm-roster-filter-chips",
    id: "admin-roster-filter-chips",
    role: "group",
    "aria-label": "Show which attendee states",
  });
  const rebuild = () => {
    clear(row);
    for (const chip of ROSTER_FILTER_CHIPS) {
      const on = state.rosterChips.has(chip.key);
      row.append(
        el(
          "button",
          {
            type: "button",
            class: "tm-chip",
            "aria-pressed": on ? "true" : "false",
            dataset: { rosterState: chip.key },
            onClick: () => {
              if (state.rosterChips.has(chip.key)) state.rosterChips.delete(chip.key);
              else state.rosterChips.add(chip.key);
              rebuild();
              // Repaint just the list from the already-fetched roster — no refetch (client-side filter).
              const view = document.getElementById("admin-event-roster-view");
              if (view) renderRosterPage(view);
            },
          },
          chip.label,
        ),
      );
    }
  };
  rebuild();
  return row;
}

/**
 * The first-class capacity adjust control (TM-592): a number input pre-filled with the current cap and a
 * Save button. Below it, a live over-cap warning derived on the client (overCapacityState/Warning) that
 * mirrors what the server returns — shown the moment the typed value would leave the event over cap, so
 * the admin sees the consequence BEFORE saving. Blank = unlimited.
 */
function capacityControl(event, roster) {
  const input = el("input", {
    id: `roster-capacity-${event.id}`,
    class: "tm-input tm-roster-capacity-input",
    type: "number",
    min: "1", // TM-964: 1..; blank = unlimited. Capacity 0 is never valid (edit form enforces @Min(1)).
    value: roster.capacity == null ? "" : String(roster.capacity),
    "aria-label": "Capacity (blank = unlimited)",
  });
  const warn = el("p", {
    class: "tm-notice tm-roster-overcap",
    "data-testid": "admin-event-overcap-warning",
    hidden: true,
  });
  const paintWarning = (capValue) => {
    const cap = capValue === "" ? null : Number(capValue);
    const s = overCapacityState(cap, roster.going);
    const msg = overCapacityWarning(s);
    warn.textContent = msg;
    warn.hidden = !msg;
  };
  input.addEventListener("input", () => paintWarning(input.value.trim()));
  paintWarning(input.value.trim());

  const save = el(
    "button",
    { class: "tm-btn tm-btn-sm", type: "button", onClick: () => saveCapacity(event, input.value.trim()) },
    "Save capacity",
  );
  return el("div", { class: "tm-roster-section" }, [
    el("label", { class: "tm-roster-label", for: `roster-capacity-${event.id}`, text: "Capacity" }),
    el("div", { class: "tm-roster-row" }, [input, save, el("span", { class: "tm-muted", text: "Blank = unlimited" })]),
    warn,
  ]);
}

/** The force-add form (TM-592): a user-id field + an audited override checkbox + Add. */
function forceAddForm(event) {
  const userInput = el("input", {
    id: `roster-add-user-${event.id}`,
    class: "tm-input tm-roster-adduser-input",
    type: "number",
    min: "1",
    placeholder: "User ID",
    "aria-label": "User ID to add as going",
  });
  const override = el("input", { id: `roster-add-override-${event.id}`, type: "checkbox" });
  const add = el(
    "button",
    {
      class: "tm-btn tm-btn-sm",
      type: "button",
      onClick: () => forceAddAttendee(event, userInput.value.trim(), override.checked),
    },
    "Add as going",
  );
  return el("div", { class: "tm-roster-section" }, [
    el("label", { class: "tm-roster-label", for: `roster-add-user-${event.id}`, text: "Force-add a user" }),
    el("div", { class: "tm-roster-row" }, [
      userInput,
      add,
      el("label", { class: "tm-roster-override" }, [
        override,
        el("span", { text: " Override capacity / age / one-active (audited)" }),
      ]),
    ]),
  ]);
}

/**
 * The attendee list (TM-1115) — merges the live `entries` with the `pastEntries` history (TM-1114) into
 * ONE list via the pure mergeRosterRows(), then filters it by the include/exclude chip selection with NO
 * refetch (filterRosterRows). Each row shows a 4-state badge (Going / Waitlist / Evicted / Cancelled), an
 * over-cap flag for a GOING attendee sitting over cap, and — for a LIVE row that also has a past exit
 * (rejoined-after-evict / -cancel) — a history affordance (latest past-state + timestamp). Only a LIVE
 * GOING / WAITLISTED row is evictable; a past (evicted/cancelled) row is history, no Evict.
 */
function attendeeList(event, roster) {
  const merged = mergeRosterRows(roster);
  const visible = filterRosterRows(merged, state.rosterChips);
  if (!merged.length) {
    return el("div", { class: "tm-roster-section" }, [
      el("label", { class: "tm-roster-label", text: "Attendees" }),
      el("p", { class: "tm-muted", text: "No attendees yet." }),
    ]);
  }
  if (!visible.length) {
    return el("div", { class: "tm-roster-section" }, [
      el("label", { class: "tm-roster-label", text: "Attendees" }),
      el("p", { class: "tm-muted", "data-testid": "admin-roster-empty-filtered", text: "No attendees match the selected states." }),
    ]);
  }
  const rows = visible.map((row) => {
    const badge = rosterStateBadge(row.state);
    const badgeCls = badgeClassForTone(badge.tone);
    const isLive = row.state === "GOING" || row.state === "WAITLISTED";
    // The history affordance for a rejoined-after-evict/-cancel live row: latest past state + when (the
    // shared relativeTime() from ui.js gives the "2 days ago" text + a full-timestamp title).
    const histWhen = row.history ? relativeTime(row.history.at) : null;
    const history = row.history
      ? el("span", {
          class: "tm-muted tm-roster-history",
          "data-testid": "admin-roster-history",
          title: `Previously ${rosterStateBadge(row.history.lastState).label.toLowerCase()}${row.history.byAdmin ? " by an admin" : ""} · ${histWhen.title}`,
          text: `· previously ${rosterStateBadge(row.history.lastState).label} ${histWhen.text}`,
        })
      : null;
    // A past row carries its own timestamp (when the exit was recorded).
    const pastRel = !isLive && row.at ? relativeTime(row.at) : null;
    const pastWhen = pastRel
      ? el("span", { class: "tm-muted tm-roster-history", title: pastRel.title, text: pastRel.text })
      : null;
    return el("li", { class: "tm-roster-attendee", dataset: { userId: String(row.userId), rosterState: row.state } }, [
      el("span", { class: "tm-roster-attendee-name", text: row.displayName || `User ${row.userId}` }),
      el("span", { class: `tm-badge ${badgeCls}`, "data-testid": "admin-roster-badge", text: badge.label }),
      row.overCapacity
        ? el("span", { class: "tm-badge tm-badge-off", "data-testid": "admin-roster-overcap-tag", text: "Over cap" })
        : null,
      history,
      pastWhen,
      isLive
        ? el(
            "button",
            {
              class: "tm-btn tm-btn-sm tm-btn-danger",
              type: "button",
              "aria-label": `Evict ${row.displayName || "user " + row.userId}`,
              onClick: () => evictAttendee(event, row),
            },
            "Evict",
          )
        : null,
    ]);
  });
  return el("div", { class: "tm-roster-section" }, [
    el("label", { class: "tm-roster-label", text: "Attendees" }),
    el("ul", { class: "tm-roster-attendees" }, rows),
  ]);
}

/** Save a first-class capacity adjust (TM-592); toasts the over-cap warning when the server flags it. */
async function saveCapacity(event, rawValue) {
  const capacity = rawValue === "" ? null : Number(rawValue);
  // TM-964: reject < 1 (was < 0). Capacity 0 was settable only here, and once set the edit form prefills
  // "0", errors on its @Min(1) field, and blocks every unrelated edit. Blank = unlimited; min is 1.
  if (capacity != null && (!Number.isInteger(capacity) || capacity < 1)) {
    toast("Capacity must be a whole number of 1 or more (blank = unlimited).", { type: "error" });
    return;
  }
  try {
    const result = await eventApi(`/api/v1/admin/events/${event.id}/capacity`, {
      method: "POST",
      body: { capacity },
    });
    // Reflect the new capacity into the in-memory list row so the Capacity column updates.
    const idx = state.events.findIndex((e) => e.id === event.id);
    if (idx >= 0) state.events[idx] = { ...state.events[idx], capacity };
    const warning = overCapacityWarning(result || {});
    if (warning) {
      toast(warning, { type: "warning" });
    } else {
      toast("Capacity updated.", { type: "success" });
    }
    await reloadRoster(event.id);
  } catch (err) {
    toast(err instanceof ApiError ? err.message : "Couldn't update capacity.", { type: "error" });
  }
}

/** Force-add an existing user as GOING (TM-592). Override bypasses the guards (audited server-side). */
async function forceAddAttendee(event, rawUserId, override) {
  const userId = Number(rawUserId);
  if (!Number.isInteger(userId) || userId <= 0) {
    toast("Enter a valid user ID to add.", { type: "error" });
    return;
  }
  try {
    await eventApi(`/api/v1/admin/events/${event.id}/attendees`, {
      method: "POST",
      body: { userId, override: !!override },
    });
    toast(`Added user ${userId} as going.`, { type: "success" });
    await reloadRoster(event.id);
  } catch (err) {
    toast(err instanceof ApiError ? err.message : "Couldn't add the user.", { type: "error" });
  }
}

/** Evict a specific attendee behind a danger confirm (TM-592). Frees a GOING spot; user may re-RSVP. */
async function evictAttendee(event, entry) {
  const who = entry.displayName || `user ${entry.userId}`;
  const ok = await confirmDialog({
    title: "Remove this attendee?",
    message: `${who} will be removed from “${event.heading}” and notified. A freed spot is offered to the waitlist. They can request to join again — this isn't a ban.`,
    confirmLabel: "Remove attendee",
    cancelLabel: "Keep",
    danger: true,
  });
  if (!ok) return;
  try {
    await eventApi(`/api/v1/admin/events/${event.id}/attendees/${entry.userId}/evict`, { method: "POST" });
    toast(`${who} removed. The freed spot is offered to the waitlist.`, { type: "success" });
    await reloadRoster(event.id);
  } catch (err) {
    toast(err instanceof ApiError ? err.message : "Couldn't remove the attendee.", { type: "error" });
  }
}

// ---- create / edit form (full page — TM-426) ----------------------------------------------

// The form field spec drives the grid, the read-back, and the error map from one declarative list —
// the profile.js pattern. `key` matches BOTH the input id suffix and the API field name (so a server
// RFC-7807 `errors[].field` maps straight onto the right input). `row` groups short fields two-up.
const FORM_FIELDS = [
  { key: "heading", id: "event-heading", label: "Heading", type: "text", maxLength: HEADING_MAX, required: true },
  { key: "description", id: "event-description", label: "Description", type: "textarea", maxLength: DESCRIPTION_MAX, required: true },
  { key: "locationText", id: "event-location", label: "Location", type: "text", maxLength: LOCATION_MAX, required: true, hint: 'The venue line — use "Online" for online-only events.' },
  { key: "city", id: "event-city", label: "City (optional)", type: "select", options: [["", "Choose a city…"], ...CITY_OPTIONS.map((c) => [c, c])], hint: "The public pre-reveal hint + per-city reveal default (TM-408)." },
  { key: "mapUrl", id: "event-map-url", label: "Map URL (optional)", type: "url", maxLength: URL_MAX, row: "links" },
  { key: "onlineUrl", id: "event-online-url", label: "Online URL (optional)", type: "url", maxLength: URL_MAX, row: "links" },
  { key: "timezone", id: "event-timezone", label: "Time zone", type: "timezone", required: true, hint: "Derived from the venue — change it under More options." },
  { key: "startAt", id: "event-start", label: "Starts", type: "datetime-local", required: true, row: "when" },
  { key: "endAt", id: "event-end", label: "Ends (optional)", type: "datetime-local", row: "when" },
  { key: "visibilityStart", id: "event-visibility-start", label: "Visible from", type: "datetime-local", required: true, row: "visibility" },
  { key: "visibilityEnd", id: "event-visibility-end", label: "Visible until", type: "datetime-local", required: true, row: "visibility" },
  { key: "capacity", id: "event-capacity", label: "Capacity (optional)", type: "number", min: 1, row: "limits", hint: "Blank = unlimited." },
  { key: "locationRevealHours", id: "event-reveal-hours", label: "Location reveal hours (optional)", type: "number", min: REVEAL_HOURS_MIN, max: REVEAL_HOURS_MAX, row: "limits", hint: "Hours before the start the exact location is revealed. Blank = city / app default." },
  // Booking cutoff (TM-413, exposed by TM-1157): the "stop accepting RSVPs N hours before start" override.
  // Lives under "More options" (spliced out of the main body below, like the timezone field) — it's a
  // rarely-changed inherit-by-default control. Blank = inherit; 0 = accept up to start. The placeholder +
  // helper text are FILLED with the event's resolved effective value after prefill (the booking-cutoff
  // block in buildEventForm) so the admin sees exactly what applies if they leave it blank.
  { key: "bookingCutoffHours", id: "event-booking-cutoff-hours", label: "Stop accepting RSVPs (hours before start, optional)", type: "number", min: BOOKING_CUTOFF_HOURS_MIN, max: BOOKING_CUTOFF_HOURS_MAX, hint: "Hours before the start that RSVPs, waitlist joins and claims stop. 0 = accept right up to the start. Blank = city / app default." },
  // Age band (TM-1065): the two number inputs are no longer laid out two-up. They stay in FORM_FIELDS
  // (so readDraft / validateEventDraft / server-error routing still key off them) but are RE-HOMED inside
  // the age-band control (buildAgeBandControl), revealed only when the "Custom" band chip is chosen. The
  // "customage" row groups them two-up INSIDE that control's reveal region.
  { key: "ageMin", id: "event-age-min", label: "Min age", type: "number", min: AGE_MIN_BOUND, max: AGE_MAX_BOUND, row: "customage" },
  { key: "ageMax", id: "event-age-max", label: "Max age", type: "number", min: AGE_MIN_BOUND, max: AGE_MAX_BOUND, row: "customage" },
  // Price (TM-1076): the £ amount input. Like the age inputs it stays in FORM_FIELDS (so readDraft /
  // validateEventDraft / server-error routing key off `price`) but is RE-HOMED inside the price control
  // (buildPriceControl), revealed only when the "Custom" price chip is chosen. The preset chips (Free /
  // £5 / £10) seed it and hide it; Custom reveals it. DEFAULT selection = Free.
  { key: "price", id: "event-price", label: "Custom price (£)", type: "number", min: 0, step: "0.01" },
  { key: "openingMessage", id: "event-opening-message", label: "Chat opening message (optional)", type: "textarea", maxLength: OPENING_MESSAGE_MAX, hint: "Auto-posted once as an announcement when the event's group chat first opens. Blank = none (TM-710)." },
];

/** Human label for a field key (drops the trailing "(optional)"), used in the "can't clear" warning (TM-734). */
const FIELD_LABELS = new Map(FORM_FIELDS.map((f) => [f.key, f.label.replace(/\s*\(optional\)\s*$/i, "")]));
function fieldLabel(key) {
  return FIELD_LABELS.get(key) || (key === "venueId" ? "Venue" : key);
}

/** Build one field control (label + input/select/textarea + hint + role=alert error), profile.js style. */
function buildField(field, fields) {
  const errorId = `${field.id}-error`;
  const hintId = field.hint ? `${field.id}-hint` : null;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || null;

  let input;
  if (field.type === "textarea") {
    input = el("textarea", { id: field.id, class: "tm-input tm-textarea", rows: "4", maxLength: field.maxLength, "aria-describedby": describedBy });
  } else if (field.type === "timezone") {
    input = el("select", { id: field.id, class: "tm-input", "aria-describedby": describedBy });
  } else if (field.type === "select") {
    // A plain <select> of [value, label] pairs (ported from admin-venues.js:493). The City field uses
    // this (TM-1063), sourcing CITY_OPTIONS from profile-core.js so there's ONE city list app-wide.
    input = el(
      "select",
      { id: field.id, class: "tm-input", "aria-describedby": describedBy },
      (field.options || []).map(([value, label]) => el("option", { value, text: label })),
    );
  } else {
    input = el("input", {
      id: field.id,
      class: "tm-input",
      type: field.type,
      maxLength: field.maxLength,
      min: field.min,
      max: field.max,
      step: field.step,
      // A static placeholder from the field spec (the booking-cutoff field's effective-value placeholder is
      // set dynamically after prefill; this covers any future field that wants a fixed one).
      placeholder: field.placeholder,
      // A stepped number (the price £ amount, TM-1076) accepts decimals → "decimal" keypad; a whole-number
      // field keeps the "numeric" keypad.
      inputmode: field.type === "number" ? (field.step ? "decimal" : "numeric") : null,
      "aria-describedby": describedBy,
    });
  }

  const error = el("p", { id: errorId, class: "tm-field-error", role: "alert", hidden: true });
  const hint = field.hint ? el("p", { id: hintId, class: "tm-muted tm-field-hint", text: field.hint }) : null;
  fields.set(field.key, { input, error });

  // The timezone field gets a "Use mine" filler beside it (profile.js pattern) — one tap drops in the
  // browser's zone. The full IANA option list is populated by the caller (fillForm).
  const control =
    field.type === "timezone"
      ? el("div", { class: "tm-field-fill" }, [
          input,
          el(
            "button",
            {
              class: "tm-btn tm-btn-sm",
              type: "button",
              onClick: () => {
                const guess = guessTimeZone();
                if (guess && isValidTimeZone(guess)) {
                  ensureZoneOption(input, guess);
                  input.value = guess;
                  // Fire "input" so the form-level revalidate + the TM-1066 manual-edit flag react to
                  // "Use mine" exactly as they do to a hand-pick (an explicit choice is a manual edit,
                  // so a later venue re-pick won't clobber it). Programmatic value sets don't fire on
                  // their own, so dispatch it.
                  input.dispatchEvent(new Event("input", { bubbles: true }));
                }
              },
            },
            "Use mine",
          ),
        ])
      : input;

  return el("div", { class: "tm-form-field", dataset: { field: field.key } }, [
    el("label", { class: "tm-field-label", for: field.id, text: field.label }),
    control,
    hint,
    error,
  ]);
}

/**
 * Select a saved city in the TM-1063 City dropdown. A value on the OFFERED list (or "") selects
 * directly; a saved OFF-LIST city (e.g. "Dubai" set before the list existed, or a venue's off-list
 * city) gets its own extra option injected so it stays VISIBLE and SELECTABLE — an existing event is
 * preserved, never silently overwritten on save (the profile.js fillCitySelect idiom). `data-offlist`
 * stops re-fills from stacking duplicate options for the same value.
 *
 * TM-1174: "off-list" is now relative to the admin-managed catalogue (offeredCityNames() — the fetched
 * list, or the CITY_OPTIONS fallback while unfetched/offline), not the hardcoded CITY_OPTIONS.
 *
 * @param {HTMLSelectElement} select the city <select>.
 * @param {*} value the saved city value.
 */
function fillCitySelect(select, value) {
  if (!select) return;
  const saved = value == null ? "" : String(value).trim();
  if (isOffListCity(saved, offeredCityNames()) && select.getAttribute("data-offlist") !== saved) {
    select.append(el("option", { value: saved, text: saved }));
    select.setAttribute("data-offlist", saved);
  }
  select.value = saved;
}

/**
 * Repopulate the city <select> from the admin-managed catalogue (TM-1174) — called once the primed
 * loadCityCatalogue() resolves so an admin-added city appears without a code deploy. Rebuilds the
 * options from offeredCityNames(), PRESERVES the current selection (an off-list saved city stays
 * selectable via cityOptionRows), and clears the stale `data-offlist` marker before re-filling so
 * fillCitySelect re-injects the off-list option against the fresh list. No-op if the offered list
 * still matches (nothing to add) — but re-filling is cheap and idempotent.
 *
 * @param {HTMLSelectElement} select the city <select>.
 */
function repopulateCitySelect(select) {
  if (!select) return;
  const current = select.value;
  const rows = cityOptionRows(offeredCityNames(), current);
  clear(select).append(...rows.map(([value, label]) => el("option", { value, text: label })));
  // The off-list marker was set against the OLD list; drop it so fillCitySelect re-evaluates the saved
  // value against the freshly-offered names (a value that just became on-list no longer needs injecting).
  select.removeAttribute("data-offlist");
  fillCitySelect(select, current);
}

/**
 * The generic `.tm-chips` / `.tm-chip` preset-chip primitive (TM-1064) — a row of tap-to-seed buttons.
 * Each chip is `{ label, value }` (a bare string is shorthand for `{ label: s, value: s }`). Tapping a
 * chip calls `onPick(value, chipEl)`; the caller decides what to do with the value (seed a field, then
 * revalidate). Chips whose `value` is blank render DISABLED (a harmless no-op — used by the schedule
 * chips whose value depends on an as-yet-blank Start). The chip keeps its `data-chip` = value so the
 * heading e2e (TM-382) can still target `.tm-chip[data-chip="Coffee & Code"]`.
 *
 * @param {(string|{label:string,value:string})[]} chips
 * @param {(value:string, chipEl:HTMLButtonElement)=>void} onPick
 * @param {{ariaLabel?: string}} [opts]
 * @returns {HTMLDivElement}
 */
function buildPresetChips(chips, onPick, { ariaLabel = "Suggestions" } = {}) {
  return el(
    "div",
    { class: "tm-chips", role: "group", "aria-label": ariaLabel },
    chips.map((c) => {
      const chip = typeof c === "string" ? { label: c, value: c } : c;
      const disabled = chip.value === "" || chip.value == null;
      const btn = el(
        "button",
        {
          class: "tm-chip",
          type: "button",
          dataset: { chip: chip.value },
          disabled: disabled || null,
          "aria-disabled": disabled ? "true" : null,
          onClick: disabled ? null : () => onPick(chip.value, btn),
        },
        chip.label,
      );
      return btn;
    }),
  );
}

/**
 * The Coffee & X heading suggestion chips (TM-382) — now a thin wrapper over {@link buildPresetChips} so
 * the primitive is shared with the scheduling chips (TM-1064). Behaviour-identical: tap to prefill the
 * heading, focus it, still fully editable after.
 */
function buildChips(headingInput, onChange) {
  return buildPresetChips(
    CATEGORY_CHIPS,
    (value) => {
      headingInput.value = value;
      headingInput.focus();
      onChange();
    },
    { ariaLabel: "Heading suggestions" },
  );
}

/** The event image control (TM-166 avatar UX): preview + file input + progress + inline error. The
 *  picked file is held and uploaded on save (the id must exist first for a create), not on pick. */
function buildImageControl(event) {
  const configured = isStorageConfigured();
  let pendingFile = null;

  const placeholder = el("span", { class: "tm-event-image-empty", "aria-hidden": "true", text: "🗓️" });
  const preview = el("img", { class: "tm-event-image-img", alt: "", hidden: true });
  const frame = el("div", { class: "tm-event-image-frame", "aria-hidden": "true" }, [placeholder, preview]);

  const file = el("input", {
    id: "event-image-file",
    class: "tm-event-image-file",
    type: "file",
    accept: "image/*",
    disabled: !configured,
    "aria-describedby": "event-image-error event-image-hint",
  });
  const progressBar = el("div", { class: "tm-avatar-progress-bar" });
  const progress = el(
    "div",
    { class: "tm-avatar-progress", role: "progressbar", "aria-label": "Upload progress", "aria-valuemin": "0", "aria-valuemax": "100", hidden: true },
    [progressBar],
  );
  const error = el("p", { id: "event-image-error", class: "tm-field-error", role: "alert", hidden: true });
  const sizeHint = `JPG, PNG or GIF, up to ${Math.round(MAX_EVENT_IMAGE_BYTES / (1024 * 1024))} MB. Optional.`;
  const hasExisting = event && event.imagePath;
  const hint = el("p", {
    id: "event-image-hint",
    class: "tm-muted tm-field-hint",
    text: !configured
      ? "Main image uploads aren't available in this environment yet."
      : hasExisting
        ? `A main image is already set. Choose a file to replace it. ${sizeHint}`
        : sizeHint,
  });

  const setError = (msg) => {
    error.textContent = msg || "";
    error.hidden = !msg;
  };
  const setProgress = (fraction) => {
    const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
    progress.hidden = false;
    progressBar.style.width = `${pct}%`;
    progress.setAttribute("aria-valuenow", String(pct));
  };
  const resetProgress = () => {
    progress.hidden = true;
    progressBar.style.width = "0%";
  };

  file.addEventListener("change", () => {
    setError("");
    const picked = file.files && file.files[0];
    if (!picked) return;
    const invalid = validateEventImageFile(picked);
    if (invalid) {
      setError(invalid);
      pendingFile = null;
      return;
    }
    pendingFile = picked;
    // Local object-URL preview (no upload yet) so the admin sees their pick before saving.
    preview.src = URL.createObjectURL(picked);
    preview.hidden = false;
    placeholder.hidden = true;
  });

  // TM-712: seed the preview from the EXISTING image when editing an event that already has one and no
  // new file has been picked. imagePath is EITHER an http(s) URL (legacy/external) OR a Firebase Storage
  // object path (`event-images/{id}`) — the write-only field that previously only fed a text hint here,
  // so an already-set image never previewed on edit-open. Resolve a path to a fresh download URL; a URL
  // is used directly. If resolution fails (Storage off, object missing) we keep the placeholder rather
  // than showing a broken image — mirroring events.js detailHero (TM-708) and admin-venues.js (TM-711).
  const existingRef = eventImageRef(event?.imagePath);
  if (existingRef) {
    const showExisting = (url) => {
      // A pick between resolve start and finish wins — never clobber the admin's newer object-URL preview.
      if (!url || pendingFile) return;
      preview.src = url;
      preview.hidden = false;
      placeholder.hidden = true;
    };
    if (existingRef.kind === "url") showExisting(existingRef.value);
    else downloadUrlForPath(existingRef.value).then(showExisting);
  }

  const node = el("section", { class: "tm-event-image", "aria-label": "Event image" }, [
    frame,
    el("div", { class: "tm-event-image-meta" }, [
      el("label", { class: "tm-field-label", for: "event-image-file", text: "Main image" }),
      file,
      progress,
      hint,
      error,
    ]),
  ]);

  // Seed a pending image programmatically (TM-1061 clone): the cloned draft fetches the SOURCE event's
  // image as a Blob and hands it here as a File, so the create submit re-uploads it to a fresh
  // `event-images/{newId}` object (a DISTINCT storage object, never the source URL). Behaves exactly like
  // a hand-picked file — validate, hold it, show a local preview — so the ordinary submit path uploads it.
  const setPendingFile = (picked) => {
    if (!configured || !picked) return;
    const invalid = validateEventImageFile(picked);
    if (invalid) { setError(invalid); pendingFile = null; return; }
    setError("");
    pendingFile = picked;
    preview.src = URL.createObjectURL(picked);
    preview.hidden = false;
    placeholder.hidden = true;
  };

  return { node, getFile: () => pendingFile, setPendingFile, setProgress, resetProgress, setError };
}

/**
 * Duplicate a SOURCE event's image into the clone's create form (TM-1061), producing a NEW storage object
 * (never a shared reference to the source URL). Resolves the source `imagePath` to a fetchable URL — a
 * Storage object path (`event-images/{sourceId}`) via `downloadUrlForPath`, or an http(s) URL used directly
 * — fetches its bytes as a Blob, wraps it in a File, and seeds it as the create form's PENDING image. The
 * ordinary create submit then re-uploads that File to `event-images/{newId}` (a DISTINCT object), so the
 * clone gets its own image, exactly as if the admin had re-picked the same picture. Reuses the existing
 * event-image upload path end-to-end — no new plumbing, no backend work. Best-effort + non-fatal: any
 * failure (Storage off, object gone, a cross-origin fetch the browser blocks) just leaves the clone with
 * no image (the admin can add one) rather than breaking the form or silently sharing the source URL.
 *
 * @param {string} imagePath the SOURCE event's imagePath (a Storage object path or an http(s) URL).
 * @param {{ setPendingFile: (file: File) => void }} image the clone form's image control.
 */
async function seedCloneImage(imagePath, image) {
  try {
    const ref = eventImageRef(imagePath);
    if (!ref) return; // no image on the source → clone opens image-less
    const url = ref.kind === "url" ? ref.value : await downloadUrlForPath(ref.value);
    if (!url) return; // couldn't resolve a fetchable URL (Storage off / object gone)
    const res = await fetch(url);
    if (!res.ok) return;
    const blob = await res.blob();
    // Name/type the File so validateEventImageFile accepts it (it checks type.startsWith("image/")). Fall
    // back to a jpeg content-type if the blob carries none (a resolved download URL usually does).
    const type = blob.type && blob.type.startsWith("image/") ? blob.type : "image/jpeg";
    const ext = type.split("/")[1] || "jpg";
    const file = new File([blob], `cloned-event-image.${ext}`, { type });
    image.setPendingFile(file);
  } catch {
    // Non-fatal: a failed duplication leaves the clone image-less; never share the source URL.
  }
}

/**
 * Load the ACTIVE venues for the event-create picker (TM-519). Kept small (an admin curates tens of
 * venues) — one page of the active-only inventory. A failure returns an empty list so the picker
 * degrades to "one-off location only" rather than blocking event creation. Uses the shared eventApi
 * wrapper (Bearer + 401 handling); the venues API is under the same ADMIN gate as events.
 */
async function fetchActiveVenues() {
  try {
    const envelope = await eventApi("/api/v1/admin/venues?active=true&size=100&sort=name,asc");
    return Array.isArray(envelope?.items) ? envelope.items : [];
  } catch {
    return [];
  }
}

/**
 * The venue picker (TM-519): a <select> of saved active venues plus a "＋ New venue" shortcut, with a
 * blank "one-off location" option that preserves the legacy free-text path (back-compat). Picking a
 * venue prefills the (required) Location line and City from it when they're still blank — so the event
 * always keeps a display location AND references the venue, and edits to the venue propagate. The
 * picked venue id flows into the event payload as `venueId`.
 *
 * @param {?object} event the EventResponse being edited (for the prefill), or null on create.
 * @param {(venue: ?object, ctx: {initial: boolean}) => void} onSelect called with the chosen venue (or
 *   null) after a change. `ctx.initial` is true only for the one-shot echo of the current selection right
 *   after the async venue list loads (not a user pick) — so a consumer can skip clobbering established
 *   prefilled values (TM-1066 timezone derive).
 * @returns {{node: HTMLElement, getValue: () => string}}
 */
function buildVenuePicker(event, onSelect) {
  const currentId = event && event.venueId != null ? String(event.venueId) : "";
  const blankOption = () => el("option", { value: "", text: "One-off location (no saved venue)" });
  const select = el("select", { id: "event-venue", class: "tm-input", "aria-describedby": "event-venue-hint" }, [blankOption()]);
  const newLink = el("a", { class: "tm-btn tm-btn-sm", id: "event-venue-new", href: adminVenueNewHash() }, "＋ New venue");
  const hint = el("p", {
    id: "event-venue-hint",
    class: "tm-muted tm-field-hint",
    text: "Pick a saved venue to reuse its address + details (edits to it propagate), or leave as a one-off location.",
  });

  let venues = [];
  const populate = (list) => {
    venues = list;
    const options = [blankOption(), ...list.map((v) => el("option", { value: String(v.id), text: venueSummaryLabel(v) }))];
    // Editing an event whose venue was since deactivated: keep it selectable so the reference survives.
    if (currentId && !list.some((v) => String(v.id) === currentId)) {
      options.push(el("option", { value: currentId, text: `Venue #${currentId} (deactivated)` }));
    }
    clear(select).append(...options);
    select.value = currentId;
  };
  populate([]);

  // Async-load the active venues, then re-populate (keeping any current selection). This initial echo of
  // the current selection is flagged `initial:true` so a consumer can tell it apart from a real user pick
  // (TM-1066: the timezone derive must NOT clobber a saved/prefilled event timezone on edit-open — that
  // auto-fire is not a user choosing a venue).
  fetchActiveVenues().then((list) => {
    populate(list);
    onSelect?.(venues.find((v) => String(v.id) === select.value) || null, { initial: true });
  });

  select.addEventListener("change", () => {
    onSelect?.(venues.find((v) => String(v.id) === select.value) || null, { initial: false });
  });

  const node = el("div", { class: "tm-form-field", dataset: { field: "venueId" } }, [
    el("label", { class: "tm-field-label", for: "event-venue", text: "Venue (optional)" }),
    el("div", { class: "tm-field-fill" }, [select, newLink]),
    hint,
  ]);
  return { node, getValue: () => select.value };
}

/**
 * The In person / Online format selector (TM-1063) — a CLIENT-ONLY radio group (a real
 * `role=radiogroup` so it's keyboard + screen-reader navigable) that drives which location fields the
 * form shows. It persists NOTHING: the format is inferred from the event on edit and only shapes the
 * client view + the payload ("Online" locationText / onlineUrl). `onChange(format)` fires on a pick.
 *
 * @param {"inperson"|"online"} initial the format to select on open.
 * @param {(format: "inperson"|"online") => void} onChange
 * @returns {{node: HTMLElement, setActive: (format: string) => void}}
 */
function buildFormatSelector(initial, onChange) {
  const CHOICES = [
    [EVENT_FORMAT_INPERSON, "In person"],
    [EVENT_FORMAT_ONLINE, "Online"],
  ];
  const radios = new Map();
  const options = CHOICES.map(([value, label]) => {
    const input = el("input", {
      class: "tm-format-radio",
      type: "radio",
      name: "event-format",
      id: `event-format-${value}`,
      value,
      checked: value === initial,
      onChange: () => onChange(value),
    });
    radios.set(value, input);
    return el("label", { class: "tm-format-option", for: `event-format-${value}` }, [input, el("span", { text: label })]);
  });

  const node = el("div", { class: "tm-form-field", dataset: { field: "format" } }, [
    el("span", { class: "tm-field-label", id: "event-format-label", text: "Format" }),
    el("div", { class: "tm-format-choices", role: "radiogroup", "aria-labelledby": "event-format-label" }, options),
    el("p", { class: "tm-muted tm-field-hint", text: "In person shows the location + venue; Online asks only for a joining link." }),
  ]);

  return {
    node,
    setActive: (format) => {
      for (const [value, input] of radios) input.checked = value === format;
    },
  };
}

/**
 * The "Repeat" recurrence control (TM-796, recurring events v1) — CREATE-only. A toggle turns the single
 * event into a recurring SERIES: OFF = today's single-create path (unchanged); ON reveals the recurrence
 * picker — Daily/Weekly frequency, an "every N" interval, a weekday selector (Weekly only, defaulting to
 * the chosen start date's own weekday), and an end condition (Until a date OR After N occurrences, exactly
 * one). It owns NO backend field of its own — on submit the caller reads {@link readRecurrence} for the
 * recurrence draft, validates it with `validateSeriesDraft`, and POSTs a `CreateSeriesRequest` built by
 * `buildSeriesPayload` to `.../events/series` instead of the single-create POST.
 *
 * Styling mirrors the More-options fields (chips/selects/number inputs), consistent with the rest of the
 * form. Errors from `validateSeriesDraft` paint next to their field via {@link paintErrors}.
 *
 * @param {() => void} onToggle called when Repeat flips (the caller re-runs the save gate / relabels Save).
 * @param {() => void} onChange called on any recurrence field change (the caller re-validates).
 * @returns {{
 *   node: HTMLElement,
 *   isEnabled: () => boolean,
 *   readRecurrence: () => object,
 *   paintErrors: (errors: Record<string,string>) => void,
 *   syncWeekdayDefault: (startLocal: string) => void,
 * }}
 */
function buildRecurrenceControl(onToggle, onChange) {
  // The ON/OFF toggle. A plain checkbox styled as a switch — accessible, and its checked state is the
  // single source of "is this a series?". Its id is stable so the e2e / capture can target it.
  const toggle = el("input", {
    id: "event-repeat-toggle",
    class: "tm-repeat-toggle",
    type: "checkbox",
    role: "switch",
    "aria-describedby": "event-repeat-hint",
  });

  // Frequency chips (Daily / Weekly) — the buildPresetChips primitive, mirroring the age/price controls.
  let frequency = SERIES_FREQ_DAILY;
  const freqChips = el("div", { class: "tm-chips-slot", id: "event-repeat-frequency" });
  const freqError = el("p", { id: "event-repeat-frequency-error", class: "tm-field-error", role: "alert", hidden: true });

  // Every-N interval.
  const intervalInput = el("input", {
    id: "event-repeat-interval",
    class: "tm-input",
    type: "number",
    min: SERIES_INTERVAL_MIN,
    inputmode: "numeric",
    value: String(SERIES_INTERVAL_MIN),
    "aria-describedby": "event-repeat-interval-error",
  });
  const intervalError = el("p", { id: "event-repeat-interval-error", class: "tm-field-error", role: "alert", hidden: true });
  // The "day(s)/week(s)" unit label after the interval — reflects the current frequency.
  const intervalUnit = el("span", { class: "tm-repeat-interval-unit", id: "event-repeat-interval-unit", text: "day(s)" });

  // Weekday selector (Weekly only) — a plain <select> of the ISO weekdays.
  const weekdaySelect = el(
    "select",
    { id: "event-repeat-weekday", class: "tm-input", "aria-describedby": "event-repeat-weekday-error" },
    SERIES_WEEKDAYS.map((d) => el("option", { value: d.value, text: d.label })),
  );
  const weekdayError = el("p", { id: "event-repeat-weekday-error", class: "tm-field-error", role: "alert", hidden: true });
  const weekdayField = el("div", { class: "tm-form-field tm-repeat-weekday-field", dataset: { field: "byWeekday" } }, [
    el("label", { class: "tm-field-label", for: "event-repeat-weekday", text: "On weekday" }),
    weekdaySelect,
    weekdayError,
  ]);
  // Whether the admin has hand-picked a weekday — once they do, a later start-date change won't clobber it
  // (the field DEFAULTS to the start's weekday only while untouched, mirroring the TM-1066 tz-derive rule).
  let weekdayUserPicked = false;
  weekdaySelect.addEventListener("change", () => { weekdayUserPicked = true; onChange(); });

  // End condition — exactly one of "Until <date>" / "After <N> occurrences", chosen by two radios.
  let endMode = SERIES_END_UNTIL;
  const untilInput = el("input", {
    id: "event-repeat-until",
    class: "tm-input",
    type: "date",
    "aria-describedby": "event-repeat-end-error",
  });
  const afterInput = el("input", {
    id: "event-repeat-after",
    class: "tm-input",
    type: "number",
    min: 1,
    inputmode: "numeric",
    placeholder: "e.g. 8",
    "aria-describedby": "event-repeat-end-error",
  });
  const endError = el("p", { id: "event-repeat-end-error", class: "tm-field-error", role: "alert", hidden: true });

  const endRadio = (value, label, control) => {
    const radio = el("input", {
      class: "tm-repeat-end-radio",
      type: "radio",
      name: "event-repeat-end",
      id: `event-repeat-end-${value}`,
      value,
      checked: value === endMode,
      onChange: () => { endMode = value; applyEndView(); onChange(); },
    });
    return { radio, node: el("label", { class: "tm-repeat-end-option", for: `event-repeat-end-${value}` }, [radio, el("span", { text: label }), control]) };
  };
  const untilOpt = endRadio(SERIES_END_UNTIL, "Until", untilInput);
  const afterOpt = endRadio(SERIES_END_AFTER, "After", afterInput);
  const afterUnit = el("span", { class: "tm-repeat-after-unit", text: "occurrences" });
  afterOpt.node.append(afterUnit);
  const applyEndView = () => {
    untilOpt.radio.checked = endMode === SERIES_END_UNTIL;
    afterOpt.radio.checked = endMode === SERIES_END_AFTER;
    // Disable the inactive control so a stray value in it can't be read (only the active one supplies the
    // end condition; buildSeriesPayload reads by endMode anyway, but this keeps the UI honest).
    untilInput.disabled = endMode !== SERIES_END_UNTIL;
    afterInput.disabled = endMode !== SERIES_END_AFTER;
  };

  // The frequency-dependent view: the weekday field shows for Weekly only; the interval unit tracks it.
  const applyFrequencyView = () => {
    const weekly = frequency === SERIES_FREQ_WEEKLY;
    weekdayField.hidden = !weekly;
    intervalUnit.textContent = weekly ? "week(s)" : "day(s)";
  };
  const paintFreqChips = () => {
    for (const btn of freqChips.querySelectorAll(".tm-chip")) {
      const on = btn.dataset.chip === frequency;
      btn.classList.toggle("tm-chip-active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    }
  };
  freqChips.append(
    buildPresetChips(
      SERIES_FREQUENCIES.map(([value, label]) => ({ value, label })),
      (value) => {
        frequency = value === SERIES_FREQ_WEEKLY ? SERIES_FREQ_WEEKLY : SERIES_FREQ_DAILY;
        paintFreqChips();
        applyFrequencyView();
        onChange();
      },
      { ariaLabel: "Repeat frequency" },
    ),
  );
  paintFreqChips();

  intervalInput.addEventListener("input", onChange);
  untilInput.addEventListener("input", onChange);
  afterInput.addEventListener("input", onChange);

  // The reveal region — everything below the toggle, shown only when Repeat is ON.
  const reveal = el("div", { class: "tm-repeat-body", id: "event-repeat-body", hidden: true }, [
    el("div", { class: "tm-form-field", dataset: { field: "frequency" } }, [
      el("span", { class: "tm-field-label", text: "Frequency" }),
      freqChips,
      freqError,
    ]),
    el("div", { class: "tm-form-field", dataset: { field: "interval" } }, [
      el("label", { class: "tm-field-label", for: "event-repeat-interval", text: "Repeat every" }),
      el("div", { class: "tm-repeat-interval-row" }, [intervalInput, intervalUnit]),
      intervalError,
    ]),
    weekdayField,
    el("div", { class: "tm-form-field", dataset: { field: "end" } }, [
      el("span", { class: "tm-field-label", id: "event-repeat-end-label", text: "Ends" }),
      el("div", { class: "tm-repeat-end-choices", role: "radiogroup", "aria-labelledby": "event-repeat-end-label" }, [untilOpt.node, afterOpt.node]),
      endError,
    ]),
  ]);

  const applyToggleView = () => { reveal.hidden = !toggle.checked; };
  toggle.addEventListener("change", () => { applyToggleView(); onToggle(); });

  applyFrequencyView();
  applyEndView();

  const node = el("div", { class: "tm-form-field tm-repeat", id: "event-repeat", dataset: { field: "repeat" } }, [
    el("label", { class: "tm-repeat-switch", for: "event-repeat-toggle" }, [
      toggle,
      el("span", { class: "tm-field-label", text: "Repeat" }),
    ]),
    el("p", { class: "tm-muted tm-field-hint", id: "event-repeat-hint", text: "Turn on to create a repeating series from this event. The details above become the template; the times become the first occurrence." }),
    reveal,
  ]);

  return {
    node,
    isEnabled: () => toggle.checked,
    readRecurrence: () => ({
      frequency,
      interval: intervalInput.value,
      byWeekday: frequency === SERIES_FREQ_WEEKLY ? weekdaySelect.value : "",
      endMode,
      untilDate: untilInput.value,
      afterN: afterInput.value,
    }),
    paintErrors: (errors = {}) => {
      const set = (node, msg) => { node.textContent = msg || ""; node.hidden = !msg; };
      set(freqError, errors.frequency);
      set(intervalError, errors.interval);
      set(weekdayError, errors.byWeekday);
      // Both the end-mode and per-branch (until/after) errors surface on the one end error node.
      set(endError, errors.endMode || errors.untilDate || errors.afterN);
    },
    // Default the weekday to the chosen start date's own weekday, UNLESS the admin has hand-picked one
    // (TM-796: "defaults to the weekday of the chosen start date"). Called on start-date change.
    syncWeekdayDefault: (startLocal) => {
      if (weekdayUserPicked) return;
      const wd = weekdayOfLocal(startLocal);
      if (wd) weekdaySelect.value = wd;
    },
  };
}

/**
 * The Map URL live preview (TM-1063). A debounced GET /api/v1/link-preview?url=… renders a small card
 * for a reachable URL (reusing the pure normalisePreview view-model via {@link mapUrlPreviewState}), a
 * neutral "no rich preview" note when the URL is reachable but carries no OpenGraph data (e.g. a Google
 * Maps consent page — NOT broken), or a "link looks broken" note ONLY when the endpoint reports the URL
 * unreachable (a non-2xx). It NEVER gates Save — it's advisory. A newer keystroke supersedes an
 * in-flight request via a monotonically-increasing token, so a slow response can't clobber a newer one.
 *
 * @returns {{node: HTMLElement, schedule: (url: string) => void}}
 */
function buildMapUrlPreview() {
  const node = el("div", { class: "tm-map-preview", dataset: { field: "mapUrlPreview" }, "aria-live": "polite" });
  let timer = null;
  let token = 0;

  const render = (state, preview) => {
    clear(node);
    if (state === "none") return;
    if (state === "broken") {
      node.append(el("p", { class: "tm-muted tm-map-preview-broken", text: "This link looks broken — we couldn't reach it. You can still save it." }));
      return;
    }
    if (state === "empty") {
      node.append(el("p", { class: "tm-muted tm-map-preview-empty", text: "Link looks reachable (no rich preview available)." }));
      return;
    }
    // state === "preview": a small card. Fields are rendered as text / an image src (never HTML).
    const children = [];
    if (preview.imageUrl) {
      children.push(el("img", {
        class: "tm-map-preview-img",
        src: preview.imageUrl,
        alt: "",
        loading: "lazy",
        referrerpolicy: "no-referrer",
        crossorigin: "anonymous",
        onError: (e) => { e.target.style.display = "none"; },
      }));
    }
    const body = [el("div", { class: "tm-map-preview-title", text: preview.title })];
    if (preview.description) body.push(el("div", { class: "tm-map-preview-desc", text: preview.description }));
    children.push(el("div", { class: "tm-map-preview-body" }, body));
    node.append(el("div", { class: "tm-map-preview-card" }, children));
  };

  const fetchPreview = async (url) => {
    const mine = ++token;
    try {
      const response = await apiFetch(`/api/v1/link-preview?url=${encodeURIComponent(url)}`, {
        headers: { Accept: "application/json" },
      });
      // ok === false → the endpoint rejected the URL as unfetchable (broken). A 2xx body may be empty.
      const raw = response.ok ? await response.json().catch(() => null) : null;
      if (mine !== token) return; // a newer keystroke superseded this request
      const { state, preview } = mapUrlPreviewState(url, response.ok, raw);
      render(state, preview);
    } catch {
      if (mine !== token) return;
      // A transport-level throw (rare — apiFetch returns non-2xx rather than throwing) = unreachable.
      render("broken", null);
    }
  };

  const schedule = (rawValue) => {
    const url = String(rawValue ?? "").trim();
    if (timer) clearTimeout(timer);
    if (url === "") {
      token++; // cancel any in-flight render
      render("none", null);
      return;
    }
    timer = setTimeout(() => fetchPreview(url), 450);
  };

  return { node, schedule };
}

/**
 * The age-band control (TM-1065) — one control that replaces the old two raw "Min age / Max age" number
 * inputs. It offers the preset chips (18-30 / 21-35 / 30+ / All ages) plus a **Custom** chip that reveals
 * the two number inputs for any other band. Built on the shared {@link buildPresetChips} primitive.
 *
 * The two number inputs are the SAME `#event-age-min` / `#event-age-max` inputs FORM_FIELDS built (passed
 * in via `customRow`), so `readDraft` / `validateEventDraft` / server-error routing are untouched: a
 * preset chip just SEEDS those inputs (via {@link ageBandToMinMax}) and hides them; Custom reveals them.
 * On open it reverse-maps the current `{min,max}` draft to a preset ({@link minMaxToAgeBand}), falling back
 * to Custom for a non-preset band (e.g. a saved 25-40, or the 18-99 create default) so the exact numbers
 * stay visible + editable.
 *
 * A server `ageMin`/`ageMax` validation error is routed here (via `revealForError`) so it renders on the
 * band's own error node and forces Custom open — it can never hide behind a collapsed reveal.
 *
 * @param {{minInput: HTMLInputElement, maxInput: HTMLInputElement, customRow: HTMLElement}} parts the
 *   FORM_FIELDS-built min/max inputs and the two-up `.tm-field-row` wrapper holding their field blocks.
 * @param {string} initialMin the min value already seeded into the input (draft/prefill).
 * @param {string} initialMax the max value already seeded into the input.
 * @param {() => void} onChange called after a chip pick seeds the inputs (the caller revalidates).
 * @returns {{node: HTMLElement, revealForError: (message: string) => void, clearError: () => void}}
 */
function buildAgeBandControl({ minInput, maxInput, customRow }, initialMin, initialMax, onChange) {
  // The chip set = the presets + a trailing Custom chip. Each chip's data-chip is its label so a chip is
  // targetable by copy (e.g. `.tm-chip[data-chip="Custom"]` in the e2e).
  const chipDefs = [...AGE_BAND_PRESETS.map((b) => b.label), AGE_BAND_CUSTOM];
  let active = minMaxToAgeBand(initialMin, initialMax); // the preset (or Custom) the current band maps to

  const error = el("p", { id: "event-age-band-error", class: "tm-field-error", role: "alert", hidden: true });
  const chipsHolder = el("div", { class: "tm-chips-slot" });
  // The reveal region wraps the two number inputs; shown only for Custom.
  const reveal = el("div", { class: "tm-age-custom", hidden: true }, [customRow]);

  const paintActive = () => {
    // Reflect the active band on the chips (aria-pressed + a class hook) and toggle the Custom reveal.
    for (const btn of chipsHolder.querySelectorAll(".tm-chip")) {
      const on = btn.dataset.chip === active;
      btn.classList.toggle("tm-chip-active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    }
    reveal.hidden = active !== AGE_BAND_CUSTOM;
  };

  const pick = (label) => {
    active = label;
    if (label === AGE_BAND_CUSTOM) {
      // Custom keeps whatever numbers are already in the inputs (don't wipe an admin's typed band).
      paintActive();
      // Focus the min input so a keyboard user lands on it once the reveal opens.
      minInput.focus();
    } else {
      const { min, max } = ageBandToMinMax(label);
      minInput.value = min;
      maxInput.value = max;
      paintActive();
    }
    error.hidden = true;
    error.textContent = "";
    onChange();
  };

  const chips = buildPresetChips(chipDefs, (value) => pick(value), { ariaLabel: "Age band" });
  chipsHolder.append(chips);
  paintActive();

  // Typing in the custom inputs can change which band the numbers represent — keep the active chip in
  // sync (e.g. typing 18/30 by hand lights the "18-30" preset chip) WITHOUT collapsing the reveal.
  const syncFromInputs = () => {
    const mapped = minMaxToAgeBand(minInput.value, maxInput.value);
    // Stay on Custom while the admin is editing custom numbers even if they momentarily match a preset,
    // so the reveal doesn't slam shut mid-edit — only reflect the chip highlight.
    for (const btn of chipsHolder.querySelectorAll(".tm-chip")) {
      const on = active === AGE_BAND_CUSTOM ? btn.dataset.chip === AGE_BAND_CUSTOM : btn.dataset.chip === mapped;
      btn.classList.toggle("tm-chip-active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    }
  };
  minInput.addEventListener("input", syncFromInputs);
  maxInput.addEventListener("input", syncFromInputs);

  const node = el("div", { class: "tm-form-field tm-age-band", dataset: { field: "ageBand" } }, [
    el("span", { class: "tm-field-label", id: "event-age-band-label", text: "Age band (optional)" }),
    chipsHolder,
    el("p", { class: "tm-muted tm-field-hint", text: "Who can attend. Tap a band, or Custom to set exact ages. All ages = no limit." }),
    reveal,
    error,
  ]);

  return {
    node,
    // A server ageMin/ageMax error → force Custom open + render on the band's own error node so it's
    // never hidden behind a collapsed reveal (AC: a server ageMin error renders on the band control).
    revealForError: (message) => {
      active = AGE_BAND_CUSTOM;
      paintActive();
      error.textContent = message || "";
      error.hidden = !message;
    },
    clearError: () => {
      error.textContent = "";
      error.hidden = true;
    },
  };
}

/**
 * The price control (TM-1076) — one control that replaces the absent price field that made every
 * form-created event silently £5. It offers the preset chips (Free (£0) / £5 / £10) plus a **Custom**
 * chip that reveals a free-text £ amount input for any other price. Built on the shared
 * {@link buildPresetChips} primitive, mirroring the age-band control.
 *
 * DEFAULT selection = **Free** — a brand-new, untouched control resolves to `pricePence:0`, so creating an
 * event with the control untouched produces a FREE event, not £5 (the whole point of the ticket).
 *
 * The £ input is the SAME `#event-price` input FORM_FIELDS built (passed in via `priceInput`), so
 * `readDraft` / `validateEventDraft` / server-error routing are untouched: a preset chip just SEEDS that
 * input (via {@link priceChipToPence} → pounds) and hides it; Custom reveals it. On open it reverse-maps
 * the current £ draft to a preset ({@link penceToPriceChip}), falling back to Custom for a non-preset
 * amount (e.g. a saved £7.50) so the exact number stays visible + editable.
 *
 * A server `pricePence` validation error is routed here (via `revealForError`) so it renders on the
 * price control's own error node and forces Custom open — it can never hide behind a collapsed reveal.
 *
 * @param {HTMLInputElement} priceInput the FORM_FIELDS-built #event-price £ amount input.
 * @param {string} initialPrice the £ value already seeded into the input (draft/prefill; "" on create).
 * @param {() => void} onChange called after a chip pick seeds the input (the caller revalidates).
 * @returns {{node: HTMLElement, revealForError: (message: string) => void, clearError: () => void}}
 */
function buildPriceControl(priceInput, initialPrice, onChange) {
  // The chip set = the presets + a trailing Custom chip. Each chip's data-chip is its label so a chip is
  // targetable by copy (e.g. `.tm-chip[data-chip="Free (£0)"]` / `.tm-chip[data-chip="Custom"]` in the e2e).
  const chipDefs = [...PRICE_CHIP_PRESETS.map((p) => p.label), PRICE_CHIP_CUSTOM];
  // Reverse-map the initial £ amount to a chip. On CREATE the input is blank → penceToPriceChip("") =
  // Custom, so we explicitly default to Free (the ticket's DEFAULT) when there's nothing to map.
  const initialPence = initialPrice.trim() === "" ? null : Math.round(Number(initialPrice.trim()) * 100);
  let active = initialPrice.trim() === "" ? PRICE_DEFAULT_CHIP : penceToPriceChip(initialPence);

  const error = el("p", { id: "event-price-error", class: "tm-field-error", role: "alert", hidden: true });
  const chipsHolder = el("div", { class: "tm-chips-slot" });
  // The reveal region wraps the £ input; shown only for Custom.
  const reveal = el("div", { class: "tm-price-custom", hidden: true }, [priceInput.closest(".tm-form-field") || priceInput]);

  const paintActive = () => {
    for (const btn of chipsHolder.querySelectorAll(".tm-chip")) {
      const on = btn.dataset.chip === active;
      btn.classList.toggle("tm-chip-active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    }
    reveal.hidden = active !== PRICE_CHIP_CUSTOM;
  };

  const pick = (label) => {
    active = label;
    if (label === PRICE_CHIP_CUSTOM) {
      // Custom keeps whatever number is already in the input (don't wipe an admin's typed amount).
      paintActive();
      priceInput.focus();
    } else {
      // Seed the £ input with the preset's amount so the draft (and buildEventPayload) carries it — even
      // though the input is hidden, readDraft reads its value, so Free MUST seed "0" here.
      priceInput.value = penceToPounds(priceChipToPence(label));
      paintActive();
    }
    error.hidden = true;
    error.textContent = "";
    onChange();
  };

  const chips = buildPresetChips(chipDefs, (value) => pick(value), { ariaLabel: "Price" });
  chipsHolder.append(chips);

  // On CREATE (blank input) the default chip is Free — SEED "0" into the input so the untouched control
  // resolves to pricePence:0 (not a blank the payload would floor to 0 anyway, but explicit = correct and
  // keeps readDraft honest). On EDIT the input already carries the prefilled amount; leave it.
  if (initialPrice.trim() === "" && active !== PRICE_CHIP_CUSTOM) {
    priceInput.value = penceToPounds(priceChipToPence(active));
  }
  paintActive();

  // Typing in the custom input can change which preset the number represents — keep the active chip in
  // sync (e.g. typing 5 by hand lights the "£5" chip) WITHOUT collapsing the reveal.
  const syncFromInput = () => {
    const raw = priceInput.value.trim();
    const pence = raw === "" ? null : Math.round(Number(raw) * 100);
    const mapped = Number.isFinite(pence) ? penceToPriceChip(pence) : PRICE_CHIP_CUSTOM;
    for (const btn of chipsHolder.querySelectorAll(".tm-chip")) {
      const on = active === PRICE_CHIP_CUSTOM ? btn.dataset.chip === PRICE_CHIP_CUSTOM : btn.dataset.chip === mapped;
      btn.classList.toggle("tm-chip-active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    }
  };
  priceInput.addEventListener("input", syncFromInput);

  const node = el("div", { class: "tm-form-field tm-price-band", dataset: { field: "price" } }, [
    el("span", { class: "tm-field-label", id: "event-price-label", text: "Price" }),
    chipsHolder,
    el("p", { class: "tm-muted tm-field-hint", text: "What attendees pay. Free by default — tap a preset, or Custom to set an exact amount." }),
    reveal,
    error,
  ]);

  return {
    node,
    // A server pricePence error → force Custom open + render on the control's own error node so it's never
    // hidden behind a collapsed reveal.
    revealForError: (message) => {
      active = PRICE_CHIP_CUSTOM;
      paintActive();
      error.textContent = message || "";
      error.hidden = !message;
    },
    clearError: () => {
      error.textContent = "";
      error.hidden = true;
    },
  };
}

/**
 * Build the create/edit event form as a detached DOM subtree (no shell) — the SAME fields, validation,
 * Coffee & X chips, image control and read-back the modal used; only the surrounding shell changed
 * from a modal() to a full page (TM-426). `mode` is "create" (event=null) or "edit" (event = the
 * EventResponse). On a valid submit it converts the local wall-clock times to UTC, POSTs/PATCHes,
 * uploads any picked image against the (now-existing) id, then calls `onDone`; a "Cancel" button (and
 * the page's back link) call `onCancel`. Returns { node } to mount + a `focusHeading` to call once the
 * node is in the document.
 */
function buildEventForm({ mode, event = null, cloneDraft = null, onDone, onCancel, onReset }) {
  // Clone mode (TM-1061): `mode` is "create" (the clone goes through the ordinary create POST — nothing
  // persisted until Save) but the form opens PRE-FILLED from `cloneDraft` (a form-model built by the pure
  // buildCloneDraft: source fields copied, times shifted by the chosen offset, opening message blanked).
  // It's a distinct concept from an EDIT (there's no source `event` to PATCH), so it rides the create path
  // everywhere `event` is checked — `event` stays null. `cloneDraft.imagePath` (if any) is duplicated to a
  // NEW storage object below by seeding the create form's pending image from the source image blob.
  const isClone = mode === "create" && cloneDraft != null;
  const fields = new Map();
  const fieldNodes = FORM_FIELDS.map((f) => buildField(f, fields));
  const headingInput = fields.get("heading").input;

  // Group the fields: a chips row above the heading, then paired short fields two-up (links / when /
  // visibility / limits / age) using .tm-field-row, everything else full width. Order follows FORM_FIELDS.
  const byKey = new Map(FORM_FIELDS.map((f, i) => [f.key, fieldNodes[i]]));
  const rowGroups = new Map();
  const layout = [];
  for (const f of FORM_FIELDS) {
    if (f.row) {
      if (!rowGroups.has(f.row)) {
        const holder = el("div", { class: "tm-field-row" });
        rowGroups.set(f.row, holder);
        layout.push(holder);
      }
      rowGroups.get(f.row).append(byKey.get(f.key));
    } else {
      layout.push(byKey.get(f.key));
    }
  }

  // Age band (TM-1065): pull the two-up custom-age row OUT of the top-level layout — it's re-homed inside
  // the age-band control's Custom reveal (built below). We keep a reference to splice the band control
  // into the layout at the same position the row occupied.
  const customAgeRow = rowGroups.get("customage") || null;
  const ageRowIndex = customAgeRow ? layout.indexOf(customAgeRow) : -1;
  if (ageRowIndex >= 0) layout.splice(ageRowIndex, 1);

  // Price (TM-1076): pull the standalone #event-price £ field OUT of the top-level layout — it's re-homed
  // inside the price control's Custom reveal (built below). We splice the control into the layout at the
  // position the £ field occupied.
  const priceFieldNode = byKey.get("price") || null;
  const priceFieldIndex = priceFieldNode ? layout.indexOf(priceFieldNode) : -1;
  if (priceFieldIndex >= 0) layout.splice(priceFieldIndex, 1);

  const image = buildImageControl(event);
  // The venue picker (TM-519) is built below (after revalidate exists); readDraft reads its value.
  let venuePicker = null;
  // The "More options" <details> the timezone field lives under (TM-1066); a mutable ref so the submit
  // error-paint can force it OPEN when the (required) timezone is in error — a hidden required error is
  // otherwise invisible. Set once the disclosure is built (below).
  let moreOptions = null;
  // TM-1066 derive-precedence: has the admin hand-edited the timezone since open? The event's zone is
  // DERIVED from the picked venue (deriveVenueTimezone) UNLESS this flips true — after that a manual
  // value is never clobbered by a later venue re-pick. Set only from a REAL user edit of the tz select
  // (a native change/input, or the "Use mine" button which dispatches "input"); the venue-derive sets
  // the value programmatically WITHOUT dispatching, so it never trips this.
  let tzUserEdited = false;
  // The age-band control (TM-1065) is built after the model prefill; setFieldError routes ageMin/ageMax
  // errors onto its own error node (via this mutable ref) so they stay visible on the band control.
  let ageBand = null;
  // The price control (TM-1076) is built after the model prefill; setFieldError routes `price` errors onto
  // its own error node (via this mutable ref) so they stay visible on the control (its £ input lives in a
  // Custom reveal, so a bare field error could otherwise hide behind a collapsed reveal).
  let priceControl = null;

  // Format selector (TM-1063) — CLIENT-ONLY view state, no backend field. In person → show the physical
  // cluster (Location + Venue + City + Map URL) and hide Online URL; Online → show Online URL only. The
  // chosen format is inferred on edit (formatFromEvent) and fed into the draft so validateEventDraft /
  // buildEventPayload apply the format-conditional rules. `mapUrl`/`onlineUrl` share the "links" row, so
  // we toggle the individual field WRAPPERS (not the row) to hide one while showing the other.
  // Clone (TM-1061) carries the source's inferred format on its draft (toFormModel set draft.format via
  // formatFromEvent) so an Online source clones as Online; a plain create is In person. Fall back to
  // re-deriving from the draft's signals if a hand-built draft omitted format.
  let currentFormat = event
    ? formatFromEvent(event)
    : isClone
      ? (cloneDraft.format || formatFromEvent(cloneDraft))
      : EVENT_FORMAT_INPERSON;
  // Physical-only nodes hidden in Online mode; the venue picker node is spliced in later, so it's toggled
  // via a mutable ref set once it exists.
  const formatToggle = buildFormatSelector(currentFormat, (next) => setFormat(next));

  const setFieldError = (key, message) => {
    const f = fields.get(key);
    if (!f) return;
    f.error.textContent = message || "";
    f.error.hidden = !message;
    if (message) {
      f.input.setAttribute("aria-invalid", "true");
      f.input.classList.add("tm-field-invalid");
    } else {
      f.input.removeAttribute("aria-invalid");
      f.input.classList.remove("tm-field-invalid");
    }
    // Age band (TM-1065): the two age inputs live inside the band control's Custom reveal, so mirror their
    // error onto the band's own error node — and force the reveal open — so a server (or live) ageMin/
    // ageMax error can never hide behind a collapsed reveal. Clearing it clears the band error too.
    if ((key === "ageMin" || key === "ageMax") && ageBand) {
      if (message) ageBand.revealForError(message);
      else ageBand.clearError();
    }
    // Price (TM-1076): the £ input lives inside the price control's Custom reveal, so mirror its error onto
    // the control's own error node — and force the reveal open — so a server (or live) `price`/`pricePence`
    // error can never hide behind a collapsed reveal. Clearing it clears the control error too.
    if (key === "price" && priceControl) {
      if (message) priceControl.revealForError(message);
      else priceControl.clearError();
    }
    // Timezone (TM-1066) now lives under the "More options" <details>; a server OR live error on it force-
    // opens the disclosure so it's never hidden behind a collapsed section. Clearing it leaves the
    // disclosure as-is (don't slam it shut mid-edit). paintAllErrors additionally focuses on submit.
    if (key === "timezone" && message && moreOptions) moreOptions.open = true;
  };

  const readDraft = () => {
    const draft = {};
    for (const f of FORM_FIELDS) draft[f.key] = fields.get(f.key).input.value;
    // The venue reference (TM-519) isn't a FORM_FIELDS input; read it off the picker (blank on create
    // until built, "" = one-off location).
    draft.venueId = venuePicker ? venuePicker.getValue() : "";
    // The CLIENT-ONLY format (TM-1063) drives the conditional validation + payload shaping.
    draft.format = currentFormat;
    return draft;
  };

  // Live-validate the WHOLE draft (cross-field rules need it), but only paint the field the admin just
  // changed plus any field ALREADY showing an error — so a pristine, untouched required field doesn't
  // shout before they've submitted (the profile.js live-clear UX). paintAllErrors() (on submit) shows
  // everything.
  const revalidate = (changedKey) => {
    const { errors } = validateEventDraft(readDraft(), { requireForCreate: mode === "create" });
    for (const f of FORM_FIELDS) {
      const showing = !fields.get(f.key).error.hidden;
      if (f.key === changedKey || showing) setFieldError(f.key, errors[f.key] || "");
    }
    return errors;
  };
  const paintAllErrors = () => {
    const { errors } = validateEventDraft(readDraft(), { requireForCreate: mode === "create" });
    for (const f of FORM_FIELDS) setFieldError(f.key, errors[f.key] || "");
    // TM-1066: the (required) timezone now lives under the "More options" <details>. If it's in error on
    // submit, force the disclosure OPEN and focus the field — a hidden required error is otherwise
    // invisible, so the admin can't see or reach what's blocking Save.
    if (errors.timezone && moreOptions) {
      moreOptions.open = true;
      const tzInput = fields.get("timezone").input;
      if (tzInput) tzInput.focus();
    }
    return errors;
  };

  // Show/hide the location cluster for the current format (TM-1063). In person → physical trio (Location,
  // Venue, City, Map URL) visible, Online URL hidden; Online → only Online URL visible. Values are NOT
  // cleared on toggle — hiding a populated field keeps its value so a toggle round-trip restores it
  // (AC: "toggle back restores values, no loss"). Errors on a now-hidden field are cleared so a stale
  // "Location required" can't block Save after switching to Online.
  const physicalKeys = ["locationText", "mapUrl", "city"];
  let mapPreviewRef = null; // set once buildMapUrlPreview runs (below); toggled with the physical cluster
  // The Online URL field's <label>: its text is state-dependent (TM-1063). The field is optional in
  // In-person mode (hidden) but REQUIRED in Online mode — so the label must not read "(optional)" then.
  const onlineUrlLabel = byKey.get("onlineUrl").querySelector(".tm-field-label");
  const applyFormatView = () => {
    const online = currentFormat === EVENT_FORMAT_ONLINE;
    for (const key of physicalKeys) {
      byKey.get(key).hidden = online;
      if (online) setFieldError(key, ""); // drop a stale required-error on a hidden physical field
    }
    if (venuePicker && venuePicker.node) venuePicker.node.hidden = online;
    // The Map URL preview slot rides with the Map URL field — hide + clear it in Online mode so a stale
    // preview card can't linger after switching away from In person.
    if (mapPreviewRef) {
      mapPreviewRef.node.hidden = online;
      // Cancel the preview when hidden; re-seed it from the retained value when In person is restored
      // (round-trip must not lose the Map URL or its preview).
      mapPreviewRef.schedule(online ? "" : (fields.get("mapUrl").input.value || ""));
    }
    byKey.get("onlineUrl").hidden = !online;
    if (!online) setFieldError("onlineUrl", ""); // drop a stale online-url error when hidden
    // Reflect the field's REAL state in its label: required (the joining link) in Online mode, optional
    // otherwise — so the label never lies (TM-1063 follow-up). No "(optional)" while it's required.
    if (onlineUrlLabel) onlineUrlLabel.textContent = online ? "Online URL (required)" : "Online URL (optional)";
  };
  const setFormat = (next) => {
    const normalised = next === EVENT_FORMAT_ONLINE ? EVENT_FORMAT_ONLINE : EVENT_FORMAT_INPERSON;
    if (normalised === currentFormat) return;
    currentFormat = normalised;
    formatToggle.setActive(currentFormat);
    applyFormatView();
    revalidate(); // re-run the format-conditional gate (no single changedKey — repaint showing errors)
  };

  for (const f of FORM_FIELDS) {
    const input = fields.get(f.key).input;
    input.addEventListener("input", () => revalidate(f.key));
    // <select>s (timezone, city) fire "change", not "input", in some engines — listen for both.
    if (f.type === "timezone" || f.type === "select") input.addEventListener("change", () => revalidate(f.key));
  }
  // TM-1066: any REAL user edit of the timezone (native change/input, or "Use mine" which dispatches
  // "input") pins it — a later venue re-pick then leaves the admin's value alone (deriveVenueTimezone).
  // The venue-derive sets the value programmatically without dispatching, so it never trips this.
  {
    const tzEdit = fields.get("timezone").input;
    const markEdited = () => { tzUserEdited = true; };
    tzEdit.addEventListener("input", markEdited);
    tzEdit.addEventListener("change", markEdited);
  }

  // Prefill: timezone options first (needs the selected zone), then the rest of the values. A CLONE
  // (TM-1061) prefills from its clone draft (source fields copied, times shifted, opening message blanked)
  // — the same shape toFormModel produces, so the identical prefill loop below fills every field.
  const model = event ? toFormModel(event) : isClone ? cloneDraft : { timezone: guessTimeZone() };
  fillTimeZoneOptions(fields.get("timezone").input, model.timezone);
  for (const f of FORM_FIELDS) {
    if (f.type === "timezone") continue;
    if (f.key === "city") continue; // the city <select> needs the off-list allowance (below)
    const v = model[f.key];
    if (v != null && v !== "") fields.get(f.key).input.value = v;
  }
  // City (TM-1063): a dropdown of cities. A saved OFF-LIST city (e.g. "Dubai" set before the list
  // existed, or a venue's off-list city) stays selectable via an injected option so an existing event is
  // never silently overwritten on save — the profile.js fillCitySelect / cityChoiceError idiom. The
  // options seeded by buildField are the CITY_OPTIONS fallback (never empty on first paint); the priming
  // below swaps in the admin-managed catalogue once it resolves.
  fillCitySelect(fields.get("city").input, model.city);
  // TM-1174: prime the admin-managed city catalogue and repopulate the #event-city options from
  // offeredCityNames() once it resolves, so an admin-added city becomes selectable with NO code deploy.
  // loadCityCatalogue never rejects (it resolves to the fallback on failure/empty), so a catalogue
  // outage just leaves the field on the fallback list — the picker never breaks. The current selection
  // (incl. an off-list saved city) is preserved across the repaint.
  loadCityCatalogue().then(() => repopulateCitySelect(fields.get("city").input));

  // Booking cutoff (TM-1157): show the EFFECTIVE inherited value (the resolved override → city → app
  // default, or the app default of 1h on create) as the field's PLACEHOLDER + in the helper text, so an
  // admin who leaves the override BLANK sees exactly what will apply. The input itself stays blank when the
  // event inherits (toFormModel gave "" for a null override) — the placeholder is what renders in that
  // case. Reads the resolved value off the event on edit; falls back to the app default on create.
  {
    const cutoffField = fields.get("bookingCutoffHours");
    if (cutoffField) {
      const effective = effectiveBookingCutoffHours(event || {});
      cutoffField.input.setAttribute("placeholder", String(effective));
      // Resolve the hint node from the field's own wrapper (NOT document.getElementById) — the form is
      // still an in-memory tree at prefill time, not yet mounted, so a document lookup would miss.
      const hint = cutoffField.input.closest(".tm-form-field")?.querySelector(".tm-field-hint");
      if (hint) {
        const unit = effective === 1 ? "hour" : "hours";
        const applies =
          effective === 0
            ? "accepted right up to the start"
            : `stopped ${effective} ${unit} before the start`;
        hint.textContent =
          `Hours before the start that RSVPs, waitlist joins and claims stop. 0 = accept right up to the start.`
          + ` Blank = the city / app default (currently RSVPs ${applies}).`;
      }
    }
  }

  // Age band (TM-1065): on CREATE the default band is 18-99 (attendees are 18-99, TM-884) — seed the two
  // age inputs so the whole adult range is pre-filled and untouched. 18-99 is a non-preset band, so the
  // control opens on Custom showing 18/99 (see buildAgeBandControl → minMaxToAgeBand). On EDIT the prefill
  // already seeded ageMin/ageMax from the event (loop above), so leave them. A CLONE (TM-1061) likewise
  // already carries the source event's age band in its draft (prefilled above), so it's NOT re-defaulted —
  // only a PLAIN create (no clone draft) gets the 18-99 default.
  if (mode === "create" && !isClone) {
    fields.get("ageMin").input.value = String(AGE_DEFAULT_MIN);
    fields.get("ageMax").input.value = String(AGE_DEFAULT_MAX);
  }

  // The venue picker (TM-519): sits under the Location line. Picking a venue prefills the required
  // Location line + City from it when they're still blank (so the event always has a display location
  // AND references the venue), then re-validates. Built here — after revalidate/prefill — so its
  // onSelect can safely call them; spliced into the layout right after the location field.
  venuePicker = buildVenuePicker(event, (chosen, { initial } = {}) => {
    if (chosen) {
      const loc = fields.get("locationText").input;
      if (loc.value.trim() === "") loc.value = chosen.addressLine || chosen.name || "";
      const cityInput = fields.get("city").input;
      // City is now a <select> (TM-1063); a venue's city may be off-list, so inject it as a selectable
      // option before choosing it (fillCitySelect handles both on-list and off-list values).
      if (cityInput && cityInput.value.trim() === "" && chosen.city) fillCitySelect(cityInput, chosen.city);
      // TM-1066: DERIVE the event's timezone from the venue. deriveVenueTimezone applies the locked
      // precedence — overwrite unless the admin has hand-edited the field (tzUserEdited), and never blank
      // it for a venue that carries no/invalid zone. Read defensively (`chosen?.timezone`). SKIP on the
      // `initial` auto-echo (edit-open re-selecting the event's own venue) so a SAVED event timezone is
      // never silently overwritten by its venue's — the edit prefill must behave exactly as before.
      if (!initial) {
        const derived = deriveVenueTimezone(chosen, tzUserEdited);
        if (derived) {
          const tzInput = fields.get("timezone").input;
          ensureZoneOption(tzInput, derived);
          // Set the value programmatically (NO dispatch) so the manual-edit flag doesn't trip — this is a
          // derive, not a hand-edit. revalidate("timezone") below repaints its error state.
          tzInput.value = derived;
          revalidate("timezone");
        }
      }
    }
    // TM-1112: the one-shot `initial` echo fires on LOAD (right after the venue list resolves), before the
    // admin has touched anything. Painting `locationText` as the changedKey then would render its required
    // error on a pristine create form — the "Location is required" bug shown before any input. On the
    // initial echo, revalidate with NO changedKey so ONLY fields already showing an error repaint (none on
    // a fresh create form) and no pristine required error is surfaced. A REAL pick (initial === false)
    // still passes "locationText" so its live validation fires as before. Save (paintAllErrors) is
    // untouched, so it still blocks an empty required field; edit-open (locationText prefilled) is
    // unaffected — the field is non-empty, so it validates clean either way.
    revalidate(initial ? undefined : "locationText");
  });
  const locationNode = byKey.get("locationText");
  const locIdx = layout.indexOf(locationNode);
  if (locIdx >= 0) layout.splice(locIdx + 1, 0, venuePicker.node);
  else layout.push(venuePicker.node);

  // Age band (TM-1065): build the control now that the inputs carry their prefill/create-default values, so
  // it reverse-maps them to the right chip (a preset, or Custom for a non-preset band). It hosts the two-up
  // custom-age row (pulled from the layout earlier) inside its Custom reveal. Splice its node in where the
  // old age row sat — just after the capacity/reveal "limits" row (or at the end as a fallback).
  ageBand = buildAgeBandControl(
    { minInput: fields.get("ageMin").input, maxInput: fields.get("ageMax").input, customRow: customAgeRow || el("div") },
    fields.get("ageMin").input.value,
    fields.get("ageMax").input.value,
    () => { revalidate("ageMin"); revalidate("ageMax"); },
  );
  const limitsRow = rowGroups.get("limits") || null;
  const limitsIdx = limitsRow ? layout.indexOf(limitsRow) : -1;
  if (limitsIdx >= 0) layout.splice(limitsIdx + 1, 0, ageBand.node);
  else layout.push(ageBand.node);

  // Price (TM-1076): build the control now the #event-price input carries any prefill value (blank on
  // create → the control defaults to Free and seeds "0"; a saved £ amount on edit → reverse-maps to a chip
  // or Custom). It re-homes the £ field inside its Custom reveal. Splice its node right after the age band.
  priceControl = buildPriceControl(
    fields.get("price").input,
    fields.get("price").input.value,
    () => revalidate("price"),
  );
  const ageBandIdx = layout.indexOf(ageBand.node);
  if (ageBandIdx >= 0) layout.splice(ageBandIdx + 1, 0, priceControl.node);
  else layout.push(priceControl.node);

  // Format selector (TM-1063): sits ABOVE the location cluster. Spliced in just before the Location
  // field so it reads "choose In person/Online, then the fields that apply".
  const formatIdx = layout.indexOf(locationNode);
  if (formatIdx >= 0) layout.splice(formatIdx, 0, formatToggle.node);
  else layout.unshift(formatToggle.node);

  // Map URL live preview (TM-1063): a debounced GET /api/v1/link-preview under the Map URL field. A
  // reachable URL renders a small preview card (or a neutral "no rich preview" note when it carries no
  // OG data — e.g. a Maps consent page); an UNREACHABLE URL shows a "link looks broken" note. It NEVER
  // gates Save. Mounted right after the Map URL field wrapper.
  const mapPreview = buildMapUrlPreview();
  mapPreviewRef = mapPreview;
  const mapNode = byKey.get("mapUrl");
  // mapUrl shares the "links" row holder with onlineUrl; append the preview slot inside that row after
  // the map field so it tracks the field's show/hide.
  if (mapNode && mapNode.parentNode) mapNode.parentNode.insertBefore(mapPreview.node, mapNode.nextSibling);
  else layout.push(mapPreview.node);
  const mapInput = fields.get("mapUrl").input;
  mapInput.addEventListener("input", () => mapPreview.schedule(mapInput.value));

  // Apply the initial format view now that every toggleable node (incl. the venue picker + map preview)
  // exists — hides the Online URL for a new In-person event, or the physical trio for an Online one, and
  // seeds the Map URL preview from a prefilled value on an In-person edit-open (via applyFormatView).
  applyFormatView();

  // Past-start warning (TM-1061): a NON-BLOCKING, visible note shown ONLY on a clone whose (offset-shifted)
  // start still lands in the past — e.g. +7h on an old event. Save is NOT blocked (distinct from the
  // required-field errors), but the admin must SEE they're about to create an already-past event so they
  // fix the time first (no auto-bump, no silent bad data). Recomputed live from the pure pastStartWarning
  // whenever the Start or timezone changes, so it clears the moment the admin picks a future start. Not
  // shown on a plain create/edit (only a clone opens with a pre-filled, possibly-past start).
  const pastStartNote = el("p", {
    class: "tm-field-error tm-event-past-start-note",
    id: "event-past-start-warning",
    role: "alert",
    hidden: true,
  });
  const refreshPastStartWarning = () => {
    if (!isClone) return; // the warning is a clone-only affordance
    const message = pastStartWarning(readDraft());
    pastStartNote.textContent = message;
    pastStartNote.hidden = message === "";
  };

  // Scheduling preset chips (TM-1064): a `.tm-chips` row under each datetime field + the reveal field,
  // one-tap SEEDS the input (fields stay editable — the TM-382 contract) then re-validates so an ordering
  // error clears/appears live. The datetime chips are ZONE-AWARE and, for the offset ones (Ends/Visible),
  // read the CURRENT Start draft — so they're recomputed whenever the timezone or Start changes. A chip
  // whose value is blank (e.g. "Ends +2h" before a Start is set) renders disabled (a harmless no-op).
  const tzInput = fields.get("timezone").input;
  const startInput = fields.get("startAt").input;
  const scheduleChipRows = []; // { rebuild } per row — recomputed on tz/start change
  const refreshScheduleChips = () => scheduleChipRows.forEach((r) => r.rebuild());
  const mountChipsFor = (fieldKey, compute) => {
    const holder = el("div", { class: "tm-chips-slot" });
    const rebuild = () => {
      const tz = tzInput.value;
      const input = fields.get(fieldKey).input;
      const row = buildPresetChips(compute(tz), (value) => {
        if (value === "") return; // defensive: disabled chips don't fire, but never seed a blank
        input.value = value;
        revalidate(fieldKey);
        // Seeding Start makes the Ends / Visible-from / Visible-until chips live (they read Start), and a
        // reseed of any field can flip an ordering error — recompute EVERY row so they all stay current.
        refreshScheduleChips();
      }, { ariaLabel: `${fieldLabel(fieldKey)} presets` });
      clear(holder).append(row);
    };
    rebuild();
    scheduleChipRows.push({ rebuild });
    // Mount the chip row directly under the field's control (inside its .tm-form-field wrapper).
    const wrapper = byKey.get(fieldKey);
    if (wrapper) wrapper.append(holder);
    return holder;
  };
  mountChipsFor("startAt", (tz) => startChips(tz));
  mountChipsFor("endAt", (tz) => endChips(startInput.value, tz));
  mountChipsFor("visibilityStart", (tz) => visibleFromChips(startInput.value, tz));
  mountChipsFor("visibilityEnd", (tz) => visibleUntilChips(startInput.value, tz));
  mountChipsFor("locationRevealHours", () => revealHourChips());
  // Start or timezone changing by hand shifts the offset/relative chips — recompute them all (the reveal
  // chips are constant, but rebuilding every row is cheap and keeps a single code path). The clone
  // past-start warning (TM-1061) reads Start + timezone too, so refresh it on the same edits.
  tzInput.addEventListener("change", () => { refreshScheduleChips(); refreshPastStartWarning(); });
  startInput.addEventListener("input", () => { refreshScheduleChips(); refreshPastStartWarning(); });

  // Tap-to-prefill sample templates ABOVE a textarea (TM-1065 opening message + TM-1113 description). Both
  // work identically: tapping a chip SEEDS the textarea (free text after — the TM-382 seeding contract),
  // focuses it, then re-validates so the field's cap/required state repaints live; the field's max length is
  // unchanged (each template already fits its cap). The chips are labelled "Template 1/2/3" (the full text
  // is long) with the real text in a `title` tooltip. Category-specific copy is deferred to TM-219. Mounted
  // right after the field's <label>, before the textarea.
  const mountTemplateChips = (fieldKey, templates, ariaLabel) => {
    const input = fields.get(fieldKey).input;
    const defs = templates.map((text, i) => ({ label: `Template ${i + 1}`, value: text }));
    const chips = buildPresetChips(
      defs,
      (value) => {
        input.value = value;
        input.focus();
        revalidate(fieldKey);
      },
      { ariaLabel },
    );
    // A full-text title on each chip so hovering/long-pressing reveals what it will insert.
    [...chips.querySelectorAll(".tm-chip")].forEach((btn, i) => {
      btn.setAttribute("title", templates[i]);
    });
    const wrapper = byKey.get(fieldKey);
    if (wrapper) {
      const label = wrapper.querySelector(".tm-field-label");
      if (label && label.nextSibling) wrapper.insertBefore(chips, label.nextSibling);
      else wrapper.insertBefore(chips, wrapper.firstChild);
    }
    return chips;
  };
  // Description templates (TM-1113): generic tap-to-insert starters above the Description textarea, the same
  // primitive + seeding contract as the opening-message templates (DESCRIPTION_MAX cap unchanged).
  mountTemplateChips("description", DESCRIPTION_TEMPLATES, "Description templates");
  // Opening-message templates (TM-1065): generic tap-to-prefill starters above the opening-message textarea.
  mountTemplateChips("openingMessage", OPENING_MESSAGE_TEMPLATES, "Opening-message templates");

  // "More options" (TM-1066): the timezone field is DERIVED from the picked venue, so its raw selector
  // moves out of the main body into a native <details> disclosure near the form bottom — reachable for
  // the override case but out of the way otherwise. The field is UNCHANGED (still required + validated +
  // prefilled + "Use mine"); only its home in the layout moves. Reuse the TM-398 `.tm-event-calendar`
  // disclosure styling (styles.css) so the toggle reads consistently with the events UI. The submit
  // error-paint force-opens this (via `moreOptions`) so a hidden required-timezone error is never
  // invisible. Capacity/reveal/age stay in the main body; the timezone and the booking-cutoff override
  // (TM-1157) — both inherit-by-default / rarely-changed controls — live here.
  const timezoneNode = byKey.get("timezone");
  const tzIdx = layout.indexOf(timezoneNode);
  if (tzIdx >= 0) layout.splice(tzIdx, 1);
  // Booking cutoff (TM-1157): pull its field OUT of the main body into the More-options disclosure, next
  // to the timezone — it MIRRORS the timezone/reveal three-tier "blank = inherit" idiom and belongs with
  // the other override controls rather than in the main limits row.
  const bookingCutoffNode = byKey.get("bookingCutoffHours");
  const cutoffIdx = bookingCutoffNode ? layout.indexOf(bookingCutoffNode) : -1;
  if (cutoffIdx >= 0) layout.splice(cutoffIdx, 1);
  moreOptions = el(
    "details",
    { class: "tm-event-calendar tm-event-more-options", id: "event-more-options" },
    [
      el("summary", { class: "tm-event-calendar-toggle", id: "event-more-options-toggle" }, "More options"),
      el("div", { class: "tm-event-more-options-body" }, [timezoneNode, bookingCutoffNode].filter(Boolean)),
    ],
  );
  // Render it near the bottom of the main fields (after the last body field, before the image + actions).
  layout.push(moreOptions);

  // Repeat / recurrence control (TM-796): CREATE-only. OFF = the unchanged single-create path; ON turns
  // the form into a recurring SERIES (the fields above become the template; the times become the first
  // occurrence). Recurrence is create-only in v1 — an edit of a series occurrence is a plain event edit,
  // so we never build the control in edit mode (the AC: "edit mode shows NO recurrence controls"). Sits
  // just below "More options", above the image + actions. The submit handler branches on
  // `recurrence?.isEnabled()` to POST /series vs the single-create POST.
  let recurrence = null;
  if (mode === "create") {
    recurrence = buildRecurrenceControl(
      () => {
        // Toggling Repeat changes the Save gate (recurrence rules apply) and the Save button copy.
        relabelSave();
        revalidate();
      },
      () => {
        // A recurrence field changed — re-run the recurrence validation so inline errors clear/appear.
        if (recurrence && recurrence.isEnabled()) {
          recurrence.paintErrors(validateSeriesDraft(readSeriesDraft()).errors);
        }
      },
    );
    layout.push(recurrence.node);
    // Default the WEEKLY weekday to the chosen start's own weekday, and keep it in sync as the start
    // changes (until the admin hand-picks a weekday). The start input already fires the schedule-chip
    // refresh; add the weekday sync to the same edit.
    recurrence.syncWeekdayDefault(startInput.value);
    startInput.addEventListener("input", () => recurrence.syncWeekdayDefault(startInput.value));
  }

  // The combined draft a SERIES submit reads: the ordinary event draft (template + the start/window
  // instants the recurrence rules cross-check) merged with the recurrence knobs. Only meaningful when
  // Repeat is ON (recurrence exists + enabled); otherwise the single-create readDraft() is used.
  const readSeriesDraft = () => ({ ...readDraft(), ...(recurrence ? recurrence.readRecurrence() : {}) });

  // Dirty-guard baseline (TM-1101): the values the form OPENED with, captured AFTER every control has
  // seeded its defaults (below, once the sub-controls exist) — the guessed timezone + age defaults + the
  // Free-price seed on create, or the toFormModel prefill on edit. `isDirty()` compares the LIVE draft to
  // this baseline (via the pure isDirtyDraft) and ALSO treats a freshly-picked (not-yet-uploaded) image as
  // dirty — a picked File never shows up in the text draft, so it's ORed in here at the DOM layer. Mutable
  // so a "Clear all / Reset" can re-snapshot the fresh baseline after it resets the fields.
  let baselineDraft = null;
  const isDirty = () => {
    // Before the baseline snapshot exists (during construction) nothing is dirty yet.
    if (!baselineDraft) return false;
    return isDirtyDraft(readDraft(), baselineDraft) || image.getFile() != null;
  };
  // Confirm-on-exit (TM-1101): a DIRTY form warns before discarding; a PRISTINE form leaves silently.
  // Returns true when it's safe to leave (pristine, or the admin confirmed the discard). Shared by the
  // Cancel button and the "← Events" back link (wired in mountEventForm via the returned `confirmExit`).
  const confirmExit = async () => {
    if (busy || !isDirty()) return true;
    return confirmDialog({
      title: "Discard your changes?",
      message: "This form has unsaved changes. Leaving now discards them.",
      confirmLabel: "Discard changes",
      cancelLabel: "Keep editing",
      danger: true,
    });
  };

  // The Save button copy reflects what a submit will DO: on create it reads "Create series" when Repeat is
  // ON (TM-796) so the admin knows they're about to create a whole series, "Create event" otherwise; edit
  // is always "Save changes" (no recurrence in edit mode).
  const saveLabel = () =>
    mode === "create" ? (recurrence && recurrence.isEnabled() ? "Create series" : "Create event") : "Save changes";
  const save = el("button", { class: "tm-btn tm-btn-primary", id: "event-save", type: "submit" }, saveLabel());
  const relabelSave = () => { if (!busy) save.textContent = saveLabel(); };
  // Cancel returns to the list without saving (TM-426); the page's "← Events" back link does the same.
  // Both now gate on confirmExit so a dirty form warns before discarding (TM-1101).
  const cancel = el("button", { class: "tm-btn", id: "event-cancel", type: "button", onClick: async () => {
    if (await confirmExit()) onCancel?.();
  } }, "Cancel");
  // Clear all / Reset (TM-1101): create → a blank form; edit → the saved event restored. Re-mounts the form
  // from scratch (via onReset) so EVERY control — fields, format, venue, age band, price, image — returns to
  // its opened state without hand-reversing each. Only acts when there's something to reset (dirty); a
  // pristine form's Reset is a harmless no-op, and it never prompts (nothing to lose).
  const resetLabel = mode === "create" ? "Clear all" : "Reset";
  const reset = el("button", {
    class: "tm-btn", id: "event-reset", type: "button",
    onClick: async () => {
      if (busy || !isDirty()) return;
      const ok = await confirmDialog({
        title: mode === "create" ? "Clear the whole form?" : "Reset your changes?",
        message: mode === "create"
          ? "This empties every field back to a blank event."
          : "This restores every field to the event's saved values, discarding your changes.",
        confirmLabel: resetLabel,
        cancelLabel: "Keep editing",
        danger: true,
      });
      if (ok) onReset?.();
    },
  }, resetLabel);
  let busy = false;

  const setBusy = (on, labelWhileBusy) => {
    busy = on;
    save.disabled = on;
    cancel.disabled = on;
    reset.disabled = on;
    save.textContent = on ? labelWhileBusy : saveLabel();
  };

  const form = el("form", { class: "tm-event-form", id: "event-form", novalidate: true }, [
    el("div", { class: "tm-form-field" }, [
      el("label", { class: "tm-field-label", for: "event-heading", text: "Heading" }),
      buildChips(headingInput, () => revalidate("heading")),
      // The heading field's input/hint/error were built above; re-home them under this custom label.
      fields.get("heading").input,
      el("p", { class: "tm-muted tm-field-hint", text: `Tap a suggestion or write your own. Up to ${HEADING_MAX} characters.` }),
      fields.get("heading").error,
    ]),
    ...layout.filter((node) => node !== byKey.get("heading")),
    image.node,
    // Clone past-start warning (TM-1061) — non-blocking, sits just above the actions so it's next to Save.
    pastStartNote,
    el("div", { class: "tm-form-actions" }, [reset, cancel, save]),
  ]);

  // Clone (TM-1061): compute the initial past-start warning now the form is assembled — a clone can open
  // already in the past (e.g. +7h on an old event), so the note must show on open, not just after an edit.
  refreshPastStartWarning();
  // Clone image duplication (TM-1061): the source event's image is duplicated to a NEW storage object, not
  // shared. Fetch the source image as a Blob and hand it to the image control as a pending File — the
  // ordinary create submit then uploads it to `event-images/{newId}` (a distinct object). Best-effort: if
  // the source has no image, or it can't be fetched (Storage off, object gone, a cross-origin legacy URL),
  // the clone simply opens with no image and the admin can add one — never a broken share of the source URL.
  if (isClone && cloneDraft.imagePath) {
    seedCloneImage(cloneDraft.imagePath, image);
  }

  // Snapshot the dirty-guard baseline NOW — after the whole form (incl. the sub-controls that seed the
  // timezone/age/price defaults) is built, so a freshly-opened form reads as pristine (TM-1101). readDraft
  // reads the venue picker + currentFormat, both set by this point. The venue picker's async initial echo
  // (create) re-selects the blank one-off option (no field change), so it never dirties this baseline.
  baselineDraft = readDraft();

  const revealSummaryText = event ? revealSummary(event) : "";
  // Booking-cutoff note (TM-1157): mirrors the reveal note — a plain-English one-liner of when RSVPs stop
  // for THIS event and where that value came from (its own override vs the city/app default).
  const bookingCutoffText = event ? bookingCutoffSummary(event) : "";
  // The full-page shell (TM-426): the form + the reveal-timing + booking-cutoff notes, mounted into
  // #admin-event-form-view by enterAdminEventForm(). No modal() — the page scrolls, nothing is clipped.
  const node = el("div", { class: "tm-event-form-page" }, [
    form,
    revealSummaryText ? el("p", { class: "tm-muted tm-event-reveal-note", text: revealSummaryText }) : null,
    bookingCutoffText ? el("p", { class: "tm-muted tm-event-booking-cutoff-note", text: bookingCutoffText }) : null,
  ]);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy) return;
    const errors = paintAllErrors();
    // Recurrence gate (TM-796): when Repeat is ON, ALSO validate the recurrence rule (mirrors the series
    // API's edge — exactly-one-end, interval ≥ 1, WEEKLY weekday set & matches the start). Paint the
    // inline recurrence errors and block Save if any, so the admin fixes bad combos before the POST.
    const seriesOn = mode === "create" && recurrence && recurrence.isEnabled();
    let seriesErrors = {};
    if (seriesOn) {
      seriesErrors = validateSeriesDraft(readSeriesDraft()).errors;
      recurrence.paintErrors(seriesErrors);
    }
    if (Object.keys(errors).length || Object.keys(seriesErrors).length) {
      toast("Please fix the highlighted fields.", { type: "error" });
      return;
    }

    setBusy(true, seriesOn ? "Creating series…" : mode === "create" ? "Creating…" : "Saving…");
    image.setError("");
    try {
      const draft = readDraft();
      const body = buildEventPayload(draft);
      const pending = image.getFile();

      // On edit, an optional field the admin blanked can't be transmitted (the PATCH omits blanks and
      // the server reads absent as "leave unchanged"), so clearing it silently no-ops. Surface it
      // rather than toast a false "saved" (TM-734).
      const stuckCleared = mode === "create" ? [] : clearedOptionalFields(event, draft);

      if (seriesOn) {
        // Repeat ON (TM-796): POST a CreateSeriesRequest to .../events/series instead of the single
        // create. The template + first-occurrence anchor + recurrence rule come from buildSeriesPayload.
        // On 201 the response carries the created series + its generated occurrences, which the list (via
        // onDone → loadEvents) now shows. Image handling mirrors the single-create path: the id we PATCH
        // the image onto is the FIRST occurrence's (occurrences[0]) — the template image for the batch.
        const created = await eventApi("/api/v1/admin/events/series", { method: "POST", body: buildSeriesPayload(readSeriesDraft()) });
        const firstOccurrence = Array.isArray(created?.occurrences) ? created.occurrences[0] : null;
        if (pending && firstOccurrence?.id != null) {
          try {
            const { path } = await uploadEventImage(firstOccurrence.id, pending, image.setProgress);
            await eventApi(`/api/v1/admin/events/${firstOccurrence.id}`, { method: "PATCH", body: { imagePath: path } });
          } catch (imgErr) {
            toast(`Series created, but the image didn't upload (${imgErr?.message || "upload failed"}). Open an occurrence to add one.`, { type: "error" });
            onDone?.();
            return;
          }
        }
        const count = Number(created?.occurrenceBatchSize ?? created?.occurrences?.length) || 0;
        toast(count > 0 ? `Series created — ${count} ${count === 1 ? "occurrence" : "occurrences"} scheduled.` : "Series created.", { type: "success" });
        onDone?.();
        return;
      }

      if (mode === "create") {
        const createdEvent = await eventApi("/api/v1/admin/events", { method: "POST", body });
        if (pending && createdEvent?.id != null) {
          // The id exists now — upload the image to event-images/{id}, then persist its path (TM-392).
          // If ONLY the image step fails the event is already created, so navigate back to the list
          // rather than stay on the form (a re-submit would create a DUPLICATE); the admin adds it via Edit.
          try {
            const { path } = await uploadEventImage(createdEvent.id, pending, image.setProgress);
            await eventApi(`/api/v1/admin/events/${createdEvent.id}`, { method: "PATCH", body: { imagePath: path } });
          } catch (imgErr) {
            toast(`Event created, but the image didn't upload (${imgErr?.message || "upload failed"}). Open it to add one.`, { type: "error" });
            onDone?.();
            return;
          }
        }
      } else {
        // TM-966: PATCH the metadata FIRST, then upload the image only if that succeeds. The old order
        // (upload → PATCH with imagePath) uploaded to Storage BEFORE the server could reject the edit —
        // so a past-event edit (409 EVENT_ENDED) left an ORPHANED storage object. Doing the PATCH first
        // means a rejected edit never uploads anything; a second PATCH carries the new image path.
        let updated = await eventApi(`/api/v1/admin/events/${event.id}`, { method: "PATCH", body });
        if (pending) {
          const { path } = await uploadEventImage(event.id, pending, image.setProgress);
          updated = await eventApi(`/api/v1/admin/events/${event.id}`, { method: "PATCH", body: { imagePath: path } });
        }
        // TM-1076: reflect the server's just-saved EventResponse straight into the in-memory list row so the
        // edit cache can't lag the save. onDone → loadEvents refetches too, but that's async — a re-open (or
        // deep-link) that beats the refetch would otherwise read a STALE cached row (enterAdminEventForm
        // prefers state.events), re-prefilling the form from pre-edit values. The console's mutate handlers
        // (cancelEvent / saveCapacity) already splice the fresh row in for the same reason; do it here too.
        if (updated && updated.id != null) {
          const idx = state.events.findIndex((e) => String(e.id) === String(updated.id));
          if (idx >= 0) state.events[idx] = updated;
        }
      }

      if (stuckCleared.length) {
        // The rest of the edit saved, but the blanked optional(s) couldn't be cleared through the API —
        // tell the admin plainly rather than claim a clean save (TM-734).
        const names = stuckCleared.map(fieldLabel).join(", ");
        toast(
          `Saved, but ${names} can't be cleared here yet — ${stuckCleared.length > 1 ? "those fields keep" : "that field keeps"} their previous value.`,
          { type: "error" },
        );
      } else {
        toast(mode === "create" ? "Event created." : "Event saved.", { type: "success" });
      }
      // Navigate back to the list, which reloads it (router → enterAdminEvents → loadEvents), so the
      // just-created / edited event shows immediately (TM-426).
      onDone?.();
    } catch (err) {
      image.resetProgress();
      if (err instanceof ApiError && err.fieldErrors?.length) {
        // Backend RFC-7807 validation: attach each message to its field (field names match FORM_FIELDS
        // keys); anything unmapped goes to a summary toast.
        const leftover = [];
        for (const fe of err.fieldErrors) {
          if (fields.has(fe.field)) setFieldError(fe.field, fe.message);
          else leftover.push(fe.message);
        }
        toast(leftover.length ? leftover.join(" ") : "Please fix the highlighted fields.", { type: "error" });
      } else {
        toast(err instanceof ApiError ? err.message : "Couldn't save the event.", { type: "error" });
      }
      setBusy(false);
    }
  });

  // The heading is focused for immediate typing after the node is mounted (see mountEventForm) — a
  // small, house-consistent nicety. focus() only takes effect once the node is in the document.
  // `confirmExit` lets the page's "← Events" back link share the dirty-guard (TM-1101); `isDirty` is
  // exposed for the same gate / for tests.
  return { node, focusHeading: () => headingInput.focus(), confirmExit, isDirty };
}

/** Module-level guard so a slow edit-by-id fetch that resolves AFTER the admin has navigated away (or
 *  switched to a different form target) can't paint a stale form — the events.js renderToken trick. */
let formToken = 0;

/**
 * Router entry (TM-426) for the full-page create/edit form. `mode` is "create" (id null) or "edit".
 * For an edit we render from the row already in memory when we have it (the admin clicked "Edit" in the
 * list — the common path); otherwise we fetch it by id, so the route also works on a direct deep-link /
 * page refresh. On save or cancel the form navigates back to the list, which reloads it.
 */
export async function enterAdminEventForm(mode, id = null) {
  const view = document.getElementById("admin-event-form-view");
  if (!view) return;
  const mine = ++formToken;

  if (mode === "create") {
    // Clone (TM-1061): a Clone action stashed a pre-filled draft before navigating here; take it (one-shot,
    // so a later plain "New event" or a refresh opens a blank form, not a stale clone) and mount in clone
    // mode. No stash → an ordinary blank create.
    const clone = takePendingClone();
    mountEventForm(view, "create", null, clone ? clone.draft : null);
    return;
  }

  const cached = state.events.find((e) => String(e.id) === String(id));
  if (cached) {
    // TM-966: a past (finished) event is read-only. The list hides its Edit control, but a deep-link /
    // manually-typed edit URL bypasses that — guard here so the form never mounts for a past event
    // (the server would 409 the PATCH anyway, and on an edit-with-image the upload runs BEFORE the PATCH,
    // orphaning a storage object). Redirect back to the list with a toast.
    if (isPastEvent(cached)) {
      redirectPastEventEdit();
      return;
    }
    mountEventForm(view, "edit", cached);
    return;
  }

  // Not in memory (deep-link / refresh straight onto an edit URL): fetch it by id.
  renderFormLoading(view);
  try {
    const event = await eventApi(`/api/v1/admin/events/${encodeURIComponent(id)}`);
    if (mine !== formToken) return; // navigated away / switched target while the fetch was in flight
    if (!event) {
      renderFormError(view, "That event isn't available anymore.", null);
      return;
    }
    // TM-966: same past-event guard on the deep-link/refresh path (the fetched event carries the `past` flag).
    if (isPastEvent(event)) {
      redirectPastEventEdit();
      return;
    }
    mountEventForm(view, "edit", event);
  } catch (err) {
    if (mine !== formToken) return;
    const gone = err instanceof ApiError && err.status === 404;
    renderFormError(
      view,
      gone ? "That event isn't available anymore." : "Couldn't load this event. Please try again.",
      gone ? null : () => enterAdminEventForm("edit", id),
    );
  }
}

/**
 * TM-966: bounce a past-event edit attempt back to the events list with an explanatory toast. A finished
 * event is read-only (the server 409s the PATCH), and mounting the form would let an edit-with-image
 * upload an object BEFORE the doomed PATCH — orphaning it in Storage. Redirecting before the form mounts
 * avoids both. Navigating (hash change) re-enters the list route, which reloads it.
 */
function redirectPastEventEdit() {
  toast("This event has ended and can no longer be edited.", { type: "error" });
  window.location.hash = ADMIN_EVENTS_ROUTE;
}

/** Mount the page chrome (a "← Events" back-link header) + the form into the view, then focus heading. */
function mountEventForm(view, mode, event, cloneDraft = null) {
  const back = () => { window.location.hash = ADMIN_EVENTS_ROUTE; };
  // Clear/Reset (TM-1101): re-mount the SAME target from scratch — create → a fresh blank form, edit → the
  // saved event re-prefilled — so every control returns to its opened state and a fresh dirty baseline is
  // re-snapshotted. `event` is the saved EventResponse (unchanged by an unsaved edit), so an edit reset
  // restores exactly the saved values. A CLONE (TM-1061) re-mounts from the SAME clone draft, so Reset
  // restores the cloned-and-shifted values (not a blank form) — the clone's "opened state".
  const doReset = () => mountEventForm(view, mode, event, cloneDraft);
  const { node, focusHeading, confirmExit } = buildEventForm({ mode, event, cloneDraft, onDone: back, onCancel: back, onReset: doReset });
  // A clone is a create-in-progress; title it as such so the admin knows this is a NEW event, not an edit.
  const title = mode === "create" ? (cloneDraft ? "Clone event" : "New event") : `Edit · ${event.heading || "event"}`;
  clear(view).append(formHeader(title, confirmExit), node);
  focusHeading();
}

/**
 * The "← Events" back-link header, reusing the events-detail chrome (.tm-admin-head + an anchor). The back
 * link now gates on `confirmExit` (TM-1101): a dirty form warns before discarding, a pristine one leaves
 * silently. It stays a real anchor (right href, focusable, middle-click-openable) but intercepts a plain
 * left-click to run the async confirm first, then navigate on confirm.
 */
function formHeader(title, confirmExit) {
  const back = el("a", { class: "tm-btn tm-btn-sm", id: "admin-event-form-back", href: ADMIN_EVENTS_ROUTE }, "← Events");
  if (typeof confirmExit === "function") {
    back.addEventListener("click", (e) => {
      // Let modified clicks (new tab/window) and non-primary buttons through untouched.
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      confirmExit().then((ok) => {
        if (ok) window.location.hash = ADMIN_EVENTS_ROUTE;
      });
    });
  }
  return el("div", { class: "tm-admin-head tm-event-form-head" }, [
    el("h2", {}, [doodle("calendar", { class: "tm-doodle-header" }), title]),
    back,
  ]);
}

/** The transient "loading the event to edit" state while an edit-by-id fetch is in flight. */
function renderFormLoading(view) {
  clear(view).append(formHeader("Edit event"), el("p", { class: "tm-muted", text: "Loading event…" }));
}

/** The edit-by-id failure state: a message + either Retry (transient) or a back-to-list link (gone). */
function renderFormError(view, message, onRetry) {
  clear(view).append(
    formHeader("Edit event"),
    el("div", { class: "tm-error tm-empty" }, [
      doodle("calendar", { class: "tm-doodle-empty" }),
      el("p", { text: message }),
      onRetry
        ? el("button", { class: "tm-btn", type: "button", onClick: onRetry }, "Retry")
        : el("a", { class: "tm-btn", href: ADMIN_EVENTS_ROUTE }, "Back to events"),
    ]),
  );
}

// ---- mount --------------------------------------------------------------------------------

function buildShell(view) {
  const search = el("input", {
    id: "admin-events-search",
    type: "search",
    class: "tm-input",
    placeholder: "Search heading, location, city…",
    "aria-label": "Search events",
    onInput: (e) => { state.search = e.target.value; state.page = 0; renderTable(); },
  });
  const sizeSelect = el(
    "select",
    { class: "tm-input", "aria-label": "Rows per page", onChange: (e) => { state.pageSize = Number(e.target.value); state.page = 0; renderTable(); } },
    PAGE_SIZES.map((n) => el("option", { value: String(n), text: `${n} / page`, selected: n === state.pageSize })),
  );

  const stats = el("div", { class: "tm-stats", id: "admin-events-stats" });
  const table = el("div", { class: "tm-table-wrap", id: "admin-events-table" });
  const pager = el("div", { class: "tm-pager", id: "admin-events-pager" });

  shell = { stats, table, pager };

  clear(view).append(
    el("div", { class: "tm-admin-head" }, [
      el("h2", {}, [doodle("calendar", { class: "tm-doodle-header" }), "Events"]),
      el("div", { class: "tm-admin-head-actions" }, [
        el("button", { class: "tm-btn tm-btn-primary tm-btn-sm", id: "admin-events-new", type: "button", onClick: () => { window.location.hash = adminEventNewHash(); } }, "New event"),
        el("button", { class: "tm-btn tm-btn-sm", id: "admin-events-refresh", type: "button", onClick: loadEvents }, "Refresh"),
      ]),
    ]),
    stats,
    el("div", { class: "tm-toolbar" }, [search, sizeSelect]),
    lifecycleChipRow(),
    table,
    pager,
  );
}

/**
 * The lifecycle filter chips (TM-1096) — one `aria-pressed` toggle chip per lifecycle bucket
 * (LIFECYCLE_FILTERS), replacing the old single-select status dropdown. Multi-select: toggling a chip
 * adds/removes its lifecycle label from `state.lifecycleFilter` (a Set); an event shows if its lifecycle
 * label is in the set (empty set ⇒ all, via matchesLifecycleFilter). An "All" / "Clear" affordance
 * flips the whole set: All selects every bucket, Clear empties it (both then show everything, but the
 * chips reflect which the admin asked for). Built on the existing `.tm-chip` CSS — `aria-pressed="true"`
 * is what lights a chip up. Rebuilt in place on every toggle so the pressed state stays in sync.
 */
function lifecycleChipRow() {
  const row = el("div", {
    class: "tm-chips tm-events-filter-chips",
    id: "admin-events-lifecycle-chips",
    role: "group",
    "aria-label": "Filter by lifecycle",
  });
  const rebuild = () => {
    clear(row);
    for (const [key, label] of LIFECYCLE_FILTERS) {
      const on = state.lifecycleFilter.has(key);
      row.append(
        el(
          "button",
          {
            type: "button",
            class: "tm-chip",
            "aria-pressed": on ? "true" : "false",
            dataset: { lifecycle: key },
            onClick: () => {
              if (state.lifecycleFilter.has(key)) state.lifecycleFilter.delete(key);
              else state.lifecycleFilter.add(key);
              state.page = 0;
              rebuild();
              render();
            },
          },
          label,
        ),
      );
    }
    // All / Clear: All selects every bucket; Clear empties the set. Both leave the list showing
    // everything, but the pressed chips record the admin's intent (all-on vs none-on).
    const allOn = LIFECYCLE_FILTERS.every(([key]) => state.lifecycleFilter.has(key));
    row.append(
      el(
        "button",
        {
          type: "button",
          class: "tm-chip tm-chip-all",
          id: "admin-events-lifecycle-all",
          onClick: () => {
            state.lifecycleFilter = allOn ? new Set() : new Set(LIFECYCLE_FILTERS.map(([key]) => key));
            state.page = 0;
            rebuild();
            render();
          },
        },
        allOn ? "Clear" : "All",
      ),
    );
  };
  rebuild();
  return row;
}

/** Called by the router when the #/admin/events view becomes active. Builds the shell once, then loads. */
export function enterAdminEvents() {
  const view = document.getElementById("admin-events-view");
  if (!view) return;
  if (!shell) buildShell(view);
  loadEvents();
}

// Bridge for the router (which imports this) + ad-hoc use.
if (typeof window !== "undefined") {
  window.tmAdminEvents = { enterAdminEvents, enterAdminEventForm, enterAdminEventRoster, loadEvents };
}
