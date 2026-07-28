// Dedicated interests-management ROUTE — DOM renderer (TM-1095).
//
// The `#/profile/interests` full-screen view. It REPLACES the in-place picker overlay (the `.tm-modal`
// TM-970 opened from the profile hub's "Manage" / "＋ add" chip): the hub chip now routes HERE instead of
// opening a modal. The route adds a SEARCH field, COLLAPSIBLE category sections (with a synthetic
// "Popular" group first), a current-selection summary with add/remove, and a STICKY Save/Cancel bar —
// while keeping the SAME min/max bounds (GET /interests/config) and the SAME full-set-replace save
// (PATCH /me { interests:[...] }) the overlay used.
//
// Framework-free + XSS-safe: every node is built with the TM-133 `el()` kit (textContent only, no
// innerHTML seam), matching profile.js. All the decision logic (search filter, grouping, collapse,
// min/max gating, dirty/valid Save gate) lives in the pure, unit-tested interests-route-core.js — this
// module is a thin renderer that reads the view-model and repaints on each interaction.
//
// The router (router.js) owns the route gate + #interests-view visibility and calls enterInterests() on
// entry; this module reads /me + the catalogue/config, then paints. On Save it PATCHes /me and returns
// to the profile hub; Cancel discards and returns (prompting first if there are unsaved changes).

import { getMe, updateMe, getInterestCatalogue, getInterestConfig, ApiError } from "./api.js";
import { currentUser } from "./auth.js";
import { clear, el, toast, confirmDialog } from "./ui.js";
import { doodle } from "./doodles.js";
import { normaliseInterestConfig } from "./interests-core.js";
import {
  groupedSections,
  selectionSummary,
  saveBarModel,
  sameLabelSet,
  toggleSection,
  toggleInterest,
  savedInterestLabels,
  noResultsMessage,
} from "./interests-route-core.js";

const $ = (id) => (typeof document !== "undefined" ? document.getElementById(id) : null);

// Where the route returns to (profile hub) on Save / Cancel / back. The hub re-fetches /me on entry, so
// a just-saved change repaints there automatically.
const PROFILE_HASH = "#/profile";
const INTERESTS_HASH = "#/profile/interests";

// Per-uid localStorage key for the collapsed-sections state, mirroring the profile-core section-state
// convention (`tm.<feature>.<version>.<uid>`). Persisting per-uid means one user's folded sections don't
// leak to another on a shared device. A blank uid → a shared "anon" bucket (pre-auth paint never sticks).
function collapseStateKey(uid) {
  return `tm.interests.collapse.v1.${uid || "anon"}`;
}

// The in-memory route state. Rebuilt on each entry (enterInterests); the DOM nodes are cached in `dom`
// so a repaint mutates the existing tree rather than rebuilding the whole page (keeps the search box
// focused + the scroll position while typing).
const state = {
  loading: false,
  error: null,
  config: normaliseInterestConfig(null), // {min, max} — the real bounds once loaded, else defaults
  catalogue: null, // the public catalogue array, or null when the read failed
  original: [], // the labels the route opened with (saved interests) — the dirty baseline
  selected: [], // the pending selection (labels)
  query: "", // the live search box value
  collapsed: new Set(), // section names the user has folded
  saving: false,
};

// Cached DOM handles for in-place repaint (set by build()).
let dom = null;

/**
 * Read the persisted collapsed-sections set for the current user (best-effort — a blocked/absent
 * localStorage just yields an empty set, so every section defaults to expanded).
 */
function loadCollapseState(uid) {
  try {
    if (typeof localStorage === "undefined") return new Set();
    const raw = localStorage.getItem(collapseStateKey(uid));
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.filter((s) => typeof s === "string") : []);
  } catch {
    return new Set();
  }
}

/** Persist the collapsed-sections set (best-effort — a write failure is silently ignored). */
function saveCollapseState(uid, collapsed) {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(collapseStateKey(uid), JSON.stringify([...collapsed]));
  } catch {
    /* ignore — collapse state is a convenience, never load-bearing */
  }
}

/** The uid for the per-user collapse key (Firebase user, or "" pre-auth). */
function activeUid() {
  try {
    return currentUser()?.uid || "";
  } catch {
    return "";
  }
}

