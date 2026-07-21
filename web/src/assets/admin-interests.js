// Admin interests console (TM-779, epic Interests) — ADMIN-only. The admin surface for the interest
// catalogue: lists the FULL catalogue (active + retired), creates, edits, retires and restores interests,
// toggles `highlighted` + sets `sortWeight`, and reads/writes the min/max-selection config. Mounts into
// #admin-interests-view; the router (TM-109) gates the ADMIN-only #/admin/interests route, exactly as it
// gates #/admin/venues.
//
// This file is the DOM/mount half; the pure, browser-free logic (validation mirroring the API DTOs, the
// payload builder, the display derivations) lives in admin-interests-core.js so `node --test` can assert
// it without a browser or the Firebase SDK — the same split admin-venues.js ↔ admin-venues-core.js uses.
// The create/edit form is its OWN full-page admin route: #/admin/interests/new and
// #/admin/interests/{id}/edit render into #admin-interest-form-view, so the form scrolls with the page.
//
// Backend contract consumed (TM-774, ADMIN-gated; 403 non-admin / 401 anon / 404 missing id — no leak):
//   GET    /api/v1/admin/interests                 — paged catalogue (PageResponse<AdminInterestResponse>),
//                                                    INCLUDING retired; ?q= label substring, ?category=
//                                                    exact, ?active= tri-state
//   GET    /api/v1/admin/interests/{id}            — one interest (retired included)
//   POST   /api/v1/admin/interests                 — create (201)
//   PATCH  /api/v1/admin/interests/{id}            — partial edit (null = leave unchanged)
//   POST   /api/v1/admin/interests/{id}/retire     — soft-delete + active=false (idempotent)
//   POST   /api/v1/admin/interests/{id}/restore    — un-retire (idempotent)
//   GET    /api/v1/admin/interests/config          — { minSelections, maxSelections }
//   PUT    /api/v1/admin/interests/config          — set both bounds (full replacement; min<=max enforced)
// A duplicate active label → 409; a stale optimistic-lock write → 409 (both surfaced as a form banner + toast).

import { apiFetch, ApiError } from "./api.js";
import { walkPages } from "./admin-page-walk-core.js";
import { clear, confirmDialog, el, stackableTable, toast } from "./ui.js";
import { doodle } from "./doodles.js";
import {
  LABEL_MAX,
  EMOJI_MAX,
  CATEGORIES,
  SORT_WEIGHT_MIN,
  SORT_WEIGHT_MAX,
  validateInterestDraft,
  buildInterestPayload,
  toInterestFormModel,
  validateConfigDraft,
  indexSelectionStats,
  selectedByLabel,
  selectorCountOf,
} from "./admin-interests-core.js";
import { ADMIN_INTERESTS_ROUTE, adminInterestNewHash, adminInterestEditHash } from "./admin-interests-route.js";
import { clampPage } from "./admin-paging-core.js";
import { statsCards } from "./admin-stats-core.js";
import { interestEmoji } from "./interests-core.js"; // shared emoji normaliser (TM-805)

const FETCH_SIZE = 100; // page size PER REQUEST of the full-catalogue walk — matches the server max page size (TM-115)
const MAX_FETCH_PAGES = 50; // runaway guard on the walk (× FETCH_SIZE = 5,000 interests)
const PAGE_SIZES = [10, 25, 50];

// Client-side status buckets so the admin can filter the full catalogue by whether an interest is offered
// to users (active) or retired.
const STATUS_FILTERS = [
  ["ALL", "All interests"],
  ["ACTIVE", "Active"],
  ["RETIRED", "Retired"],
];

// The category filter options — "ALL" plus each known bucket (mirrors CATEGORIES / TM-774).
const CATEGORY_FILTERS = [["ALL", "All categories"], ...CATEGORIES.map((c) => [c, c])];

// The category <select> choices for the form (a leading "choose" placeholder, then each known bucket).
const CATEGORY_CHOICES = [["", "Choose a category…"], ...CATEGORIES.map((c) => [c, c])];

const COLUMNS = [
  { key: "label", label: "Interest", sortable: true },
  { key: "category", label: "Category", sortable: true },
  { key: "sortWeight", label: "Weight", sortable: true },
  { key: "highlighted", label: "Featured", sortable: true },
  { key: "active", label: "Status", sortable: true },
  // TM-832: per-interest selection analytics — "<count> (<pct>%)", joined to the catalogue by label.
  // Sortable-by-popularity (the selector count is the sort key; see sortInterests).
  { key: "selectorCount", label: "Selected by", sortable: true },
];

