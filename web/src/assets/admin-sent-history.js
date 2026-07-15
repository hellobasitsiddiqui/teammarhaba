// Admin sent-history view — the DOM half (TM-444, epic TM-432, group-admin-messaging).
//
// The admin-console screen that lists the messages the signed-in admin has sent (the story: "browse
// what I've sent, so I can review past messages and their reach"). It reads GET /api/v1/admin/messages
// (TM-442) — newest-first, paged — and paints one row per campaign: title, audience summary, sent time,
// and the recipient count / delivery status. Clicking a row expands it to the full campaign detail.
// It lives on its OWN admin route (#/admin/messages), router-gated ADMIN-only (same gate as #/admin),
// mounted into #admin-message-list-view; the compose page (#/admin/messages/new, TM-443) is reached
// from the "New message" button here and now returns here after a send.
//
// All the load-bearing logic — the page-envelope normalisation, the audience/status formatting, and the
// prev/next/range paging math — lives in the pure, unit-tested admin-sent-history-core.js (the broadcast.js
// / admin-messages-core.js split), because THIS module transitively imports the Firebase SDK (via api.js
// → auth.js) and so can't run under the Node test runner. This file is the wiring: fetch a page, build the
// rows/pager with el(), toggle a row's detail, and page back/forward.
//
// EXPANDED-ROW BODY (TM-562): the sent-history LIST read (GET /api/v1/admin/messages) is header-only —
// id, title, audience (type + ref), recipient count, deep-link, sent-at, status — and does NOT carry the
// message body. So when a row is expanded, this view fetches the by-id detail (GET
// /api/v1/admin/messages/{id}, api.getAdminMessage — added in TM-562, the follow-up TM-442 flagged) to
// finally show the ACTUAL body that was sent, alongside the header facts. The per-row fetch is cached in
// state.details (keyed by campaign id), and messageBodyState (core) maps each cache entry — loading /
// error / body / empty — to what the detail panel paints, so the async wiring stays here while the
// (unit-tested) "what to show" decision lives in the browser-free core.

import { listSentAdminMessages, getAdminMessage, recallAdminMessage, ApiError } from "./api.js";
import { clear, el, relativeTime, toast, confirmDialog } from "./ui.js";
import { doodle } from "./doodles.js";
import { adminMessageNewHash } from "./admin-message-route.js";
import {
  DEFAULT_PAGE_SIZE,
  normalisePageResponse,
  audienceSummary,
  audienceRefDetail,
  audienceTypeLabel,
  formatRecipientCount,
  statusBadge,
  messageBodyState,
  hasPrevPage,
  hasNextPage,
  clampPage,
  pageIndicator,
  rangeIndicator,
  isEmptyHistory,
} from "./admin-sent-history-core.js";
// The RECALL control — the same shared, unit-tested recall-core the compose success panel mounts
// (TM-473). The core doc always intended these list rows to consume recallControlModel(); wiring it
// here is what actually mounts the affordance so a sent message stays recallable from its history row
// after the post-send panel is gone (TM-734).
import {
  RECALL_LABEL,
  RECALLED_LABEL,
  recallControlModel,
  recallConfirmCopy,
  summariseRecall,
} from "./admin-message-recall-core.js";

// The admin console this view's back link + heading return to (a real, router-registered destination).
const ADMIN_ROUTE = "#/admin";

// ---- state --------------------------------------------------------------------------------

const state = {
  // The current page's normalised envelope (see admin-sent-history-core.normalisePageResponse).
  data: { items: [], page: 0, size: DEFAULT_PAGE_SIZE, totalElements: 0, totalPages: 0 },
  page: 0, // the page index we're currently viewing / fetching (zero-based)
  size: DEFAULT_PAGE_SIZE,
  loading: false,
  error: null,
  // The id of the row currently expanded to its full detail, or null when all rows are collapsed.
  expandedId: null,
  // Per-campaign message-body fetch cache (TM-562), keyed by id → { loading, error, detail }. The list
  // read is header-only, so expanding a row fetches its body by id (getAdminMessage) into here. Cleared
  // on each page load so a Refresh re-fetches; a body is immutable, so within a page the cache is stable.
  details: new Map(),
};

// Persistent shell references (built once in buildShell), so a re-render only repaints the body + pager.
let shell = null;

// ---- data ---------------------------------------------------------------------------------

/**
 * Fetch and show one page of the sent history. Guards against landing on an empty page PAST the end
 * (e.g. the last row of the last page was the campaign we just left, and the total shrank): if a
 * non-first page comes back empty while pages still exist, it clamps back and refetches once.
 * @param {number} page zero-based page to load.
 */