/**
 * Build the static page skeleton ONCE into #interests-view: the topbar (back to profile), the
 * current-selection summary, the search box, the sections container, and the sticky Save/Cancel bar.
 * Selection-dependent content (the summary chips, the section list, the Save enabled/error state) is
 * painted by the repaint helpers, so the search box + scroll position survive every toggle.
 */
function build(view) {
  const back = el(
    "a",
    { class: "tm-pf-gear tm-pf-back", href: PROFILE_HASH, "aria-label": "Back to profile" },
    "‹",
  );
  const title = el("h1", { class: "tm-pf-title", text: "Your interests" });

  // Current-selection summary (count line + the chosen chips, each removable).
  const summaryCount = el("p", { class: "tm-muted tm-pf-picker-count" });
  const summaryChips = el("div", { class: "tm-pf-chips tm-interests-route-selected" });

  // Search box — filters the catalogue as you type. A <label> ties the input to its purpose for a11y;
  // the input has an id so the label's `for` reaches it and the router/e2e can target it.
  const searchInput = el("input", {
    id: "interests-search",
    type: "search",
    class: "tm-input tm-interests-search",
    placeholder: "Search interests…",
    autocomplete: "off",
    "aria-label": "Search interests",
    onInput: (e) => {
      // Only the sections react to the query — the selection summary + sticky bar are search-independent.
      state.query = e.target.value;
      repaintSections();
    },
  });

  // The sections container (Popular + categories), rebuilt in place by repaintSections().
  const sections = el("div", { class: "tm-interests-sections" });

  // Sticky Save/Cancel bar. The error line is always in the tree (hidden when savable) so a toggle only
  // flips its text — no structural change. Cancel discards; Save PATCHes /me.
  const errorLine = el("p", { class: "tm-field-error tm-interests-route-error", role: "alert", hidden: true });
  const cancelBtn = el(
    "button",
    { type: "button", class: "tm-btn tm-interests-cancel", onClick: onCancel },
    "Cancel",
  );
  const saveBtn = el(
    "button",
    { type: "button", class: "tm-btn tm-btn-primary tm-interests-save", onClick: onSave },
    "Save",
  );
  const stickyBar = el("div", { class: "tm-interests-stickybar" }, [
    errorLine,
    el("div", { class: "tm-interests-stickybar-actions" }, [cancelBtn, saveBtn]),
  ]);

  const status = el("div", { class: "tm-interests-status" });

  clear(view).append(
    el("div", { class: "tm-pf tm-interests-route" }, [
      el("header", { class: "tm-pf-topbar" }, [back, title]),
      status,
      el("div", { class: "tm-interests-route-body" }, [
        el("section", { class: "tm-interests-summary", "aria-label": "Your selected interests" }, [
          summaryCount,
          summaryChips,
        ]),
        el("div", { class: "tm-interests-search-wrap" }, [searchInput]),
        sections,
      ]),
      stickyBar,
    ]),
  );

  dom = { summaryCount, summaryChips, searchInput, sections, errorLine, saveBtn, cancelBtn, status };
}

/** Repaint the current-selection summary (count line + removable chips). */
function repaintSummary() {
  if (!dom) return;
  const model = selectionSummary(state.selected, state.config);
  dom.summaryCount.textContent = model.countLine;
  clear(dom.summaryChips);
  if (model.empty) {
    dom.summaryChips.append(
      el("p", { class: "tm-muted tm-interests-none", text: `Pick at least ${state.config.min} to get started.` }),
    );
    return;
  }
  for (const chip of model.chips) {
    // Every summary chip is removable — the Save gate (not the chip) enforces the min, so a user can
    // transiently drop below it while re-picking. Removing simply toggles the label out of the selection.
    dom.summaryChips.append(
      el(
        "button",
        {
          type: "button",
          class: "tm-pf-chip tm-pf-chip-on tm-pf-chip-remove",
          "aria-label": `Remove ${chip.label}`,
          disabled: state.saving,
          onClick: () => toggleLabel(chip.label),
        },
        [el("span", { text: chip.label }), el("span", { class: "tm-pf-chip-x", "aria-hidden": "true", text: "×" })],
      ),
    );
  }
}

