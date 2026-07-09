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
// HEADER-ONLY DETAIL (TM-442, no backend change this ticket): the sent-history endpoint projects the
// campaign HEADER — id, title, audience (type + ref), recipient count, deep-link, sent-at, status — but
// NOT the message body (the body is persisted in admin_message, but the header-only read doesn't expose
// it, and this frontend-only ticket adds no API change). So the expanded row surfaces every header fact
// the endpoint returns, with the title as the message headline and an explicit note that the full body
// isn't part of the sent-history summary (a by-id detail endpoint would be the follow-up — see the PR).

import { listSentAdminMessages, ApiError } from "./api.js";
import { clear, el, relativeTime } from "./ui.js";
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
  hasPrevPage,
  hasNextPage,
  clampPage,
  pageIndicator,
  rangeIndicator,
  isEmptyHistory,
} from "./admin-sent-history-core.js";

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

// ---- rendering ----------------------------------------------------------------------------

/** A `.tm-badge` in the tone the status descriptor asks for (ok / off / info — all existing tones). */
function statusPill(status) {
  const { label, tone } = statusBadge(status);
  return el("span", { class: `tm-badge tm-badge-${tone}`, text: label });
}

/** The expanded detail panel for a row: every header fact the endpoint returns, plus the body caveat. */
function rowDetail(rowData) {
  const { label: refLabel, value: refValue } = audienceRefDetail(rowData);
  const when = relativeTime(rowData.sentAt);
  const deepLink = typeof rowData.deepLink === "string" && rowData.deepLink.trim() ? rowData.deepLink.trim() : null;

  const detail = el("div", { class: "tm-sent-detail", id: `admin-sent-detail-${rowData.id}` }, [
    // The title as the message headline — the closest "what was said" the header-only read exposes.
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
    // Honest about the header-only endpoint (TM-442): the full body isn't part of this summary read.
    el("p", { class: "tm-muted tm-sent-detail-note", text: "The full message body isn't part of the sent-history summary." }),
  ]);
  return detail;
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