async function loadPage(page) {
  state.page = Math.max(0, page);
  state.loading = true;
  state.error = null;
  // A new page (or a Refresh) drops the previous page's body cache — the ids differ, and a Refresh should
  // re-fetch rather than serve a stale body.
  state.details.clear();
  render();
  try {
    const envelope = await listSentAdminMessages({ page: state.page, size: state.size });
    const data = normalisePageResponse(envelope, { fallbackSize: state.size });

    // Overshot the end (empty later page but pages exist) — clamp back and refetch the real last page.
    if (data.items.length === 0 && state.page > 0 && data.totalPages > 0) {
      const clamped = clampPage(state.page, data.totalPages);
      if (clamped !== state.page) {
        await loadPage(clamped);
        return;
      }
    }

    state.data = data;
    state.page = data.page;
    // A row expanded on the previous page shouldn't stay "open" against a different row on the new page.
    state.expandedId = null;
  } catch (err) {
    state.error = err instanceof ApiError ? err.message : "Could not load sent messages.";
  } finally {
    state.loading = false;
    render();
  }
}

/**
 * Ensure the message body for campaign {@code id} is being (or has been) fetched (TM-562). The list read
 * is header-only, so the body is loaded lazily on expand via the by-id detail endpoint
 * (api.getAdminMessage). Fetches once per id: an in-flight or already-loaded entry is left alone, but a
 * previous ERROR is retried (so collapsing + reopening a failed row tries again). Repaints the list when
 * the fetch settles, but only if the row is still the expanded one (the admin may have moved on).
 * @param {number} id the campaign id whose body to load.
 */
async function ensureDetail(id) {
  const existing = state.details.get(id);
  // Already loading, or already loaded successfully — nothing to do. (An error entry falls through so
  // reopening the row retries the fetch.)
  if (existing && (existing.loading || existing.detail)) return;

  const entry = { loading: true, error: null, detail: null };
  state.details.set(id, entry);
  try {
    entry.detail = await getAdminMessage(id);
  } catch (err) {
    entry.error = err instanceof ApiError ? err.message : "Could not load the message body.";
  } finally {
    entry.loading = false;
    // Only repaint if this row is still the one open — avoids clobbering a row the admin has since opened.
    if (state.expandedId === id) renderList();
  }
}

// ---- rendering ----------------------------------------------------------------------------

/** A `.tm-badge` in the tone the status descriptor asks for (ok / off / info — all existing tones). */
function statusPill(status) {
  const { label, tone } = statusBadge(status);
  return el("span", { class: `tm-badge tm-badge-${tone}`, text: label });
}

/**
 * The message-body block for the expanded row (TM-562): the actual body fetched by id, or a
 * loading/error/empty placeholder while it isn't available. `messageBodyState` (core) decides which of
 * the four modes to show for the current fetch-cache entry; the DOM just paints it. The body text is set
 * via `text` (never innerHTML), so it renders as-typed with no markup interpretation.
 */
function bodyBlock(rowData) {
  const { mode, text } = messageBodyState(state.details.get(rowData.id));
  // The real body reads as plain body text; the placeholders (loading / error / empty) are muted.
  const textClass = mode === "body" ? "tm-sent-detail-body-text" : "tm-muted tm-sent-detail-body-note";
  return el("div", { class: `tm-sent-detail-body tm-sent-detail-body-${mode}` }, [
    el("h5", { class: "tm-sent-detail-body-label", text: "Message" }),
    el("p", { class: textClass, text }),
  ]);
}

/** The expanded detail panel for a row: every header fact the endpoint returns, plus the fetched body. */
function rowDetail(rowData) {
  const { label: refLabel, value: refValue } = audienceRefDetail(rowData);
  const when = relativeTime(rowData.sentAt);
  const deepLink = typeof rowData.deepLink === "string" && rowData.deepLink.trim() ? rowData.deepLink.trim() : null;

  const detail = el("div", { class: "tm-sent-detail", id: `admin-sent-detail-${rowData.id}` }, [
    // The title as the message headline.
    el("h4", { class: "tm-sent-detail-title", text: rowData.title || "(untitled)" }),
    el("dl", { class: "tm-detail tm-sent-detail-facts" }, [
      el("dt", { text: "Audience" }),
      el("dd", { text: audienceTypeLabel(rowData.audienceType) }),
      el("dt", { text: refLabel }),
      el("dd", { text: refValue }),
      el("dt", { text: "Recipients" }),
      el("dd", { text: formatRecipientCount(rowData.recipientCount) }),
      el("dt", { text: "Status" }),
      el("dd", {}, [statusPill(rowData.status)]),
      el("dt", { text: "Deep-link" }),
      el("dd", { text: deepLink || "None" }),
      el("dt", { text: "Sent" }),
      el("dd", {}, [el("time", { datetime: String(rowData.sentAt || ""), title: when.title, text: when.title || when.text })]),
      el("dt", { text: "Sent by" }),
      el("dd", { text: rowData.sentByUid || "—" }),
    ]),
    // The actual message body, fetched by id on expand (TM-562) — the "open one to see the body" AC.
    bodyBlock(rowData),
    // The RECALL control (TM-734): "wherever a sent message is shown". A live row offers recall; an
    // already-recalled row (status RECALLED) shows the disabled terminal state + note. Mounted here so a
    // sent message stays recallable from its history row, not only from the transient post-send panel.
    recallBlock(rowData),
  ]);
  return detail;
}

