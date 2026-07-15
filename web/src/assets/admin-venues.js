// Admin venues console (TM-519, epic TM-390) — ADMIN-only. The admin surface for the reusable
// venue/location library: lists the FULL venue inventory (active + deactivated), and creates, edits,
// deactivates and reactivates venues against the admin API (TM-519). Mounts into #admin-venues-view;
// the router (TM-109) gates the ADMIN-only #/admin/venues route, exactly as it gates #/admin/events.
//
// This file is the DOM/mount half; the pure, browser-free logic (validation mirroring the API DTOs,
// the payload builder, the display derivations) lives in admin-venues-core.js so `node --test` can
// assert it without a browser or the Firebase SDK — the same split admin-events.js ↔ event-form.js
// uses. The create/edit form is its OWN full-page admin route: #/admin/venues/new and
// #/admin/venues/{id}/edit render into #admin-venue-form-view, so the form scrolls with the page (no
// height cap) and the submit button is always reachable.
//
// Backend contract consumed (TM-519, ADMIN-gated):
//   GET    /api/v1/admin/venues                 — paged inventory (PageResponse<VenueResponse>);
//                                                 ?q= searches name/city, ?active=true = picker filter
//   GET    /api/v1/admin/venues/{id}            — one venue
//   POST   /api/v1/admin/venues                 — create (201)
//   PATCH  /api/v1/admin/venues/{id}            — partial edit (null = leave unchanged)
//   POST   /api/v1/admin/venues/{id}/deactivate — retire from the picker (kept; idempotent)
//   POST   /api/v1/admin/venues/{id}/reactivate — offer again (idempotent)
// Venue photos ride the house avatar pattern (TM-166): the photo is uploaded to Storage at
// `venue-images/{id}` AFTER the id exists, then its path is persisted with a follow-up PATCH.

import { apiFetch, ApiError } from "./api.js";
import { walkPages } from "./admin-page-walk-core.js";
import { clear, confirmDialog, el, toast } from "./ui.js";
import { doodle } from "./doodles.js";
import { isStorageConfigured, uploadVenueImage, validateVenueImageFile, MAX_VENUE_IMAGE_BYTES, downloadUrlForPath } from "./storage.js";
import {
  NAME_MAX,
  ADDRESS_MAX,
  CITY_MAX,
  URL_MAX,
  NOTES_MAX,
  DETAIL_MAX,
  CAPACITY_MIN,
  validateVenueDraft,
  buildVenuePayload,
  clearedOptionalVenueFields,
  toVenueFormModel,
  venueImageRef,
} from "./admin-venues-core.js";
import { ADMIN_VENUES_ROUTE, adminVenueNewHash, adminVenueEditHash } from "./admin-venues-route.js";

const FETCH_SIZE = 100; // page size PER REQUEST of the full-inventory walk — matches the server max page size (TM-115)
const MAX_FETCH_PAGES = 50; // runaway guard on the walk (× FETCH_SIZE = 5,000 venues)
const PAGE_SIZES = [10, 25, 50];

// Client-side status buckets so the admin can filter the full inventory by whether a venue is offered
// in the event-create picker (active) or retired (inactive).
const STATUS_FILTERS = [
  ["ALL", "All venues"],
  ["ACTIVE", "Active"],
  ["INACTIVE", "Deactivated"],
];

const COLUMNS = [
  { key: "name", label: "Venue", sortable: true },
  { key: "city", label: "City / area", sortable: true },
  { key: "capacity", label: "Capacity", sortable: false },
  { key: "active", label: "Status", sortable: true },
];

// The indoor/outdoor <select> options (mirrors the backend IndoorOutdoor enum).
const INDOOR_OUTDOOR_CHOICES = [
  ["", "Unspecified"],
  ["INDOOR", "Indoor"],
  ["OUTDOOR", "Outdoor"],
  ["MIXED", "Mixed"],
];