const state = {
  interests: [],
  totalInterests: 0,
  fetchComplete: true,
  fetchPartial: false, // a page failed mid-walk — `interests` is a prefix of the true catalogue (TM-727)
  fetchTruncated: false, // the runaway guard tripped before the last page — `interests` is a prefix (TM-727)
  loading: false,
  error: null,
  search: "",
  statusFilter: "ALL",
  categoryFilter: "ALL",
  // Default sort mirrors the backend default (sort_weight DESC, then label): highlights/popular first.
  sortKey: "sortWeight",
  sortDir: "desc",
  page: 0,
  pageSize: 25,
  config: null, // { minSelections, maxSelections } once loaded; null until then / on load failure
  // TM-832: per-label selection stats, indexed label → { selectorCount, percent }. Empty Map until loaded
  // OR on a failed stats fetch — a missing label then renders as "0 (0%)", so the table works regardless.
  selectionStats: new Map(),
};

let shell = null; // { config, stats, table, pager } persistent containers

// ---- data ---------------------------------------------------------------------------------

/**
 * One authenticated call to the admin interests API. Goes through apiFetch (Bearer + 401 refresh/retry/
 * redirect, TM-108). A non-2xx is parsed as RFC-7807 and thrown as the shared {@link ApiError}, carrying
 * `.status` and (for a 400) the per-field `errors` so the form can paint them. 204 → null.
 */
