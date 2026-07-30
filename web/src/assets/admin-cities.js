// Admin cities console (TM-1166, epic wave-admin-events-city) — ADMIN-only. The admin surface for the
// city catalogue (TM-1089): lists the FULL catalogue (active + retired), and creates, edits, reorders
// (sort weight), retires and restores cities against the admin API. Mounts into #admin-cities-view;
// the router (TM-133) gates the ADMIN-only #/admin/cities route, exactly as it gates #/admin/venues.
//
// Each city carries TWO uploaded images (TM-1166): a small ICON image (shown beside the name) AND a
// big EMPTY-STATE image. Both ride the house avatar/upload pattern (TM-166) — the file is uploaded to
// Storage (`city-icon-images/{id}` / `city-images/{id}`) AFTER the id exists, then its object PATH is
// persisted with a follow-up PATCH (iconImagePath / imagePath). icon_emoji stays as an OPTIONAL
// fallback glyph (a city may carry an uploaded icon image, a plain emoji, or neither).
//
// This file is the DOM/mount half; the pure, browser-free logic (validation mirroring the API DTOs,
// the payload builder, the display derivations) lives in admin-cities-core.js so `node --test` can
// assert it without a browser or the Firebase SDK — the same split admin-venues.js ↔ admin-venues-core.js
// uses. The create/edit form is its OWN full-page admin route: #/admin/cities/new and
// #/admin/cities/{id}/edit render into #admin-city-form-view.
//
// Backend contract consumed (TM-1089, ADMIN-gated):
//   GET    /api/v1/admin/cities                 — paged catalogue INCL. retired (PageResponse<AdminCityResponse>)
//   GET    /api/v1/admin/cities/{id}            — one city
//   POST   /api/v1/admin/cities                 — create (201)
//   PATCH  /api/v1/admin/cities/{id}            — partial edit (null = leave unchanged)
//   POST   /api/v1/admin/cities/{id}/retire     — soft-delete (kept; idempotent)
//   POST   /api/v1/admin/cities/{id}/restore    — un-retire (idempotent)

import { apiFetch, ApiError } from "./api.js";
import { walkPages } from "./admin-page-walk-core.js";
import { clear, confirmDialog, el, stackableTable, toast } from "./ui.js";
import { doodle } from "./doodles.js";
import {
  isStorageConfigured,
  uploadCityImage,
  uploadCityIconImage,
  validateCityImageFile,
  MAX_CITY_IMAGE_BYTES,
  downloadUrlForPath,
} from "./storage.js";
import {
  NAME_MAX,
  COUNTRY_MAX,
  ICON_EMOJI_MAX,
  SORT_WEIGHT_MIN,
  SORT_WEIGHT_MAX,
  validateCityDraft,
  buildCityPayload,
  toCityFormModel,
  cityImageRef,
} from "./admin-cities-core.js";
import { ADMIN_CITIES_ROUTE, adminCityNewHash, adminCityEditHash } from "./admin-cities-route.js";
import { clampPage } from "./admin-paging-core.js";
import { statsCards } from "./admin-stats-core.js";

const FETCH_SIZE = 100; // page size PER REQUEST of the full-catalogue walk — matches the server max (TM-115)
const MAX_FETCH_PAGES = 50; // runaway guard on the walk (× FETCH_SIZE = 5,000 cities)
const PAGE_SIZES = [10, 25, 50];

// Client-side status buckets so the admin can filter the full catalogue by whether a city is offered
// to users (active) or retired.
const STATUS_FILTERS = [
  ["ALL", "All cities"],
  ["ACTIVE", "Active"],
  ["RETIRED", "Retired"],
];

const COLUMNS = [
  { key: "name", label: "City", sortable: true },
  { key: "country", label: "Country", sortable: true },
  { key: "sortWeight", label: "Sort", sortable: true },
  { key: "active", label: "Status", sortable: true },
];