/**
 * The recall affordance for an expanded history row, driven by the shared recall-core (TM-473/TM-734).
 * A live message renders a danger "Recall message" button that confirms-then-recalls; a recalled one
 * renders the disabled "Recalled" state and the status note. Identical copy/state to the compose
 * success panel because both read recallControlModel().
 */
function recallBlock(rowData) {
  const model = recallControlModel(rowData);
  const btnId = `admin-sent-recall-${rowData.id}`;
  const action = model.canRecall
    ? el("button", {
        class: "tm-btn tm-btn-danger",
        id: btnId,
        type: "button",
        onClick: () => recall(rowData),
      }, RECALL_LABEL)
    : el("button", { class: "tm-btn", type: "button", disabled: true }, RECALLED_LABEL);

  return el("div", { class: "tm-sent-detail-recall" }, [
    model.note ? el("p", { class: "tm-muted tm-sent-detail-recall-note", text: model.note }) : null,
    el("div", { class: "tm-form-actions" }, [action]),
  ]);
}

/**
 * Confirm-then-recall a sent-history row (TM-734), reusing the exact confirm copy + summary the compose
 * success panel uses (recall-core). On success the row's status is flipped to RECALLED locally and the
 * list repaints so the control shows the recalled state; on failure it toasts and re-enables the button.
 * @param {object} rowData the expanded campaign row (carries the id recall targets).
 */
async function recall(rowData) {
  const ok = await confirmDialog({
    title: "Recall message?",
    message: recallConfirmCopy(),
    confirmLabel: RECALL_LABEL,
    danger: true,
  });
  if (!ok) return;

  const btn = document.getElementById(`admin-sent-recall-${rowData.id}`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Recalling…";
  }
  try {
    const result = await recallAdminMessage(rowData.id);
    toast(summariseRecall(result), { type: "success", timeout: 8000 });
    // Reflect the recall in the loaded page so the row (and its status pill) repaint as recalled without
    // a full reload — the list projects RECALLED as the derived status, which recallControlModel reads.
    const row = state.data.items.find((it) => it.id === rowData.id);
    if (row) row.status = "RECALLED";
    rowData.status = "RECALLED";
    renderList();
  } catch (err) {
    toast(err instanceof ApiError ? err.message : "Couldn't recall the message.", { type: "error" });
    if (btn) {
      btn.disabled = false;
      btn.textContent = RECALL_LABEL;
    }
  }
}

/** One history row: a toggle header (title + audience + reach + status + time) and its detail panel. */
function renderRow(rowData) {
  const expanded = state.expandedId === rowData.id;
  const when = relativeTime(rowData.sentAt);

  const header = el("button", {
    class: "tm-sent-row-head",
    type: "button",
    "aria-expanded": expanded ? "true" : "false",
    "aria-controls": `admin-sent-detail-${rowData.id}`,
    onClick: () => {
      // Accordion-ish: clicking the open row closes it, clicking another opens that one.
      state.expandedId = expanded ? null : rowData.id;
      // Opening a row lazily fetches its body by id (TM-562) — the list read is header-only. Kicks the
      // fetch off (a no-op if already loaded/in-flight); the panel shows a loading placeholder until it
      // settles, then ensureDetail repaints. Closing (expandedId=null) fetches nothing.
      if (state.expandedId === rowData.id) ensureDetail(rowData.id);
      renderList();
    },
  }, [
    el("span", { class: "tm-sent-row-main" }, [
      el("span", { class: "tm-sent-row-title", text: rowData.title || "(untitled)" }),
      el("span", { class: "tm-muted tm-sent-row-audience", text: audienceSummary(rowData) }),
    ]),
    el("span", { class: "tm-sent-row-meta" }, [
      el("span", { class: "tm-badge tm-sent-row-count", text: formatRecipientCount(rowData.recipientCount) }),
      statusPill(rowData.status),
      el("time", { class: "tm-muted tm-sent-row-time", datetime: String(rowData.sentAt || ""), title: when.title, text: when.text }),
      el("span", { class: "tm-sent-row-caret", "aria-hidden": "true", text: expanded ? "▾" : "▸" }),
    ]),
  ]);

  return el("li", { class: `tm-sent-row${expanded ? " tm-sent-row-open" : ""}` }, [
    header,
    expanded ? rowDetail(rowData) : null,
  ]);
}