/** Repaint the sections list (Popular + categories) from the pure view-model, honouring the search + collapse state. */
function repaintSections() {
  if (!dom) return;
  clear(dom.sections);
  const catalogue = state.catalogue;
  if (!Array.isArray(catalogue) || catalogue.length === 0) {
    dom.sections.append(
      el("p", { class: "tm-muted tm-interests-unavailable", text: "The interests list isn't available right now. Please try again later." }),
    );
    return;
  }
  const { sections, matchCount, filtering } = groupedSections(catalogue, state.selected, {
    max: state.config.max,
    query: state.query,
    collapsed: state.collapsed,
  });
  // A search that matches nothing → an honest empty state naming the query (a blank query never lands
  // here; groupedSections returns every section for it).
  if (filtering && matchCount === 0) {
    dom.sections.append(el("p", { class: "tm-muted tm-interests-noresults", text: noResultsMessage(state.query) }));
    return;
  }
  for (const section of sections) {
    dom.sections.append(buildSection(section));
  }
}

/**
 * Build one collapsible section: a header button (toggles collapse; carries aria-expanded) + the chip
 * row. When collapsed the chip row is hidden (kept in the DOM so aria-controls resolves + expanding is
 * instant). A search force-expands every section (the pure model already returns collapsed:false while
 * filtering), so the fold state only bites when the list is unfiltered.
 */
function buildSection(section) {
  const bodyId = `interests-section-${slug(section.name)}`;
  const chevron = el("span", { class: "tm-interests-chevron", "aria-hidden": "true", text: section.collapsed ? "▸" : "▾" });
  const header = el(
    "button",
    {
      type: "button",
      class: section.popular ? "tm-interests-section-head tm-interests-section-head-popular" : "tm-interests-section-head",
      "aria-expanded": section.collapsed ? "false" : "true",
      "aria-controls": bodyId,
      onClick: () => onToggleSection(section.name),
    },
    [chevron, el("span", { class: "tm-interests-section-title", text: section.name }), el("span", { class: "tm-interests-section-count tm-muted", text: String(section.options.length) })],
  );
  const row = el("div", { id: bodyId, class: "tm-pf-chips tm-interests-section-body", hidden: section.collapsed });
  for (const opt of section.options) {
    const emojiSpan = opt.emoji
      ? el("span", { class: "tm-pf-chip-emoji", "aria-hidden": "true", text: opt.emoji })
      : null;
    row.append(
      el(
        "button",
        {
          type: "button",
          class: opt.selected ? "tm-pf-chip tm-pf-picker-opt tm-pf-chip-on" : "tm-pf-chip tm-pf-picker-opt",
          "aria-pressed": opt.selected ? "true" : "false",
          disabled: opt.disabled || state.saving,
          onClick: () => toggleLabel(opt.label),
        },
        [emojiSpan, el("span", { text: opt.label })],
      ),
    );
  }
  return el("section", { class: "tm-interests-section" }, [header, row]);
}

/** A DOM-id-safe slug of a section name (for aria-controls). Letters/digits kept; the rest → "-". */
function slug(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "section";
}

/** Repaint the sticky Save/Cancel bar's enabled state + error line from the valid+dirty model. */
function repaintSaveBar() {
  if (!dom) return;
  const model = saveBarModel(state.selected, state.original, state.config);
  dom.errorLine.textContent = model.error;
  dom.errorLine.hidden = !model.error;
  dom.saveBtn.disabled = !model.canSave || state.saving;
  dom.cancelBtn.disabled = state.saving;
}

/** Toggle a label in the pending selection (max-guarded), then repaint the three selection-dependent regions. */
function toggleLabel(label) {
  if (state.saving) return;
  state.selected = toggleInterest(state.selected, label, { max: state.config.max });
  repaintSummary();
  repaintSections();
  repaintSaveBar();
}

/** Fold/unfold a section, persist the new state, and repaint the sections. */
function onToggleSection(name) {
  state.collapsed = toggleSection(state.collapsed, name);
  saveCollapseState(activeUid(), state.collapsed);
  repaintSections();
}

