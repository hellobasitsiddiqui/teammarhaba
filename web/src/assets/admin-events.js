// Admin events console (TM-395, epic TM-390) — ADMIN-only. The admin surface for the events MVP:
// lists the FULL event inventory (cancelled + not-yet-visible + finished included), and creates,
// edits and cancels events against the admin API (TM-392). Mounts into #admin-events-view; the
// router (TM-109) gates the ADMIN-only #/admin/events route, exactly as it gates #/admin.
//
// This file is the DOM/mount half; the pure, browser-free logic (validation mirroring the API DTOs,
// UTC ⇄ local-wall-clock conversion, the payload builder, the display derivations) lives in
// event-form.js so `node --test` can assert it without a browser or the Firebase SDK — the same split
// admin.js ↔ broadcast.js uses. The create/edit form is a MODAL (built outside #admin-events-table,
// which renderTable() clears on every keystroke/refresh), so an in-progress draft survives a table
// re-render — the TM-358 lesson ("the compose panel must live outside the re-rendered table").
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
import { clear, confirmDialog, el, modal, toast } from "./ui.js";
import { doodle } from "./doodles.js";
import { isStorageConfigured, uploadEventImage, validateEventImageFile, MAX_EVENT_IMAGE_BYTES } from "./storage.js";
import {
  HEADING_MAX,
  DESCRIPTION_MAX,
  LOCATION_MAX,
  URL_MAX,
  CITY_MAX,
  REVEAL_HOURS_MIN,
  REVEAL_HOURS_MAX,
  AGE_MIN_BOUND,
  AGE_MAX_BOUND,
  CATEGORY_CHIPS,
  guessTimeZone,
  isValidTimeZone,
  validateEventDraft,
  buildEventPayload,
  toFormModel,
  eventLifecycle,
  capacityLabel,
  attendanceCounts,
  revealSummary,
  formatEventWhen,
} from "./event-form.js";

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
 * re-order. A page failing mid-walk keeps what loaded and flags the fetch partial; only a failure with
 * nothing loaded errors the table.
 */
export async function loadEvents() {
  state.loading = true;
  state.error = null;
  render();
  try {
    const all = [];
    let total = 0;
    let complete = false;
    for (let page = 0; page < MAX_FETCH_PAGES; page += 1) {
      const envelope = await eventApi(
        `/api/v1/admin/events?page=${page}&size=${FETCH_SIZE}&sort=startAt,desc`,
      );
      const items = Array.isArray(envelope?.items) ? envelope.items : [];
      all.push(...items);
      const reported = Number(envelope?.totalElements);
      if (Number.isFinite(reported)) total = Math.max(total, reported);
      const totalPages = Number(envelope?.totalPages);
      const lastByServer = Number.isFinite(totalPages) && page + 1 >= totalPages;
      if (lastByServer || items.length < FETCH_SIZE) {
        complete = true;
        break;
      }
    }
    state.events = all;
    state.totalEvents = Math.max(total, all.length);
    state.fetchComplete = complete;
  } catch (err) {
    state.error = err instanceof ApiError ? err.message : "Could not load events.";
    state.events = [];
    state.totalEvents = 0;
    state.fetchComplete = true;
  } finally {
    state.loading = false;
    state.page = 0;
    render();
  }
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
  const rows = sortEvents(filteredEvents(now), now);
  if (!rows.length) {
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

  const body = el(
    "tbody",
    {},
    pageRows.map((event) => {
      const counts = attendanceCounts(event);
      const attendance = `${counts.going == null ? "—" : counts.going} / ${counts.waitlist == null ? "—" : counts.waitlist}`;
      return el("tr", { dataset: { eventId: String(event.id) } }, [
        el("td", {}, [
          el("span", { class: "tm-event-heading", text: event.heading || "—" }),
          event.onlineUrl ? el("span", { class: "tm-badge tm-badge-unknown tm-event-tag", text: "Online" }) : null,
        ]),
        el("td", { class: "tm-muted", text: formatEventWhen(event.startAt, event.timezone) }),
        el("td", {}, [statusPill(event, now)]),
        el("td", { class: "tm-muted", text: attendance }),
        el("td", { class: "tm-muted", text: capacityLabel(event.capacity) }),
        el("td", { class: "tm-actions" }, rowActions(event)),
      ]);
    }),
  );

  shell.table.append(el("table", { class: "tm-table" }, [el("thead", {}, head), body]));
  renderPager(rows.length);
}

function rowActions(event) {
  const edit = el(
    "button",
    { class: "tm-btn tm-btn-sm", type: "button", "aria-label": `Edit ${event.heading}`, onClick: () => openEventForm("edit", event) },
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
    toast(err instanceof ApiError ? err.message : "Could not cancel the event.", { type: "error" });
  }
}

// ---- create / edit form (modal) -----------------------------------------------------------

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
];

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
 * Open the create/edit modal. `mode` is "create" (event=null) or "edit" (event = the row's
 * EventResponse). The form lives on document.body (via modal()), OUTSIDE #admin-events-table, so a
 * background list refresh never disturbs the draft (TM-358). On save it validates against the API's
 * rules, converts the local wall-clock times to UTC, POSTs/PATCHes, uploads any picked image against
 * the (now-existing) id, then closes and reloads the list.
 */
export function openEventForm(mode, event = null) {
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

  const save = el("button", { class: "tm-btn tm-btn-primary", id: "event-save", type: "submit" }, mode === "create" ? "Create event" : "Save changes");
  let busy = false;

  const setBusy = (on, labelWhileBusy) => {
    busy = on;
    save.disabled = on;
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
    el("div", { class: "tm-form-actions" }, [save]),
  ]);

  const revealSummaryText = event ? revealSummary(event) : "";

  const { close } = modal(mode === "create" ? "New event" : `Edit · ${event.heading}`, [
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
      const body = buildEventPayload(readDraft());
      const pending = image.getFile();

      if (mode === "create") {
        const createdEvent = await eventApi("/api/v1/admin/events", { method: "POST", body });
        if (pending && createdEvent?.id != null) {
          // The id exists now — upload the image to event-images/{id}, then persist its path (TM-392).
          // If ONLY the image step fails the event is already created, so close + reload rather than
          // leave the modal open (a re-submit would create a DUPLICATE); the admin adds it via Edit.
          try {
            const { path } = await uploadEventImage(createdEvent.id, pending, image.setProgress);
            await eventApi(`/api/v1/admin/events/${createdEvent.id}`, { method: "PATCH", body: { imagePath: path } });
          } catch (imgErr) {
            toast(`Event created, but the image didn't upload (${imgErr?.message || "upload failed"}). Open it to add one.`, { type: "error" });
            close();
            await loadEvents();
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

      toast(mode === "create" ? "Event created." : "Event saved.", { type: "success" });
      close();
      await loadEvents();
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
        toast(err instanceof ApiError ? err.message : "Could not save the event.", { type: "error" });
      }
      setBusy(false);
    }
  });

  // Focus the heading for immediate typing (a fresh create) — a small, house-consistent nicety.
  headingInput.focus();
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
        el("button", { class: "tm-btn tm-btn-primary tm-btn-sm", id: "admin-events-new", type: "button", onClick: () => openEventForm("create") }, "New event"),
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
  window.tmAdminEvents = { enterAdminEvents, loadEvents, openEventForm };
}