const state = {
  cities: [],
  totalCities: 0,
  fetchComplete: true,
  fetchPartial: false, // a page failed mid-walk — `cities` is a prefix of the true catalogue (TM-727)
  fetchTruncated: false, // the runaway guard tripped before the last page — `cities` is a prefix
  loading: false,
  error: null,
  search: "",
  statusFilter: "ALL",
  sortKey: "sortWeight",
  sortDir: "desc",
  page: 0,
  pageSize: 25,
};

let shell = null; // { stats, table, pager } persistent containers

// ---- data ---------------------------------------------------------------------------------

/**
 * One authenticated call to the admin cities API. Goes through apiFetch (Bearer + 401 refresh/retry/
 * redirect, TM-108). A non-2xx is parsed as RFC-7807 and thrown as the shared {@link ApiError},
 * carrying `.status` and (for a 400) the per-field `errors` so the form can paint them. 204 → null.
 */
async function cityApi(path, { method = "GET", body } = {}) {
  const res = await apiFetch(path, {
    method,
    headers: body
      ? { "Content-Type": "application/json", Accept: "application/json" }
      : { Accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 403) throw new ApiError(403, "You need an admin role to manage cities.");
  if (!res.ok) {
    const problem = await res.json().catch(() => ({}));
    const fieldErrors = Array.isArray(problem.errors) ? problem.errors : [];
    throw new ApiError(res.status, problem.detail || problem.title || `Request failed (${res.status})`, fieldErrors);
  }
  return res.status === 204 ? null : res.json();
}

/**
 * Load the WHOLE city catalogue (incl. retired) by walking the paged endpoint (TM-1089) — small scale,
 * so we hold them in memory and search/filter/sort/paginate in the browser, mirroring admin-venues.js.
 * A page failing mid-walk keeps what loaded and flags the fetch partial (TM-727); only a failure with
 * nothing loaded errors the table. Hitting the runaway guard flags the fetch truncated.
 */
export async function loadCities() {
  // Re-entry guard (TM-751): a second Refresh while a load is running would start a whole second
  // concurrent page walk, doubling requests and racing two result sets into state.cities.
  if (state.loading) return;
  state.loading = true;
  state.error = null;
  render();
  const result = await walkPages(
    (page) => cityApi(`/api/v1/admin/cities?page=${page}&size=${FETCH_SIZE}&sort=sortWeight,desc`),
    { pageSize: FETCH_SIZE, maxPages: MAX_FETCH_PAGES },
  );
  if (result.error) {
    state.error = result.error instanceof ApiError ? result.error.message : "Could not load cities.";
    state.cities = [];
    state.totalCities = 0;
    state.fetchComplete = true;
    state.fetchPartial = false;
    state.fetchTruncated = false;
  } else {
    state.error = null;
    state.cities = result.items; // kept even when a later page failed (partial)
    state.totalCities = result.total;
    state.fetchComplete = result.complete;
    state.fetchPartial = result.partial;
    state.fetchTruncated = result.truncated;
  }
  state.loading = false;
  state.page = 0;
  render();
}

// ---- derived view -------------------------------------------------------------------------

function filteredCities() {
  const q = state.search.trim().toLowerCase();
  return state.cities.filter((c) => {
    if (state.statusFilter === "ACTIVE" && c.retired) return false;
    if (state.statusFilter === "RETIRED" && !c.retired) return false;
    if (q) {
      const haystack = [c.name, c.country].filter(Boolean).join(" ").toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

function sortCities(list) {
  const { sortKey, sortDir } = state;
  const dir = sortDir === "desc" ? -1 : 1;
  const keyOf = (c) => {
    if (sortKey === "active") return c.retired ? 0 : 1; // active sorts above retired ascending
    if (sortKey === "sortWeight") return Number(c.sortWeight) || 0;
    return String(c[sortKey] ?? "").toLowerCase();
  };
  return [...list].sort((a, b) => {
    const av = keyOf(a);
    const bv = keyOf(b);
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    // Stable tiebreak on name so equal-weight cities keep a deterministic order.
    return String(a.name ?? "").toLowerCase().localeCompare(String(b.name ?? "").toLowerCase());
  });
}

// ---- rendering ----------------------------------------------------------------------------

/** The status pill for a row — Active (ok) or Retired (off). */
function statusPill(city) {
  return city.retired
    ? el("span", { class: "tm-badge tm-badge-off", text: "Retired" })
    : el("span", { class: "tm-badge tm-badge-ok", text: "Active" });
}

/**
 * A small square thumbnail for a city row — the uploaded ICON image if there is one, else the emoji
 * glyph, else a "📍" placeholder. When there's an icon-image path we resolve the Storage object path to
 * a fresh download URL and swap the `<img>` in; if resolution fails we keep the emoji/placeholder —
 * never a broken image (mirrors admin-venues.js venueThumb, TM-711).
 */
function cityThumb(city) {
  const glyph = (city.iconEmoji || "").trim() || "📍";
  const placeholder = el("span", { class: "tm-venue-thumb-empty", "aria-hidden": "true", text: glyph });
  const frame = el("div", { class: "tm-venue-thumb", "aria-hidden": "true" }, [placeholder]);
  const ref = cityImageRef(city?.iconImagePath);
  if (!ref) return frame;

  const img = el("img", { class: "tm-venue-thumb-img", alt: "", loading: "lazy" });
  const show = (url) => {
    if (!url) return; // keep the emoji/placeholder — never a broken <img>
    img.src = url;
    placeholder.hidden = true;
    frame.append(img);
  };
  if (ref.kind === "url") show(ref.value);
  else downloadUrlForPath(ref.value).then(show);
  return frame;
}

function renderStats() {
  const total = Math.max(state.totalCities, state.cities.length);
  const active = state.cities.filter((c) => !c.retired).length;
  const retired = state.cities.filter((c) => c.retired).length;
  const cards = statsCards(
    [
      ["Total", total],
      ["Active", active],
      ["Retired", retired],
    ],
    state.loading,
  );
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
    shell.table.append(el("p", { class: "tm-muted", text: "Loading cities…" }));
    return;
  }
  if (state.error) {
    shell.table.append(
      el("div", { class: "tm-error" }, [
        el("p", { text: state.error }),
        el("button", { class: "tm-btn", type: "button", onClick: loadCities }, "Retry"),
      ]),
    );
    return;
  }

  const rows = sortCities(filteredCities());
  if (!rows.length) {
    const notice = fetchIncompleteNotice();
    if (notice) shell.table.append(notice);
    const filtered = state.cities.length > 0;
    const message = filtered ? "No cities match your filters." : "No cities yet. Add your first one.";
    shell.table.append(
      el("div", { class: "tm-empty", id: "admin-cities-empty" }, [
        doodle("pin", { class: "tm-doodle-empty" }),
        el("p", { class: "tm-muted", text: message }),
      ]),
    );
    renderPager(0);
    return;
  }

  // TM-721: clamp a stale page index BEFORE slicing (see admin-paging-core.js).
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

  const body = el(
    "tbody",
    {},
    pageRows.map((city) =>
      el("tr", { dataset: { cityId: String(city.id) } }, [
        // TM-935: data-label on every body td drives the CSS stacked-card layout at ≤30rem.
        el("td", { "data-label": "City" }, [
          el("div", { class: "tm-venue-cell" }, [
            cityThumb(city),
            el("div", { class: "tm-venue-cell-text" }, [
              el("span", { class: "tm-event-heading", text: city.name || "—" }),
            ]),
          ]),
        ]),
        el("td", { "data-label": "Country", class: "tm-muted", text: city.country || "—" }),
        el("td", { "data-label": "Sort", class: "tm-muted", text: String(city.sortWeight ?? 0) }),
        el("td", { "data-label": "Status" }, [statusPill(city)]),
        el("td", { class: "tm-actions" }, rowActions(city)),
      ]),
    ),
  );

  const notice = fetchIncompleteNotice();
  if (notice) shell.table.append(notice);
  shell.table.append(stackableTable(el("thead", {}, head), body));
  renderPager(rows.length);
}

/**
 * A non-blocking notice when the catalogue walk did NOT load the whole set (TM-727) — a page failed
 * mid-walk (partial) or the runaway guard tripped before the last page (truncated). Returns null on a
 * full, clean load.
 */
function fetchIncompleteNotice() {
  if (state.fetchTruncated) {
    return el("div", { class: "tm-notice", "data-testid": "admin-cities-truncated" }, [
      el("p", {
        text:
          `Showing the first ${state.cities.length} cities — there are more than this console loads at once. ` +
          "Use search to narrow down.",
      }),
    ]);
  }
  if (state.fetchPartial) {
    return el("div", { class: "tm-notice", "data-testid": "admin-cities-partial" }, [
      el("p", { text: "Some cities couldn’t be loaded, so this list may be incomplete." }),
      el("button", { class: "tm-btn tm-btn-sm", type: "button", onClick: loadCities }, "Retry"),
    ]);
  }
  return null;
}

function rowActions(city) {
  const edit = el(
    "button",
    {
      class: "tm-btn tm-btn-sm",
      type: "button",
      "aria-label": `Edit ${city.name}`,
      onClick: () => {
        window.location.hash = adminCityEditHash(city.id);
      },
    },
    "Edit",
  );
  if (!city.retired) {
    return [
      edit,
      el(
        "button",
        { class: "tm-btn tm-btn-sm tm-btn-danger", type: "button", "aria-label": `Retire ${city.name}`, onClick: () => retireCity(city) },
        "Retire",
      ),
    ];
  }
  return [
    edit,
    el(
      "button",
      { class: "tm-btn tm-btn-sm", type: "button", "aria-label": `Restore ${city.name}`, onClick: () => restoreCity(city) },
      "Restore",
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
    // Sort weight defaults to descending (higher first — the reorder intent); text ascending.
    state.sortDir = key === "sortWeight" ? "desc" : "asc";
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

/** Retire a city behind a confirm — it's removed from the picker but the record (and every user/event
 *  that saved it by name) survives. */
async function retireCity(city) {
  const ok = await confirmDialog({
    title: "Retire this city?",
    message: `“${city.name}” will no longer be offered to users. Existing users and events that saved it keep working — this isn't a delete, and you can restore it any time.`,
    confirmLabel: "Retire",
    cancelLabel: "Keep active",
    danger: true,
  });
  if (!ok) return;
  await mutateRetire(city, "retire", "City retired.");
}

/** Restore a retired city — offer it to users again. */
async function restoreCity(city) {
  await mutateRetire(city, "restore", "City restored.");
}

async function mutateRetire(city, action, successMessage) {
  try {
    const updated = await cityApi(`/api/v1/admin/cities/${city.id}/${action}`, { method: "POST" });
    const idx = state.cities.findIndex((c) => c.id === city.id);
    if (idx >= 0 && updated) state.cities[idx] = updated;
    render();
    toast(successMessage, { type: "success" });
  } catch (err) {
    // A restore can 409 if another active city took the name while this one was retired (TM-1089).
    toast(err instanceof ApiError ? err.message : "Couldn't update the city.", { type: "error" });
    if (err instanceof ApiError && err.status === 409) loadCities();
  }
}

// ---- create / edit form (full page) -------------------------------------------------------

// The form field spec drives the layout, the read-back, and the error map from one declarative list —
// the admin-venues.js pattern. `key` matches BOTH the input id suffix and the API field name (so a
// server RFC-7807 `errors[].field` maps straight onto the right input). `row` groups short fields.
const FORM_FIELDS = [
  { key: "name", id: "city-name", label: "Name", type: "text", maxLength: NAME_MAX, required: true },
  { key: "country", id: "city-country", label: "Country", type: "text", maxLength: COUNTRY_MAX, required: true },
  { key: "iconEmoji", id: "city-icon-emoji", label: "Icon emoji (optional)", type: "text", maxLength: ICON_EMOJI_MAX, hint: "A fallback glyph shown beside the name when no icon image is set, e.g. a flag." },
  { key: "geoLat", id: "city-geo-lat", label: "Latitude (optional)", type: "text", row: "geo", hint: "Decimal degrees, e.g. 51.5074. Add both or neither." },
  { key: "geoLng", id: "city-geo-lng", label: "Longitude (optional)", type: "text", row: "geo", hint: "Decimal degrees, e.g. -0.1278." },
  { key: "sortWeight", id: "city-sort-weight", label: "Sort weight (optional)", type: "number", min: SORT_WEIGHT_MIN, max: SORT_WEIGHT_MAX, hint: `Higher sorts first in the picker (${SORT_WEIGHT_MIN}–${SORT_WEIGHT_MAX}). Blank = 0.` },
];

/** Build one field control (label + input + hint + role=alert error), profile.js style. */
function buildField(field, fields) {
  const errorId = `${field.id}-error`;
  const hintId = field.hint ? `${field.id}-hint` : null;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || null;

  const input = el("input", {
    id: field.id,
    class: "tm-input",
    type: field.type,
    maxLength: field.maxLength,
    min: field.min,
    max: field.max,
    inputmode: field.type === "number" ? "numeric" : null,
    "aria-describedby": describedBy,
  });

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

/**
 * One image control (TM-1166 avatar UX): preview + file input + progress + inline error. Used TWICE —
 * once for the icon image and once for the big empty-state image. The picked file is held and uploaded
 * on save (the id must exist first for a create), not on pick.
 *
 * @param {object} opts.city the AdminCityResponse being edited (null on create).
 * @param {"icon"|"image"} opts.kind which upload this control drives.
 * @param {string} opts.idPrefix DOM-id prefix so the two controls don't collide.
 * @param {string} opts.label the field label.
 * @param {string} opts.existingPath the stored path for this kind (icon → iconImagePath, image → imagePath).
 * @param {string} opts.placeholderGlyph the placeholder shown when there's no image.
 */
function buildImageControl({ kind, idPrefix, label, existingPath, placeholderGlyph }) {
  const configured = isStorageConfigured();
  let pendingFile = null;

  const placeholder = el("span", { class: "tm-event-image-empty", "aria-hidden": "true", text: placeholderGlyph });
  const preview = el("img", { class: "tm-event-image-img", alt: "", hidden: true });
  const frame = el("div", { class: "tm-event-image-frame", "aria-hidden": "true" }, [placeholder, preview]);

  const fileId = `${idPrefix}-file`;
  const errorId = `${idPrefix}-error`;
  const hintId = `${idPrefix}-hint`;
  const file = el("input", {
    id: fileId,
    class: "tm-event-image-file",
    type: "file",
    accept: "image/*",
    disabled: !configured,
    "aria-describedby": `${errorId} ${hintId}`,
  });
  const progressBar = el("div", { class: "tm-avatar-progress-bar" });
  const progress = el(
    "div",
    { class: "tm-avatar-progress", role: "progressbar", "aria-label": "Upload progress", "aria-valuemin": "0", "aria-valuemax": "100", hidden: true },
    [progressBar],
  );
  const error = el("p", { id: errorId, class: "tm-field-error", role: "alert", hidden: true });
  const sizeHint = `JPG, PNG or GIF, up to ${Math.round(MAX_CITY_IMAGE_BYTES / (1024 * 1024))} MB. Optional.`;
  const hasExisting = Boolean(existingPath);
  const hint = el("p", {
    id: hintId,
    class: "tm-muted tm-field-hint",
    text: !configured
      ? "City image uploads aren't available in this environment yet."
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
    const invalid = validateCityImageFile(picked);
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

  // Seed the preview from the EXISTING image when editing a city that already has one and no new file
  // has been picked. The stored value is a Storage object path — resolve it to a fresh download URL. A
  // URL (legacy/external) is used directly. On failure keep the placeholder (never a broken image).
  const existingRef = cityImageRef(existingPath);
  if (existingRef) {
    const showExisting = (url) => {
      if (!url || pendingFile) return; // a pick between resolve start/finish wins.
      preview.src = url;
      preview.hidden = false;
      placeholder.hidden = true;
    };
    if (existingRef.kind === "url") showExisting(existingRef.value);
    else downloadUrlForPath(existingRef.value).then(showExisting);
  }

  const node = el("section", { class: "tm-event-image", "aria-label": label }, [
    frame,
    el("div", { class: "tm-event-image-meta" }, [
      el("label", { class: "tm-field-label", for: fileId, text: label }),
      file,
      progress,
      hint,
      error,
    ]),
  ]);

  return { node, kind, getFile: () => pendingFile, setProgress, resetProgress, setError };
}

/**
 * Build the create/edit city form as a detached DOM subtree. `mode` is "create" (city=null) or "edit"
 * (city = the AdminCityResponse). On a valid submit it POSTs/PATCHes, uploads any picked icon/image
 * against the (now-existing) id, then calls `onDone`; a "Cancel" button calls `onCancel`.
 */
function buildCityForm({ mode, city = null, onDone, onCancel }) {
  const fields = new Map();
  const fieldNodes = FORM_FIELDS.map((f) => buildField(f, fields));
  const nameInput = fields.get("name").input;

  // Group the paired geo fields two-up; everything else full width. Order follows FORM_FIELDS.
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

  const model = city ? toCityFormModel(city) : {};
  const iconControl = buildImageControl({
    kind: "icon",
    idPrefix: "city-icon-image",
    label: "Icon image",
    existingPath: model.iconImagePath || "",
    placeholderGlyph: (model.iconEmoji || "").trim() || "📍",
  });
  const imageControl = buildImageControl({
    kind: "image",
    idPrefix: "city-image",
    label: "Empty-state image",
    existingPath: model.imagePath || "",
    placeholderGlyph: "🏙️",
  });

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
    const { errors } = validateCityDraft(readDraft(), { requireForCreate: mode === "create" });
    for (const f of FORM_FIELDS) {
      const showing = !fields.get(f.key).error.hidden;
      if (f.key === changedKey || showing) setFieldError(f.key, errors[f.key] || "");
    }
    return errors;
  };
  const paintAllErrors = () => {
    const { errors } = validateCityDraft(readDraft(), { requireForCreate: mode === "create" });
    for (const f of FORM_FIELDS) setFieldError(f.key, errors[f.key] || "");
    return errors;
  };

  for (const f of FORM_FIELDS) {
    fields.get(f.key).input.addEventListener("input", () => revalidate(f.key));
  }

  // Prefill from the existing city (edit).
  if (city) {
    for (const f of FORM_FIELDS) {
      const v = model[f.key];
      if (v != null && v !== "") fields.get(f.key).input.value = v;
    }
  }

  const save = el("button", { class: "tm-btn tm-btn-primary", id: "city-save", type: "submit" }, mode === "create" ? "Create city" : "Save changes");
  const cancel = el("button", { class: "tm-btn", id: "city-cancel", type: "button", onClick: () => onCancel?.() }, "Cancel");
  let busy = false;

  const setBusy = (on, labelWhileBusy) => {
    busy = on;
    save.disabled = on;
    cancel.disabled = on;
    save.textContent = on ? labelWhileBusy : mode === "create" ? "Create city" : "Save changes";
  };

  const form = el("form", { class: "tm-event-form", id: "city-form", novalidate: true }, [
    ...layout,
    iconControl.node,
    imageControl.node,
    el("div", { class: "tm-form-actions" }, [cancel, save]),
  ]);

  const node = el("div", { class: "tm-event-form-page" }, [form]);

  /** Upload a picked file for one control against the (existing) city id → its stored object path. */
  const uploadFor = (control, cityId) =>
    control.kind === "icon"
      ? uploadCityIconImage(cityId, control.getFile(), control.setProgress)
      : uploadCityImage(cityId, control.getFile(), control.setProgress);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy) return;
    const errors = paintAllErrors();
    if (Object.keys(errors).length) {
      toast("Please fix the highlighted fields.", { type: "error" });
      return;
    }

    setBusy(true, mode === "create" ? "Creating…" : "Saving…");
    iconControl.setError("");
    imageControl.setError("");
    try {
      const body = buildCityPayload(readDraft());
      const controls = [iconControl, imageControl].filter((c) => c.getFile());

      if (mode === "create") {
        const created = await cityApi("/api/v1/admin/cities", { method: "POST", body });
        if (controls.length && created?.id != null) {
          // The id exists now — upload each picked image to its path, then persist the paths in ONE
          // follow-up PATCH. If ONLY the image step fails the city is already created, so navigate
          // back (a re-submit would create a DUPLICATE); the admin adds the image via Edit.
          try {
            const patch = {};
            for (const c of controls) {
              const { path } = await uploadFor(c, created.id);
              patch[c.kind === "icon" ? "iconImagePath" : "imagePath"] = path;
            }
            await cityApi(`/api/v1/admin/cities/${created.id}`, { method: "PATCH", body: patch });
          } catch (imgErr) {
            toast(`City created, but an image didn't upload (${imgErr?.message || "upload failed"}). Open it to add one.`, { type: "error" });
            onDone?.();
            return;
          }
        }
      } else {
        for (const c of controls) {
          const { path } = await uploadFor(c, city.id);
          body[c.kind === "icon" ? "iconImagePath" : "imagePath"] = path;
        }
        await cityApi(`/api/v1/admin/cities/${city.id}`, { method: "PATCH", body });
      }

      toast(mode === "create" ? "City created." : "City saved.", { type: "success" });
      onDone?.();
    } catch (err) {
      iconControl.resetProgress();
      imageControl.resetProgress();
      if (err instanceof ApiError && err.fieldErrors?.length) {
        const leftover = [];
        for (const fe of err.fieldErrors) {
          if (fields.has(fe.field)) setFieldError(fe.field, fe.message);
          else leftover.push(fe.message);
        }
        toast(leftover.length ? leftover.join(" ") : "Please fix the highlighted fields.", { type: "error" });
      } else if (err instanceof ApiError && err.status === 409) {
        toast(err.message, { type: "error" });
        loadCities();
      } else {
        toast(err instanceof ApiError ? err.message : "Couldn't save the city.", { type: "error" });
      }
      setBusy(false);
    }
  });

  return { node, focusName: () => nameInput.focus() };
}

/** Module-level guard so a slow edit-by-id fetch that resolves AFTER navigation can't paint a stale form. */
let formToken = 0;

/**
 * Router entry for the full-page create/edit form. `mode` is "create" (id null) or "edit". For an edit
 * we render from the row already in memory when we have it; otherwise we fetch it by id, so the route
 * also works on a direct deep-link / page refresh.
 */
export async function enterAdminCityForm(mode, id = null) {
  const view = document.getElementById("admin-city-form-view");
  if (!view) return;
  const mine = ++formToken;

  if (mode === "create") {
    mountCityForm(view, "create", null);
    return;
  }

  const cached = state.cities.find((c) => String(c.id) === String(id));
  if (cached) {
    mountCityForm(view, "edit", cached);
    return;
  }

  renderFormLoading(view);
  try {
    const city = await cityApi(`/api/v1/admin/cities/${encodeURIComponent(id)}`);
    if (mine !== formToken) return;
    if (!city) {
      renderFormError(view, "That city isn't available anymore.", null);
      return;
    }
    mountCityForm(view, "edit", city);
  } catch (err) {
    if (mine !== formToken) return;
    const gone = err instanceof ApiError && err.status === 404;
    renderFormError(
      view,
      gone ? "That city isn't available anymore." : "Couldn't load this city. Please try again.",
      gone ? null : () => enterAdminCityForm("edit", id),
    );
  }
}

/** Mount the page chrome (a "← Cities" back-link header) + the form, then focus the name field. */
function mountCityForm(view, mode, city) {
  const back = () => {
    window.location.hash = ADMIN_CITIES_ROUTE;
  };
  const { node, focusName } = buildCityForm({ mode, city, onDone: back, onCancel: back });
  const title = mode === "create" ? "New city" : `Edit · ${city.name || "city"}`;
  clear(view).append(formHeader(title), node);
  focusName();
}

/** The "← Cities" back-link header. */
function formHeader(title) {
  return el("div", { class: "tm-admin-head tm-event-form-head" }, [
    el("h2", {}, [doodle("pin", { class: "tm-doodle-header" }), title]),
    el("a", { class: "tm-btn tm-btn-sm", id: "admin-city-form-back", href: ADMIN_CITIES_ROUTE }, "← Cities"),
  ]);
}

/** The transient "loading the city to edit" state while an edit-by-id fetch is in flight. */
function renderFormLoading(view) {
  clear(view).append(formHeader("Edit city"), el("p", { class: "tm-muted", text: "Loading city…" }));
}

/** The edit-by-id failure state: a message + either Retry (transient) or a back-to-list link (gone). */
function renderFormError(view, message, onRetry) {
  clear(view).append(
    formHeader("Edit city"),
    el("div", { class: "tm-error tm-empty" }, [
      doodle("pin", { class: "tm-doodle-empty" }),
      el("p", { text: message }),
      onRetry
        ? el("button", { class: "tm-btn", type: "button", onClick: onRetry }, "Retry")
        : el("a", { class: "tm-btn", href: ADMIN_CITIES_ROUTE }, "Back to cities"),
    ]),
  );
}

// ---- mount --------------------------------------------------------------------------------

function buildShell(view) {
  const search = el("input", {
    id: "admin-cities-search",
    type: "search",
    class: "tm-input",
    placeholder: "Search name, country…",
    "aria-label": "Search cities",
    onInput: (e) => {
      state.search = e.target.value;
      state.page = 0;
      renderTable();
    },
  });
  const statusSelect = el(
    "select",
    { id: "admin-cities-status-filter", class: "tm-input", "aria-label": "Filter by status", onChange: (e) => { state.statusFilter = e.target.value; state.page = 0; render(); } },
    STATUS_FILTERS.map(([value, label]) => el("option", { value, text: label })),
  );
  const sizeSelect = el(
    "select",
    { class: "tm-input", "aria-label": "Rows per page", onChange: (e) => { state.pageSize = Number(e.target.value); state.page = 0; renderTable(); } },
    PAGE_SIZES.map((n) => el("option", { value: String(n), text: `${n} / page`, selected: n === state.pageSize })),
  );

  const stats = el("div", { class: "tm-stats", id: "admin-cities-stats" });
  const table = el("div", { class: "tm-table-wrap", id: "admin-cities-table" });
  const pager = el("div", { class: "tm-pager", id: "admin-cities-pager" });

  shell = { stats, table, pager };

  clear(view).append(
    el("div", { class: "tm-admin-head" }, [
      el("h2", {}, [doodle("pin", { class: "tm-doodle-header" }), "Cities"]),
      el("div", { class: "tm-admin-head-actions" }, [
        el("button", { class: "tm-btn tm-btn-primary tm-btn-sm", id: "admin-cities-new", type: "button", onClick: () => { window.location.hash = adminCityNewHash(); } }, "New city"),
        el("button", { class: "tm-btn tm-btn-sm", id: "admin-cities-refresh", type: "button", onClick: loadCities }, "Refresh"),
      ]),
    ]),
    stats,
    el("div", { class: "tm-toolbar" }, [search, statusSelect, sizeSelect]),
    table,
    pager,
  );
}

/** Called by the router when the #/admin/cities view becomes active. Builds the shell once, then loads. */
export function enterAdminCities() {
  const view = document.getElementById("admin-cities-view");
  if (!view) return;
  if (!shell) buildShell(view);
  loadCities();
}

// Bridge for the router (which imports this) + ad-hoc use.
if (typeof window !== "undefined") {
  window.tmAdminCities = { enterAdminCities, enterAdminCityForm, loadCities };
}