/** Whether the pending selection differs from what the route opened with (the leave-guard signal). */
function isDirty() {
  return !sameLabelSet(state.selected, state.original);
}

/** Cancel: discard changes (prompting first if dirty) and return to the profile hub. */
async function onCancel() {
  if (state.saving) return;
  if (isDirty()) {
    const leave = await confirmDialog({
      title: "Discard changes?",
      message: "You have unsaved interest changes. Leave without saving?",
      confirmLabel: "Discard",
      cancelLabel: "Keep editing",
      danger: true,
    });
    if (!leave) return;
  }
  navigateToProfile();
}

/** Save: PATCH /me with the full pending set, then return to the profile hub (which repaints from /me). */
async function onSave() {
  if (state.saving) return;
  const model = saveBarModel(state.selected, state.original, state.config);
  if (!model.canSave) return; // the button is disabled, but belt-and-braces
  state.saving = true;
  repaintSummary();
  repaintSections();
  repaintSaveBar();
  try {
    await updateMe({ interests: savedInterestLabels(state.selected) });
    // Sync the baseline so the leave-guard on the (synchronous) navigate doesn't re-prompt.
    state.original = savedInterestLabels(state.selected);
    toast("Interests updated.", { type: "success", timeout: 2000 });
    navigateToProfile();
  } catch (err) {
    // The backend is the authoritative min/max + catalogue gate; surface its RFC-7807 detail verbatim.
    const message = err instanceof ApiError ? err.message : "Couldn't update your interests. Please try again.";
    toast(message, { type: "error" });
    state.saving = false;
    repaintSummary();
    repaintSections();
    repaintSaveBar();
  }
}

/** Navigate back to the profile hub. */
function navigateToProfile() {
  if (typeof window !== "undefined") window.location.hash = PROFILE_HASH;
}

/** Reflect load/error state in the status region: a loading line, or a retry card on failure. */
function renderStatus() {
  if (!dom) return;
  clear(dom.status);
  if (state.loading) {
    dom.status.append(el("p", { class: "tm-muted", text: "Loading interests…" }));
    return;
  }
  if (state.error) {
    dom.status.append(
      el("div", { class: "tm-error tm-empty" }, [
        doodle("chat", { class: "tm-doodle-empty", title: "Couldn't load interests" }),
        el("p", { text: state.error }),
        el("button", { class: "tm-btn", type: "button", onClick: load }, "Retry"),
      ]),
    );
  }
}

/** Fetch /me + the config + the catalogue, seed the state, and paint everything. */
async function load() {
  state.loading = true;
  state.error = null;
  renderStatus();
  try {
    // /me for the current selection; config + catalogue for the bounds + the pickable list. All three in
    // parallel — the catalogue is the biggest read and the page is inert without it.
    const [me, config, catalogue] = await Promise.all([getMe(), getInterestConfig(), getInterestCatalogue()]);
    state.config = normaliseInterestConfig(config);
    state.catalogue = catalogue;
    state.original = savedInterestLabels(me?.interests);
    state.selected = [...state.original];
    state.collapsed = loadCollapseState(activeUid());
    state.loading = false;
    renderStatus();
    repaintSummary();
    repaintSections();
    repaintSaveBar();
  } catch (err) {
    // A 401 already redirected (api.js); surface anything else as a retryable error. The catalogue read
    // failing is the common case — the page then shows the retry card rather than an empty section list.
    state.loading = false;
    state.error = "Could not load your interests.";
    console.warn("[interests-route] load failed:", err?.message ?? err);
    renderStatus();
  }
}

/**
 * Router entry point — called when the `#/profile/interests` route becomes active. Rebuilds the page
 * skeleton and (re)loads, mirroring the enterProfile lifecycle (the router only re-enters when the route
 * actually changes). Resetting `query`/`saving` on each entry means a fresh visit always starts clean.
 */
export function enterInterests() {
  const view = $("interests-view");
  if (!view) return;
  state.query = "";
  state.saving = false;
  build(view);
  if (dom && dom.searchInput) dom.searchInput.value = "";
  load();
}

// Bridge for ad-hoc use / debugging, mirroring window.tmProfile.
if (typeof window !== "undefined") {
  window.tmInterests = { enterInterests };
}
