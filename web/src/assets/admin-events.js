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
import { clear, confirmDialog, el, ensureZoneOption, fillTimeZoneOptions, guessTimeZone, stackableTable, toast } from "./ui.js";
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
  matchesStatusFilter,
  attendanceCounts,
  overCapacityState,
  overCapacityWarning,
  revealSummary,
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
  ageBandToMinMax,
  minMaxToAgeBand,
} from "./event-form.js";
import { ADMIN_EVENTS_ROUTE, adminEventNewHash, adminEventEditHash } from "./admin-event-route.js";
import { venueSummaryLabel } from "./admin-venues-core.js";
import { CITY_OPTIONS, cityChoiceError } from "./profile-core.js";
import { adminVenueNewHash } from "./admin-venues-route.js";
import { clampPage } from "./admin-paging-core.js";
import { statsCards } from "./admin-stats-core.js";

const FETCH_SIZE = 100; // page size PER REQUEST of the full-inventory walk — matches the server max page size (TM-115)
const MAX_FETCH_PAGES = 50; // runaway guard on the walk (× FETCH_SIZE = 5,000 events)
const PAGE_SIZES = [10, 25, 50];

// Client-side status buckets over the DERIVED lifecycle (event-form.js), so the admin can filter the
// full inventory the way they think about it — not just the raw PUBLISHED|CANCELLED the API stores.
const STATUS_FILTERS = [
  ["ALL", "All statuses"],
  ["Visible", "Visible now"],
  ["Hidden", "Hidden (upcoming)"],
  // TM-965: "Unlisted" — past its visibility window but not yet started. eventLifecycle emits this label,
  // so without a matching filter option an unlisted event matched NO non-ALL filter and disappeared.
  ["Unlisted", "Unlisted (window closed)"],
  ["Finished", "Finished"],
  ["Cancelled", "Cancelled"],
];

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
  statusFilter: "ALL",
  sortKey: "startAt",
  sortDir: "desc",
  page: 0,
  pageSize: 25,
  // TM-592 roster panel: the id of the event whose inline roster/capacity panel is open (null = none),
  // plus the last-loaded roster payload and its load/error status, so re-renders keep the panel open.
  openRosterId: null,
  roster: null, // the { eventId, capacity, going, waitlist, entries } payload for the open panel
  rosterLoading: false,
  rosterError: null,
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
    // TM-965: match against the DERIVED lifecycle label via the pure predicate — covers "Unlisted" too.
    if (!matchesStatusFilter(e, state.statusFilter, now)) return false;
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

/** The derived status pill for a row — colour follows the lifecycle tone (event-form.js). */
function statusPill(event, now) {
  const { label, tone } = eventLifecycle(event, now);
  const cls =
    tone === "ok" ? "tm-badge-ok" : tone === "off" ? "tm-badge-off" : tone === "info" ? "tm-badge-info" : "tm-badge-unknown";
  return el("span", { class: `tm-badge ${cls}`, text: label });
}