const state = {
  venues: [],
  totalVenues: 0,
  fetchComplete: true,
  fetchPartial: false, // a page failed mid-walk — `venues` is a prefix of the true inventory (TM-727)
  fetchTruncated: false, // the runaway guard tripped before the last page — `venues` is a prefix (TM-727)
  loading: false,
  error: null,
  search: "",
  statusFilter: "ALL",
  sortKey: "name",
  sortDir: "asc",
  page: 0,
  pageSize: 25,
};

let shell = null; // { stats, table, pager } persistent containers

// ---- data ---------------------------------------------------------------------------------

/**
 * One authenticated call to the admin venues API. Goes through apiFetch (Bearer + 401 refresh/retry/
 * redirect, TM-108). A non-2xx is parsed as RFC-7807 and thrown as the shared {@link ApiError},
 * carrying `.status` and (for a 400) the per-field `errors` so the form can paint them. 204 → null.
 */
async function venueApi(path, { method = "GET", body } = {}) {
  const res = await apiFetch(path, {
    method,
    headers: body
      ? { "Content-Type": "application/json", Accept: "application/json" }
      : { Accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 403) throw new ApiError(403, "You need an admin role to manage venues.");
  if (!res.ok) {
    const problem = await res.json().catch(() => ({}));
    const fieldErrors = Array.isArray(problem.errors) ? problem.errors : [];
    throw new ApiError(res.status, problem.detail || problem.title || `Request failed (${res.status})`, fieldErrors);
  }
  return res.status === 204 ? null : res.json();
}

/**
 * Load a page of active venues for the event-create picker (TM-519). Kept small (an admin curates
 * tens of venues) — the picker asks for the active-only inventory in one page; a failure returns an
 * empty list so the picker degrades to "one-off location only" rather than blocking event creation.
 *
 * @returns {Promise<Array>} the active VenueResponses (possibly empty).
 */
export async function fetchActiveVenues() {
  try {
    const envelope = await venueApi(`/api/v1/admin/venues?active=true&size=${FETCH_SIZE}&sort=name,asc`);
    return Array.isArray(envelope?.items) ? envelope.items : [];
  } catch {
    return [];
  }
}

/**
 * Load the WHOLE venue inventory by walking the paged endpoint (TM-519) — small scale, so we hold
 * them in memory and search/filter/sort/paginate in the browser, mirroring admin-events.js. A page
 * failing mid-walk keeps what loaded and flags the fetch partial (TM-727); only a failure with nothing
 * loaded errors the table. Hitting the runaway guard flags the fetch truncated.
 */
export async function loadVenues() {
  state.loading = true;
  state.error = null;
  render();
  // Same pure, DOM-free page-walk as admin-events.js (admin-page-walk-core.js): keeps partial pages and
  // surfaces truncation rather than silently discarding either.
  const result = await walkPages(
    (page) => venueApi(`/api/v1/admin/venues?page=${page}&size=${FETCH_SIZE}&sort=name,asc`),
    { pageSize: FETCH_SIZE, maxPages: MAX_FETCH_PAGES },
  );
  if (result.error) {
    state.error = result.error instanceof ApiError ? result.error.message : "Could not load venues.";
    state.venues = [];
    state.totalVenues = 0;
    state.fetchComplete = true;
    state.fetchPartial = false;
    state.fetchTruncated = false;
  } else {
    state.error = null;
    state.venues = result.items; // kept even when a later page failed (partial)
    state.totalVenues = result.total;
    state.fetchComplete = result.complete;
    state.fetchPartial = result.partial;
    state.fetchTruncated = result.truncated;
  }
  state.loading = false;
  state.page = 0;
  render();
}

// ---- derived view -------------------------------------------------------------------------

function filteredVenues() {
  const q = state.search.trim().toLowerCase();
  return state.venues.filter((v) => {
    if (state.statusFilter === "ACTIVE" && !v.active) return false;
    if (state.statusFilter === "INACTIVE" && v.active) return false;
    if (q) {
      const haystack = [v.name, v.city, v.addressLine].filter(Boolean).join(" ").toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

function sortVenues(list) {
  const { sortKey, sortDir } = state;
  const dir = sortDir === "desc" ? -1 : 1;
  const keyOf = (v) => {
    if (sortKey === "active") return v.active ? 1 : 0;
    return String(v[sortKey] ?? "").toLowerCase();
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

/** The status pill for a row — Active (ok) or Deactivated (off). */
function statusPill(venue) {
  return venue.active
    ? el("span", { class: "tm-badge tm-badge-ok", text: "Active" })
    : el("span", { class: "tm-badge tm-badge-off", text: "Deactivated" });
}

/**
 * A small square thumbnail for a venue row (TM-711) — the photo that `photoPath` stores was uploaded
 * but rendered NOWHERE. A "📍" placeholder box shows when there's no photo; when there is, we resolve
 * the Storage object path to a fresh download URL and swap the `<img>` in. If resolution fails (Storage
 * off / missing object) we drop the `<img>` and keep the placeholder — never a broken image (mirrors
 * events.js detailHero, TM-708).
 */
function venueThumb(venue) {
  const placeholder = el("span", { class: "tm-venue-thumb-empty", "aria-hidden": "true", text: "📍" });
  const frame = el("div", { class: "tm-venue-thumb", "aria-hidden": "true" }, [placeholder]);
  const ref = venueImageRef(venue?.photoPath);
  if (!ref) return frame;

  const img = el("img", { class: "tm-venue-thumb-img", alt: "", loading: "lazy" });
  const show = (url) => {
    if (!url) return; // keep the placeholder — never a broken <img>
    img.src = url;
    placeholder.hidden = true;
    frame.append(img);
  };
  if (ref.kind === "url") show(ref.value);
  else downloadUrlForPath(ref.value).then(show);
  return frame;
}

function renderStats() {
  const total = Math.max(state.totalVenues, state.venues.length);
  const active = state.venues.filter((v) => v.active).length;
  const inactive = state.venues.filter((v) => !v.active).length;
  const cards = [
    ["Total", total],
    ["Active", active],
    ["Deactivated", inactive],
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
    shell.table.append(el("p", { class: "tm-muted", text: "Loading venues…" }));
    return;
  }
  if (state.error) {
    shell.table.append(
      el("div", { class: "tm-error" }, [
        el("p", { text: state.error }),
        el("button", { class: "tm-btn", type: "button", onClick: loadVenues }, "Retry"),
      ]),
    );
    return;
  }

  const rows = sortVenues(filteredVenues());
  if (!rows.length) {
    const notice = fetchIncompleteNotice();
    if (notice) shell.table.append(notice);
    const filtered = state.venues.length > 0;
    const message = filtered ? "No venues match your filters." : "No venues yet. Add your first one.";
    shell.table.append(
      el("div", { class: "tm-empty", id: "admin-venues-empty" }, [
        doodle("pin", { class: "tm-doodle-empty" }),
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
    pageRows.map((venue) =>
      el("tr", { dataset: { venueId: String(venue.id) } }, [
        el("td", {}, [
          el("div", { class: "tm-venue-cell" }, [
            venueThumb(venue),
            el("div", { class: "tm-venue-cell-text" }, [
              el("span", { class: "tm-event-heading", text: venue.name || "—" }),
              el("span", { class: "tm-muted tm-venue-address", text: venue.addressLine || "" }),
            ]),
          ]),
        ]),
        el("td", { class: "tm-muted", text: venue.city || "—" }),
        el("td", { class: "tm-muted", text: venue.capacity == null ? "—" : String(venue.capacity) }),
        el("td", {}, [statusPill(venue)]),
        el("td", { class: "tm-actions" }, rowActions(venue)),
      ]),
    ),
  );

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
    return el("div", { class: "tm-notice", "data-testid": "admin-venues-truncated" }, [
      el("p", {
        text:
          `Showing the first ${state.venues.length} venues — there are more than this console loads at once. ` +
          "Use search to narrow down.",
      }),
    ]);
  }
  if (state.fetchPartial) {
    return el("div", { class: "tm-notice", "data-testid": "admin-venues-partial" }, [
      el("p", { text: "Some venues couldn’t be loaded, so this list may be incomplete." }),
      el("button", { class: "tm-btn tm-btn-sm", type: "button", onClick: loadVenues }, "Retry"),
    ]);
  }
  return null;
}

function rowActions(venue) {
  const edit = el(
    "button",
    {
      class: "tm-btn tm-btn-sm",
      type: "button",
      "aria-label": `Edit ${venue.name}`,
      onClick: () => { window.location.hash = adminVenueEditHash(venue.id); },
    },
    "Edit",
  );
  if (venue.active) {
    return [
      edit,
      el(
        "button",
        { class: "tm-btn tm-btn-sm tm-btn-danger", type: "button", "aria-label": `Deactivate ${venue.name}`, onClick: () => deactivateVenue(venue) },
        "Deactivate",
      ),
    ];
  }
  return [
    edit,
    el(
      "button",
      { class: "tm-btn tm-btn-sm", type: "button", "aria-label": `Reactivate ${venue.name}`, onClick: () => reactivateVenue(venue) },
      "Reactivate",
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
    state.sortDir = "asc";
  }
  state.page = 0;
  renderTable();
}

function render() {
  if (!shell) return;
  renderStats();
  renderTable();
}

// ---- actions ------------------------------------------------------------------------------

/** Deactivate a venue behind a confirm — it's retired from the picker but the record survives. */
async function deactivateVenue(venue) {
  const ok = await confirmDialog({
    title: "Deactivate this venue?",
    message: `“${venue.name}” will no longer appear in the event-create picker. Existing events that use it keep working — this isn't a delete, and you can reactivate it any time.`,
    confirmLabel: "Deactivate",
    cancelLabel: "Keep active",
    danger: true,
  });
  if (!ok) return;
  await mutateActive(venue, "deactivate", "Venue deactivated.");
}

/** Reactivate a venue — offer it in the picker again. */
async function reactivateVenue(venue) {
  await mutateActive(venue, "reactivate", "Venue reactivated.");
}

async function mutateActive(venue, action, successMessage) {
  try {
    const updated = await venueApi(`/api/v1/admin/venues/${venue.id}/${action}`, { method: "POST" });
    const idx = state.venues.findIndex((v) => v.id === venue.id);
    if (idx >= 0 && updated) state.venues[idx] = updated;
    render();
    toast(successMessage, { type: "success" });
  } catch (err) {
    toast(err instanceof ApiError ? err.message : "Couldn't update the venue.", { type: "error" });
  }
}

// ---- create / edit form (full page) -------------------------------------------------------

// The form field spec drives the layout, the read-back, and the error map from one declarative list —
// the admin-events.js pattern. `key` matches BOTH the input id suffix and the API field name (so a
// server RFC-7807 `errors[].field` maps straight onto the right input). `row` groups short fields.
const FORM_FIELDS = [
  { key: "name", id: "venue-name", label: "Name", type: "text", maxLength: NAME_MAX, required: true },
  { key: "addressLine", id: "venue-address", label: "Address", type: "text", maxLength: ADDRESS_MAX, required: true, hint: "The full street address. Shown to attendees after the location reveal (TM-408)." },
  { key: "city", id: "venue-city", label: "City / area (optional)", type: "text", maxLength: CITY_MAX, hint: "The searchable area tag — matches the event's per-city reveal default." },
  { key: "latitude", id: "venue-latitude", label: "Latitude (optional)", type: "text", row: "geo", hint: "Decimal degrees, e.g. 51.5074. Add both or neither." },
  { key: "longitude", id: "venue-longitude", label: "Longitude (optional)", type: "text", row: "geo", hint: "Decimal degrees, e.g. -0.1278." },
  { key: "mapUrl", id: "venue-map-url", label: "Map URL (optional)", type: "url", maxLength: URL_MAX },
  { key: "capacity", id: "venue-capacity", label: "Capacity (optional)", type: "number", min: CAPACITY_MIN, row: "details", hint: "Headline capacity of the place." },
  { key: "indoorOutdoor", id: "venue-indoor-outdoor", label: "Indoor / outdoor (optional)", type: "select", options: INDOOR_OUTDOOR_CHOICES, row: "details" },
  { key: "accessibility", id: "venue-accessibility", label: "Accessibility (optional)", type: "textarea", maxLength: DETAIL_MAX, hint: "Step-free access, accessible toilets, etc." },
  { key: "parking", id: "venue-parking", label: "Parking (optional)", type: "textarea", maxLength: DETAIL_MAX },
  { key: "notes", id: "venue-notes", label: "Notes / directions (optional)", type: "textarea", maxLength: NOTES_MAX },
];

/** Human label for a field key (drops the trailing "(optional)"), used in the "can't clear" warning (TM-734). */
const FIELD_LABELS = new Map(FORM_FIELDS.map((f) => [f.key, f.label.replace(/\s*\(optional\)\s*$/i, "")]));
function venueFieldLabel(key) {
  return FIELD_LABELS.get(key) || key;
}

/** Build one field control (label + input/textarea/select + hint + role=alert error), profile.js style. */
function buildField(field, fields) {
  const errorId = `${field.id}-error`;
  const hintId = field.hint ? `${field.id}-hint` : null;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || null;

  let input;
  if (field.type === "textarea") {
    input = el("textarea", { id: field.id, class: "tm-input tm-textarea", rows: "3", maxLength: field.maxLength, "aria-describedby": describedBy });
  } else if (field.type === "select") {
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
      inputmode: field.type === "number" ? "numeric" : null,
      "aria-describedby": describedBy,
    });
  }

  const error = el("p", { id: errorId, class: "tm-field-error", role: "alert", hidden: true });
  const hint = field.hint ? el("p", { id: hintId, class: "tm-muted tm-field-hint", text: field.hint }) : null;
  fields.set(field.key, { input, error });

  return el("div", { class: "tm-form-field", dataset: { field: field.key } }, [
    el("label", { class: "tm-field-label", for: field.id, text: field.label }),
    input,
    hint,
    error,
  ]);
}

/** The venue photo control (TM-166 avatar UX): preview + file input + progress + inline error. The
 *  picked file is held and uploaded on save (the id must exist first for a create), not on pick. */
function buildPhotoControl(venue) {
  const configured = isStorageConfigured();
  let pendingFile = null;

  const placeholder = el("span", { class: "tm-event-image-empty", "aria-hidden": "true", text: "📍" });
  const preview = el("img", { class: "tm-event-image-img", alt: "", hidden: true });
  const frame = el("div", { class: "tm-event-image-frame", "aria-hidden": "true" }, [placeholder, preview]);

  const file = el("input", {
    id: "venue-image-file",
    class: "tm-event-image-file",
    type: "file",
    accept: "image/*",
    disabled: !configured,
    "aria-describedby": "venue-image-error venue-image-hint",
  });
  const progressBar = el("div", { class: "tm-avatar-progress-bar" });
  const progress = el(
    "div",
    { class: "tm-avatar-progress", role: "progressbar", "aria-label": "Upload progress", "aria-valuemin": "0", "aria-valuemax": "100", hidden: true },
    [progressBar],
  );
  const error = el("p", { id: "venue-image-error", class: "tm-field-error", role: "alert", hidden: true });
  const sizeHint = `JPG, PNG or GIF, up to ${Math.round(MAX_VENUE_IMAGE_BYTES / (1024 * 1024))} MB. Optional.`;
  const hasExisting = venue && venue.photoPath;
  const hint = el("p", {
    id: "venue-image-hint",
    class: "tm-muted tm-field-hint",
    text: !configured
      ? "Venue photo uploads aren't available in this environment yet."
      : hasExisting
        ? `A photo is already set. Choose a file to replace it. ${sizeHint}`
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
    const invalid = validateVenueImageFile(picked);
    if (invalid) {
      setError(invalid);
      pendingFile = null;
      return;
    }
    pendingFile = picked;
    preview.src = URL.createObjectURL(picked);
    preview.hidden = false;
    placeholder.hidden = true;
  });

  // TM-711: seed the preview from the EXISTING photo when editing a venue that already has one and no
  // new file has been picked. photoPath is a Firebase Storage object path (`venue-images/{id}`) — the
  // write-only field that previously rendered nowhere — so resolve it to a fresh download URL. A URL
  // (legacy/external) is used directly. If resolution fails (Storage off, object missing) we keep the
  // placeholder rather than showing a broken image, mirroring events.js detailHero (TM-708).
  const existingRef = venueImageRef(venue?.photoPath);
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

  const node = el("section", { class: "tm-event-image", "aria-label": "Venue photo" }, [
    frame,
    el("div", { class: "tm-event-image-meta" }, [
      el("label", { class: "tm-field-label", for: "venue-image-file", text: "Photo" }),
      file,
      progress,
      hint,
      error,
    ]),
  ]);

  return { node, getFile: () => pendingFile, setProgress, resetProgress, setError };
}

/**
 * Build the create/edit venue form as a detached DOM subtree. `mode` is "create" (venue=null) or
 * "edit" (venue = the VenueResponse). On a valid submit it POSTs/PATCHes, uploads any picked photo
 * against the (now-existing) id, then calls `onDone`; a "Cancel" button calls `onCancel`.
 */
function buildVenueForm({ mode, venue = null, onDone, onCancel }) {
  const fields = new Map();
  const fieldNodes = FORM_FIELDS.map((f) => buildField(f, fields));
  const nameInput = fields.get("name").input;

  // Group the fields: paired short fields two-up (geo / details) via .tm-field-row, everything else
  // full width. Order follows FORM_FIELDS.
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

  const photo = buildPhotoControl(venue);

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

  const revalidate = (changedKey) => {
    const { errors } = validateVenueDraft(readDraft(), { requireForCreate: mode === "create" });
    for (const f of FORM_FIELDS) {
      const showing = !fields.get(f.key).error.hidden;
      if (f.key === changedKey || showing) setFieldError(f.key, errors[f.key] || "");
    }
    return errors;
  };
  const paintAllErrors = () => {
    const { errors } = validateVenueDraft(readDraft(), { requireForCreate: mode === "create" });
    for (const f of FORM_FIELDS) setFieldError(f.key, errors[f.key] || "");
    return errors;
  };

  for (const f of FORM_FIELDS) {
    const input = fields.get(f.key).input;
    input.addEventListener("input", () => revalidate(f.key));
    if (f.type === "select") input.addEventListener("change", () => revalidate(f.key));
  }

  // Prefill from the existing venue (edit).
  if (venue) {
    const model = toVenueFormModel(venue);
    for (const f of FORM_FIELDS) {
      const v = model[f.key];
      if (v != null && v !== "") fields.get(f.key).input.value = v;
    }
  }

  const save = el("button", { class: "tm-btn tm-btn-primary", id: "venue-save", type: "submit" }, mode === "create" ? "Create venue" : "Save changes");
  const cancel = el("button", { class: "tm-btn", id: "venue-cancel", type: "button", onClick: () => onCancel?.() }, "Cancel");
  let busy = false;

  const setBusy = (on, labelWhileBusy) => {
    busy = on;
    save.disabled = on;
    cancel.disabled = on;
    save.textContent = on ? labelWhileBusy : mode === "create" ? "Create venue" : "Save changes";
  };

  const form = el("form", { class: "tm-event-form", id: "venue-form", novalidate: true }, [
    ...layout,
    photo.node,
    el("div", { class: "tm-form-actions" }, [cancel, save]),
  ]);

  const node = el("div", { class: "tm-event-form-page" }, [form]);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy) return;
    const errors = paintAllErrors();
    if (Object.keys(errors).length) {
      toast("Please fix the highlighted fields.", { type: "error" });
      return;
    }

    setBusy(true, mode === "create" ? "Creating…" : "Saving…");
    photo.setError("");
    try {
      const draft = readDraft();
      const body = buildVenuePayload(draft);
      const pending = photo.getFile();

      // On edit, a blanked optional can't be transmitted (PATCH omits blanks; server reads absent as
      // "leave unchanged"), so clearing it silently no-ops — surface it instead of a false "saved" (TM-734).
      const stuckCleared = mode === "create" ? [] : clearedOptionalVenueFields(venue, draft);

      if (mode === "create") {
        const created = await venueApi("/api/v1/admin/venues", { method: "POST", body });
        if (pending && created?.id != null) {
          // The id exists now — upload the photo to venue-images/{id}, then persist its path. If ONLY
          // the photo step fails the venue is already created, so navigate back (a re-submit would
          // create a DUPLICATE); the admin adds the photo via Edit.
          try {
            const { path } = await uploadVenueImage(created.id, pending, photo.setProgress);
            await venueApi(`/api/v1/admin/venues/${created.id}`, { method: "PATCH", body: { photoPath: path } });
          } catch (imgErr) {
            toast(`Venue created, but the photo didn't upload (${imgErr?.message || "upload failed"}). Open it to add one.`, { type: "error" });
            onDone?.();
            return;
          }
        }
      } else {
        if (pending) {
          const { path } = await uploadVenueImage(venue.id, pending, photo.setProgress);
          body.photoPath = path;
        }
        await venueApi(`/api/v1/admin/venues/${venue.id}`, { method: "PATCH", body });
      }

      if (stuckCleared.length) {
        const names = stuckCleared.map(venueFieldLabel).join(", ");
        toast(
          `Saved, but ${names} can't be cleared here yet — ${stuckCleared.length > 1 ? "those fields keep" : "that field keeps"} their previous value.`,
          { type: "error" },
        );
      } else {
        toast(mode === "create" ? "Venue created." : "Venue saved.", { type: "success" });
      }
      onDone?.();
    } catch (err) {
      photo.resetProgress();
      if (err instanceof ApiError && err.fieldErrors?.length) {
        const leftover = [];
        for (const fe of err.fieldErrors) {
          if (fields.has(fe.field)) setFieldError(fe.field, fe.message);
          else leftover.push(fe.message);
        }
        toast(leftover.length ? leftover.join(" ") : "Please fix the highlighted fields.", { type: "error" });
      } else {
        toast(err instanceof ApiError ? err.message : "Couldn't save the venue.", { type: "error" });
      }
      setBusy(false);
    }
  });

  return { node, focusName: () => nameInput.focus() };
}

/** Module-level guard so a slow edit-by-id fetch that resolves AFTER navigation can't paint a stale form. */
let formToken = 0;

/**
 * Router entry for the full-page create/edit form. `mode` is "create" (id null) or "edit". For an
 * edit we render from the row already in memory when we have it; otherwise we fetch it by id, so the
 * route also works on a direct deep-link / page refresh.
 */
export async function enterAdminVenueForm(mode, id = null) {
  const view = document.getElementById("admin-venue-form-view");
  if (!view) return;
  const mine = ++formToken;

  if (mode === "create") {
    mountVenueForm(view, "create", null);
    return;
  }

  const cached = state.venues.find((v) => String(v.id) === String(id));
  if (cached) {
    mountVenueForm(view, "edit", cached);
    return;
  }

  renderFormLoading(view);
  try {
    const venue = await venueApi(`/api/v1/admin/venues/${encodeURIComponent(id)}`);
    if (mine !== formToken) return;
    if (!venue) {
      renderFormError(view, "That venue isn't available anymore.", null);
      return;
    }
    mountVenueForm(view, "edit", venue);
  } catch (err) {
    if (mine !== formToken) return;
    const gone = err instanceof ApiError && err.status === 404;
    renderFormError(
      view,
      gone ? "That venue isn't available anymore." : "Couldn't load this venue. Please try again.",
      gone ? null : () => enterAdminVenueForm("edit", id),
    );
  }
}

/** Mount the page chrome (a "← Venues" back-link header) + the form, then focus the name field. */
function mountVenueForm(view, mode, venue) {
  const back = () => { window.location.hash = ADMIN_VENUES_ROUTE; };
  const { node, focusName } = buildVenueForm({ mode, venue, onDone: back, onCancel: back });
  const title = mode === "create" ? "New venue" : `Edit · ${venue.name || "venue"}`;
  clear(view).append(formHeader(title), node);
  focusName();
}

/** The "← Venues" back-link header. */
function formHeader(title) {
  return el("div", { class: "tm-admin-head tm-event-form-head" }, [
    el("h2", {}, [doodle("pin", { class: "tm-doodle-header" }), title]),
    el("a", { class: "tm-btn tm-btn-sm", id: "admin-venue-form-back", href: ADMIN_VENUES_ROUTE }, "← Venues"),
  ]);
}

/** The transient "loading the venue to edit" state while an edit-by-id fetch is in flight. */
function renderFormLoading(view) {
  clear(view).append(formHeader("Edit venue"), el("p", { class: "tm-muted", text: "Loading venue…" }));
}

/** The edit-by-id failure state: a message + either Retry (transient) or a back-to-list link (gone). */
function renderFormError(view, message, onRetry) {
  clear(view).append(
    formHeader("Edit venue"),
    el("div", { class: "tm-error tm-empty" }, [
      doodle("pin", { class: "tm-doodle-empty" }),
      el("p", { text: message }),
      onRetry
        ? el("button", { class: "tm-btn", type: "button", onClick: onRetry }, "Retry")
        : el("a", { class: "tm-btn", href: ADMIN_VENUES_ROUTE }, "Back to venues"),
    ]),
  );
}

// ---- mount --------------------------------------------------------------------------------

function buildShell(view) {
  const search = el("input", {
    id: "admin-venues-search",
    type: "search",
    class: "tm-input",
    placeholder: "Search name, city, address…",
    "aria-label": "Search venues",
    onInput: (e) => { state.search = e.target.value; state.page = 0; renderTable(); },
  });
  const statusSelect = el(
    "select",
    { id: "admin-venues-status-filter", class: "tm-input", "aria-label": "Filter by status", onChange: (e) => { state.statusFilter = e.target.value; state.page = 0; render(); } },
    STATUS_FILTERS.map(([value, label]) => el("option", { value, text: label })),
  );
  const sizeSelect = el(
    "select",
    { class: "tm-input", "aria-label": "Rows per page", onChange: (e) => { state.pageSize = Number(e.target.value); state.page = 0; renderTable(); } },
    PAGE_SIZES.map((n) => el("option", { value: String(n), text: `${n} / page`, selected: n === state.pageSize })),
  );

  const stats = el("div", { class: "tm-stats", id: "admin-venues-stats" });
  const table = el("div", { class: "tm-table-wrap", id: "admin-venues-table" });
  const pager = el("div", { class: "tm-pager", id: "admin-venues-pager" });

  shell = { stats, table, pager };

  clear(view).append(
    el("div", { class: "tm-admin-head" }, [
      el("h2", {}, [doodle("pin", { class: "tm-doodle-header" }), "Venues"]),
      el("div", { class: "tm-admin-head-actions" }, [
        el("button", { class: "tm-btn tm-btn-primary tm-btn-sm", id: "admin-venues-new", type: "button", onClick: () => { window.location.hash = adminVenueNewHash(); } }, "New venue"),
        el("button", { class: "tm-btn tm-btn-sm", id: "admin-venues-refresh", type: "button", onClick: loadVenues }, "Refresh"),
      ]),
    ]),
    stats,
    el("div", { class: "tm-toolbar" }, [search, statusSelect, sizeSelect]),
    table,
    pager,
  );
}

/** Called by the router when the #/admin/venues view becomes active. Builds the shell once, then loads. */
export function enterAdminVenues() {
  const view = document.getElementById("admin-venues-view");
  if (!view) return;
  if (!shell) buildShell(view);
  loadVenues();
}

// Bridge for the router (which imports this) + ad-hoc use.
if (typeof window !== "undefined") {
  window.tmAdminVenues = { enterAdminVenues, enterAdminVenueForm, loadVenues, fetchActiveVenues };
}