async function interestApi(path, { method = "GET", body } = {}) {
  const res = await apiFetch(path, {
    method,
    headers: body
      ? { "Content-Type": "application/json", Accept: "application/json" }
      : { Accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 403) throw new ApiError(403, "You need an admin role to manage interests.");
  if (!res.ok) {
    const problem = await res.json().catch(() => ({}));
    const fieldErrors = Array.isArray(problem.errors) ? problem.errors : [];
    throw new ApiError(res.status, problem.detail || problem.title || `Request failed (${res.status})`, fieldErrors);
  }
  return res.status === 204 ? null : res.json();
}

/**
 * Load the WHOLE interest catalogue by walking the paged endpoint (TM-774) — small scale, so we hold them
 * in memory and search/filter/sort/paginate in the browser, mirroring admin-venues.js. A page failing
 * mid-walk keeps what loaded and flags the fetch partial (TM-727); only a failure with nothing loaded
 * errors the table. Hitting the runaway guard flags the fetch truncated. The endpoint returns retired rows
 * too (the whole point of the console).
 */
export async function loadInterests() {
  // TM-751 re-entry guard: a second Refresh while a load is running would start a whole second concurrent
  // page walk, doubling request volume and racing two result sets into state.interests. Bail if one's in
  // flight — mirrors the guarded loadVenues() in admin-venues.js.
  if (state.loading) return;
  state.loading = true;
  state.error = null;
  render();
  // TM-832: fetch the per-interest selection stats ALONGSIDE the catalogue walk (parallel — the stats are a
  // single aggregate call, independent of the paged walk). Non-fatal: a failed stats fetch leaves the index
  // empty so every row falls back to "0 (0%)"; the catalogue still loads.
  const [result] = await Promise.all([
    walkPages(
      (page) => interestApi(`/api/v1/admin/interests?page=${page}&size=${FETCH_SIZE}&sort=sortWeight,desc`),
      { pageSize: FETCH_SIZE, maxPages: MAX_FETCH_PAGES },
    ),
    loadSelectionStats(),
  ]);
  if (result.error) {
    state.error = result.error instanceof ApiError ? result.error.message : "Could not load interests.";
    state.interests = [];
    state.totalInterests = 0;
    state.fetchComplete = true;
    state.fetchPartial = false;
    state.fetchTruncated = false;
  } else {
    state.error = null;
    state.interests = result.items; // kept even when a later page failed (partial)
    state.totalInterests = result.total;
    state.fetchComplete = result.complete;
    state.fetchPartial = result.partial;
    state.fetchTruncated = result.truncated;
  }
  state.loading = false;
  state.page = 0;
  render();
}

/**
 * Load the min/max-selection config (TM-774). Non-fatal: on error we leave `state.config` null and the
 * config panel shows a muted "bounds unavailable" note — the list must still work without it.
 */
async function loadConfig() {
  try {
    const config = await interestApi("/api/v1/admin/interests/config");
    state.config = config && typeof config === "object" ? config : null;
  } catch {
    state.config = null;
  }
  if (shell) renderConfigPanel();
}

/**
 * Load the per-interest selection stats (TM-832) — the "Selected by" column data — and index them by label
 * (indexSelectionStats). Non-fatal: on any error we leave an EMPTY index so every row renders "0 (0%)"; the
 * catalogue must still work without stats. Called from loadInterests (parallel with the catalogue walk).
 */
async function loadSelectionStats() {
  try {
    const stats = await interestApi("/api/v1/admin/interests/stats");
    state.selectionStats = indexSelectionStats(stats);
  } catch {
    state.selectionStats = new Map();
  }
}

// ---- derived view -------------------------------------------------------------------------

function filteredInterests() {
  const q = state.search.trim().toLowerCase();
  return state.interests.filter((i) => {
    if (state.statusFilter === "ACTIVE" && !i.active) return false;
    if (state.statusFilter === "RETIRED" && !i.retired) return false;
    if (state.categoryFilter !== "ALL" && i.category !== state.categoryFilter) return false;
    if (q) {
      const haystack = [i.label, i.category].filter(Boolean).join(" ").toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

function sortInterests(list) {
  const { sortKey, sortDir } = state;
  const dir = sortDir === "desc" ? -1 : 1;
  const keyOf = (i) => {
    if (sortKey === "active") return i.active ? 1 : 0;
    if (sortKey === "highlighted") return i.highlighted ? 1 : 0;
    if (sortKey === "sortWeight") return Number(i.sortWeight) || 0;
    // TM-832: sort-by-popularity — the numeric selector count (0 when unselected), joined by label.
    if (sortKey === "selectorCount") return selectorCountOf(i, state.selectionStats);
    return String(i[sortKey] ?? "").toLowerCase();
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

/** The status pill for a row — Active (ok) or Retired (off). Driven off `active`; `retired` is its mirror. */
function statusPill(interest) {
  return interest.active
    ? el("span", { class: "tm-badge tm-badge-ok", text: "Active" })
    : el("span", { class: "tm-badge tm-badge-off", text: "Retired" });
}

/** The "Featured" cell — a ✓ pill when highlighted, else an em-dash. */
function featuredCell(interest) {
  return interest.highlighted
    ? el("span", { class: "tm-badge tm-badge-ok", text: "★ Featured" })
    : el("span", { class: "tm-muted", text: "—" });
}

function renderStats() {
  const total = Math.max(state.totalInterests, state.interests.length);
  const active = state.interests.filter((i) => i.active).length;
  const retired = state.interests.filter((i) => i.retired).length;
  const featured = state.interests.filter((i) => i.highlighted).length;
  // TM-756 (4th instance, found in grounding — the ticket body lists only users/events/venues):
  // loadInterests() renders BEFORE the page walk resolves, so these counts derive from EMPTY state —
  // the mask (admin-stats-core.js) shows "—" per card while loading instead of a false "Total 0",
  // mirroring the table's state.loading gate; loaded cards pass through untouched.
  const cards = statsCards([
    ["Total", total],
    ["Active", active],
    ["Retired", retired],
    ["Featured", featured],
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

/**
 * The inline "Selection limits" config panel (TM-779) — the min/max number of interests a user must pick.
 * Visually secondary (a muted framed sub-panel) so it doesn't compete with the table. On Save it validates
 * with validateConfigDraft (mirrors InterestConfigRequest) then PUTs BOTH fields (a full replacement).
 */
function renderConfigPanel() {
  const panel = clear(shell.config);
  panel.append(el("h3", { class: "tm-config-title", text: "Selection limits" }));

  if (state.config === null) {
    panel.append(
      el("p", { class: "tm-muted", text: "Selection limits are unavailable right now." }),
      el("button", { class: "tm-btn tm-btn-sm", type: "button", onClick: loadConfig }, "Retry"),
    );
    return;
  }

  const minInput = el("input", {
    id: "admin-interests-config-min",
    class: "tm-input",
    type: "number",
    min: "1",
    inputmode: "numeric",
    value: state.config.minSelections == null ? "" : String(state.config.minSelections),
    "aria-label": "Minimum interests a user must select",
    "aria-describedby": "admin-interests-config-error",
  });
  const maxInput = el("input", {
    id: "admin-interests-config-max",
    class: "tm-input",
    type: "number",
    min: "1",
    inputmode: "numeric",
    value: state.config.maxSelections == null ? "" : String(state.config.maxSelections),
    "aria-label": "Maximum interests a user may select",
    "aria-describedby": "admin-interests-config-error",
  });
  const error = el("p", { id: "admin-interests-config-error", class: "tm-field-error", role: "alert", hidden: true });
  const save = el("button", { class: "tm-btn tm-btn-primary tm-btn-sm", id: "admin-interests-config-save", type: "button" }, "Save limits");

  const setError = (msg) => {
    error.textContent = msg || "";
    error.hidden = !msg;
  };

  save.addEventListener("click", async () => {
    setError("");
    const draft = { minSelections: minInput.value, maxSelections: maxInput.value };
    const { errors, canSave } = validateConfigDraft(draft);
    if (!canSave) {
      setError(errors.minSelections || errors.maxSelections || "Please check the limits.");
      return;
    }
    save.disabled = true;
    const prevLabel = save.textContent;
    save.textContent = "Saving…";
    try {
      const updated = await interestApi("/api/v1/admin/interests/config", {
        method: "PUT",
        body: { minSelections: Number(minInput.value), maxSelections: Number(maxInput.value) },
      });
      if (updated && typeof updated === "object") state.config = updated;
      toast("Selection limits saved.", { type: "success" });
    } catch (err) {
      if (err instanceof ApiError && err.fieldErrors?.length) {
        setError(err.fieldErrors.map((fe) => fe.message).join(" "));
      } else {
        setError(err instanceof ApiError ? err.message : "Couldn't save the limits.");
      }
    } finally {
      save.disabled = false;
      save.textContent = prevLabel;
    }
  });

  panel.append(
    el("p", { class: "tm-muted tm-field-hint", text: "How many interests a user must pick during onboarding." }),
    el("div", { class: "tm-field-row" }, [
      el("div", { class: "tm-form-field" }, [
        el("label", { class: "tm-field-label", for: "admin-interests-config-min", text: "Minimum" }),
        minInput,
      ]),
      el("div", { class: "tm-form-field" }, [
        el("label", { class: "tm-field-label", for: "admin-interests-config-max", text: "Maximum" }),
        maxInput,
      ]),
    ]),
    error,
    save,
  );
}

function renderTable() {
  clear(shell.table);
  if (state.loading) {
    shell.table.append(el("p", { class: "tm-muted", text: "Loading interests…" }));
    return;
  }
  if (state.error) {
    shell.table.append(
      el("div", { class: "tm-error" }, [
        el("p", { text: state.error }),
        el("button", { class: "tm-btn", type: "button", onClick: loadInterests }, "Retry"),
      ]),
    );
    return;
  }

  const rows = sortInterests(filteredInterests());
  if (!rows.length) {
    const notice = fetchIncompleteNotice();
    if (notice) shell.table.append(notice);
    const filtered = state.interests.length > 0;
    const message = filtered ? "No interests match your filters." : "No interests yet. Add your first one.";
    shell.table.append(
      el("div", { class: "tm-empty", id: "admin-interests-empty" }, [
        doodle("celebrate", { class: "tm-doodle-empty" }),
        el("p", { class: "tm-muted", text: message }),
      ]),
    );
    renderPager(0);
    return;
  }

  // TM-721: clamp a stale page index BEFORE slicing (see admin-paging-core.js). Retiring/deleting the last
  // interest on a page shrinks `rows` below the page start; without this we'd paint a blank table while the
  // pager (which clamps too late) reads "Page 1 of 1".
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
    pageRows.map((interest) =>
      el("tr", { dataset: { interestId: String(interest.id) } }, [
        // TM-935: data-label on every body td drives the CSS stacked-card layout at ≤30rem (the label
        // is painted via td::before once the header row is hidden). The trailing Actions cell has none.
        el("td", { "data-label": "Interest" }, [
          // Leading catalogue emoji (TM-805) next to the label, only when the row carries one.
          interestEmoji(interest)
            ? el("span", { class: "tm-admin-interest-emoji", "aria-hidden": "true", text: interestEmoji(interest) })
            : null,
          el("span", { class: "tm-event-heading", text: interest.label || "—" }),
        ]),
        el("td", { "data-label": "Category", class: "tm-muted", text: interest.category || "—" }),
        el("td", { "data-label": "Weight", class: "tm-muted", text: interest.sortWeight == null ? "—" : String(interest.sortWeight) }),
        el("td", { "data-label": "Featured" }, [featuredCell(interest)]),
        el("td", { "data-label": "Status" }, [statusPill(interest)]),
        // TM-832: "Selected by" — "<count> (<pct>%)" joined to the stats index by label ("0 (0%)" if none).
        el("td", { "data-label": "Selected by", class: "tm-muted", text: selectedByLabel(interest, state.selectionStats) }),
        el("td", { class: "tm-actions" }, rowActions(interest)),
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
 * mid-walk (partial) or the runaway guard tripped before the last page (truncated). Without this the
 * table silently shows a prefix as if it were complete. Returns null on a full, clean load.
 */
function fetchIncompleteNotice() {
  if (state.fetchTruncated) {
    return el("div", { class: "tm-notice", "data-testid": "admin-interests-truncated" }, [
      el("p", {
        text:
          `Showing the first ${state.interests.length} interests — there are more than this console loads at once. ` +
          "Use search to narrow down.",
      }),
    ]);
  }
  if (state.fetchPartial) {
    return el("div", { class: "tm-notice", "data-testid": "admin-interests-partial" }, [
      el("p", { text: "Some interests couldn’t be loaded, so this list may be incomplete." }),
      el("button", { class: "tm-btn tm-btn-sm", type: "button", onClick: loadInterests }, "Retry"),
    ]);
  }
  return null;
}

function rowActions(interest) {
  const edit = el(
    "button",
    {
      class: "tm-btn tm-btn-sm",
      type: "button",
      "aria-label": `Edit ${interest.label}`,
      onClick: () => { window.location.hash = adminInterestEditHash(interest.id); },
    },
    "Edit",
  );
  if (interest.active) {
    return [
      edit,
      el(
        "button",
        { class: "tm-btn tm-btn-sm tm-btn-danger", type: "button", "aria-label": `Retire ${interest.label}`, onClick: () => retireInterest(interest) },
        "Retire",
      ),
    ];
  }
  return [
    edit,
    el(
      "button",
      { class: "tm-btn tm-btn-sm", type: "button", "aria-label": `Restore ${interest.label}`, onClick: () => restoreInterest(interest) },
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

/** Retire an interest behind a confirm — it's removed from the user picker but the record (and any user
 *  snapshot that copied it) survives, and you can restore it any time. */
async function retireInterest(interest) {
  const ok = await confirmDialog({
    title: "Retire this interest?",
    message: `“${interest.label}” will no longer be offered to users. Existing selections keep working — this isn't a delete, and you can restore it any time.`,
    confirmLabel: "Retire",
    cancelLabel: "Keep active",
    danger: true,
  });
  if (!ok) return;
  await mutateRetire(interest, "retire", "Interest retired.");
}

/** Restore a retired interest — offer it to users again. */
async function restoreInterest(interest) {
  await mutateRetire(interest, "restore", "Interest restored.");
}

async function mutateRetire(interest, action, successMessage) {
  try {
    const updated = await interestApi(`/api/v1/admin/interests/${interest.id}/${action}`, { method: "POST" });
    const idx = state.interests.findIndex((i) => i.id === interest.id);
    if (idx >= 0 && updated) state.interests[idx] = updated;
    render();
    toast(successMessage, { type: "success" });
  } catch (err) {
    toast(err instanceof ApiError ? err.message : "Couldn't update the interest.", { type: "error" });
  }
}

// ---- create / edit form (full page) -------------------------------------------------------

// The form field spec drives the layout, the read-back, and the error map from one declarative list —
// the admin-venues.js pattern. `key` matches BOTH the input id suffix and the API field name (so a server
// RFC-7807 `errors[].field` maps straight onto the right input).
const FORM_FIELDS = [
  { key: "label", id: "interest-label", label: "Label", type: "text", maxLength: LABEL_MAX, required: true, hint: 'Shown in the user picker, e.g. "Coffee & cafés".' },
  { key: "emoji", id: "interest-emoji", label: "Emoji (optional)", type: "text", maxLength: EMOJI_MAX, hint: 'A small glyph shown beside the label, e.g. "☕". Leave blank for none.' },
  { key: "category", id: "interest-category", label: "Category", type: "select", required: true, options: CATEGORY_CHOICES, hint: "One of the fixed catalogue buckets." },
  { key: "sortWeight", id: "interest-weight", label: "Sort weight (optional)", type: "number", min: SORT_WEIGHT_MIN, max: SORT_WEIGHT_MAX, hint: "Higher floats to the top. Blank = default (100 if featured, else 0)." },
  { key: "highlighted", id: "interest-featured", label: "Featured", type: "checkbox", hint: "Featured interests are promoted in the picker." },
];

/** Build one field control (label + input/select/checkbox + hint + role=alert error), profile.js style. */
function buildField(field, fields) {
  const errorId = `${field.id}-error`;
  const hintId = field.hint ? `${field.id}-hint` : null;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || null;

  let input;
  if (field.type === "select") {
    input = el(
      "select",
      { id: field.id, class: "tm-input", "aria-describedby": describedBy },
      (field.options || []).map(([value, label]) => el("option", { value, text: label })),
    );
  } else if (field.type === "checkbox") {
    input = el("input", { id: field.id, type: "checkbox", class: "tm-checkbox", "aria-describedby": describedBy });
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
  fields.set(field.key, { input, error, type: field.type });

  // A checkbox reads more naturally as [box] Label than the stacked label-above-input the others use.
  if (field.type === "checkbox") {
    return el("div", { class: "tm-form-field tm-form-field-check", dataset: { field: field.key } }, [
      el("label", { class: "tm-field-label tm-check-label", for: field.id }, [input, el("span", { text: field.label })]),
      hint,
      error,
    ]);
  }

  return el("div", { class: "tm-form-field", dataset: { field: field.key } }, [
    el("label", { class: "tm-field-label", for: field.id, text: field.label }),
    input,
    hint,
    error,
  ]);
}

/** Read a single field's value — its `.checked` for a checkbox, `.value` otherwise. */
function readFieldValue(entry) {
  return entry.type === "checkbox" ? entry.input.checked : entry.input.value;
}

/**
 * Build the create/edit interest form as a detached DOM subtree. `mode` is "create" (interest=null) or
 * "edit" (interest = the AdminInterestResponse). On a valid submit it POSTs/PATCHes then calls `onDone`;
 * a "Cancel" button calls `onCancel`. A 409 (duplicate label / stale write) surfaces as a form-level
 * banner + toast (and re-loads on a stale write so the admin sees current state).
 */
function buildInterestForm({ mode, interest = null, onDone, onCancel }) {
  const fields = new Map();
  const fieldNodes = FORM_FIELDS.map((f) => buildField(f, fields));
  const labelInput = fields.get("label").input;

  const banner = el("p", { class: "tm-field-error", id: "interest-form-banner", role: "alert", hidden: true });

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
    for (const f of FORM_FIELDS) draft[f.key] = readFieldValue(fields.get(f.key));
    return draft;
  };

  const revalidate = (changedKey) => {
    const { errors } = validateInterestDraft(readDraft(), { requireForCreate: mode === "create" });
    for (const f of FORM_FIELDS) {
      const showing = !fields.get(f.key).error.hidden;
      if (f.key === changedKey || showing) setFieldError(f.key, errors[f.key] || "");
    }
    return errors;
  };
  const paintAllErrors = () => {
    const { errors } = validateInterestDraft(readDraft(), { requireForCreate: mode === "create" });
    for (const f of FORM_FIELDS) setFieldError(f.key, errors[f.key] || "");
    return errors;
  };

  for (const f of FORM_FIELDS) {
    const entry = fields.get(f.key);
    entry.input.addEventListener("input", () => revalidate(f.key));
    if (f.type === "select" || f.type === "checkbox") entry.input.addEventListener("change", () => revalidate(f.key));
  }

  // Prefill from the existing interest (edit).
  if (interest) {
    const model = toInterestFormModel(interest);
    for (const f of FORM_FIELDS) {
      const entry = fields.get(f.key);
      if (f.type === "checkbox") entry.input.checked = Boolean(model[f.key]);
      else if (model[f.key] != null && model[f.key] !== "") entry.input.value = model[f.key];
    }
  }

  const save = el("button", { class: "tm-btn tm-btn-primary", id: "interest-save", type: "submit" }, mode === "create" ? "Create interest" : "Save changes");
  const cancel = el("button", { class: "tm-btn", id: "interest-cancel", type: "button", onClick: () => onCancel?.() }, "Cancel");
  let busy = false;

  const setBusy = (on, labelWhileBusy) => {
    busy = on;
    save.disabled = on;
    cancel.disabled = on;
    save.textContent = on ? labelWhileBusy : mode === "create" ? "Create interest" : "Save changes";
  };

  const form = el("form", { class: "tm-event-form", id: "interest-form", novalidate: true }, [
    banner,
    ...fieldNodes,
    el("div", { class: "tm-form-actions" }, [cancel, save]),
  ]);

  const node = el("div", { class: "tm-event-form-page" }, [form]);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy) return;
    banner.hidden = true;
    const errors = paintAllErrors();
    if (Object.keys(errors).length) {
      toast("Please fix the highlighted fields.", { type: "error" });
      return;
    }

    setBusy(true, mode === "create" ? "Creating…" : "Saving…");
    try {
      const body = buildInterestPayload(readDraft());
      if (mode === "create") {
        await interestApi("/api/v1/admin/interests", { method: "POST", body });
      } else {
        await interestApi(`/api/v1/admin/interests/${interest.id}`, { method: "PATCH", body });
      }
      toast(mode === "create" ? "Interest created." : "Interest saved.", { type: "success" });
      onDone?.();
    } catch (err) {
      if (err instanceof ApiError && err.fieldErrors?.length) {
        // 400 with per-field errors — map each onto its input; anything unmapped goes to the banner.
        const leftover = [];
        for (const fe of err.fieldErrors) {
          if (fields.has(fe.field)) setFieldError(fe.field, fe.message);
          else leftover.push(fe.message);
        }
        if (leftover.length) {
          banner.textContent = leftover.join(" ");
          banner.hidden = false;
        }
        toast("Please fix the highlighted fields.", { type: "error" });
      } else if (err instanceof ApiError && err.status === 409) {
        // A duplicate active label or a stale optimistic-lock write — there's no field to attach it to,
        // so surface it as a form-level banner + toast. Reload the list so the admin sees current state.
        banner.textContent = err.message;
        banner.hidden = false;
        toast(err.message, { type: "error" });
        loadInterests();
      } else {
        toast(err instanceof ApiError ? err.message : "Couldn't save the interest.", { type: "error" });
      }
      setBusy(false);
    }
  });

  return { node, focusLabel: () => labelInput.focus() };
}

/** Module-level guard so a slow edit-by-id fetch that resolves AFTER navigation can't paint a stale form. */
let formToken = 0;

/**
 * Router entry for the full-page create/edit form. `mode` is "create" (id null) or "edit". For an edit we
 * render from the row already in memory when we have it; otherwise we fetch it by id, so the route also
 * works on a direct deep-link / page refresh.
 */
export async function enterAdminInterestForm(mode, id = null) {
  const view = document.getElementById("admin-interest-form-view");
  if (!view) return;
  const mine = ++formToken;

  if (mode === "create") {
    mountInterestForm(view, "create", null);
    return;
  }

  const cached = state.interests.find((i) => String(i.id) === String(id));
  if (cached) {
    mountInterestForm(view, "edit", cached);
    return;
  }

  renderFormLoading(view);
  try {
    const interest = await interestApi(`/api/v1/admin/interests/${encodeURIComponent(id)}`);
    if (mine !== formToken) return;
    if (!interest) {
      renderFormError(view, "That interest isn't available anymore.", null);
      return;
    }
    mountInterestForm(view, "edit", interest);
  } catch (err) {
    if (mine !== formToken) return;
    const gone = err instanceof ApiError && err.status === 404;
    renderFormError(
      view,
      gone ? "That interest isn't available anymore." : "Couldn't load this interest. Please try again.",
      gone ? null : () => enterAdminInterestForm("edit", id),
    );
  }
}

/** Mount the page chrome (a "← Interests" back-link header) + the form, then focus the label field. */
function mountInterestForm(view, mode, interest) {
  const back = () => { window.location.hash = ADMIN_INTERESTS_ROUTE; };
  const { node, focusLabel } = buildInterestForm({ mode, interest, onDone: back, onCancel: back });
  const title = mode === "create" ? "New interest" : `Edit · ${interest.label || "interest"}`;
  clear(view).append(formHeader(title), node);
  focusLabel();
}

/** The "← Interests" back-link header. */
function formHeader(title) {
  return el("div", { class: "tm-admin-head tm-event-form-head" }, [
    el("h2", {}, [doodle("celebrate", { class: "tm-doodle-header" }), title]),
    el("a", { class: "tm-btn tm-btn-sm", id: "admin-interest-form-back", href: ADMIN_INTERESTS_ROUTE }, "← Interests"),
  ]);
}

/** The transient "loading the interest to edit" state while an edit-by-id fetch is in flight. */
function renderFormLoading(view) {
  clear(view).append(formHeader("Edit interest"), el("p", { class: "tm-muted", text: "Loading interest…" }));
}

/** The edit-by-id failure state: a message + either Retry (transient) or a back-to-list link (gone). */
function renderFormError(view, message, onRetry) {
  clear(view).append(
    formHeader("Edit interest"),
    el("div", { class: "tm-error tm-empty" }, [
      doodle("celebrate", { class: "tm-doodle-empty" }),
      el("p", { text: message }),
      onRetry
        ? el("button", { class: "tm-btn", type: "button", onClick: onRetry }, "Retry")
        : el("a", { class: "tm-btn", href: ADMIN_INTERESTS_ROUTE }, "Back to interests"),
    ]),
  );
}

// ---- mount --------------------------------------------------------------------------------

function buildShell(view) {
  const search = el("input", {
    id: "admin-interests-search",
    type: "search",
    class: "tm-input",
    placeholder: "Search label, category…",
    "aria-label": "Search interests",
    onInput: (e) => { state.search = e.target.value; state.page = 0; renderTable(); },
  });
  const statusSelect = el(
    "select",
    { id: "admin-interests-status-filter", class: "tm-input", "aria-label": "Filter by status", onChange: (e) => { state.statusFilter = e.target.value; state.page = 0; render(); } },
    STATUS_FILTERS.map(([value, label]) => el("option", { value, text: label })),
  );
  const categorySelect = el(
    "select",
    { id: "admin-interests-category-filter", class: "tm-input", "aria-label": "Filter by category", onChange: (e) => { state.categoryFilter = e.target.value; state.page = 0; render(); } },
    CATEGORY_FILTERS.map(([value, label]) => el("option", { value, text: label })),
  );
  const sizeSelect = el(
    "select",
    { class: "tm-input", "aria-label": "Rows per page", onChange: (e) => { state.pageSize = Number(e.target.value); state.page = 0; renderTable(); } },
    PAGE_SIZES.map((n) => el("option", { value: String(n), text: `${n} / page`, selected: n === state.pageSize })),
  );

  const config = el("section", { class: "tm-config-panel", id: "admin-interests-config", "aria-label": "Selection limits" });
  const stats = el("div", { class: "tm-stats", id: "admin-interests-stats" });
  const table = el("div", { class: "tm-table-wrap", id: "admin-interests-table" });
  const pager = el("div", { class: "tm-pager", id: "admin-interests-pager" });

  shell = { config, stats, table, pager };

  clear(view).append(
    el("div", { class: "tm-admin-head" }, [
      el("h2", {}, [doodle("celebrate", { class: "tm-doodle-header" }), "Interests"]),
      el("div", { class: "tm-admin-head-actions" }, [
        el("button", { class: "tm-btn tm-btn-primary tm-btn-sm", id: "admin-interests-new", type: "button", onClick: () => { window.location.hash = adminInterestNewHash(); } }, "New interest"),
        el("button", { class: "tm-btn tm-btn-sm", id: "admin-interests-refresh", type: "button", onClick: loadInterests }, "Refresh"),
      ]),
    ]),
    stats,
    el("div", { class: "tm-toolbar" }, [search, statusSelect, categorySelect, sizeSelect]),
    config,
    table,
    pager,
  );
  renderConfigPanel();
}

/** Called by the router when the #/admin/interests view becomes active. Builds the shell once, then loads. */
export function enterAdminInterests() {
  const view = document.getElementById("admin-interests-view");
  if (!view) return;
  if (!shell) buildShell(view);
  loadInterests();
  loadConfig();
}

// Bridge for the router (which imports this) + ad-hoc use.
if (typeof window !== "undefined") {
  window.tmAdminInterests = { enterAdminInterests, enterAdminInterestForm, loadInterests };
}