function renderStats(now) {
  const total = Math.max(state.totalEvents, state.events.length);
  const visible = state.events.filter((e) => eventLifecycle(e, now).label === "Visible").length;
  const cancelled = state.events.filter((e) => String(e.status).toUpperCase() === "CANCELLED").length;
  // TM-756: loadEvents() renders BEFORE the page walk resolves, so these counts derive from EMPTY
  // state — the mask (admin-stats-core.js) shows "—" per card while loading instead of a false
  // "Total 0", mirroring the table's state.loading gate below; loaded cards pass through untouched.
  const cards = statsCards([
    ["Total", total],
    ["Visible now", visible],
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
    // TM-592: the inline roster/capacity panel drops in as a full-width row directly under its event.
    if (state.openRosterId === event.id) bodyRows.push(rosterPanelRow(event));
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
  // A past event is READ-ONLY (TM-518): both Edit and Cancel are unavailable (the server rejects them
  // too, with a 409). Render a single DISABLED "Edit" so the control is visibly present-but-inert, and
  // no Cancel — a finished event has nothing left to call off. Kept in lock-step with the server-side
  // reject via the same `past` flag the projection carries.
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
    // A cancelled event keeps its history (cancel ≠ delete) — nothing left to cancel, so only Edit.
    return [edit];
  }
  // Roster + capacity control (TM-592): opens an inline panel below the row with the attendee list
  // (evict), a force-add form and a first-class capacity adjust that surfaces the over-cap warning.
  const roster = el(
    "button",
    {
      class: "tm-btn tm-btn-sm",
      type: "button",
      "aria-label": `Manage roster for ${event.heading}`,
      onClick: () => toggleRoster(event),
    },
    "Roster",
  );
  return [
    roster,
    edit,
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

// ---- roster + capacity control (TM-592) ---------------------------------------------------

/**
 * Toggle the inline roster/capacity panel for an event. Opening loads the roster (GET .../roster);
 * clicking Roster again on the open event closes it. Only one panel is open at a time (a fresh open
 * replaces any other), keeping the table compact.
 */
async function toggleRoster(event) {
  if (state.openRosterId === event.id) {
    state.openRosterId = null;
    state.roster = null;
    state.rosterError = null;
    renderTable();
    return;
  }
  state.openRosterId = event.id;
  state.roster = null;
  state.rosterError = null;
  state.rosterLoading = true;
  renderTable();
  await reloadRoster(event.id);
}

/** (Re)load the open event's roster into state and repaint the panel. */
async function reloadRoster(eventId) {
  if (state.openRosterId !== eventId) return; // panel closed / switched while we were away
  state.rosterLoading = true;
  state.rosterError = null;
  renderTable();
  try {
    const roster = await eventApi(`/api/v1/admin/events/${eventId}/roster`);
    if (state.openRosterId !== eventId) return;
    state.roster = roster;
  } catch (err) {
    if (state.openRosterId !== eventId) return;
    state.rosterError = err instanceof ApiError ? err.message : "Couldn't load the roster.";
  } finally {
    state.rosterLoading = false;
    renderTable();
  }
}

/** The full-width table row hosting the open roster panel for `event`. */
function rosterPanelRow(event) {
  return el(
    "tr",
    { class: "tm-event-roster-row", "data-testid": "admin-event-roster-row", dataset: { eventId: String(event.id) } },
    [el("td", { colspan: String(COLUMNS.length + 1) }, [rosterPanel(event)])],
  );
}

/** The roster panel body: capacity control + over-cap warning, force-add form, and the attendee list. */
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
  const roster = state.roster || { capacity: event.capacity, going: 0, waitlist: 0, entries: [] };
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
    attendeeList(event, roster),
  );
  return panel;
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

/** The attendee list (TM-592): GOING (with over-cap flag) then WAITLISTED, each with an Evict button. */
function attendeeList(event, roster) {
  const entries = Array.isArray(roster.entries) ? roster.entries : [];
  if (!entries.length) {
    return el("div", { class: "tm-roster-section" }, [
      el("p", { class: "tm-muted", text: "No attendees yet." }),
    ]);
  }
  const rows = entries.map((entry) => {
    const isGoing = String(entry.state).toUpperCase() === "GOING";
    const badgeCls = isGoing ? "tm-badge-ok" : "tm-badge-info";
    return el("li", { class: "tm-roster-attendee", dataset: { userId: String(entry.userId) } }, [
      el("span", { class: "tm-roster-attendee-name", text: entry.displayName || `User ${entry.userId}` }),
      el("span", { class: `tm-badge ${badgeCls}`, text: isGoing ? "Going" : "Waitlist" }),
      entry.overCapacity
        ? el("span", { class: "tm-badge tm-badge-off", "data-testid": "admin-roster-overcap-tag", text: "Over cap" })
        : null,
      el(
        "button",
        {
          class: "tm-btn tm-btn-sm tm-btn-danger",
          type: "button",
          "aria-label": `Evict ${entry.displayName || "user " + entry.userId}`,
          onClick: () => evictAttendee(event, entry),
        },
        "Evict",
      ),
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
  // Age band (TM-1065): the two number inputs are no longer laid out two-up. They stay in FORM_FIELDS
  // (so readDraft / validateEventDraft / server-error routing still key off them) but are RE-HOMED inside
  // the age-band control (buildAgeBandControl), revealed only when the "Custom" band chip is chosen. The
  // "customage" row groups them two-up INSIDE that control's reveal region.
  { key: "ageMin", id: "event-age-min", label: "Min age", type: "number", min: AGE_MIN_BOUND, max: AGE_MAX_BOUND, row: "customage" },
  { key: "ageMax", id: "event-age-max", label: "Max age", type: "number", min: AGE_MIN_BOUND, max: AGE_MAX_BOUND, row: "customage" },
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
      inputmode: field.type === "number" ? "numeric" : null,
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
 * Select a saved city in the TM-1063 City dropdown. A value on CITY_OPTIONS (or "") selects directly;
 * a saved OFF-LIST city (e.g. "Dubai" set before the list existed, or a venue's off-list city) gets its
 * own extra option injected so it stays VISIBLE and SELECTABLE — an existing event is preserved, never
 * silently overwritten on save (the profile.js fillCitySelect idiom). `data-offlist` stops re-fills from
 * stacking duplicate options for the same value.
 *
 * @param {HTMLSelectElement} select the city <select>.
 * @param {*} value the saved city value.
 */
function fillCitySelect(select, value) {
  if (!select) return;
  const saved = value == null ? "" : String(value).trim();
  if (saved !== "" && !CITY_OPTIONS.includes(saved) && select.getAttribute("data-offlist") !== saved) {
    select.append(el("option", { value: saved, text: saved }));
    select.setAttribute("data-offlist", saved);
  }
  select.value = saved;
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

  return { node, getFile: () => pendingFile, setProgress, resetProgress, setError };
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
 * Build the create/edit event form as a detached DOM subtree (no shell) — the SAME fields, validation,
 * Coffee & X chips, image control and read-back the modal used; only the surrounding shell changed
 * from a modal() to a full page (TM-426). `mode` is "create" (event=null) or "edit" (event = the
 * EventResponse). On a valid submit it converts the local wall-clock times to UTC, POSTs/PATCHes,
 * uploads any picked image against the (now-existing) id, then calls `onDone`; a "Cancel" button (and
 * the page's back link) call `onCancel`. Returns { node } to mount + a `focusHeading` to call once the
 * node is in the document.
 */
function buildEventForm({ mode, event = null, onDone, onCancel }) {
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

  // Format selector (TM-1063) — CLIENT-ONLY view state, no backend field. In person → show the physical
  // cluster (Location + Venue + City + Map URL) and hide Online URL; Online → show Online URL only. The
  // chosen format is inferred on edit (formatFromEvent) and fed into the draft so validateEventDraft /
  // buildEventPayload apply the format-conditional rules. `mapUrl`/`onlineUrl` share the "links" row, so
  // we toggle the individual field WRAPPERS (not the row) to hide one while showing the other.
  let currentFormat = event ? formatFromEvent(event) : EVENT_FORMAT_INPERSON;
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

  // Prefill: timezone options first (needs the selected zone), then the rest of the values.
  const model = event ? toFormModel(event) : { timezone: guessTimeZone() };
  fillTimeZoneOptions(fields.get("timezone").input, model.timezone);
  for (const f of FORM_FIELDS) {
    if (f.type === "timezone") continue;
    if (f.key === "city") continue; // the city <select> needs the off-list allowance (below)
    const v = model[f.key];
    if (v != null && v !== "") fields.get(f.key).input.value = v;
  }
  // City (TM-1063): a dropdown of CITY_OPTIONS. A saved OFF-LIST city (e.g. "Dubai" set before the list
  // existed, or a venue's off-list city) stays selectable via an injected option so an existing event is
  // never silently overwritten on save — the profile.js fillCitySelect / cityChoiceError idiom.
  fillCitySelect(fields.get("city").input, model.city);

  // Age band (TM-1065): on CREATE the default band is 18-99 (attendees are 18-99, TM-884) — seed the two
  // age inputs so the whole adult range is pre-filled and untouched. 18-99 is a non-preset band, so the
  // control opens on Custom showing 18/99 (see buildAgeBandControl → minMaxToAgeBand). On EDIT the prefill
  // already seeded ageMin/ageMax from the event (loop above), so leave them.
  if (mode === "create") {
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
    revalidate("locationText");
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
  // chips are constant, but rebuilding every row is cheap and keeps a single code path).
  tzInput.addEventListener("change", refreshScheduleChips);
  startInput.addEventListener("input", refreshScheduleChips);

  // Opening-message sample templates (TM-1065): 2-3 GENERIC tap-to-prefill starters ABOVE the textarea.
  // Tapping one SEEDS the textarea (free text after — the TM-382 seeding contract) then re-validates; the
  // OPENING_MESSAGE_MAX cap is unchanged. Category-specific templates are deferred to TM-219. The chips
  // are labelled "Template 1/2/3" (their full text is long) with the real text in a title tooltip.
  const openingInput = fields.get("openingMessage").input;
  const templateDefs = OPENING_MESSAGE_TEMPLATES.map((text, i) => ({ label: `Template ${i + 1}`, value: text }));
  const templateChips = buildPresetChips(
    templateDefs,
    (value) => {
      openingInput.value = value;
      openingInput.focus();
      revalidate("openingMessage");
    },
    { ariaLabel: "Opening-message templates" },
  );
  // A full-text title on each chip so hovering/long-pressing reveals what it will insert.
  [...templateChips.querySelectorAll(".tm-chip")].forEach((btn, i) => {
    btn.setAttribute("title", OPENING_MESSAGE_TEMPLATES[i]);
  });
  // Mount ABOVE the textarea: insert the chips right after the field's <label>, before the textarea.
  const openingWrapper = byKey.get("openingMessage");
  if (openingWrapper) {
    const label = openingWrapper.querySelector(".tm-field-label");
    if (label && label.nextSibling) openingWrapper.insertBefore(templateChips, label.nextSibling);
    else openingWrapper.insertBefore(templateChips, openingWrapper.firstChild);
  }

  // "More options" (TM-1066): the timezone field is DERIVED from the picked venue, so its raw selector
  // moves out of the main body into a native <details> disclosure near the form bottom — reachable for
  // the override case but out of the way otherwise. The field is UNCHANGED (still required + validated +
  // prefilled + "Use mine"); only its home in the layout moves. Reuse the TM-398 `.tm-event-calendar`
  // disclosure styling (styles.css) so the toggle reads consistently with the events UI. The submit
  // error-paint force-opens this (via `moreOptions`) so a hidden required-timezone error is never
  // invisible. Only the timezone lives here; capacity/reveal/age stay in the main body.
  const timezoneNode = byKey.get("timezone");
  const tzIdx = layout.indexOf(timezoneNode);
  if (tzIdx >= 0) layout.splice(tzIdx, 1);
  moreOptions = el(
    "details",
    { class: "tm-event-calendar tm-event-more-options", id: "event-more-options" },
    [
      el("summary", { class: "tm-event-calendar-toggle", id: "event-more-options-toggle" }, "More options"),
      el("div", { class: "tm-event-more-options-body" }, [timezoneNode]),
    ],
  );
  // Render it near the bottom of the main fields (after the last body field, before the image + actions).
  layout.push(moreOptions);

  const save = el("button", { class: "tm-btn tm-btn-primary", id: "event-save", type: "submit" }, mode === "create" ? "Create event" : "Save changes");
  // Cancel returns to the list without saving (TM-426); the page's "← Events" back link does the same.
  const cancel = el("button", { class: "tm-btn", id: "event-cancel", type: "button", onClick: () => onCancel?.() }, "Cancel");
  let busy = false;

  const setBusy = (on, labelWhileBusy) => {
    busy = on;
    save.disabled = on;
    cancel.disabled = on;
    save.textContent = on ? labelWhileBusy : mode === "create" ? "Create event" : "Save changes";
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
    el("div", { class: "tm-form-actions" }, [cancel, save]),
  ]);

  const revealSummaryText = event ? revealSummary(event) : "";
  // The full-page shell (TM-426): the form + the reveal-timing note, mounted into #admin-event-form-view
  // by enterAdminEventForm(). No modal() — the page scrolls, so nothing is clipped on a short viewport.
  const node = el("div", { class: "tm-event-form-page" }, [
    form,
    revealSummaryText ? el("p", { class: "tm-muted tm-event-reveal-note", text: revealSummaryText }) : null,
  ]);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy) return;
    const errors = paintAllErrors();
    if (Object.keys(errors).length) {
      toast("Please fix the highlighted fields.", { type: "error" });
      return;
    }

    setBusy(true, mode === "create" ? "Creating…" : "Saving…");
    image.setError("");
    try {
      const draft = readDraft();
      const body = buildEventPayload(draft);
      const pending = image.getFile();

      // On edit, an optional field the admin blanked can't be transmitted (the PATCH omits blanks and
      // the server reads absent as "leave unchanged"), so clearing it silently no-ops. Surface it
      // rather than toast a false "saved" (TM-734).
      const stuckCleared = mode === "create" ? [] : clearedOptionalFields(event, draft);

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
        await eventApi(`/api/v1/admin/events/${event.id}`, { method: "PATCH", body });
        if (pending) {
          const { path } = await uploadEventImage(event.id, pending, image.setProgress);
          await eventApi(`/api/v1/admin/events/${event.id}`, { method: "PATCH", body: { imagePath: path } });
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
  return { node, focusHeading: () => headingInput.focus() };
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
    mountEventForm(view, "create", null);
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
function mountEventForm(view, mode, event) {
  const back = () => { window.location.hash = ADMIN_EVENTS_ROUTE; };
  const { node, focusHeading } = buildEventForm({ mode, event, onDone: back, onCancel: back });
  const title = mode === "create" ? "New event" : `Edit · ${event.heading || "event"}`;
  clear(view).append(formHeader(title), node);
  focusHeading();
}

/** The "← Events" back-link header, reusing the events-detail chrome (.tm-admin-head + an anchor). */
function formHeader(title) {
  return el("div", { class: "tm-admin-head tm-event-form-head" }, [
    el("h2", {}, [doodle("calendar", { class: "tm-doodle-header" }), title]),
    el("a", { class: "tm-btn tm-btn-sm", id: "admin-event-form-back", href: ADMIN_EVENTS_ROUTE }, "← Events"),
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
  const statusSelect = el(
    "select",
    { id: "admin-events-status-filter", class: "tm-input", "aria-label": "Filter by status", onChange: (e) => { state.statusFilter = e.target.value; state.page = 0; render(); } },
    STATUS_FILTERS.map(([value, label]) => el("option", { value, text: label })),
  );
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
    el("div", { class: "tm-toolbar" }, [search, statusSelect, sizeSelect]),
    table,
    pager,
  );
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
  window.tmAdminEvents = { enterAdminEvents, enterAdminEventForm, loadEvents };
}