/** Repaint just the list body (rows / empty / loading / error) — cheap, called on expand + page load. */
function renderList() {
  if (!shell) return;
  const body = clear(shell.body);

  if (state.loading) {
    body.append(el("p", { class: "tm-muted", text: "Loading sent messages…" }));
    return;
  }
  if (state.error) {
    body.append(el("div", { class: "tm-error" }, [
      el("p", { text: state.error }),
      el("button", { class: "tm-btn", type: "button", onClick: () => loadPage(state.page) }, "Retry"),
    ]));
    return;
  }

  const { items } = state.data;
  if (isEmptyHistory(items, state.page)) {
    // Genuinely-empty history (nothing ever sent) — the empty-state with a compose CTA.
    body.append(el("div", { class: "tm-empty" }, [
      doodle("chat", { class: "tm-doodle-empty" }),
      el("p", { class: "tm-empty-title", text: "No messages sent yet" }),
      el("p", { class: "tm-muted", text: "Messages you send to people, a city, or event attendees will show up here." }),
      el("a", { class: "tm-btn tm-btn-primary", href: adminMessageNewHash() }, "Compose a message"),
    ]));
    return;
  }

  body.append(el("ul", { class: "tm-sent-list" }, items.map(renderRow)));
}

/** Repaint the pager (range + prev/next) beneath the list. Hidden entirely while loading / on error. */
function renderPager() {
  if (!shell) return;
  const pager = clear(shell.pager);
  if (state.loading || state.error) return;

  const { page, size, totalElements, totalPages, items } = state.data;
  // Nothing to page through on a single (or empty) page — keep the footer quiet.
  if (totalElements === 0) return;

  pager.append(
    el("span", { class: "tm-muted", text: rangeIndicator(page, size, totalElements, items.length) }),
    el("div", { class: "tm-pager-controls" }, [
      el("button", {
        class: "tm-btn tm-btn-sm",
        type: "button",
        disabled: !hasPrevPage(page),
        onClick: () => loadPage(page - 1),
      }, "Prev"),
      el("span", { class: "tm-muted", text: pageIndicator(page, totalPages) }),
      el("button", {
        class: "tm-btn tm-btn-sm",
        type: "button",
        disabled: !hasNextPage(page, totalPages),
        onClick: () => loadPage(page + 1),
      }, "Next"),
    ]),
  );
}

/** Full repaint of the dynamic parts (list + pager). The head (title / actions) is stable, built once. */
function render() {
  renderList();
  renderPager();
}

/** Build the view shell ONCE and stash live references, then the caller kicks off the first load. */
function buildShell(view) {
  const body = el("div", { class: "tm-sent-body", id: "admin-sent-body" });
  const pager = el("div", { class: "tm-pager", id: "admin-sent-pager" });

  shell = { body, pager };

  clear(view).append(
    el("div", { class: "tm-admin-head tm-sent-head" }, [
      el("h2", {}, [doodle("chat", { class: "tm-doodle-header" }), "Sent messages"]),
      el("div", { class: "tm-admin-head-actions" }, [
        el("a", { class: "tm-btn tm-btn-sm", id: "admin-sent-back", href: ADMIN_ROUTE }, "← Admin"),
        el("button", { class: "tm-btn tm-btn-sm", id: "admin-sent-refresh", type: "button", onClick: () => loadPage(state.page) }, "Refresh"),
        el("a", { class: "tm-btn tm-btn-primary tm-btn-sm", id: "admin-sent-new", href: adminMessageNewHash() }, "New message"),
      ]),
    ]),
    el("p", { class: "tm-muted tm-sent-intro", text: "Messages you've sent, newest first. Open one to see who it went to and its reach." }),
    body,
    pager,
  );
}

/**
 * Router entry (TM-444): mount the sent-history view (once) and load the first page. Re-entry reloads
 * from page 0 so a just-sent campaign shows at the top (the router resets its `active` flag on leave,
 * so returning here re-runs this). The router gates the ADMIN-only #/admin/messages route before calling.
 */
export function enterAdminSentHistory() {
  const view = document.getElementById("admin-message-list-view");
  if (!view) return;
  buildShell(view);
  state.expandedId = null;
  loadPage(0);
}

// Bridge for the router (which imports this) + ad-hoc use.
if (typeof window !== "undefined") {
  window.tmAdminSentHistory = { enterAdminSentHistory };
}
