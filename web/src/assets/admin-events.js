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
import { clear, confirmDialog, el, toast } from "./ui.js";
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
  guessTimeZone,
  isValidTimeZone,
  validateEventDraft,
  buildEventPayload,
  clearedOptionalFields,
  toFormModel,
  eventLifecycle,
  capacityLabel,
  attendanceCounts,
  revealSummary,
  formatEventWhen,
  isPastEvent,
  partitionEventsByPast,
} from "./event-form.js";
import { ADMIN_EVENTS_ROUTE, adminEventNewHash, adminEventEditHash } from "./admin-event-route.js";
import { venueSummaryLabel } from "./admin-venues-core.js";
import { adminVenueNewHash } from "./admin-venues-route.js";
import { clampPage } from "./admin-paging-core.js";

const FETCH_SIZE = 100; // page size PER REQUEST of the full-inventory walk — matches the server max page size (TM-115)
const MAX_FETCH_PAGES = 50; // runaway guard on the walk (× FETCH_SIZE = 5,000 events)
const PAGE_SIZES = [10, 25, 50];

// Client-side status buckets over the DERIVED lifecycle (event-form.js), so the admin can filter the
// full inventory the way they think about it — not just the raw PUBLISHED|CANCELLED the API stores.
const STATUS_FILTERS = [
  ["ALL", "All statuses"],
  ["Visible", "Visible now"],
  ["Hidden", "Hidden (upcoming)"],
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

// Fallback timezone shortlist if Intl.supportedValuesOf isn't available (older engines). The real list
// is the full IANA set; this just keeps the picker usable everywhere.
const FALLBACK_ZONES = [
  "UTC", "Europe/London", "Europe/Paris", "Europe/Istanbul", "America/New_York", "America/Los_Angeles",
  "America/Sao_Paulo", "Asia/Dubai", "Asia/Karachi", "Asia/Kolkata", "Asia/Singapore", "Asia/Tokyo",
  "Australia/Sydney",
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
    if (state.statusFilter !== "ALL" && eventLifecycle(e, now).label !== state.statusFilter) return false;
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
  const cards = [
    ["Total", total],
    ["Visible now", visible],
    ["Cancelled", cancelled],
  ];
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
  });
  const body = el("tbody", {}, bodyRows);

  const notice = fetchIncompleteNotice();
  if (notice) shell.table.append(notice);
  shell.table.append(el("table", { class: "tm-table" }, [el("thead", {}, head), body]));
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
    el("td", {}, [
      el("span", { class: "tm-event-heading", text: event.heading || "—" }),
      event.onlineUrl ? el("span", { class: "tm-badge tm-badge-unknown tm-event-tag", text: "Online" }) : null,
    ]),
    el("td", { class: "tm-muted", text: formatEventWhen(event.startAt, event.timezone) }),
    el("td", {}, [statusPill(event, now)]),
    el("td", { class: "tm-muted", text: attendance }),
    el("td", { class: "tm-muted", text: capacityLabel(event.capacity) }),
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
  return [
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

// ---- create / edit form (full page — TM-426) ----------------------------------------------

// The form field spec drives the grid, the read-back, and the error map from one declarative list —
// the profile.js pattern. `key` matches BOTH the input id suffix and the API field name (so a server
// RFC-7807 `errors[].field` maps straight onto the right input). `row` groups short fields two-up.
const FORM_FIELDS = [
  { key: "heading", id: "event-heading", label: "Heading", type: "text", maxLength: HEADING_MAX, required: true },
  { key: "description", id: "event-description", label: "Description", type: "textarea", maxLength: DESCRIPTION_MAX, required: true },
  { key: "locationText", id: "event-location", label: "Location", type: "text", maxLength: LOCATION_MAX, required: true, hint: 'The venue line — use "Online" for online-only events.' },
  { key: "city", id: "event-city", label: "City (optional)", type: "text", maxLength: CITY_MAX, hint: "The public pre-reveal hint + per-city reveal default (TM-408)." },
  { key: "mapUrl", id: "event-map-url", label: "Map URL (optional)", type: "url", maxLength: URL_MAX, row: "links" },
  { key: "onlineUrl", id: "event-online-url", label: "Online URL (optional)", type: "url", maxLength: URL_MAX, row: "links" },
  { key: "timezone", id: "event-timezone", label: "Time zone", type: "timezone", required: true, hint: "The event's local IANA zone; all times below are entered in it." },
  { key: "startAt", id: "event-start", label: "Starts", type: "datetime-local", required: true, row: "when" },
  { key: "endAt", id: "event-end", label: "Ends (optional)", type: "datetime-local", row: "when" },
  { key: "visibilityStart", id: "event-visibility-start", label: "Visible from", type: "datetime-local", required: true, row: "visibility" },
  { key: "visibilityEnd", id: "event-visibility-end", label: "Visible until", type: "datetime-local", required: true, row: "visibility" },
  { key: "capacity", id: "event-capacity", label: "Capacity (optional)", type: "number", min: 1, row: "limits", hint: "Blank = unlimited." },
  { key: "locationRevealHours", id: "event-reveal-hours", label: "Reveal hours (optional)", type: "number", min: REVEAL_HOURS_MIN, max: REVEAL_HOURS_MAX, row: "limits", hint: "Hours before the start the exact location is revealed. Blank = city / app default." },
  { key: "ageMin", id: "event-age-min", label: "Min age (optional)", type: "number", min: AGE_MIN_BOUND, max: AGE_MAX_BOUND, row: "age" },
  { key: "ageMax", id: "event-age-max", label: "Max age (optional)", type: "number", min: AGE_MIN_BOUND, max: AGE_MAX_BOUND, row: "age" },
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

/** Make sure `zone` is a selectable option in a timezone <select> (defensive for a non-listed id). */
function ensureZoneOption(select, zone) {
  if (!zone) return;
  if (![...select.options].some((o) => o.value === zone)) {
    select.append(el("option", { value: zone, text: zone }));
  }
}

/** Populate a timezone <select> with the full IANA set (or the fallback), preselecting `selected`. */
function fillTimeZoneOptions(select, selected) {
  let zones;
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    zones = null;
  }
  if (!Array.isArray(zones) || !zones.length) zones = FALLBACK_ZONES.slice();
  const chosen = (selected || guessTimeZone() || "UTC").trim();
  if (chosen && !zones.includes(chosen)) zones = [chosen, ...zones];
  clear(select).append(...zones.map((z) => el("option", { value: z, text: z, selected: z === chosen })));
  select.value = chosen;
}

/** The Coffee & X suggestion chips (TM-382): tap to prefill the heading, still fully editable after. */
function buildChips(headingInput, onChange) {
  return el(
    "div",
    { class: "tm-chips", role: "group", "aria-label": "Heading suggestions" },
    CATEGORY_CHIPS.map((chip) =>
      el(
        "button",
        {
          class: "tm-chip",
          type: "button",
          dataset: { chip },
          onClick: () => {
            headingInput.value = chip;
            headingInput.focus();
            onChange();
          },
        },
        chip,
      ),
    ),
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
      ? "Event image uploads aren't available in this environment yet."
      : hasExisting
        ? `An image is already set. Choose a file to replace it. ${sizeHint}`
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
      el("label", { class: "tm-field-label", for: "event-image-file", text: "Image" }),
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
 * @param {(venue: ?object) => void} onSelect called with the chosen venue (or null) after a change.
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

  // Async-load the active venues, then re-populate (keeping any current selection).
  fetchActiveVenues().then((list) => {
    populate(list);
    onSelect?.(venues.find((v) => String(v.id) === select.value) || null);
  });

  select.addEventListener("change", () => {
    onSelect?.(venues.find((v) => String(v.id) === select.value) || null);
  });

  const node = el("div", { class: "tm-form-field", dataset: { field: "venueId" } }, [
    el("label", { class: "tm-field-label", for: "event-venue", text: "Venue (optional)" }),
    el("div", { class: "tm-field-fill" }, [select, newLink]),
    hint,
  ]);
  return { node, getValue: () => select.value };
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

  const image = buildImageControl(event);
  // The venue picker (TM-519) is built below (after revalidate exists); readDraft reads its value.
  let venuePicker = null;

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
  };

  const readDraft = () => {
    const draft = {};
    for (const f of FORM_FIELDS) draft[f.key] = fields.get(f.key).input.value;
    // The venue reference (TM-519) isn't a FORM_FIELDS input; read it off the picker (blank on create
    // until built, "" = one-off location).
    draft.venueId = venuePicker ? venuePicker.getValue() : "";
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
    return errors;
  };

  for (const f of FORM_FIELDS) {
    const input = fields.get(f.key).input;
    input.addEventListener("input", () => revalidate(f.key));
    if (f.type === "timezone") input.addEventListener("change", () => revalidate(f.key));
  }

  // Prefill: timezone options first (needs the selected zone), then the rest of the values.
  const model = event ? toFormModel(event) : { timezone: guessTimeZone() };
  fillTimeZoneOptions(fields.get("timezone").input, model.timezone);
  for (const f of FORM_FIELDS) {
    if (f.type === "timezone") continue;
    const v = model[f.key];
    if (v != null && v !== "") fields.get(f.key).input.value = v;
  }

  // The venue picker (TM-519): sits under the Location line. Picking a venue prefills the required
  // Location line + City from it when they're still blank (so the event always has a display location
  // AND references the venue), then re-validates. Built here — after revalidate/prefill — so its
  // onSelect can safely call them; spliced into the layout right after the location field.
  venuePicker = buildVenuePicker(event, (chosen) => {
    if (chosen) {
      const loc = fields.get("locationText").input;
      if (loc.value.trim() === "") loc.value = chosen.addressLine || chosen.name || "";
      const cityInput = fields.get("city").input;
      if (cityInput && cityInput.value.trim() === "" && chosen.city) cityInput.value = chosen.city;
    }
    revalidate("locationText");
  });
  const locationNode = byKey.get("locationText");
  const locIdx = layout.indexOf(locationNode);
  if (locIdx >= 0) layout.splice(locIdx + 1, 0, venuePicker.node);
  else layout.push(venuePicker.node);

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
        if (pending) {
          const { path } = await uploadEventImage(event.id, pending, image.setProgress);
          body.imagePath = path;
        }
        await eventApi(`/api/v1/admin/events/${event.id}`, { method: "PATCH", body });
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
